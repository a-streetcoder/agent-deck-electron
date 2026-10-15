import { describe, expect, it } from "vitest";
import type { ValidationResult } from "../src/loopEngine.ts";
import type { SubagentRunRecord } from "../src/subagentRunStore.ts";
import {
  launchVerifier,
  VerifierRefusedError,
  verifierVerdict,
  verifyTargetError,
  type VerifierDeps,
} from "../src/verifier.ts";

const target = (extra: Partial<SubagentRunRecord> = {}): SubagentRunRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  parentSessionId: "s1",
  task: "build it",
  agent: "coder",
  status: "completed",
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  completedAt: "2026-10-15T00:00:01.000Z",
  summary: "PRODUCER_SUMMARY",
  ...extra,
});

describe("verifierVerdict: the typed verdict of a verifier's answer", () => {
  it.each([
    ["APPROVE\nLooks right.", "APPROVE", "Looks right.", "strict"],
    ["REJECT: the join has no tests", "REJECT", "the join has no tests", "lenient"],
    ["**CONTINUE** — one more pass", "CONTINUE", "one more pass", "lenient"],
    ["ASK_HUMAN\nNeeds a product call.", "ASK_HUMAN", "Needs a product call.", "strict"],
    ["Verdict: REJECT\nmissing tests", "REJECT", "Verdict: REJECT\nmissing tests", "lenient"],
    // FAIL is the loop checker's; a verifier answering it has no verdict.
    ["FAIL\nbroken", "missing", "FAIL\nbroken", "missing"],
    ["I think this should be approved", "missing", "I think this should be approved", "missing"],
  ])("%j -> %s", (text, decision, reason, parse) => {
    expect(verifierVerdict(text, "v1")).toEqual({
      decision,
      reason,
      parse,
      verifierRunId: "v1",
      text,
    });
  });
});

describe("verifyTargetError: only a finished run of the caller session", () => {
  it("refuses an unknown or foreign run (the owner-scoped read returns nothing)", () => {
    expect(verifyTargetError(undefined, "r1")).toMatch(/No Deck subagent r1 in this session/);
  });
  it("refuses a run still starting or running", () => {
    expect(verifyTargetError(target({ status: "running" }), "r1")).toMatch(/still running/);
    expect(verifyTargetError(target({ status: "starting" }), "r1")).toMatch(/still starting/);
  });
  it("refuses the producer's own agent, accepts another or an anonymous verifier", () => {
    expect(verifyTargetError(target(), "r1", "Coder")).toMatch(/never verifies its own work/);
    expect(verifyTargetError(target(), "r1", "reviewer")).toBeUndefined();
    expect(verifyTargetError(target(), "r1")).toBeUndefined();
    for (const status of ["failed", "stopped", "interrupted"] as const) {
      expect(verifyTargetError(target({ status }), "r1", "reviewer")).toBeUndefined();
    }
  });
});

describe("launchVerifier", () => {
  function deps(record: SubagentRunRecord | undefined, answer: Promise<{ text: string }>) {
    const calls: string[] = [];
    const spawned: { task: string; options: Record<string, unknown> }[] = [];
    const verdicts: unknown[] = [];
    const validation: ValidationResult = {
      command: "npm test",
      workingDirectory: "/repo",
      exitCode: 1,
      durationMs: 5,
      stdout: "",
      stderr: "",
      stdoutTail: "1 failing",
      classification: "completed",
      passed: false,
      evidence: "exit 1",
    };
    const value: VerifierDeps = {
      run: (parent, runId) => (parent === "s1" && runId === record?.id ? record : undefined),
      cwd: () => "/repo",
      filesChanged: async () => ["src/a.ts"],
      runValidation: async (cwd, command) => {
        calls.push(`validate ${cwd} ${command}`);
        return validation;
      },
      spawn: async (_parent, task, options) => {
        calls.push("spawn");
        spawned.push({ task, options });
        return { runId: "22222222-2222-4222-8222-222222222222", done: answer };
      },
      recordVerdict: (parent, runId, verdict) => {
        calls.push("record");
        verdicts.push({ parent, runId, verdict });
      },
      warn: () => {},
    };
    return { value, calls, spawned, verdicts };
  }

  it("runs validation first, hands the evidence to a verify-role spawn and records the verdict", async () => {
    const record = target({ worktreePath: "/wt" });
    const d = deps(record, Promise.resolve({ text: "REJECT: 1 failing test" }));
    const { runId, done } = await launchVerifier(d.value, {
      parentSessionId: "s1",
      targetRunId: record.id,
      task: "check the build",
      agentName: "reviewer",
      validationCommand: "npm test",
    });
    const outcome = await done;
    // Validation in the target's worktree, before the verifier starts.
    expect(d.calls).toEqual(["validate /wt npm test", "spawn", "record"]);
    const prompt = d.spawned[0]!.task;
    expect(prompt).toMatch(/^verify: check the build/);
    expect(prompt).toContain("PRODUCER_SUMMARY");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("Validation (already run by Agent Deck, before your review): failed");
    expect(prompt).toContain("1 failing");
    expect(prompt).toContain(
      "The exact first non-empty line must be APPROVE, REJECT, CONTINUE, or ASK_HUMAN.",
    );
    expect(d.spawned[0]!.options).toMatchObject({
      agentName: "reviewer",
      targetRunId: record.id,
      detached: false,
    });
    expect(outcome).toMatchObject({ decision: "REJECT", reason: "1 failing test" });
    expect(d.verdicts).toEqual([
      {
        parent: "s1",
        runId: record.id,
        verdict: { decision: "REJECT", reason: "1 failing test", verifierRunId: runId },
      },
    ]);
  });

  it("refuses a foreign or running target before anything runs", async () => {
    const running = deps(target({ status: "running" }), Promise.resolve({ text: "" }));
    await expect(
      launchVerifier(running.value, {
        parentSessionId: "s1",
        targetRunId: target().id,
        task: "t",
        validationCommand: "npm test",
      }),
    ).rejects.toBeInstanceOf(VerifierRefusedError);
    const foreign = deps(target(), Promise.resolve({ text: "" }));
    await expect(
      launchVerifier(foreign.value, {
        parentSessionId: "other-session",
        targetRunId: target().id,
        task: "t",
      }),
    ).rejects.toThrow(/in this session/);
    expect([...running.calls, ...foreign.calls]).toEqual([]);
  });

  it("a verifier that did not finish records a missing verdict and done still resolves", async () => {
    const d = deps(target(), Promise.reject(new Error("child crashed")));
    const { done } = await launchVerifier(d.value, {
      parentSessionId: "s1",
      targetRunId: target().id,
      task: "t",
    });
    await expect(done).resolves.toMatchObject({
      decision: "missing",
      reason: "The verifier did not finish: child crashed",
    });
    expect(d.calls).toEqual(["spawn", "record"]);
    expect(d.spawned[0]!.task).toContain("Validation: no validation command is configured.");
  });
});
