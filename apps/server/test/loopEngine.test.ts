import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cwd } from "node:process";
import {
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  type LoopDefinition,
  type LoopStructure,
} from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { LoopEngine } from "../src/loopEngine.ts";

/**
 * Loop engine control flow, hermetic: the agent executor is injected (no pi),
 * while the validation command runs FOR REAL (`exit 0` / `exit 1`) so the
 * exit-code stop condition is exercised end-to-end.
 */

function makeLoop(overrides: Partial<LoopDefinition> = {}): LoopDefinition {
  return {
    id: "x",
    name: "test",
    description: "",
    goal: "do the thing",
    structure: "singleAgent",
    agentName: undefined,
    maxIterations: 3,
    validationCommand: "exit 0",
    writeTarget: "artifactMarkdown",
    source: "user",
    filePath: "x",
    ...overrides,
  };
}

describe("loop engine (single-agent)", () => {
  it.each<LoopStructure>(["agentPipeline", "parallelAgents", "discoveryTriage", "humanApproval"])(
    "rejects unsupported %s before allocating a run or invoking its executor",
    (structure) => {
      let calls = 0;
      const engine = new LoopEngine({
        executeAgent: async () => {
          calls += 1;
          return "must not run";
        },
      });

      expect(() => engine.start(makeLoop({ structure }), cwd())).toThrow(
        expect.objectContaining({ code: LOOP_STRUCTURE_UNSUPPORTED_CODE, structure }),
      );
      expect(calls).toBe(0);
      expect(engine.list()).toEqual([]);
    },
  );

  it("runs maker, report-only checker, validation, then evaluator and revises with evidence", async () => {
    const calls: Array<{ phase: string; prompt: string }> = [];
    let round = 0;
    const engine = new LoopEngine({
      executeRole: async ({ phase, prompt }) => {
        calls.push({ phase, prompt });
        if (phase === "maker") return `maker-${++round}`;
        if (phase === "checker")
          return round === 1 ? "REJECT\nMissing test evidence" : "APPROVE\nLooks good";
        return round === 1 ? "CONTINUE\nNot done" : "SUCCESS\nGoal met";
      },
      runValidation: async () => ({ passed: true, evidence: "tests green" }),
    });
    const run = engine.start(
      makeLoop({
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "green tests",
        validationCommand: "test",
      }),
      cwd(),
    );
    await engine.settled(run.id);
    expect(run.status).toBe("completed");
    expect(calls.map((call) => call.phase)).toEqual([
      "maker",
      "checker",
      "evaluator",
      "maker",
      "checker",
      "evaluator",
    ]);
    expect(calls[3]!.prompt).toContain("Missing test evidence");
    expect(run.iterations.map((iteration) => iteration.checkerDecision)).toEqual([
      "REJECT",
      "APPROVE",
    ]);
    expect(run.iterations[1]!.goalDecision).toBe("SUCCESS");
  });

  it.each([
    ["FAIL", "failed", "agentFailed"],
    ["not a decision", "failed", "agentFailed"],
  ] as const)("handles checker %s fail-closed", async (decision, status, reason) => {
    const engine = new LoopEngine({
      executeRole: async ({ phase }) => (phase === "checker" ? decision : "maker"),
    });
    const run = engine.start(
      makeLoop({
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "strict",
      }),
      cwd(),
    );
    await engine.settled(run.id);
    expect(run).toMatchObject({ status, stopReason: reason });
  });

  it.each(["REJECT", "ASK_HUMAN"] as const)(
    "completes for checker %s when evaluator succeeds and validation passes",
    async (checkerDecision) => {
      const engine = new LoopEngine({
        executeRole: async ({ phase }) =>
          phase === "checker"
            ? `${checkerDecision}\nChecker evidence`
            : phase === "evaluator"
              ? "SUCCESS\nGoal evidence"
              : "made",
        runValidation: async () => ({ passed: true, evidence: "tests passed" }),
      });
      const run = engine.start(
        makeLoop({
          structure: "makerChecker",
          makerName: "Maker",
          checkerName: "Checker",
          checkerRubric: "strict",
        }),
        cwd(),
      );
      await engine.settled(run.id);
      expect(run).toMatchObject({ status: "completed", stopReason: "success" });
      expect(run.iterations[0]).toMatchObject({ checkerDecision, goalDecision: "SUCCESS" });
    },
  );

  it("requires evaluator SUCCESS and configured validation together", async () => {
    const engine = new LoopEngine({
      executeRole: async ({ phase }) =>
        phase === "checker" ? "APPROVE\nok" : phase === "evaluator" ? "SUCCESS\nok" : "made",
      runValidation: async () => ({ passed: false, evidence: "tests failed" }),
    });
    const run = engine.start(
      makeLoop({
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "strict",
        maxIterations: 1,
      }),
      cwd(),
    );
    await engine.settled(run.id);
    expect(run.status).toBe("notAchieved");
    expect(run.stopReason).toBe("validationFailedAfterFinalIteration");
  });

  it("matches native applyGoalEvaluation ordering: ASK_HUMAN stops only after evaluator CONTINUE", async () => {
    const engine = new LoopEngine({
      executeRole: async ({ phase }) =>
        phase === "checker"
          ? "ASK_HUMAN\nNeed a decision"
          : phase === "evaluator"
            ? "CONTINUE\nNot complete"
            : "made",
    });
    const run = engine.start(
      makeLoop({
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "strict",
      }),
      cwd(),
    );
    await engine.settled(run.id);
    expect(run).toMatchObject({ status: "stopped", stopReason: "humanInputRequired" });
  });

  it("stops on the first passing validation (exit 0)", async () => {
    let calls = 0;
    const engine = new LoopEngine({
      executeAgent: async () => {
        calls += 1;
        return "agent output";
      },
    });
    const run = engine.start(makeLoop({ validationCommand: "exit 0", maxIterations: 5 }), cwd());
    await engine.settled(run.id);
    expect(run.status).toBe("completed");
    expect(run.stopReason).toBe("success");
    expect(calls).toBe(1); // stopped after the first passing iteration
    expect(run.iterations).toHaveLength(1);
    expect(run.iterations[0]).toMatchObject({ index: 1, validationPassed: true });
    expect(run.endedAt).toBeDefined();
  });

  it("runs every iteration then fails when validation never passes (exit 1)", async () => {
    let calls = 0;
    const engine = new LoopEngine({
      executeAgent: async () => {
        calls += 1;
        return "out";
      },
    });
    const run = engine.start(makeLoop({ validationCommand: "exit 1", maxIterations: 3 }), cwd());
    await engine.settled(run.id);
    expect(run.status).toBe("failed");
    expect(run.stopReason).toBe("validationFailedAfterFinalIteration");
    expect(calls).toBe(3);
    expect(run.iterations.map((i) => i.validationPassed)).toEqual([false, false, false]);
  });

  it("fails immediately with no validation command (native validationUnavailable)", async () => {
    const engine = new LoopEngine({ executeAgent: async () => "out" });
    const run = engine.start(makeLoop({ validationCommand: "", maxIterations: 4 }), cwd());
    await engine.settled(run.id);
    expect(run.status).toBe("failed");
    expect(run.stopReason).toBe("validationUnavailable");
    expect(run.iterations).toHaveLength(1);
  });

  it("fails when the agent throws (agentFailed), recording the error", async () => {
    const engine = new LoopEngine({
      executeAgent: async () => {
        throw new Error("agent exploded");
      },
    });
    const run = engine.start(makeLoop(), cwd());
    await engine.settled(run.id);
    expect(run.status).toBe("failed");
    expect(run.stopReason).toBe("agentFailed");
    expect(run.iterations[0]).toMatchObject({ output: "agent exploded", validationPassed: null });
  });

  it("a throwing validation runner is treated as a failure, never stuck as running", async () => {
    const engine = new LoopEngine({
      executeAgent: async () => "out",
      runValidation: async () => {
        throw new Error("validation runner blew up");
      },
    });
    const run = engine.start(makeLoop({ validationCommand: "whatever", maxIterations: 2 }), cwd());
    await engine.settled(run.id);
    // Both iterations ran (validation never "passed"), and the run reached a
    // terminal state instead of hanging on "running".
    expect(run.status).toBe("failed");
    expect(run.stopReason).toBe("validationFailedAfterFinalIteration");
    expect(run.iterations.map((i) => i.validationPassed)).toEqual([false, false]);
  });

  it.each(["maker", "checker", "validation", "evaluator"] as const)(
    "actively cancels in-flight %s work and terminalizes once",
    async (blockedPhase) => {
      let entered = "";
      let cancelCalls = 0;
      const block = (signal: AbortSignal): Promise<string> =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      const engine = new LoopEngine({
        executeRole: async ({ phase, signal }) => {
          entered = phase;
          if (phase === blockedPhase) return await block(signal);
          if (phase === "checker") return "APPROVE\nok";
          if (phase === "evaluator") return "SUCCESS\nok";
          return "maker output";
        },
        runValidation: async (_cwd, _command, signal) => {
          entered = "validation";
          if (blockedPhase === "validation") {
            await block(signal!);
          }
          return true;
        },
      });
      const run = engine.start(
        makeLoop({
          structure: "makerChecker",
          makerName: "Maker",
          checkerName: "Checker",
          checkerRubric: "strict",
        }),
        cwd(),
        { cancel: async () => void (cancelCalls += 1) },
      );
      await expect.poll(() => entered).toBe(blockedPhase);
      await engine.stop(run.id);
      expect(run).toMatchObject({ status: "stopped", stopReason: "userStopped" });
      expect(run.endedAt).toBeDefined();
      expect(cancelCalls).toBe(1);
    },
  );

  it("persists report-only artifacts outside the project for every role", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-artifacts-data-"));
    const project = mkdtempSync(path.join(tmpdir(), "loop-artifacts-project-"));
    const engine = new LoopEngine({
      dataDir,
      executeRole: async ({ phase }) =>
        phase === "checker"
          ? "APPROVE\nchecker report"
          : phase === "evaluator"
            ? "SUCCESS\nevaluator report"
            : "maker report",
    });
    const run = engine.start(
      makeLoop({
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "strict",
        writeTarget: "artifactMarkdown",
        validationCommand: "",
      }),
      project,
    );
    await engine.settled(run.id);
    const artifacts = run.iterations[0]!.artifacts;
    expect(artifacts.map((artifact) => artifact.phase)).toEqual(["maker", "checker", "evaluator"]);
    for (const artifact of artifacts) {
      expect(artifact.filePath.startsWith(project + path.sep)).toBe(false);
      expect(artifact.filePath.startsWith(path.join(dataDir, "loop-artifacts") + path.sep)).toBe(
        true,
      );
      expect(readFileSync(artifact.filePath, "utf8")).toContain("report");
    }
    const terminalStore = readFileSync(path.join(dataDir, "loop-runs.json"), "utf8");
    const terminalArtifacts = artifacts.map((artifact) => readFileSync(artifact.filePath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readFileSync(path.join(dataDir, "loop-runs.json"), "utf8")).toBe(terminalStore);
    expect(artifacts.map((artifact) => readFileSync(artifact.filePath, "utf8"))).toEqual(
      terminalArtifacts,
    );
  });

  it.each([
    ["truncated", "["],
    ["wrong root", "{}"],
    ["invalid record", JSON.stringify([{ id: "bad", status: "running" }])],
  ])("quarantines a %s run store and starts safely", (_label, content) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-corrupt-"));
    const store = path.join(dataDir, "loop-runs.json");
    writeFileSync(store, content);
    writeFileSync(`${store}.stale.tmp`, "partial");
    const warnings: string[] = [];
    const engine = new LoopEngine({ dataDir, warn: (message) => warnings.push(message) });
    expect(engine.list()).toEqual([]);
    expect(existsSync(store)).toBe(false);
    expect(existsSync(`${store}.stale.tmp`)).toBe(false);
    expect(readdirSync(dataDir).some((entry) => entry.startsWith("loop-runs.corrupt-"))).toBe(true);
    expect(warnings[0]).toContain("Quarantined invalid Loop run store");
  });

  it("quarantines launch ownership that lacks the required canonical/worktree proof", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-ownership-invalid-"));
    const store = path.join(dataDir, "loop-runs.json");
    const engine = new LoopEngine({ dataDir, executeAgent: async () => "done" });
    const run = engine.start(makeLoop(), cwd());
    await engine.settled(run.id);
    const records = JSON.parse(readFileSync(store, "utf8")) as Array<Record<string, unknown>>;
    records[0]!.launch = { sessionId: "parent", writeTarget: "newWorktree" };
    writeFileSync(store, JSON.stringify(records));

    expect(new LoopEngine({ dataDir }).list()).toEqual([]);
    expect(readdirSync(dataDir).some((entry) => entry.startsWith("loop-runs.corrupt-"))).toBe(true);
  });

  it("atomically persists runs and recovers orphan active records as interrupted", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-runs-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new LoopEngine({
      dataDir,
      executeAgent: async () => {
        await gate;
        return "out";
      },
    });
    const active = first.start(makeLoop({ writeTarget: "currentCheckout" }), cwd(), {
      launch: {
        sessionId: "loop-parent",
        writeTarget: "currentCheckout",
        checkoutLockKey: "/canonical/project",
      },
    });
    expect(JSON.parse(readFileSync(path.join(dataDir, "loop-runs.json"), "utf8"))[0].status).toBe(
      "running",
    );
    const recoveredEngine = new LoopEngine({ dataDir });
    const recovered = recoveredEngine.get(active.id)!;
    expect(recovered).toMatchObject({
      status: "interrupted",
      stopReason: "appInterrupted",
      launch: { sessionId: "loop-parent", checkoutLockKey: "/canonical/project" },
    });
    expect(recoveredEngine.recoveryCheckoutLocks()).toEqual(
      new Map([["/canonical/project", active.id]]),
    );
    expect(recoveredEngine.pendingResourceReconciliations()).toHaveLength(1);

    recoveredEngine.markSessionReconciled(active.id);
    recoveredEngine.acknowledgeCheckoutRecovery(active.id);
    const afterAcknowledgement = new LoopEngine({ dataDir });
    expect(afterAcknowledgement.recoveryCheckoutLocks()).toEqual(new Map());
    expect(afterAcknowledgement.pendingResourceReconciliations()).toEqual([]);
    expect(afterAcknowledgement.get(active.id)?.launch?.checkoutAcknowledgedAt).toBeDefined();
    release();
    await first.settled(active.id);
  });

  it("stops cooperatively when stop() is called mid-iteration (userStopped)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const engine = new LoopEngine({
      executeAgent: async () => {
        calls += 1;
        await gate;
        return "out";
      },
      runValidation: async () => false,
    });
    const run = engine.start(makeLoop({ maxIterations: 5 }), cwd());
    // The first agent call is in flight; ask to stop, then let it finish.
    engine.stop(run.id);
    release();
    await engine.settled(run.id);
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("userStopped");
    expect(calls).toBe(1); // never started a second iteration
  });
});
