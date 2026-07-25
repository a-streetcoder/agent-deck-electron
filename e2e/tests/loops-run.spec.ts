import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import type { LoopRun } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
let projectId: string;
const project = mkdtempSync(path.join(tmpdir(), "proj-looprun-"));

async function putLoop(body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${harness.baseUrl}/loops`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
}

test.beforeAll(async () => {
  harness = await startHarness({
    chunkDelayMs: 35,
    reply: (message) => {
      if (message.includes("You are performing discovery and triage")) {
        if (message.includes("Keep triage running")) {
          return `# Classification\n${"slow streamed triage evidence ".repeat(20)}`;
        }
        return "# Classification\nHigh impact finding with owner, evidence, and safest next action.";
      }
      if (message.includes("Parallel branch:")) {
        return "Parallel branch produced detailed independent streamed report evidence.";
      }
      if (message.includes("Pipeline stage:")) {
        return "Pipeline stage produced a detailed ordered streamed handoff report.";
      }
      if (message.includes("exact first non-empty line must be APPROVE")) {
        return "APPROVE\nChecker found concrete passing evidence.";
      }
      if (
        message.includes("report-only natural-language goal evaluator") ||
        message.includes("exact first non-empty line must be SUCCESS")
      ) {
        return "SUCCESS\nGoal evaluator confirmed the requested outcome.";
      }
      return "Maker produced a detailed streamed implementation report.";
    },
  });
  const agentsDir = path.join(harness.piHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "Maker.md"),
    "---\nname: Maker\ntools: read, bash, edit\n---\nMake.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Checker.md"),
    "---\nname: Checker\ntools: read, bash, edit\n---\nCheck.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Agent A.md"),
    "---\nname: Agent A\ntools: read, bash, edit\n---\nRun A.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Agent B.md"),
    "---\nname: Agent B\ntools: read, bash, edit\n---\nRun B.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Agent C.md"),
    "---\nname: Agent C\ntools: read, bash, edit\n---\nRun C.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Triage Agent.md"),
    "---\nname: Triage Agent\ntools: read, bash, edit\n---\nClassify.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Broken Triage.md"),
    "---\nname: Broken Triage\ntools: read\n---\nExercise runtime failure.\n",
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: project });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: project });
  execFileSync("git", ["config", "user.name", "E2E"], { cwd: project });
  writeFileSync(path.join(project, "README.md"), "# Loop E2E\n");
  execFileSync("git", ["add", "README.md"], { cwd: project });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: project });

  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!response.ok) throw new Error(await response.text());
  projectId = ((await response.json()) as { project: { id: string } }).project.id;

  await putLoop({
    name: "Green Suite",
    goal: "Make it pass.",
    agentName: "Agent A",
    validationCommand: "exit 0",
    maxIterations: 3,
  });
  await putLoop({
    name: "Bounded Validation",
    goal: "Capture bounded validation diagnostics.",
    agentName: "Agent A",
    validationCommand: `${process.execPath} -e "process.stdout.write('x'.repeat(20000));process.stderr.write('bounded stderr')"`,
    maxIterations: 1,
  });
  await putLoop({
    name: "Retained Worktree",
    goal: "Produce retained review evidence.",
    agentName: "Agent A",
    validationCommand: "exit 0",
    writeTarget: "newWorktree",
    maxIterations: 1,
  });
  await putLoop({
    name: "Reviewed Report",
    goal: "Produce and review evidence.",
    structure: "makerChecker",
    makerName: "Maker",
    checkerName: "Checker",
    checkerRubric: "Require concrete evidence.",
    validationCommand: "exit 0",
    writeTarget: "artifactMarkdown",
    maxIterations: 2,
  });
  await putLoop({
    name: "Failing Parallel",
    goal: "Surface a branch failure.",
    structure: "parallelAgents",
    parallelBranches: ["Missing Agent", "Agent A"],
    validationCommand: "exit 0",
    writeTarget: "artifactMarkdown",
    maxIterations: 1,
  });
  await putLoop({
    name: "Slow Parallel Stop",
    goal: "Keep independent reports running until stopped.",
    structure: "parallelAgents",
    parallelBranches: ["Agent A", "Agent B", "Agent C"],
    validationCommand: "exit 1",
    writeTarget: "artifactMarkdown",
    maxIterations: 10,
  });
  await putLoop({
    name: "Unavailable Triage",
    goal: "Discover unavailable-agent behavior.",
    structure: "discoveryTriage",
    triageAgent: "Unavailable Explorer",
    classificationPrompt: "",
    validationCommand: "exit 0",
    writeTarget: "artifactMarkdown",
    maxIterations: 1,
  });
  await putLoop({
    name: "Failing Triage",
    goal: "Force triage runtime failure.",
    structure: "discoveryTriage",
    triageAgent: "Broken Triage",
    classificationPrompt: "Classify failure evidence.",
    validationCommand: "exit 0",
    writeTarget: "artifactMarkdown",
    maxIterations: 1,
  });
  await putLoop({
    name: "Slow Triage Stop",
    goal: "Keep triage running until stopped.",
    structure: "discoveryTriage",
    triageAgent: "Triage Agent",
    classificationPrompt: "Classify severity, owner, evidence, and next action.",
    validationCommand: "exit 1",
    writeTarget: "artifactMarkdown",
    maxIterations: 10,
  });
  await putLoop({
    name: "Reject Approval",
    structure: "humanApproval",
    checkpointPrompt: "Reject this unsafe proposal.",
    writeTarget: "newWorktree",
  });
  await putLoop({
    name: "Slow Stop",
    goal: "Keep working until stopped.",
    structure: "agentPipeline",
    pipelineStages: ["Agent A", "Agent B"],
    validationCommand: "exit 1",
    writeTarget: "currentCheckout",
    maxIterations: 10,
  });
});

