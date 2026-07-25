import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { isLoopRunTerminal, type LoopRun } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Loop run engine end-to-end against real pi: POST /loops/:name/run drives the
 * loop's agent (a real pi subagent, mock provider) each iteration and runs the
 * validation command. `exit 0` completes after one iteration; `exit 1` runs to
 * maxIterations then fails — the exit code is the deterministic stop control.
 */

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;
let base: string;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const project = mkdtempSync(path.join(tmpdir(), "pi-loops-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

beforeAll(async () => {
  const agentsDir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "Maker.md"),
    "---\nname: Maker\ntools: read, grep, bash, edit, write\n---\nMake the requested change.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Checker.md"),
    "---\nname: Checker\ntools: read, grep, bash, edit, write\n---\nReview only.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Agent A.md"),
    "---\nname: Agent A\ntools: read, grep, bash, edit, write\n---\nRun stage A.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Agent B.md"),
    "---\nname: Agent B\ntools: read, grep, bash, edit, write\n---\nRun stage B.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Agent C.md"),
    "---\nname: Agent C\ntools: read, grep, bash, edit, write\n---\nRun independent report C.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Triage Agent.md"),
    "---\nname: Triage Agent\ntools: read, grep, bash, edit, write\n---\nClassify discovery evidence.\n",
  );
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    PI_SKIP_VERSION_CHECK: "1",
  });
  mock = await startMockProvider({
    chunkDelayMs: 15,
    reply: (message) => {
      if (message.includes("exact first non-empty line must be APPROVE")) {
        return "APPROVE\nChecker streamed concrete ordered evidence before approving.";
      }
      if (message.includes("exact first non-empty line must be SUCCESS")) {
        return "SUCCESS\nEvaluator streamed independent ordered evidence of completion.";
      }
      if (message.includes("You are performing discovery and triage")) {
        return "# Classification\nCritical release risk streamed with owner evidence and safest next action.";
      }
      if (message.includes("Parallel branch:")) {
        const agent = message.match(/Assigned agent: (Agent [ABC])/)?.[1] ?? "Parallel agent";
        return `${agent} streamed multiple distinct independent report evidence delta words.`;
      }
      if (message.includes("Pipeline stage: 1")) {
        return "Stage A streamed multiple ordered handoff delta words.";
      }
      if (message.includes("Pipeline stage: 2") || message.includes("Pipeline stage: 3")) {
        return "Stage B streamed only after final A handoff evidence arrived.";
      }
      return "Maker streamed several ordered implementation delta words.";
    },
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir });
  base = `http://127.0.0.1:${server.port}`;
  const created = (await (
    await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })
  ).json()) as { project: { id: string } };
  projectId = created.project.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_PI_ENV;
});

async function putLoop(
  name: string,
  validationCommand: string,
  maxIterations: number,
): Promise<void> {
  const res = await fetch(`${base}/loops`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, goal: "Do the work.", validationCommand, maxIterations }),
  });
  expect(res.ok).toBe(true);
}

