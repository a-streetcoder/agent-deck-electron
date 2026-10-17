import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ValidationResult } from "../src/loopEngine.ts";
import type { SubagentRunRecord } from "../src/subagentRunStore.ts";
import {
  launchVerifier,
  planMayRunShell,
  VALIDATION_SHELL_GATE,
  VerifierRefusedError,
  verifierVerdict,
  verifyTargetError,
  validationEvidence,
  type VerifierDeps,
} from "../src/verifier.ts";
import { sessionVerifierDeps } from "../src/bridgeTools.ts";
import type { SessionManager } from "../src/SessionManager.ts";
import type { PiSandbox, SandboxCommand } from "@agent-deck/pi-host";

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

describe("planMayRunShell: the validationCommand gate", () => {
  it("allows a parent launch and agents with Pi's defaults or bash, refuses the rest", () => {
    expect(planMayRunShell({ kind: "parent" })).toBe(true);
    expect(planMayRunShell({ kind: "agent" })).toBe(true);
    expect(planMayRunShell({ kind: "agent", tools: ["read", "bash"] })).toBe(true);
    expect(planMayRunShell({ kind: "agent", tools: ["read", "grep"] })).toBe(false);
    expect(planMayRunShell({ kind: "agent", tools: [] })).toBe(false);
    expect(planMayRunShell(undefined)).toBe(false);
  });
});