test.afterAll(async () => {
  await harness.close();
});

async function openLoops(page: Page): Promise<void> {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-loops").click();
}

async function loopId(name: string): Promise<string> {
  const response = await fetch(`${harness.baseUrl}/loops`);
  const data = (await response.json()) as { loops: Array<{ id: string; name: string }> };
  const loop = data.loops.find((candidate) => candidate.name === name);
  if (!loop) throw new Error(`unknown Loop fixture: ${name}`);
  return loop.id;
}

async function launchLoop(
  page: Page,
  name: string,
  overrides: {
    goal?: string;
    context?: string;
    scope?: "firstIterationOnly" | "everyIteration";
  } = {},
): Promise<void> {
  await page.getByTestId(`loop-run-${name}`).click();
  const dialog = page.getByTestId("loop-launch-dialog");
  await expect(dialog).toBeVisible();
  if (overrides.goal !== undefined) await page.getByTestId("loop-launch-goal").fill(overrides.goal);
  if (overrides.context !== undefined)
    await page.getByTestId("loop-launch-context-override").fill(overrides.context);
  if (overrides.scope !== undefined)
    await page.getByTestId("loop-launch-scope-override").selectOption(overrides.scope);
  const confirm = page.getByTestId("loop-launch-confirm");
  const checkoutConfirmation = page.getByTestId("loop-current-checkout-confirmation");
  if (await checkoutConfirmation.count()) {
    await expect(confirm).toBeDisabled();
    await checkoutConfirmation.focus();
    await page.keyboard.press("Space");
    await expect(checkoutConfirmation).toBeChecked();
  }
  await confirm.click();
}

test("authors, duplicates, reloads, and approves an accessible Human Approval checkpoint", async ({
  page,
}) => {
  await openLoops(page);
  await page.getByTestId("new-loop").click();
  await page.getByTestId("loop-name").fill("Release Approval");
  await page.getByTestId("loop-structure").selectOption("humanApproval");
  const prompt = page.getByTestId("loop-checkpoint-prompt");
  await expect(prompt).toBeFocused();
  await prompt.fill("Review release severity and owner.");
  await page.getByTestId("loop-launch-context").fill("saved approval context");
  await page.getByTestId("loop-launch-context-scope").selectOption("everyIteration");
  await page.getByTestId("loop-save").click();
  await page.getByTestId("loop-duplicate-Release Approval").click();
  await page.getByTestId("loop-open-Copy of Release Approval").click();
  await expect(page.getByTestId("loop-checkpoint-prompt")).toHaveValue(
    "Review release severity and owner.",
  );
  await page.getByTestId("loop-cancel").click();

  await launchLoop(page, "Release Approval", {
    context: "run-only approval context",
    scope: "firstIterationOnly",
  });
  await expect(page.getByTestId("loop-human-approval-checkpoint")).toBeVisible();
  await expect(page.getByTestId("loop-checkpoint-question")).toHaveText(
    "Review release severity and owner.",
  );
  await page.reload();
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-human-approval-checkpoint")).toBeVisible();
  await expect(page.getByTestId("loop-open-session")).toHaveCount(0);
  const approve = page.getByTestId("loop-approval-approve");
  await page.route("**/loops/runs/*/resolve", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "The checkpoint changed; reload before deciding." }),
    });
  });
  await approve.click();
  await expect(page.getByTestId("loop-approval-error")).toBeVisible();
  await expect(approve).toBeFocused();
  await page.unroute("**/loops/runs/*/resolve");
  await approve.click();
  const approvedResolution = page.getByTestId("loop-approval-resolution");
  await expect(approvedResolution).toContainText("Approval recorded");
  await expect(approvedResolution).toContainText("Retry creates a fresh linked checkpoint");
  const beforeRetryResponse = await page.request.get(`${harness.baseUrl}/loops/runs`);
  const beforeRetryRuns = (await beforeRetryResponse.json()) as { runs: LoopRun[] };
  const original = beforeRetryRuns.runs
    .filter((candidate) => candidate.loopName === "Release Approval")
    .at(-1)!;
  const releaseId = await loopId("Release Approval");
  expect(
    (
      await page.request.put(`${harness.baseUrl}/loops`, {
        data: {
          id: releaseId,
          name: "Release Approval",
          goal: "edited catalog goal",
          launchContext: "edited catalog context",
        },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.delete(`${harness.baseUrl}/loops`, {
        data: { id: releaseId },
      })
    ).ok(),
  ).toBe(true);
  await expect(page.getByTestId("loop-run-retry")).toBeFocused();
  await page.getByTestId("loop-run-retry").click();
  await expect(page.getByTestId("loop-launch-dialog")).toHaveAccessibleName(
    "Retry Release Approval",
  );
  await page.getByTestId("loop-launch-confirm").click();
  await expect(page.getByTestId("loop-human-approval-checkpoint")).toBeVisible();
  const afterRetryResponse = await page.request.get(`${harness.baseUrl}/loops/runs`);
  const afterRetryRuns = (await afterRetryResponse.json()) as { runs: LoopRun[] };
  expect(afterRetryRuns.runs.find((candidate) => candidate.retryOf === original.id)).toMatchObject({
    definitionSnapshot: {
      launchContext: "run-only approval context",
      launchContextScope: "firstIterationOnly",
    },
  });
  await expect(page.getByTestId("loop-run-history")).toContainText("Approval recorded");
});