async function startRun(
  name: string,
  overrides: { goal?: string; launchContext?: string; launchContextScope?: string } = {},
): Promise<string> {
  const catalog = (await (await fetch(`${base}/loops`)).json()) as {
    loops: Array<{ id: string; name: string }>;
  };
  const loop = catalog.loops.find((candidate) => candidate.name === name);
  if (!loop) throw new Error(`missing real-Pi Loop fixture: ${name}`);
  const res = await fetch(`${base}/loops/${encodeURIComponent(loop.id)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
      env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  const { run } = (await res.json()) as { run: LoopRun };
  return run.id;
}

async function getRun(id: string): Promise<LoopRun> {
  const res = await fetch(`${base}/loops/runs/${id}`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { run: LoopRun }).run;
}

async function waitTerminal(id: string): Promise<LoopRun> {
  await expect
    .poll(async () => (await getRun(id)).status, { timeout: 60_000, interval: 200 })
    .toSatisfy(isLoopRunTerminal);
  return getRun(id);
}

describe("loop run engine (real pi)", () => {
  it("records and resolves Human Approval without sending any provider request", async () => {
    const put = await fetch(`${base}/loops`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "human-approval-loop",
        structure: "humanApproval",
        checkpointPrompt: "Review the release proposal.",
        validationCommand: "exit 1",
        writeTarget: "currentCheckout",
      }),
    });
    expect(put.ok).toBe(true);
    const requestStart = mock.requests.length;
    const run = await waitTerminal(await startRun("human-approval-loop"));
    expect(mock.requests).toHaveLength(requestStart);
    expect(run).toMatchObject({
      status: "stopped",
      stopReason: "humanInputRequired",
      checkpointPrompt: "Review the release proposal.",
    });
    expect(run).not.toHaveProperty("launch");
    expect(run.iterations[0]?.children).toEqual([]);
    expect(run.iterations.flatMap((iteration) => iteration.artifacts)).toHaveLength(1);
    expect(run.iterations[0]?.artifacts[0]?.filename).toBe("human-approval-checkpoint.md");
    const resolution = await fetch(`${base}/loops/runs/${run.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", expectedUpdatedAt: run.updatedAt }),
    });
    expect(resolution.ok).toBe(true);
    const rejected = ((await resolution.json()) as { run: LoopRun }).run;
    expect(rejected.stopReason).toBe("humanRejected");
    expect(rejected.iterations.flatMap((iteration) => iteration.artifacts)).toHaveLength(1);
    expect(mock.requests).toHaveLength(requestStart);
  });

  it("injects first/every launch context through real Pi while preserving ordered deltas", async () => {
    for (const scope of ["firstIterationOnly", "everyIteration"] as const) {
      const marker = `context-${scope}.marker`;
      const command = `node -e "const fs=require('fs');if(fs.existsSync('${marker}'))process.exit(0);fs.writeFileSync('${marker}','1');process.exit(1)"`;
      await putLoop(`context-${scope}`, command, 3);
      const requestStart = mock.requests.length;
      const run = await waitTerminal(
        await startRun(`context-${scope}`, {
          goal: `Override goal ${scope}`,
          launchContext: `UNIQUE_CONTEXT_${scope}`,
          launchContextScope: scope,
        }),
      );
      expect(run.iterations).toHaveLength(2);
      expect(run.definitionSnapshot).toMatchObject({
        goal: `Override goal ${scope}`,
        launchContext: `UNIQUE_CONTEXT_${scope}`,
        launchContextScope: scope,
      });
      const requests = mock.requests.slice(requestStart);
      const contextRequests = requests.filter((request) =>
        JSON.stringify(request.messages).includes(`UNIQUE_CONTEXT_${scope}`),
      );
      expect(contextRequests).toHaveLength(scope === "everyIteration" ? 2 : 1);
      for (
        let requestIndex = requestStart;
        requestIndex < mock.requests.length;
        requestIndex += 1
      ) {
        expect(
          mock.events.filter(
            (event) => event.requestIndex === requestIndex && event.kind === "delta",
          ).length,
        ).toBeGreaterThan(2);
      }
    }
  });

  it("completes after one iteration when validation passes (exit 0)", async () => {
    await putLoop("pass-loop", "exit 0", 5);
    const run = await waitTerminal(await startRun("pass-loop"));
    expect(run.status).toBe("completed");
    expect(run.stopReason).toBe("success");
    expect(run.iterations).toHaveLength(1);
    expect(run.iterations[0]).toMatchObject({ index: 1, validationPassed: true });
    // The agent actually ran (a real pi subagent produced output).
    expect(run.iterations[0]!.output.length).toBeGreaterThan(0);
  });

  it("streams real Pi maker, checker, and evaluator sequentially before finalization", async () => {
    const put = await fetch(`${base}/loops`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "maker-checker-loop",
        goal: "Deliver reviewed work.",
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "Require concrete evidence.",
        validationCommand: "exit 0",
        maxIterations: 2,
      }),
    });
    expect(put.ok).toBe(true);
    const requestStart = mock.requests.length;
    const run = await waitTerminal(await startRun("maker-checker-loop"));
    expect(run.status).toBe("completed");
    expect(run.iterations[0]).toMatchObject({
      checkerDecision: "APPROVE",
      goalDecision: "SUCCESS",
      validationPassed: true,
    });
    const phases = run.iterations[0]!.timeline.map((event) => event.phase);
    expect(phases.indexOf("maker")).toBeLessThan(phases.indexOf("checker"));
    expect(phases.indexOf("checker")).toBeLessThan(phases.indexOf("validation"));
    expect(phases.indexOf("validation")).toBeLessThan(phases.indexOf("evaluator"));
    const prompts = mock.requests
      .slice(requestStart)
      .map((request) => request.messages.at(-1)?.content);
    expect(JSON.stringify(prompts)).toMatch(
      /maker.*exact first non-empty line must be APPROVE.*exact first non-empty line must be SUCCESS/is,
    );
    expect(
      run.iterations[0]!.children.every((child) => (child.output?.split(" ").length ?? 0) > 3),
    ).toBe(true);
    const roleRequests = mock.requests.slice(requestStart);
    const toolsFor = (needle: string): string[] => {
      const request = roleRequests.find((item) =>
        JSON.stringify(item.messages.at(-1)?.content).includes(needle),
      );
      const tools = Array.isArray(request?.tools) ? request.tools : [];
      return tools.flatMap((tool) => {
        if (!tool || typeof tool !== "object") return [];
        const fn = (tool as { function?: { name?: unknown } }).function;
        return typeof fn?.name === "string" ? [fn.name] : [];
      });
    };
    expect(toolsFor("You are the maker")).toEqual(["read", "grep"]);
    expect(toolsFor("Review only")).toEqual(["read", "grep"]);
    expect(toolsFor("Evaluate only")).toEqual([]);
    const artifacts = run.iterations[0]!.artifacts;
    expect(artifacts.map((artifact) => artifact.phase)).toEqual(["maker", "checker", "evaluator"]);
    for (const artifact of artifacts) {
      expect(artifact.filePath.startsWith(project + path.sep)).toBe(false);
      expect(existsSync(artifact.filePath)).toBe(true);
    }
  });

  it("streams real Pi Pipeline stages in strict order before evaluator finalization", async () => {
    const put = await fetch(`${base}/loops`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "pipeline-loop",
        goal: "Deliver ordered staged work.",
        structure: "agentPipeline",
        pipelineStages: ["Agent A", "Agent A", "Agent B"],
        validationCommand: "exit 0",
        writeTarget: "artifactMarkdown",
        maxIterations: 2,
      }),
    });
    expect(put.ok).toBe(true);
    const requestStart = mock.requests.length;
    const run = await waitTerminal(await startRun("pipeline-loop"));
    expect(run.status).toBe("completed");
    expect(run.iterations[0]!.pipelineStageOutputs?.map((stage) => stage.agentName)).toEqual([
      "Agent A",
      "Agent A",
      "Agent B",
    ]);
    expect(run.iterations[0]!.children.map((child) => child.phase)).toEqual([
      "stage",
      "stage",
      "stage",
      "evaluator",
    ]);
    expect(
      run.iterations[0]!.children.every((child) => (child.output?.split(" ").length ?? 0) > 4),
    ).toBe(true);
    const prompts = mock.requests
      .slice(requestStart)
      .map((request) => JSON.stringify(request.messages.at(-1)?.content));
    const firstA = prompts.findIndex((prompt) => prompt.includes("Pipeline stage: 1"));
    const secondA = prompts.findIndex((prompt) => prompt.includes("Pipeline stage: 2"));
    const stageB = prompts.findIndex((prompt) => prompt.includes("Pipeline stage: 3"));
    expect(firstA).toBeGreaterThanOrEqual(0);
    expect(firstA).toBeLessThan(secondA);
    expect(secondA).toBeLessThan(stageB);
    expect(prompts[stageB]).toContain("Stage 1 (Agent A) report");
    expect(prompts[stageB]).toContain("Stage 2 (Agent A) report");
    const firstRequestIndex = requestStart + firstA;
    const secondRequestIndex = requestStart + secondA;
    const stageBRequestIndex = requestStart + stageB;
    expect(
      mock.events.filter(
        (event) => event.requestIndex === firstRequestIndex && event.kind === "delta",
      ).length,
    ).toBeGreaterThan(2);
    expect(
      mock.events.filter(
        (event) => event.requestIndex === secondRequestIndex && event.kind === "delta",
      ).length,
    ).toBeGreaterThan(2);
    const secondAFinal = mock.events.findIndex(
      (event) => event.requestIndex === secondRequestIndex && event.kind === "done",
    );
    const stageBStarted = mock.events.findIndex(
      (event) => event.requestIndex === stageBRequestIndex && event.kind === "request",
    );
    expect(secondAFinal).toBeGreaterThanOrEqual(0);
    expect(secondAFinal).toBeLessThan(stageBStarted);
    const stageRequests = mock.requests
      .slice(requestStart)
      .filter((request) =>
        JSON.stringify(request.messages.at(-1)?.content).includes("Pipeline stage:"),
      );
    for (const request of stageRequests) {
      const names = (Array.isArray(request.tools) ? request.tools : []).flatMap((tool) => {
        const fn =
          tool && typeof tool === "object"
            ? (tool as { function?: { name?: unknown } }).function
            : undefined;
        return typeof fn?.name === "string" ? [fn.name] : [];
      });
      expect(names).toEqual(["read", "grep"]);
    }
    expect(run.iterations[0]!.artifacts.map((artifact) => artifact.filename)).toEqual([
      "iteration-1-stage-1.md",
      "iteration-1-stage-2.md",
      "iteration-1-stage-3.md",
      "iteration-1-evaluator.md",
    ]);
    expect(
      run.iterations[0]!.artifacts.every(
        (artifact) =>
          !artifact.filePath.startsWith(project + path.sep) && existsSync(artifact.filePath),
      ),
    ).toBe(true);
  });

  it("streams overlapping real Pi Parallel branches with max two and ordered aggregation", async () => {
    const put = await fetch(`${base}/loops`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "parallel-loop",
        goal: "Investigate three independent reports.",
        structure: "parallelAgents",
        parallelBranches: ["Agent A", "Agent B", "Agent C"],
        validationCommand: "exit 0",
        writeTarget: "artifactMarkdown",
        maxIterations: 2,
      }),
    });
    expect(put.ok).toBe(true);
    const requestStart = mock.requests.length;
    const runId = await startRun("parallel-loop");
    const launched = await getRun(runId);
    expect(launched.iterations[0]!.children.map((child) => child.status)).toEqual([
      "running",
      "running",
      "queued",
    ]);
    const parentId = launched.launch!.sessionId;
    let overlappingCellIds: string[] = [];
    await expect
      .poll(
        () => {
          const parent = server.sessions.get(parentId);
          const cells =
            parent?.snapshot().state.cells.filter((cell) => cell.kind === "subagent") ?? [];
          overlappingCellIds = cells
            .filter((cell) => cell.status === "running")
            .map((cell) => cell.id);
          return overlappingCellIds.length;
        },
        { timeout: 10_000, interval: 10 },
      )
      .toBe(2);
    expect(new Set(overlappingCellIds).size).toBe(2);

    const run = await waitTerminal(runId);
    expect(run.status).toBe("completed");
    expect(run.iterations[0]!.parallelBranchOutputs?.map((branch) => branch.agentName)).toEqual([
      "Agent A",
      "Agent B",
      "Agent C",
    ]);
    expect(run.iterations[0]!.children.map((child) => child.phase)).toEqual([
      "branch",
      "branch",
      "branch",
      "evaluator",
    ]);
    expect(run.iterations[0]!.children.map((child) => child.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(new Set(run.iterations[0]!.children.map((child) => child.id)).size).toBe(4);

    const branchRequests = mock.requests
      .slice(requestStart)
      .map((request, offset) => ({
        absoluteIndex: requestStart + offset,
        request,
        prompt: JSON.stringify(request.messages.at(-1)?.content),
      }))
      .filter(({ prompt }) => prompt.includes("Parallel branch:"));
    expect(branchRequests).toHaveLength(3);
    const [first, second, third] = branchRequests;
    const firstDonePosition = mock.events.findIndex(
      (event) =>
        event.kind === "done" &&
        (event.requestIndex === first!.absoluteIndex ||
          event.requestIndex === second!.absoluteIndex),
    );
    const thirdRequestPosition = mock.events.findIndex(
      (event) => event.kind === "request" && event.requestIndex === third!.absoluteIndex,
    );
    expect(firstDonePosition).toBeGreaterThanOrEqual(0);
    expect(thirdRequestPosition).toBeGreaterThan(firstDonePosition);
    for (const branch of branchRequests) {
      expect(
        mock.events.filter(
          (event) => event.requestIndex === branch.absoluteIndex && event.kind === "delta",
        ).length,
      ).toBeGreaterThan(4);
      const tools = (Array.isArray(branch.request.tools) ? branch.request.tools : []).flatMap(
        (tool) => {
          const fn =
            tool && typeof tool === "object"
              ? (tool as { function?: { name?: unknown } }).function
              : undefined;
          return typeof fn?.name === "string" ? [fn.name] : [];
        },
      );
      expect(tools).toEqual(["read", "grep"]);
    }
    const beforeFirstDone = mock.events.slice(0, firstDonePosition);
    expect(
      new Set(
        beforeFirstDone
          .filter(
            (event) =>
              event.kind === "delta" &&
              (event.requestIndex === first!.absoluteIndex ||
                event.requestIndex === second!.absoluteIndex),
          )
          .map((event) => event.requestIndex),
      ).size,
    ).toBe(2);

    const evaluator = mock.requests
      .slice(requestStart)
      .find((request) =>
        JSON.stringify(request.messages.at(-1)?.content).includes(
          "Parallel branch reports in configured order",
        ),
      );
    const evaluatorPrompt = JSON.stringify(evaluator?.messages.at(-1)?.content);
    expect(evaluatorPrompt).toMatch(/- Agent A:.*- Agent B:.*- Agent C:/s);
    expect(Array.isArray(evaluator?.tools) ? evaluator.tools : []).toEqual([]);
    expect(run.iterations[0]!.artifacts.map((artifact) => artifact.filename)).toEqual([
      "iteration-1-branch-1.md",
      "iteration-1-branch-2.md",
      "iteration-1-branch-3.md",
      "iteration-1-evaluator.md",
    ]);
    expect(
      run.iterations[0]!.artifacts.every(
        (artifact) =>
          !artifact.filePath.startsWith(project + path.sep) && existsSync(artifact.filePath),
      ),
    ).toBe(true);
  });

  it("streams the configured real Pi Discovery/Triage agent before no-tools evaluation", async () => {
    const classificationPrompt =
      "Classify by severity and user impact.\nAssign an owner with evidence.\nRecommend the safest next action.";
    const put = await fetch(`${base}/loops`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "triage-loop",
        goal: "Discover and classify release risks without implementing fixes.",
        structure: "discoveryTriage",
        triageAgent: "Triage Agent",
        classificationPrompt,
        validationCommand: "exit 0",
        writeTarget: "artifactMarkdown",
        maxIterations: 2,
      }),
    });
    expect(put.ok).toBe(true);
    const requestStart = mock.requests.length;
    const run = await waitTerminal(await startRun("triage-loop"));
    expect(run).toMatchObject({ status: "completed", stopReason: "success" });
    expect(run.iterations[0]).toMatchObject({
      classificationOutput: expect.stringContaining("Critical release risk"),
      validationPassed: true,
      goalDecision: "SUCCESS",
    });
    expect(run.iterations[0]!.children).toMatchObject([
      { phase: "triage", agentName: "Triage Agent", status: "completed" },
      { phase: "evaluator", status: "completed" },
    ]);
    const roleRequests = mock.requests.slice(requestStart);
    const triageOffset = roleRequests.findIndex((request) =>
      JSON.stringify(request.messages.at(-1)?.content).includes(
        "You are performing discovery and triage",
      ),
    );
    const evaluatorOffset = roleRequests.findIndex((request) =>
      JSON.stringify(request.messages.at(-1)?.content).includes(
        "Evaluate the discovery and classification report only",
      ),
    );
    expect(triageOffset).toBeGreaterThanOrEqual(0);
    expect(triageOffset).toBeLessThan(evaluatorOffset);
    const triagePrompt = JSON.stringify(roleRequests[triageOffset]!.messages.at(-1)?.content);
    expect(triagePrompt).toContain(classificationPrompt.replaceAll("\n", " "));
    expect(triagePrompt).toContain(
      "Do not implement fixes unless the loop goal explicitly asks you to",
    );
    const triageRequestIndex = requestStart + triageOffset;
    expect(
      mock.events.filter(
        (event) => event.requestIndex === triageRequestIndex && event.kind === "delta",
      ).length,
    ).toBeGreaterThan(4);
    const triageTools = (
      Array.isArray(roleRequests[triageOffset]!.tools) ? roleRequests[triageOffset]!.tools : []
    ).flatMap((tool) => {
      const fn =
        tool && typeof tool === "object"
          ? (tool as { function?: { name?: unknown } }).function
          : undefined;
      return typeof fn?.name === "string" ? [fn.name] : [];
    });
    expect(triageTools).toEqual(["read", "grep"]);
    expect(
      Array.isArray(roleRequests[evaluatorOffset]!.tools)
        ? roleRequests[evaluatorOffset]!.tools
        : [],
    ).toEqual([]);
    expect(run.iterations[0]!.artifacts.map((artifact) => artifact.filename)).toEqual([
      "iteration-1-triage.md",
      "iteration-1-evaluator.md",
    ]);
  });

  it("runs every iteration then fails when validation never passes (exit 1)", async () => {
    await putLoop("fail-loop", "exit 1", 2);
    const run = await waitTerminal(await startRun("fail-loop"));
    expect(run.status).toBe("failed");
    expect(run.stopReason).toBe("validationFailedAfterFinalIteration");
    expect(run.iterations).toHaveLength(2);
    expect(run.iterations.every((i) => i.validationPassed === false)).toBe(true);
  });

  it("runs in an isolated git worktree (writeTarget newWorktree), keeping the branch", async () => {
    // A git repo project — `git worktree add` needs a repo with a branch.
    const gitProject = mkdtempSync(path.join(tmpdir(), "pi-loop-wt-"));
    const git = (args: string[]): void => void execFileSync("git", args, { cwd: gitProject });
    execFileSync("git", ["init", "-b", "main", gitProject]);
    git(["config", "user.email", "t@t.local"]);
    git(["config", "user.name", "T"]);
    writeFileSync(path.join(gitProject, "README.md"), "# x\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    const wtProjectId = (
      (await (
        await fetch(`${base}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: gitProject }),
        })
      ).json()) as { project: { id: string } }
    ).project.id;

    await fetch(`${base}/loops`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "wt-loop",
        goal: "Do the work.",
        structure: "agentPipeline",
        pipelineStages: ["Agent A", "Agent B"],
        validationCommand: "exit 0",
        maxIterations: 2,
        writeTarget: "newWorktree",
      }),
    });

    const wtCatalog = (await (await fetch(`${base}/loops`)).json()) as {
      loops: Array<{ id: string; name: string }>;
    };
    const wtLoop = wtCatalog.loops.find((candidate) => candidate.name === "wt-loop")!;
    const runRes = await fetch(`${base}/loops/${encodeURIComponent(wtLoop.id)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: wtProjectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(runRes.status).toBe(201);
    const { run, worktree } = (await runRes.json()) as {
      run: LoopRun;
      worktree: { path: string; branch: string; sourceBranch: string } | null;
    };
    expect(worktree).toBeTruthy();
    expect(
      worktree!.path.startsWith(
        realpathSync.native(path.join(dataDir, "session-worktrees", "loop")) + path.sep,
      ),
    ).toBe(true);
    expect(worktree!.branch).toMatch(/^agent-deck\/loop-/);
    expect(worktree!.sourceBranch).toBe("main");

    const final = await waitTerminal(run.id);
    expect(final.status).toBe("completed");

    // The registered worktree and branch are retained as durable review evidence.
    const branches = execFileSync("git", ["branch", "--list"], {
      cwd: gitProject,
      encoding: "utf8",
    });
    expect(branches).toContain(worktree!.branch);
    await expect.poll(() => existsSync(worktree!.path), { timeout: 15_000 }).toBe(true);
    const registered = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: gitProject,
      encoding: "utf8",
    });
    expect(registered).toContain(`worktree ${worktree!.path}`);
    expect(registered).toContain(`branch refs/heads/${worktree!.branch}`);
  });
});