describe("launchVerifier", () => {
  const VERIFIER = "22222222-2222-4222-8222-222222222222";
  function deps(
    record: SubagentRunRecord | undefined,
    answer: Promise<{ text: string }>,
    gates: { shell?: boolean; cap?: boolean } = {},
  ) {
    const calls: string[] = [];
    const spawned: { task: string; options: Record<string, unknown> }[] = [];
    const verdicts: unknown[] = [];
    const state = { record };
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
      run: (parent, runId) =>
        parent === "s1" && runId === state.record?.id ? state.record : undefined,
      cwd: () => "/repo",
      mayRunShell: () => gates.shell !== false,
      assertCanSpawn: () => {
        calls.push("gate");
        if (gates.cap) throw new Error("child cap reached");
      },
      head: async () => "h".repeat(40),
      filesChanged: async () => ["src/a.ts"],
      runValidation: async (_parent, cwd, command) => {
        calls.push(`validate ${cwd} ${command}`);
        return validation;
      },
      spawn: async (_parent, task, options) => {
        calls.push("spawn");
        spawned.push({ task, options });
        return { runId: VERIFIER, done: answer };
      },
      recordVerdict: (parent, runId, verdict) => {
        calls.push(runId === VERIFIER ? "record verifier" : "record target");
        verdicts.push({ parent, runId, verdict });
      },
      warn: () => {},
    };
    return { value, calls, spawned, verdicts, state };
  }

  it("runs validation first, hands the evidence to a verify-role spawn and records the verdict", async () => {
    const record = target();
    const d = deps(record, Promise.resolve({ text: "REJECT: 1 failing test" }));
    const { runId, done } = await launchVerifier(d.value, {
      parentSessionId: "s1",
      targetRunId: record.id,
      task: "check the build",
      agentName: "reviewer",
      validationCommand: "npm test",
    });
    const outcome = await done;
    // Gates, then validation in the session checkout, then the verifier.
    expect(d.calls).toEqual([
      "gate",
      "validate /repo npm test",
      "spawn",
      "record verifier",
      "record target",
    ]);
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
    expect(d.spawned[0]!.options).not.toHaveProperty("cwd");
    expect(outcome).toMatchObject({ decision: "REJECT", reason: "1 failing test" });
    // On the verifier's own record, then on the target.
    const verdict = { decision: "REJECT", reason: "1 failing test", verifierRunId: runId };
    expect(d.verdicts).toEqual([
      { parent: "s1", runId, verdict },
      { parent: "s1", runId: record.id, verdict },
    ]);
  });

  it("works in a worktree target: validation and the verifier there, base and HEAD in the prompt", async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), "verify-wt-"));
    try {
      const base = "b".repeat(40);
      const record = target({ worktreePath: worktree, worktreeBaseCommit: base });
      const d = deps(record, Promise.resolve({ text: "APPROVE" }));
      await (
        await launchVerifier(d.value, {
          parentSessionId: "s1",
          targetRunId: record.id,
          task: "t",
          validationCommand: "npm test",
        })
      ).done;
      expect(d.calls).toEqual([
        "gate",
        `validate ${worktree} npm test`,
        "spawn",
        "record verifier",
        "record target",
      ]);
      expect(d.spawned[0]!.options).toMatchObject({ cwd: worktree });
      const prompt = d.spawned[0]!.task;
      expect(prompt).toContain(`Base commit: ${base}; HEAD: ${"h".repeat(40)}`);
      expect(prompt).toContain(`\`git diff ${base}..${"h".repeat(40)}\``);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("refuses validationCommand when the session's agent may not run a shell; nothing runs", async () => {
    const d = deps(target(), Promise.resolve({ text: "APPROVE" }), { shell: false });
    await expect(
      launchVerifier(d.value, {
        parentSessionId: "s1",
        targetRunId: target().id,
        task: "t",
        validationCommand: "npm test",
      }),
    ).rejects.toThrow(VALIDATION_SHELL_GATE);
    expect(d.calls).toEqual([]);
    // Without a command the same session may still verify.
    const plain = await launchVerifier(d.value, {
      parentSessionId: "s1",
      targetRunId: target().id,
      task: "t",
    });
    await plain.done;
    expect(d.calls).toEqual(["gate", "spawn", "record verifier", "record target"]);
  });

  it("checks the child cap before spending a validation run", async () => {
    const d = deps(target(), Promise.resolve({ text: "APPROVE" }), { cap: true });
    await expect(
      launchVerifier(d.value, {
        parentSessionId: "s1",
        targetRunId: target().id,
        task: "t",
        validationCommand: "npm test",
        detached: true,
      }),
    ).rejects.toThrow("child cap reached");
    expect(d.calls).toEqual(["gate"]);
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

  it("drops the target's verdict when it was continued while the verifier ran; the verifier keeps its own", async () => {
    let answer!: (value: { text: string }) => void;
    const d = deps(target(), new Promise((resolve) => (answer = resolve)));
    const { done } = await launchVerifier(d.value, {
      parentSessionId: "s1",
      targetRunId: target().id,
      task: "t",
    });
    // A continuation ran and finished: a newer turn the verifier never saw.
    d.state.record = target({ completedAt: "2026-10-15T00:05:00.000Z", summary: "NEWER" });
    answer({ text: "APPROVE" });
    await expect(done).resolves.toMatchObject({ decision: "APPROVE" });
    expect(d.calls.filter((call) => call.startsWith("record"))).toEqual(["record verifier"]);
    // Still running its continuation: dropped as well.
    let answerLate!: (value: { text: string }) => void;
    const running = deps(target(), new Promise((resolve) => (answerLate = resolve)));
    const late = await launchVerifier(running.value, {
      parentSessionId: "s1",
      targetRunId: target().id,
      task: "t",
    });
    running.state.record = { ...target(), status: "running", completedAt: undefined };
    answerLate({ text: "APPROVE" });
    await late.done;
    expect(running.calls.filter((call) => call.startsWith("record"))).toEqual(["record verifier"]);
  });

  it("a cancelled or failed verifier records nothing (an earlier verdict stays); done resolves", async () => {
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
    expect(d.calls).toEqual(["gate", "spawn"]);
    expect(d.verdicts).toEqual([]);
    expect(d.spawned[0]!.task).toContain("Validation: no validation command is configured.");
  });
});

describe("validation: the session's launch env, secrets redacted", () => {
  const FAKE_TOKEN = `ghp_${"A1b2C3d4".repeat(4)}`;

  it("runs the command with the parent session's launch env (owner credentials)", async () => {
    const sessions = {
      sessionLaunchEnv: (id: string) => (id === "s1" ? { A7_ENV_PROBE: "owner-env" } : undefined),
      sessionSandbox: () => undefined,
    } as unknown as SessionManager;
    const deps = sessionVerifierDeps(sessions, () => {});
    const result = await deps.runValidation(
      "s1",
      tmpdir(),
      `node -e "process.stdout.write('probe=' + process.env.A7_ENV_PROBE)"`,
    );
    expect(result.stdout).toContain("probe=owner-env");
  });

  it("ADR 0007: runs the verify validation inside the parent session's sandbox", async () => {
    const asked: Array<[string, string]> = [];
    const wrapped: Array<{ command: SandboxCommand; policy: unknown }> = [];
    const policy = { allowWrite: [tmpdir()] } as unknown as PiSandbox["policy"];
    const sandbox: PiSandbox = {
      provider: {
        name: "srt",
        wrap: async (command, given) => {
          wrapped.push({ command, policy: given });
          return {
            ...command,
            command: process.execPath,
            args: ["-e", "process.stdout.write('inside')"],
          };
        },
      },
      policy,
    };
    const sessions = {
      sessionLaunchEnv: () => undefined,
      sessionSandbox: (id: string, cwd: string) => (asked.push([id, cwd]), sandbox),
    } as unknown as SessionManager;
    const result = await sessionVerifierDeps(sessions, () => {}).runValidation(
      "s1",
      tmpdir(),
      "pnpm test",
    );
    expect(asked).toEqual([["s1", tmpdir()]]);
    expect(wrapped[0]).toMatchObject({ command: { args: ["-c", "pnpm test"] }, policy });
    expect(result.stdout).toBe("inside");
  });

  it("redacts a token in the command and its output before the prompt", () => {
    const evidence = validationEvidence(
      {
        command: `echo ${FAKE_TOKEN}`,
        workingDirectory: "/repo",
        exitCode: 0,
        durationMs: 1,
        stdout: FAKE_TOKEN,
        stderr: `token=${"z".repeat(12)}`,
        classification: "completed",
        passed: true,
        evidence: "",
      },
      true,
    );
    expect(evidence).not.toContain(FAKE_TOKEN);
    expect(evidence).not.toContain("z".repeat(12));
    expect(evidence).toContain("Command: echo <secret>");
    expect(evidence).toContain("stdout tail:\n<secret>");
  });
});