test("rejects Human Approval by keyboard and preserves focus on a resolution conflict", async ({
  page,
}) => {
  await openLoops(page);
  await launchLoop(page, "Reject Approval");
  const reject = page.getByTestId("loop-approval-reject");
  await reject.focus();
  await page.route("**/loops/runs/*/resolve", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "The checkpoint changed; reload before deciding." }),
    });
  });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("loop-approval-error")).toHaveAttribute("role", "alert");
  await expect(reject).toBeFocused();
  await page.unroute("**/loops/runs/*/resolve");
  await reject.focus();
  await page.keyboard.press("Enter");
  const rejectedResolution = page.getByTestId("loop-approval-resolution");
  await expect(rejectedResolution).toContainText("Checkpoint rejected");
  await expect(rejectedResolution).toContainText("Work was rejected and stopped");
  await expect(rejectedResolution).not.toContainText("Retry");
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);
  await expect(page.getByTestId("loop-run-dismiss")).toBeFocused();
  await expect(page.getByTestId("loop-approval-approve")).toHaveCount(0);
  const listed = (await (await page.request.get(`${harness.baseUrl}/loops/runs`)).json()) as {
    runs: Array<{ id: string; loopName: string; updatedAt: string }>;
  };
  const rejected = [...listed.runs].reverse().find((run) => run.loopName === "Reject Approval")!;
  const opposite = await page.request.post(`${harness.baseUrl}/loops/runs/${rejected.id}/resolve`, {
    data: { decision: "approve", expectedUpdatedAt: rejected.updatedAt },
  });
  expect(opposite.status()).toBe(409);
  const retryRejected = await page.request.post(
    `${harness.baseUrl}/loops/runs/${rejected.id}/retry`,
  );
  expect(retryRejected.status()).toBe(409);
  expect(await retryRejected.json()).toMatchObject({ code: "loop_retry_unavailable" });
});

test("authors project availability and uses an accessible responsive launch override dialog", async ({
  page,
}) => {
  await page.route("**/resources/agents?projectId=*", async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { agents: Array<Record<string, unknown>> };
    if (new URL(route.request().url()).searchParams.get("projectId") === projectId) {
      data.agents.push({
        name: "Project Only",
        scope: "project",
        filePath: "/fixture/project-only.md",
        body: "Project scoped.",
        systemPromptMode: "replace",
        shadowed: false,
        replacesBuiltin: false,
      });
    }
    await route.fulfill({ response, json: data });
  });
  await openLoops(page);
  await page.getByTestId("loop-open-Green Suite").click();
  const agentSelector = page.getByTestId("loop-agent");
  await expect(agentSelector.locator('option[value="Project Only"]')).toHaveCount(1);
  await agentSelector.press("p");
  await agentSelector.press("p");
  await expect(agentSelector).toHaveValue("Project Only");
  await agentSelector.selectOption("Agent A");
  await page.getByRole("radio", { name: "Selected registered projects" }).check();
  await page.getByTestId("loop-launch-context").fill("saved context");
  await page.getByTestId("loop-launch-context-scope").selectOption("firstIterationOnly");
  const maxIterations = page.getByTestId("loop-max-iterations");
  await expect(maxIterations).toHaveAttribute("step", "1");
  await maxIterations.fill("4.8");
  await expect(maxIterations).toHaveValue("4");
  await maxIterations.fill("1e999");
  await expect(maxIterations).toHaveValue("0");
  await maxIterations.fill("0");
  await page.getByTestId("loop-save").click();
  const row = page.locator('[data-loop-name="Green Suite"]');
  await expect(row).toContainText("Unlimited");
  await expect(row).toContainText("Assigned to 1 project");

  const secondProject = mkdtempSync(path.join(tmpdir(), "proj-looprun-other-"));
  const created = await page.request.post(`${harness.baseUrl}/projects`, {
    data: { path: secondProject },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  await selectProject(page, path.basename(secondProject));
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-unavailable-Green Suite")).toContainText(
    "Assign this Loop to the project",
  );
  await expect(page.getByTestId("loop-run-Green Suite")).toBeDisabled();
  await page.getByTestId("loop-open-Green Suite").click();
  await expect(page.getByTestId("loop-agent").locator('option[value="Project Only"]')).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Cancel" }).click();

  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-loops").click();
  const runButton = page.getByTestId("loop-run-Green Suite");
  await runButton.focus();
  await runButton.click();
  const dialog = page.getByTestId("loop-launch-dialog");
  await expect(dialog).toHaveAccessibleName("Run Green Suite");
  await expect(page.getByTestId("loop-launch-goal")).toBeFocused();
  await expect(dialog).toContainText("No iteration limit");
  await page.setViewportSize({ width: 420, height: 560 });
  await expect
    .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(runButton).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 720 });
  const greenSuiteId = await loopId("Green Suite");
  await page.route(new RegExp(`/loops/${greenSuiteId}/run$`), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await runButton.click();
  await page.getByTestId("loop-launch-goal").fill("Run-only goal override");
  await expect(page.getByTestId("loop-launch-goal")).toHaveValue("Run-only goal override");
  await expect(page.getByTestId("loop-launch-success-condition")).toHaveValue(
    "Run-only goal override",
  );
  await page
    .getByTestId("loop-launch-success-condition")
    .fill("Run-only explicit success condition");
  await page
    .getByTestId("loop-launch-evaluator-model")
    .selectOption(JSON.stringify(["mock", "mock-model"]));
  await page.getByTestId("loop-launch-evaluator-thinking").selectOption("high");
  await page.getByTestId("loop-launch-context-override").fill("RUN_ONLY_CONTEXT");
  await expect(page.getByTestId("loop-launch-context-override")).toHaveValue("RUN_ONLY_CONTEXT");
  await page.getByTestId("loop-launch-scope-override").selectOption("everyIteration");
  const confirm = page.getByTestId("loop-launch-confirm");
  const start = confirm.click();
  await expect(confirm).toHaveText("Starting…");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("loop-launch-dialog")).toBeVisible();
  await start;
  await expect(page.getByTestId("loop-launch-dialog")).toHaveCount(0);
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const response = await page.request.get(`${harness.baseUrl}/loops/runs`);
  const runs = (await response.json()) as { runs: LoopRun[] };
  const run = runs.runs.filter((candidate) => candidate.loopName === "Green Suite").at(-1)!;
  expect(run.definitionSnapshot).toMatchObject({
    goal: "Run-only goal override",
    launchContext: "RUN_ONLY_CONTEXT",
    launchContextScope: "everyIteration",
    successCondition: "Run-only explicit success condition",
    successConditionSource: "custom",
    evaluatorProvider: "mock",
    evaluatorModel: "mock-model",
    evaluatorThinkingLevel: "high",
    maxIterations: 0,
  });
});

