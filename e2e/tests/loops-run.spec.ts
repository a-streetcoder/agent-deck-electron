import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
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
      if (message.includes("exact first non-empty line must be APPROVE")) {
        return "APPROVE\nChecker found concrete passing evidence.";
      }
      if (message.includes("exact first non-empty line must be SUCCESS")) {
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
    validationCommand: "exit 0",
    maxIterations: 3,
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
    name: "Slow Stop",
    goal: "Keep working until stopped.",
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

test("runs a single-agent loop to completion", async ({ page }) => {
  await openLoops(page);
  await page.getByTestId("loop-run-Green Suite").click();
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("loop-run-iterations")).toContainText("✓ passed");
});

test("shows ordered Maker+Checker evidence, disables launches, retries, and restores history", async ({
  page,
}) => {
  await openLoops(page);
  await page.getByTestId("loop-run-Reviewed Report").click();
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

  await page.getByTestId("loop-run-retry").focus();
  await expect(page.getByTestId("loop-run-retry")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("loop-run-status")).toHaveAttribute("data-status", "completed", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("loop-run-history")).toContainText("Reviewed Report");

  const history = page.getByTestId("loop-run-history");
  await expect(history).toContainText("Green Suite");
  await history.locator('[data-loop-name="Green Suite"]').click();
  await expect(page.getByTestId("loop-run-panel")).toContainText("Green Suite");
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

test("Stop cancels a running loop and Retry remains available", async ({ page }) => {
  await openLoops(page);
  await page.getByTestId("loop-run-Slow Stop").click();
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
  await expect(page.getByTestId("loop-run-retry")).toBeEnabled();
  await expect(page.getByTestId("loop-run-retry")).toBeFocused();
});

test("shows native-truthful human-input and recovery actions without broad live regions", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const humanRun = {
    id: "22222222-2222-4222-8222-222222222222",
    loopName: "Reviewed Report",
    projectId,
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
  await expect(page.getByTestId("loop-run-retry")).toBeDisabled();
  await unlock.click();
  await expect(recoveryAlert).toHaveCount(0);
  await expect(page.getByTestId("loop-run-retry")).toBeEnabled();
});

test("surfaces a typed checkout conflict in the Loop UI", async ({ page }) => {
  await openLoops(page);
  await page.route(/\/loops\/Slow%20Stop\/run$/, async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        code: "loop_checkout_busy",
        error: "Another Loop is already running in this project checkout.",
      }),
    });
  });
  await page.getByTestId("loop-run-Slow Stop").click();
  await expect(page.getByTestId("error-banner")).toContainText(
    "Another Loop is already running in this project checkout.",
  );
});

test("non-destructive artifact runs may coexist", async () => {
  const start = async (): Promise<Response> =>
    await fetch(`${harness.baseUrl}/loops/${encodeURIComponent("Reviewed Report")}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
  const [first, second] = await Promise.all([start(), start()]);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const firstId = ((await first.json()) as { run: { id: string } }).run.id;
  const secondId = ((await second.json()) as { run: { id: string } }).run.id;
  expect(firstId).not.toBe(secondId);
});

test("returns a typed conflict for concurrent destructive checkout runs", async () => {
  const start = async (): Promise<Response> =>
    await fetch(`${harness.baseUrl}/loops/${encodeURIComponent("Slow Stop")}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
  const first = await start();
  expect(first.status).toBe(201);
  const firstRun = ((await first.json()) as { run: { id: string } }).run;
  const second = await start();
  expect(second.status).toBe(409);
  await expect(second.json()).resolves.toMatchObject({ code: "loop_checkout_busy" });
  await fetch(`${harness.baseUrl}/loops/runs/${firstRun.id}/stop`, { method: "POST" });
});
