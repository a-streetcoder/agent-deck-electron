import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cwd } from "node:process";
import {
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  type LoopChildRecord,
  type LoopDefinition,
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
  it("rejects unsupported humanApproval before allocating a run or invoking its executor", () => {
    let calls = 0;
    const engine = new LoopEngine({
      executeAgent: async () => {
        calls += 1;
        return "must not run";
      },
    });

    expect(() => engine.start(makeLoop({ structure: "humanApproval" }), cwd())).toThrow(
      expect.objectContaining({
        code: LOOP_STRUCTURE_UNSUPPORTED_CODE,
        structure: "humanApproval",
      }),
    );
    expect(calls).toBe(0);
    expect(engine.list()).toEqual([]);
  });

  it("runs configured Discovery/Triage with exact prompt, bounded evidence, artifacts, and lifecycle", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-triage-data-"));
    const requests: Array<{ phase: string; agentName?: string; prompt: string }> = [];
    let validationCalls = 0;
    const firstClassification = `# Classification\n${"evidence ".repeat(2_000)}`;
    const engine = new LoopEngine({
      dataDir,
      runValidation: async () => {
        validationCalls += 1;
        return { passed: validationCalls === 2, evidence: `validation-${validationCalls}` };
      },
      executeRole: async ({ phase, agentName, prompt }) => {
        requests.push({ phase, agentName, prompt });
        if (phase === "triage") {
          return requests.filter((request) => request.phase === "triage").length === 1
            ? firstClassification
            : "# Classification\nresolved";
        }
        return validationCalls === 1 ? "CONTINUE\nMore evidence needed" : "SUCCESS\nClassified";
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "discoveryTriage",
        triageAgent: "Explorer",
        classificationPrompt: "Severity and impact\nOwner and safest next action",
        maxIterations: 2,
      }),
      cwd(),
    );
    await engine.settled(run.id);

    expect(run.status).toBe("completed");
    expect(run.iterations).toHaveLength(2);
    expect(run.iterations[0]).toMatchObject({
      classificationOutput: firstClassification,
      validationPassed: false,
      goalDecision: "CONTINUE",
    });
    expect(run.iterations[0]!.children).toMatchObject([
      { phase: "triage", agentName: "Explorer", status: "completed" },
      { phase: "evaluator", status: "completed" },
    ]);
    expect(run.iterations[0]!.timeline.map((event) => event.phase)).toEqual([
      "triage",
      "triage",
      "triage",
      "validation",
      "validation",
      "evaluator",
      "evaluator",
      "evaluator",
    ]);
    expect(run.iterations[0]!.artifacts.map((artifact) => artifact.filename)).toEqual([
      "iteration-1-triage.md",
      "iteration-1-evaluator.md",
    ]);
    const triageRequests = requests.filter((request) => request.phase === "triage");
    expect(triageRequests.map((request) => request.agentName)).toEqual(["Explorer", "Explorer"]);
    expect(triageRequests[0]!.prompt).toContain("Loop goal: do the thing");
    expect(triageRequests[0]!.prompt).toContain(
      "Classification prompt: Severity and impact Owner and safest next action",
    );
    expect(triageRequests[0]!.prompt).toContain(
      "Do not implement fixes unless the loop goal explicitly asks you to",
    );
    expect(triageRequests[0]!.prompt).toContain(
      path.join(dataDir, "loop-artifacts", run.id, "iteration-1-triage.md"),
    );
    expect(triageRequests[1]!.prompt).toContain("validation-1");
    expect(triageRequests[1]!.prompt).toContain("CONTINUE\nMore evidence needed");
    expect(triageRequests[1]!.prompt.length).toBeLessThan(15_000);
    expect(readFileSync(run.iterations[0]!.artifacts[0]!.filePath, "utf8")).toBe(
      firstClassification,
    );
  });

  it.each([
    ["artifactMarkdown", "report-only discovery. Do not edit project files"],
    ["currentCheckout", "selected current checkout"],
    ["newWorktree", "selected isolated worktree"],
  ] as const)(
    "gives Discovery/Triage truthful %s write instructions",
    async (writeTarget, text) => {
      let triagePrompt = "";
      const engine = new LoopEngine({
        executeRole: async ({ phase, prompt }) => {
          if (phase === "triage") {
            triagePrompt = prompt;
            return "classified";
          }
          return "SUCCESS\nDone";
        },
      });
      const run = engine.start(
        makeLoop({
          structure: "discoveryTriage",
          triageAgent: "Explorer",
          classificationPrompt: "Classify",
          validationCommand: "",
          writeTarget,
        }),
        cwd(),
      );
      await engine.settled(run.id);
      expect(run.status).toBe("completed");
      expect(triagePrompt).toContain(text);
      expect(triagePrompt).toContain(
        writeTarget === "artifactMarkdown"
          ? "Do not implement fixes unless the loop goal explicitly asks you to"
          : "only when the loop goal explicitly requests implementation",
      );
    },
  );

  it("applies Discovery/Triage role, validation, and evaluator failure policy", async () => {
    let validationAfterRoleFailure = 0;
    const roleFailure = new LoopEngine({
      runValidation: async () => {
        validationAfterRoleFailure += 1;
        return true;
      },
      executeRole: async ({ phase }) => {
        if (phase === "triage") throw new Error("triage unavailable");
        throw new Error("evaluator must not run");
      },
    });
    const roleFailed = roleFailure.start(
      makeLoop({
        structure: "discoveryTriage",
        triageAgent: "Explorer",
        classificationPrompt: "Classify",
      }),
      cwd(),
    );
    await roleFailure.settled(roleFailed.id);
    expect(roleFailed).toMatchObject({ status: "failed", stopReason: "agentFailed" });
    expect(roleFailed.iterations[0]!.children).toMatchObject([
      { phase: "triage", status: "failed", error: "triage unavailable" },
    ]);
    expect(validationAfterRoleFailure).toBe(0);

    const failedValidation = new LoopEngine({
      runValidation: async () => ({ passed: false, evidence: "exit 1" }),
      executeRole: async ({ phase }) =>
        phase === "triage" ? "classified" : "SUCCESS\nReport is otherwise complete",
    });
    const capped = failedValidation.start(
      makeLoop({
        structure: "discoveryTriage",
        triageAgent: "Explorer",
        classificationPrompt: "Classify",
        maxIterations: 1,
      }),
      cwd(),
    );
    await failedValidation.settled(capped.id);
    expect(capped).toMatchObject({
      status: "notAchieved",
      stopReason: "validationFailedAfterFinalIteration",
    });

    const evaluatorFailure = new LoopEngine({
      executeRole: async ({ phase }) => (phase === "triage" ? "classified" : "FAIL\nUnsafe"),
    });
    const failed = evaluatorFailure.start(
      makeLoop({
        structure: "discoveryTriage",
        triageAgent: "Explorer",
        classificationPrompt: "Classify",
      }),
      cwd(),
    );
    await evaluatorFailure.settled(failed.id);
    expect(failed).toMatchObject({ status: "failed", stopReason: "agentFailed" });
  });

  it("stops an in-flight Discovery/Triage child without evaluator or late writes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    const engine = new LoopEngine({
      executeRole: async ({ phase }) => {
        if (phase === "triage") {
          entered = true;
          await gate;
          return "late classification";
        }
        throw new Error("evaluator must not run");
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "discoveryTriage",
        triageAgent: "Explorer",
        classificationPrompt: "Classify",
      }),
      cwd(),
    );
    await expect.poll(() => entered).toBe(true);
    const stopping = engine.stop(run.id);
    release();
    await stopping;
    expect(run).toMatchObject({ status: "stopped", stopReason: "userStopped" });
    expect(run.iterations[0]!.children).toMatchObject([{ phase: "triage", status: "stopped" }]);
    expect(run.iterations[0]!.classificationOutput).toBeUndefined();
    expect(run.iterations[0]!.artifacts).toEqual([]);
  });

  it("rejects unsafe or empty Parallel definitions before allocating a run", () => {
    let calls = 0;
    const engine = new LoopEngine({
      executeRole: async () => {
        calls += 1;
        return "must not run";
      },
    });
    expect(() =>
      engine.start(
        makeLoop({
          structure: "parallelAgents",
          parallelBranches: ["A"],
          writeTarget: "currentCheckout",
        }),
        cwd(),
      ),
    ).toThrow("report-only");
    expect(() =>
      engine.start(
        makeLoop({
          structure: "parallelAgents",
          parallelBranches: ["", "  "],
          writeTarget: "artifactMarkdown",
        }),
        cwd(),
      ),
    ).toThrow("At least one parallel branch agent");
    expect(engine.list()).toEqual([]);
    expect(calls).toBe(0);
  });

  it("persists every Parallel child as stable ordered queued/running records before execution", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-parallel-queue-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const entered: number[] = [];
    const engine = new LoopEngine({
      dataDir,
      executeRole: async ({ phase, branchIndex }) => {
        if (phase === "evaluator") return "SUCCESS\nDone";
        entered.push(branchIndex!);
        await gate;
        return `report-${branchIndex}`;
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "parallelAgents",
        parallelBranches: ["A", "B", "C"],
        writeTarget: "artifactMarkdown",
      }),
      cwd(),
    );
    await expect.poll(() => entered).toEqual([0, 1]);
    const children = run.iterations[0]!.children.filter((child) => child.phase === "branch");
    expect(children).toHaveLength(3);
    expect(children.map((child) => child.agentName)).toEqual(["A", "B", "C"]);
    expect(children.map((child) => child.branchIndex)).toEqual([0, 1, 2]);
    expect(children.map((child) => child.status)).toEqual(["running", "running", "queued"]);
    expect(children[2]).toMatchObject({ queuedAt: expect.any(String) });
    expect(children[2]!.startedAt).toBeUndefined();
    const ids = children.map((child) => child.id);
    const persisted = JSON.parse(readFileSync(path.join(dataDir, "loop-runs.json"), "utf8"))[0]
      .iterations[0].children;
    expect(persisted.map((child: LoopChildRecord) => child.status)).toEqual([
      "running",
      "running",
      "queued",
    ]);

    release();
    await engine.settled(run.id);
    expect(children.map((child) => child.id)).toEqual(ids);
    expect(children.map((child) => child.status)).toEqual(["completed", "completed", "completed"]);
    expect(run.iterations[0]!.parallelBranchOutputs?.map((branch) => branch.id)).toEqual(ids);
  });

  it("overlaps Parallel branches with a hard maximum of two and aggregates in configured order", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-parallel-data-"));
    const project = mkdtempSync(path.join(tmpdir(), "loop-parallel-project-"));
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    let evaluatorPrompt = "";
    const engine = new LoopEngine({
      dataDir,
      executeRole: async ({ phase, branchIndex, prompt }) => {
        if (phase === "evaluator") {
          evaluatorPrompt = prompt;
          return "SUCCESS\nAll reports complete";
        }
        const index = branchIndex!;
        starts.push(index);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, index % 2 === 0 ? 30 : 5));
        active -= 1;
        return `report-${index}`;
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "parallelAgents",
        parallelBranches: ["A", "B", "C", "D", "E"],
        writeTarget: "artifactMarkdown",
        validationCommand: "",
      }),
      project,
    );
    await engine.settled(run.id);

    expect(run).toMatchObject({ status: "completed", stopReason: "success" });
    expect(maxActive).toBe(2);
    expect(starts).toEqual([0, 1, 2, 3, 4]);
    const iteration = run.iterations[0]!;
    expect(iteration.parallelBranchOutputs?.map((branch) => branch.agentName)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    expect(iteration.output.split("\n")).toEqual([
      "- A: report-0",
      "- B: report-1",
      "- C: report-2",
      "- D: report-3",
      "- E: report-4",
    ]);
    expect(evaluatorPrompt.indexOf("- A: report-0")).toBeLessThan(
      evaluatorPrompt.indexOf("- B: report-1"),
    );
    expect(new Set(iteration.children.map((child) => child.id)).size).toBe(6);
    expect(
      iteration.children
        .filter((child) => child.phase === "branch")
        .map((child) => child.branchIndex),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(iteration.artifacts.map((artifact) => artifact.filename)).toEqual([
      "iteration-1-branch-1.md",
      "iteration-1-branch-2.md",
      "iteration-1-branch-3.md",
      "iteration-1-branch-4.md",
      "iteration-1-branch-5.md",
      "iteration-1-evaluator.md",
    ]);
    expect(
      iteration.artifacts.every(
        (artifact) =>
          !artifact.filePath.startsWith(project + path.sep) &&
          artifact.filePath.startsWith(path.join(dataDir, "loop-artifacts") + path.sep),
      ),
    ).toBe(true);
    expect(
      new LoopEngine({ dataDir })
        .get(run.id)
        ?.iterations[0]?.parallelBranchOutputs?.map((branch) => branch.agentName),
    ).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("matches native partial failure: settles every Parallel branch, evaluates evidence, then fails", async () => {
    const calls: string[] = [];
    const engine = new LoopEngine({
      executeRole: async ({ phase, agentName }) => {
        calls.push(`${phase}:${agentName ?? ""}`);
        if (phase === "branch" && agentName === "B") throw new Error("B failed");
        if (phase === "evaluator") return "SUCCESS\nOther evidence is useful";
        return `${agentName} report`;
      },
      runValidation: async () => {
        calls.push("validation:");
        return { passed: true, evidence: "validation green" };
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "parallelAgents",
        parallelBranches: ["A", "B", "C"],
        writeTarget: "artifactMarkdown",
        validationCommand: "test",
      }),
      cwd(),
    );
    await engine.settled(run.id);

    expect(calls).toEqual(["branch:A", "branch:B", "branch:C", "validation:", "evaluator:"]);
    expect(run).toMatchObject({ status: "failed", stopReason: "agentFailed" });
    expect(run.iterations[0]).toMatchObject({
      validationPassed: true,
      goalDecision: "SUCCESS",
      parallelBranchOutputs: [
        { branchIndex: 0, agentName: "A", output: "A report" },
        { branchIndex: 1, agentName: "B", error: "B failed" },
        { branchIndex: 2, agentName: "C", output: "C report" },
      ],
    });
  });

  it("cancels all active Parallel branches, awaits cleanup, and prevents post-terminal mutation", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "loop-parallel-stop-"));
    const started: number[] = [];
    let cancelCalls = 0;
    const engine = new LoopEngine({
      dataDir,
      executeRole: async ({ phase, branchIndex, signal }) => {
        if (phase === "evaluator") return "SUCCESS";
        started.push(branchIndex!);
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "parallelAgents",
        parallelBranches: ["A", "B", "C"],
        writeTarget: "artifactMarkdown",
      }),
      cwd(),
      { cancel: async () => void (cancelCalls += 1) },
    );
    await expect.poll(() => started).toEqual([0, 1]);
    await engine.stop(run.id);
    expect(run).toMatchObject({ status: "stopped", stopReason: "userStopped" });
    expect(started).toEqual([0, 1]);
    expect(cancelCalls).toBe(1);
    expect(run.iterations[0]!.children.map((child) => child.status)).toEqual([
      "stopped",
      "stopped",
      "stopped",
    ]);
    expect(run.iterations[0]!.children[2]!.startedAt).toBeUndefined();
    expect(run.iterations[0]!.children[2]!.endedAt).toBeDefined();
    expect(run.iterations[0]!.artifacts).toEqual([]);
    expect(
      JSON.parse(
        readFileSync(path.join(dataDir, "loop-runs.json"), "utf8"),
      )[0].iterations[0].children.map((child: LoopChildRecord) => child.status),
    ).toEqual(["stopped", "stopped", "stopped"]);
    const terminal = JSON.stringify(run);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(JSON.stringify(run)).toBe(terminal);
  });

  it("runs Pipeline A → A → B in exact order with distinct identities and bounded handoffs", async () => {
    const calls: Array<{ phase: string; agentName?: string; prompt: string }> = [];
    const engine = new LoopEngine({
      executeRole: async ({ phase, agentName, prompt }) => {
        calls.push({ phase, agentName, prompt });
        if (phase === "evaluator") return "SUCCESS\nPipeline complete";
        return agentName === "Agent A" && calls.length === 1
          ? "x".repeat(20_000)
          : `${agentName} report`;
      },
      runValidation: async () => {
        calls.push({ phase: "validation", prompt: "" });
        return { passed: true, evidence: "validation green" };
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "agentPipeline",
        pipelineStages: ["Agent A", "Agent A", "Agent B"],
        validationCommand: "test",
      }),
      cwd(),
    );
    await engine.settled(run.id);

    expect(calls.map(({ phase, agentName }) => `${phase}:${agentName ?? ""}`)).toEqual([
      "stage:Agent A",
      "stage:Agent A",
      "stage:Agent B",
      "validation:",
      "evaluator:",
    ]);
    const iteration = run.iterations[0]!;
    expect(iteration.pipelineStageOutputs?.map((stage) => stage.agentName)).toEqual([
      "Agent A",
      "Agent A",
      "Agent B",
    ]);
    expect(
      new Set(
        iteration.children.filter((child) => child.phase === "stage").map((child) => child.id),
      ).size,
    ).toBe(3);
    expect(
      iteration.children
        .filter((child) => child.phase === "stage")
        .map((child) => child.stageIndex),
    ).toEqual([0, 1, 2]);
    expect(calls[2]!.prompt).toContain("Stage 1 (Agent A) report");
    expect(calls[2]!.prompt).toContain("Stage 2 (Agent A) report");
    expect(calls[2]!.prompt.length).toBeLessThan(13_000);
    expect(run).toMatchObject({ status: "completed", stopReason: "success" });
  });

  it("uses evaluator plus validation policy and carries prior-iteration evidence forward", async () => {
    let iteration = 0;
    const firstStagePrompts: string[] = [];
    const engine = new LoopEngine({
      executeRole: async ({ phase, stageIndex, prompt }) => {
        if (phase === "stage") {
          if (stageIndex === 0) {
            iteration += 1;
            firstStagePrompts.push(prompt);
          }
          return `stage report iteration ${iteration}`;
        }
        return iteration === 1 ? "CONTINUE\nNeed another pass" : "SUCCESS\nDone";
      },
      runValidation: async () => ({
        passed: iteration === 2,
        evidence: iteration === 1 ? "tests failed first" : "tests green",
      }),
    });
    const run = engine.start(
      makeLoop({
        structure: "agentPipeline",
        pipelineStages: ["A", "B"],
        validationCommand: "test",
        maxIterations: 3,
      }),
      cwd(),
    );
    await engine.settled(run.id);
    expect(run.status).toBe("completed");
    expect(run.iterations.map((item) => item.goalDecision)).toEqual(["CONTINUE", "SUCCESS"]);
    expect(firstStagePrompts[1]).toContain("Need another pass");
    expect(firstStagePrompts[1]).toContain("tests failed first");
  });

  it.each(["FAIL\nUnsafe result", "not a goal decision"])(
    "fails Pipeline closed for evaluator output %s",
    async (evaluatorOutput) => {
      const engine = new LoopEngine({
        executeRole: async ({ phase }) => (phase === "evaluator" ? evaluatorOutput : "report"),
      });
      const run = engine.start(
        makeLoop({ structure: "agentPipeline", pipelineStages: ["A"] }),
        cwd(),
      );
      await engine.settled(run.id);
      expect(run).toMatchObject({ status: "failed", stopReason: "agentFailed" });
    },
  );

  it("does not complete Pipeline on evaluator SUCCESS until configured validation passes", async () => {
    let validationCalls = 0;
    const engine = new LoopEngine({
      executeRole: async ({ phase }) => (phase === "evaluator" ? "SUCCESS\nLooks done" : "report"),
      runValidation: async () => ({
        passed: ++validationCalls === 2,
        evidence: validationCalls === 1 ? "red" : "green",
      }),
    });
    const run = engine.start(
      makeLoop({
        structure: "agentPipeline",
        pipelineStages: ["A"],
        validationCommand: "test",
        maxIterations: 2,
      }),
      cwd(),
    );
    await engine.settled(run.id);
    expect(run.status).toBe("completed");
    expect(run.iterations.map((item) => item.goalDecision)).toEqual(["SUCCESS", "SUCCESS"]);
    expect(run.iterations.map((item) => item.validationPassed)).toEqual([false, true]);
  });

  it("short-circuits Pipeline stage failure before later stages, validation, or evaluator", async () => {
    const phases: string[] = [];
    const engine = new LoopEngine({
      executeRole: async ({ phase, stageIndex }) => {
        phases.push(`${phase}-${stageIndex ?? "e"}`);
        if (phase === "stage" && stageIndex === 1) throw new Error("stage failed");
        return "report";
      },
      runValidation: async () => {
        phases.push("validation");
        return true;
      },
    });
    const run = engine.start(
      makeLoop({ structure: "agentPipeline", pipelineStages: ["A", "A", "B"] }),
      cwd(),
    );
    await engine.settled(run.id);
    expect(phases).toEqual(["stage-0", "stage-1"]);
    expect(run).toMatchObject({ status: "failed", stopReason: "agentFailed" });
  });

  it("stops Pipeline during a stage and at a stage boundary without later work", async () => {
    let stageStarted!: () => void;
    const started = new Promise<void>((resolve) => (stageStarted = resolve));
    const duringPhases: string[] = [];
    const during = new LoopEngine({
      executeRole: async ({ phase, signal }) => {
        duringPhases.push(phase);
        stageStarted();
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    });
    const duringRun = during.start(
      makeLoop({ structure: "agentPipeline", pipelineStages: ["A", "B"] }),
      cwd(),
    );
    await started;
    await during.stop(duringRun.id);
    expect(duringRun.status).toBe("stopped");
    expect(duringPhases).toEqual(["stage"]);

    let boundaryRunId = "";
    const boundaryPhases: string[] = [];
    const boundary = new LoopEngine({
      executeRole: async ({ phase }) => {
        boundaryPhases.push(phase);
        if (phase === "stage") queueMicrotask(() => void boundary.stop(boundaryRunId));
        return "stage report";
      },
    });
    const boundaryRun = boundary.start(
      makeLoop({ structure: "agentPipeline", pipelineStages: ["A", "B"] }),
      cwd(),
    );
    boundaryRunId = boundaryRun.id;
    await boundary.settled(boundaryRun.id);
    expect(boundaryRun.status).toBe("stopped");
    expect(boundaryPhases).toEqual(["stage"]);
  });

  it("stops Pipeline during validation without starting the evaluator", async () => {
    const phases: string[] = [];
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => (validationStarted = resolve));
    const engine = new LoopEngine({
      executeRole: async ({ phase }) => {
        phases.push(phase);
        return phase === "evaluator" ? "SUCCESS" : "report";
      },
      runValidation: async (_cwd, _command, signal) => {
        validationStarted();
        return await new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
    });
    const run = engine.start(
      makeLoop({
        structure: "agentPipeline",
        pipelineStages: ["A", "B"],
        validationCommand: "test",
      }),
      cwd(),
    );
    await started;
    await engine.stop(run.id);
    expect(run).toMatchObject({ status: "stopped", stopReason: "userStopped" });
    expect(phases).toEqual(["stage", "stage"]);
  });

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
    const active = first.start(
      makeLoop({
        structure: "discoveryTriage",
        triageAgent: "Explorer",
        classificationPrompt: "Classify recovery evidence.",
        writeTarget: "currentCheckout",
      }),
      cwd(),
      {
        launch: {
          sessionId: "loop-parent",
          writeTarget: "currentCheckout",
          checkoutLockKey: "/canonical/project",
        },
      },
    );
    expect(JSON.parse(readFileSync(path.join(dataDir, "loop-runs.json"), "utf8"))[0].status).toBe(
      "running",
    );
    const recoveredEngine = new LoopEngine({ dataDir });
    const recovered = recoveredEngine.get(active.id)!;
    expect(recovered).toMatchObject({
      status: "interrupted",
      stopReason: "appInterrupted",
      launch: { sessionId: "loop-parent", checkoutLockKey: "/canonical/project" },
      iterations: [
        {
          children: [
            {
              phase: "triage",
              agentName: "Explorer",
              status: "stopped",
              endedAt: expect.any(String),
            },
          ],
        },
      ],
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