test("runs a single-agent loop to completion", async ({ page }) => {
  await openLoops(page);
  await launchLoop(page, "Green Suite");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("loop-run-iterations")).toContainText("✓ passed");
  await expect(page.getByTestId("loop-run-iterations")).toContainText("Iteration manifest:");
  await expect(page.getByTestId("loop-run-iterations")).toContainText("Changed files: none");
  const validation = page.getByTestId("loop-validation-evidence").first();
  await expect(validation).toHaveAccessibleName("Validation for iteration 1");
  await expect(validation).toContainText("exit 0");
  await expect(validation).toContainText("completed");
  await expect(page.getByTestId("loop-session-evidence")).toContainText("Run manifest:");
  await expect(page.getByTestId("loop-session-evidence")).toContainText("Progress report:");
  const openSession = page.getByTestId("loop-open-session");
  await expect(openSession).toHaveAccessibleName(/Open session for Green Suite/i);
  await openSession.click();
  await expect(page.getByTestId("subagent-cell")).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("button", { name: /Subagent · Agent A result/i }).click();
  await expect(page.getByTestId("subagent-output").first()).toContainText(
    "detailed streamed implementation",
  );
  await page.reload();
  await openLoops(page);
  await page.getByTestId("loop-open-session").click();
  await expect(page.getByTestId("subagent-cell")).toHaveCount(2, { timeout: 15_000 });
  await page.getByRole("button", { name: /Subagent · Agent A result/i }).click();
  await expect(page.getByTestId("subagent-output").first()).toContainText(
    "detailed streamed implementation",
  );
});

test("renders bounded rich validation output, working directory, and artifacts", async ({
  page,
}) => {
  await openLoops(page);
  await launchLoop(page, "Bounded Validation");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const validation = page.getByTestId("loop-validation-evidence").first();
  await expect(validation).toContainText(`Working directory: ${realpathSync.native(project)}`);
  await expect(validation.getByLabel("Validation output artifacts")).toContainText("stdout.txt");
  await expect(validation.getByLabel("Validation output artifacts")).toContainText("stderr.txt");
  const stdout = validation.getByLabel("Validation stdout");
  await expect(stdout).toContainText("output truncated");
  expect((await stdout.textContent())?.length).toBeLessThan(16_500);
});

test("retains and restores registered worktree evidence in the run panel", async ({ page }) => {
  await openLoops(page);
  await launchLoop(page, "Retained Worktree");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const retained = page.getByTestId("loop-retained-worktree");
  await expect(retained).toContainText("Review worktree retained.");
  await expect(retained).toContainText("session-worktrees");
  await expect(retained).toContainText("Branch: agent-deck/loop-");

  await page.reload();
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-retained-worktree")).toContainText(
    "Review worktree retained.",
  );
});

test("authors, reorders, duplicates, runs, and restores an accessible Pipeline", async ({
  page,
}) => {
  await openLoops(page);
  await page.getByTestId("new-loop").click();
  await expect(page.getByTestId("loop-name")).toBeFocused();
  await page.getByTestId("loop-name").fill("Authored Pipeline");
  await page.getByTestId("loop-goal").fill("Run repeated agents in the configured order.");
  await page.getByTestId("loop-structure").selectOption("agentPipeline");
  const config = page.getByTestId("loop-pipeline-config");
  await expect(config).toContainText("strictly from top to bottom");
  await page.getByTestId("loop-pipeline-add-stage").click();
  await page.getByTestId("loop-pipeline-add-stage").click();
  await page.getByTestId("loop-pipeline-add-stage").click();
  await page.getByTestId("loop-pipeline-stage-agent-0").selectOption("Agent A");
  await page.getByTestId("loop-pipeline-stage-agent-1").selectOption("Agent B");
  await page.getByTestId("loop-pipeline-stage-agent-2").selectOption("Agent A");
  await page.getByRole("button", { name: "Move pipeline stage 3 up" }).click();
  await expect(page.getByTestId("loop-pipeline-stage-agent-0")).toHaveValue("Agent A");
  await expect(page.getByTestId("loop-pipeline-stage-agent-1")).toHaveValue("Agent A");
  await expect(page.getByTestId("loop-pipeline-stage-agent-2")).toHaveValue("Agent B");
  await page.getByTestId("loop-validation").fill("exit 0");
  await page.getByTestId("loop-save").click();

  const row = page.locator('[data-loop-name="Authored Pipeline"]');
  await expect(row).toContainText("Agent pipeline");
  await page.getByTestId("loop-duplicate-Authored Pipeline").click();
  await expect(page.locator('[data-loop-name="Copy of Authored Pipeline"]')).toBeVisible();

  await launchLoop(page, "Authored Pipeline");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const outputs = page.getByTestId("loop-pipeline-stage-outputs");
  await expect(outputs.locator("li")).toHaveCount(3);
  await expect(outputs.locator("li").nth(0)).toContainText("Stage 1: Agent A");
  await expect(outputs.locator("li").nth(1)).toContainText("Stage 2: Agent A");
  await expect(outputs.locator("li").nth(2)).toContainText("Stage 3: Agent B");
  await expect(page.getByTestId("loop-run-live-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);

  await page.reload();
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-pipeline-stage-outputs")).toContainText("Stage 3: Agent B");
});

test("authors, normalizes, duplicates, runs, and restores accessible Parallel reports", async ({
  page,
}) => {
  await openLoops(page);
  await page.getByTestId("new-loop").click();
  await page.getByTestId("loop-name").fill("Authored Parallel");
  await page.getByTestId("loop-goal").fill("Compare independent evidence.");
  await page.getByTestId("loop-structure").selectOption("parallelAgents");
  const config = page.getByTestId("loop-parallel-config");
  await expect(config).toContainText("at most two running concurrently");
  await expect(config).toContainText("report-only");
  await expect(page.getByTestId("loop-write-target")).toBeDisabled();
  await expect(page.getByTestId("loop-write-target")).toHaveValue("artifactMarkdown");

  await page.getByTestId("loop-parallel-add-branch").click();
  await page.getByTestId("loop-parallel-add-branch").click();
  await page.getByTestId("loop-parallel-add-branch").click();
  await page.getByTestId("loop-parallel-branch-agent-0").selectOption("Agent A");
  await page.getByTestId("loop-parallel-branch-agent-1").selectOption("Agent B");
  await page.getByTestId("loop-parallel-branch-agent-2").selectOption("Agent A");
  await page.getByRole("button", { name: "Move parallel branch 2 up" }).click();
  await expect(page.getByTestId("loop-parallel-branch-agent-0")).toHaveValue("Agent B");
  await expect(page.getByTestId("loop-parallel-branch-agent-1")).toHaveValue("Agent A");
  await page.getByTestId("loop-validation").fill("exit 0");
  await page.getByTestId("loop-save").click();

  await page.getByTestId("loop-open-Authored Parallel").click();
  await expect(page.getByTestId("loop-parallel-branch-agent-0")).toHaveValue("Agent B");
  await expect(page.getByTestId("loop-parallel-branch-agent-1")).toHaveValue("Agent A");
  await expect(page.getByTestId("loop-parallel-branch-agent-2")).toHaveCount(0);
  await page.getByTestId("loop-cancel").click();
  await page.getByTestId("loop-duplicate-Authored Parallel").click();
  await expect(page.locator('[data-loop-name="Copy of Authored Parallel"]')).toBeVisible();

  await launchLoop(page, "Authored Parallel");
  const statuses = page.getByTestId("loop-parallel-branch-statuses");
  await expect(statuses).toContainText("Branch 1: Agent B");
  await expect(statuses).toContainText("Branch 2: Agent A");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const outputs = page.getByTestId("loop-parallel-branch-outputs");
  await expect(outputs.locator("li")).toHaveCount(2);
  await expect(outputs.locator("li").nth(0)).toContainText("Configured branch 1: Agent B");
  await expect(outputs.locator("li").nth(1)).toContainText("Configured branch 2: Agent A");
  await expect(page.getByTestId("loop-run-iterations")).toContainText("iteration-1-branch-1.md");
  await expect(page.getByTestId("loop-run-live-status")).toHaveAttribute("role", "status");
  const branchLive = page.getByTestId("loop-parallel-live-status");
  await expect(branchLive).toHaveAttribute("role", "status");
  await expect(branchLive).toHaveAttribute("aria-live", "polite");
  await expect(branchLive).toHaveAttribute("aria-atomic", "true");
  await expect(branchLive).toContainText("Parallel status:");
  await expect(branchLive.getByRole("button")).toHaveCount(0);

  await page.setViewportSize({ width: 500, height: 600 });
  await expect
    .poll(() =>
      page
        .getByTestId("loop-run-panel")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);

  await page.reload();
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-parallel-branch-outputs")).toContainText(
    "Configured branch 2: Agent A",
  );
});

test("authors, duplicates, runs, reloads, and stops accessible Discovery/Triage", async ({
  page,
}) => {
  await openLoops(page);
  await page.getByTestId("new-loop").click();
  await page.getByTestId("loop-name").fill("Authored Triage");
  await page.getByTestId("loop-goal").fill("Discover release risks without implementing fixes.");
  await page.getByTestId("loop-structure").selectOption("discoveryTriage");
  const config = page.getByTestId("loop-triage-config");
  await expect(config).toContainText("runs once per iteration");
  await expect(config).toContainText("only when the goal explicitly requests implementation");
  const triageAgent = page.getByTestId("loop-triage-agent");
  await expect(triageAgent).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("A triage agent is required");
  await expect(page.getByTestId("loop-save")).toBeDisabled();
  await triageAgent.selectOption("Triage Agent");
  const prompt = page.getByTestId("loop-classification-prompt");
  const nativeDefault = "Classify findings by severity and summarize recommended next action.";
  await expect(prompt).toHaveValue(nativeDefault);
  await prompt.fill("   ");
  await prompt.blur();
  await expect(prompt).toHaveValue(nativeDefault);
  const classification =
    "Classify severity and impact.\nAssign owner and evidence.\nRecommend next action.";
  const normalizedClassification =
    "Classify severity and impact. Assign owner and evidence. Recommend next action.";
  await prompt.fill(classification);
  await page.getByTestId("loop-validation").fill("exit 0");
  await page.getByTestId("loop-save").click();

  await page.getByTestId("loop-open-Authored Triage").click();
  await expect(page.getByTestId("loop-triage-agent")).toHaveValue("Triage Agent");
  await expect(page.getByTestId("loop-classification-prompt")).toHaveValue(
    normalizedClassification,
  );
  await page.getByTestId("loop-cancel").click();
  await page.getByTestId("loop-duplicate-Authored Triage").click();
  await expect(page.locator('[data-loop-name="Copy of Authored Triage"]')).toBeVisible();

  await launchLoop(page, "Authored Triage");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const iterations = page.getByTestId("loop-run-iterations");
  await expect(iterations.locator('[data-phase="triage"]').first()).toBeVisible();
  await expect(iterations).toContainText("High impact finding");
  await expect(iterations).toContainText("iteration-1-triage.md");
  await expect(page.getByTestId("loop-validation-evidence")).toContainText("exit 0");
  await expect(page.getByTestId("loop-evaluator-decision")).toContainText("SUCCESS");
  await expect(page.getByTestId("loop-run-live-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("loop-run-live-status")).toHaveAttribute("aria-atomic", "true");
  await page.setViewportSize({ width: 500, height: 600 });
  await expect
    .poll(() =>
      page
        .getByTestId("loop-run-panel")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-run-iterations")).toContainText("High impact finding");

  await page.getByTestId("loop-run-Unavailable Triage").click();
  await expect(page.getByTestId("loop-launch-agent-errors")).toContainText(
    "Triage: “Unavailable Explorer” is unavailable",
  );
  await expect(page.getByTestId("loop-launch-confirm")).toBeDisabled();
  await expect(page.getByTestId("loop-run-panel")).toContainText("Authored Triage");
  await page.getByTestId("loop-launch-cancel").click();
  await expect(page.getByTestId("loop-launch-dialog")).toHaveCount(0);

  const failingTriageId = await loopId("Failing Triage");
  await page.route(new RegExp(`/loops/${failingTriageId}/run$`), async (route) => {
    const now = new Date().toISOString();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: "00000000-0000-4000-8000-000000000404",
          loopName: "Failing Triage",
          projectId,
          status: "failed",
          currentIteration: 1,
          maxIterations: 1,
          stopReason: "agentFailed",
          startedAt: now,
          updatedAt: now,
          endedAt: now,
          iterations: [
            {
              id: "triage-failed-iteration",
              index: 1,
              startedAt: now,
              endedAt: now,
              output: "triage provider failed",
              validationPassed: null,
              timeline: [
                {
                  id: "triage-started",
                  phase: "triage",
                  roleName: "Broken Triage",
                  note: "triage started",
                  timestamp: now,
                },
              ],
              children: [
                {
                  id: "triage-failed-child",
                  phase: "triage",
                  agentName: "Broken Triage",
                  status: "failed",
                  startedAt: now,
                  endedAt: now,
                  error: "triage provider failed",
                },
              ],
              artifacts: [],
            },
          ],
        },
      }),
    });
  });
  await launchLoop(page, "Failing Triage");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "failed", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("loop-triage-status")).toContainText("Broken Triage — Failed");
  await expect(
    page.getByRole("alert").filter({ hasText: "Discovery / triage error" }),
  ).toContainText(/triage provider failed|request failed|error/i);
  await expect(page.getByTestId("loop-run-iterations")).toContainText("Discovery / triage error");

  await launchLoop(page, "Slow Triage Stop");
  const stop = page.getByTestId("loop-run-stop");
  await expect(stop).toBeVisible();
  await stop.focus();
  await stop.click();
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "stopped", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);
  await expect(page.getByTestId("loop-run-dismiss")).toBeFocused();
});

test("shows queued Parallel branches, announces transitions, and withholds Retry after Stop", async ({
  page,
}) => {
  await openLoops(page);
  await launchLoop(page, "Slow Parallel Stop");
  const statuses = page.getByTestId("loop-parallel-branch-statuses").first();
  await expect(statuses.locator('[data-branch-index="0"]')).toContainText("Running");
  await expect(statuses.locator('[data-branch-index="1"]')).toContainText("Running");
  const third = statuses.locator('[data-branch-index="2"]');
  await expect(third).toContainText("Queued");
  const branchLive = page.getByTestId("loop-parallel-live-status");
  await expect(branchLive).toHaveText(/Branch 1 running.*Branch 2 running.*Branch 3 queued/);
  await expect(third).toContainText(/Running|Completed/, { timeout: 15_000 });
  await expect(branchLive).not.toContainText("Branch 3 queued");

  const stop = page.getByTestId("loop-run-stop");
  await stop.focus();
  await stop.click();
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "stopped", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("loop-run-panel")).toContainText("Stopped by user");
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);
  await expect(page.getByTestId("loop-run-dismiss")).toBeFocused();
});

test("repairs an existing unavailable Parallel agent without silent substitution", async ({
  page,
}) => {
  await openLoops(page);
  await page.getByTestId("loop-open-Failing Parallel").click();
  const missing = page.getByTestId("loop-parallel-branch-agent-0");
  await expect(missing).toHaveValue("Missing Agent");
  await expect(missing.locator('option[value="Missing Agent"]')).toContainText("unavailable");
  await expect(page.getByTestId("loop-agent-role-errors")).toContainText(
    "Parallel branch 1: “Missing Agent” is unavailable",
  );
  await expect(page.getByTestId("loop-save")).toBeDisabled();
  await page.getByTestId("loop-cancel").click();
  await page.getByTestId("loop-run-Failing Parallel").click();
  await expect(page.getByTestId("loop-launch-agent-errors")).toContainText(
    "Parallel branch 1: “Missing Agent” is unavailable",
  );
  await expect(page.getByTestId("loop-launch-confirm")).toBeDisabled();
  await page.getByTestId("loop-launch-cancel").click();
  await page.getByTestId("loop-open-Failing Parallel").click();
  await page.getByTestId("loop-parallel-branch-agent-0").selectOption("Agent B");
  await page.getByTestId("loop-save").click();

  await launchLoop(page, "Failing Parallel");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const statuses = page.getByTestId("loop-parallel-branch-statuses");
  await expect(statuses.locator('[data-branch-index="0"]')).toContainText("Agent B — Completed");
  await expect(statuses.locator('[data-branch-index="1"]')).toContainText("Agent A — Completed");
});

test("shows ordered Maker+Checker evidence, disables launches, and restores history", async ({
  page,
}) => {
  await openLoops(page);
  await launchLoop(page, "Reviewed Report");
  await expect(page.getByTestId("loop-run-Reviewed Report")).toBeDisabled();
  await expect(page.getByTestId("loop-run-Slow Stop")).toBeDisabled();
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  const timeline = page.getByTestId("loop-run-iterations");
  await expect(timeline.locator('[data-phase="maker"]').first()).toBeVisible();
  await expect(timeline.locator('[data-phase="checker"]').first()).toBeVisible();
  await expect(timeline.locator('[data-phase="evaluator"]').first()).toBeVisible();
  await expect(page.getByTestId("loop-checker-decision")).toContainText(
    "APPROVE — Checker found concrete passing evidence.",
  );
  await expect(page.getByTestId("loop-evaluator-decision")).toContainText(
    "SUCCESS — Goal evaluator confirmed the requested outcome.",
  );
  await expect(page.getByTestId("loop-validation-evidence")).toContainText("exit 0");
  await expect(timeline).toContainText("iteration-1-maker.md");

  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);

  const history = page.getByTestId("loop-run-history");
  await expect(history).toContainText("Reviewed Report");
  await history.locator('[data-loop-name="Reviewed Report"]').last().click();
  await expect(page.getByTestId("loop-run-panel")).toContainText("Reviewed Report");
  await expect(page.getByTestId("loop-validation-evidence")).toContainText("exit 0");
  await history.locator('[data-loop-name="Reviewed Report"]').first().click();
  await expect(page.getByTestId("loop-checker-decision")).toContainText("Checker found concrete");

  await page.reload();
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("loop-run-history")).toContainText("Reviewed Report");
  await expect(page.getByTestId("loop-run-panel")).not.toHaveAttribute("role", "status");
  await expect(page.getByTestId("loop-run-live-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("loop-run-live-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("loop-run-iterations")).not.toHaveAttribute("aria-live");
});

test("Stop cancels a running loop and native retry eligibility is enforced", async ({ page }) => {
  await openLoops(page);
  await launchLoop(page, "Slow Stop");
  const stop = page.getByTestId("loop-run-stop");
  await expect(stop).toBeVisible();
  await page.route(/\/loops\/runs\/[^/]+\/stop$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await stop.focus();
  await stop.click();
  await expect(stop).toBeFocused();
  await expect(stop).toHaveAttribute("aria-disabled", "true");
  await expect(stop).toHaveAttribute("data-pending", "true");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "stopped", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("loop-run-panel")).toContainText("Stopped by user");
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);
  await expect(page.getByTestId("loop-run-dismiss")).toBeFocused();
});

test("shows native-truthful human-input and recovery actions without broad live regions", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const humanRun = {
    id: "22222222-2222-4222-8222-222222222222",
    catalogId: "reviewed-report-id",
    loopName: "Reviewed Report",
    structure: "makerChecker",
    projectId,
    launch: {
      sessionId: "human-loop-parent",
      writeTarget: "currentCheckout",
      checkoutLockKey: "/canonical/project",
    },
    definitionSnapshot: {
      name: "Reviewed Report",
      description: "",
      goal: "Review evidence.",
      structure: "makerChecker",
      makerName: "Maker",
      checkerName: "Checker",
      checkerRubric: "Require evidence.",
      launchContextScope: "firstIterationOnly",
      maxIterations: 2,
      validationCommand: "exit 0",
      writeTarget: "currentCheckout",
    },
    status: "stopped",
    currentIteration: 1,
    maxIterations: 2,
    stopReason: "humanInputRequired",
    startedAt: now,
    updatedAt: now,
    endedAt: now,
    iterations: [
      {
        id: "iteration-human",
        index: 1,
        startedAt: now,
        endedAt: now,
        output: "maker evidence",
        checkerOutput: "ASK_HUMAN\nChoose the acceptable tradeoff.",
        checkerDecision: "ASK_HUMAN",
        evaluatorOutput: "CONTINUE\nThe goal is not complete.",
        goalDecision: "CONTINUE",
        validationPassed: true,
        validationEvidence: "tests passed",
        timeline: [],
        children: [],
        artifacts: [],
      },
    ],
  };
  await page.route(/\/loops\/runs$/, async (route) => {
    await route.fulfill({ json: { runs: [humanRun] } });
  });
  await openLoops(page);

  const alert = page.getByRole("alert").filter({ hasText: "Human input required" });
  await expect(alert).toContainText("Choose the acceptable tradeoff");
  await expect(page.getByTestId("loop-run-retry")).toBeEnabled();
  await expect(page.getByTestId("loop-evaluator-decision")).toContainText("CONTINUE");
  await expect(page.getByTestId("loop-run-panel")).not.toHaveAttribute("aria-live");
  await expect(page.getByTestId("loop-run-live-status")).toHaveText(/Stopped · Iteration 1 \/ 2/);
  await page.getByTestId("loop-run-retry").click();
  await expect(page.getByTestId("loop-launch-dialog")).toHaveAccessibleName(
    "Retry Reviewed Report",
  );
  const retryConfirmation = page.getByTestId("loop-current-checkout-confirmation");
  await expect(page.getByTestId("loop-launch-confirm")).toBeDisabled();
  await retryConfirmation.focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("loop-launch-confirm")).toBeEnabled();
  await page.getByTestId("loop-launch-cancel").click();

  await page.unroute(/\/loops\/runs$/);
  const recoveryRun = {
    ...humanRun,
    id: "33333333-3333-4333-8333-333333333333",
    status: "interrupted",
    stopReason: "appInterrupted",
    launch: {
      sessionId: "stale-loop-parent",
      writeTarget: "currentCheckout",
      checkoutLockKey: "/canonical/project",
    },
  };
  await page.route(/\/loops\/runs$/, async (route) => {
    await route.fulfill({ json: { runs: [recoveryRun] } });
  });
  await page.route(/\/loops\/runs\/[^/]+\/acknowledge$/, async (route) => {
    await route.fulfill({
      json: {
        run: {
          ...recoveryRun,
          launch: { ...recoveryRun.launch, checkoutAcknowledgedAt: new Date().toISOString() },
        },
      },
    });
  });
  await page.reload();
  await page.getByTestId("nav-loops").click();
  const recoveryAlert = page
    .getByRole("alert")
    .filter({ hasText: "Checkout locked after interruption" });
  await expect(recoveryAlert).toContainText("Ensure no old agent process remains");
  const unlock = page.getByTestId("loop-recovery-acknowledge");
  await expect(unlock).toHaveAccessibleName(/unlock checkout/i);
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);
  await unlock.click();
  await expect(recoveryAlert).toHaveCount(0);
  await expect(page.getByTestId("loop-run-retry")).toHaveCount(0);
});

test("surfaces a typed checkout conflict in the Loop UI", async ({ page }) => {
  await openLoops(page);
  const slowStopId = await loopId("Slow Stop");
  await page.route(new RegExp(`/loops/${slowStopId}/run$`), async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "loop_checkout_busy",
        error: "Another Loop is already running in this project checkout.",
      }),
    });
  });
  await launchLoop(page, "Slow Stop");
  await expect(page.getByTestId("loop-launch-dialog").getByRole("alert")).toContainText(
    "Another Loop is already running in this project checkout.",
  );
});

test("non-destructive artifact runs may coexist", async () => {
  const reviewedReportId = await loopId("Reviewed Report");
  const start = async (): Promise<Response> =>
    await fetch(`${harness.baseUrl}/loops/${encodeURIComponent(reviewedReportId)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, currentCheckoutConfirmed: true }),
    });
  const [first, second] = await Promise.all([start(), start()]);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const firstId = ((await first.json()) as { run: { id: string } }).run.id;
  const secondId = ((await second.json()) as { run: { id: string } }).run.id;
  expect(firstId).not.toBe(secondId);
});

test("returns a typed conflict for concurrent destructive checkout runs", async () => {
  const slowStopId = await loopId("Slow Stop");
  const start = async (): Promise<Response> =>
    await fetch(`${harness.baseUrl}/loops/${encodeURIComponent(slowStopId)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, currentCheckoutConfirmed: true }),
    });
  const first = await start();
  expect(first.status).toBe(201);
  const firstRun = ((await first.json()) as { run: { id: string } }).run;
  const second = await start();
  expect(second.status).toBe(409);
  await expect(second.json()).resolves.toMatchObject({ code: "loop_checkout_busy" });
  await fetch(`${harness.baseUrl}/loops/runs/${firstRun.id}/stop`, { method: "POST" });
});
