import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import type { SessionMeta } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Projects are registered folders. There is no globally selected project;
 * chats can still be opened in a project folder and listed across all projects.
 */

let harness: E2eHarness;
const projectA = mkdtempSync(path.join(tmpdir(), "proj-alpha-"));
const projectB = mkdtempSync(path.join(tmpdir(), "proj-beta-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("adding projects registers folders; chats stay project-scoped without a global picker", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("app-view-title")).toHaveText("Projects");

  await page.getByTestId("projects-add").click();
  await page.getByTestId("projects-add-path").fill(projectA);
  await page.getByTestId("projects-add-confirm").click();
  await expect(page.locator(`[data-project-name="${path.basename(projectA)}"]`)).toBeVisible();

  await page.getByTestId("projects-add").click();
  await page.getByTestId("projects-add-path").fill(projectB);
  await page.getByTestId("projects-add-confirm").click();
  await expect(page.locator(`[data-project-name="${path.basename(projectB)}"]`)).toBeVisible();
  await expect(page.getByTestId("project-active-tag")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByTestId("chat-layer")).toHaveAttribute("aria-hidden", "false");

  await selectProject(page, path.basename(projectA));
  await expect(page.getByTestId("session-cwd")).toHaveText(projectA);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  const sessions = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: SessionMeta[];
  };
  const projectSession = sessions.sessions.find((s) => s.cwd === projectA);
  expect(projectSession).toBeDefined();
  expect(projectSession!.projectId).toBeDefined();

  await page.getByTestId("composer-input").fill("message for alpha");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("user-cell")).toContainText("message for alpha");
  await expect(page.getByTestId("assistant-text")).toContainText("message for alpha", {
    timeout: 30_000,
  });

  await selectProject(page, path.basename(projectB));
  await expect(page.getByTestId("session-cwd")).toHaveText(projectB);
  await expect(page.getByTestId("user-cell")).toHaveCount(0);

  await page.getByTestId("chat-list").getByTestId(`chat-${projectSession!.id}`).click();
  await expect(page.getByTestId("session-cwd")).toHaveText(projectA);
  await expect(page.getByTestId("user-cell")).toContainText("message for alpha");
  await expect(page.getByTestId("assistant-text")).toContainText("message for alpha");
});

test("the Projects screen toggles enabled state and hides entries", async ({ page }) => {
  // A dedicated project that never hosts a session, so hide (which is refused
  // for a project with a live session) is unconditionally allowed.
  const projectC = mkdtempSync(path.join(tmpdir(), "proj-gamma-"));
  const name = path.basename(projectC);
  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectC }),
  });
  if (!response.ok) throw new Error(await response.text());

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-projects").click();

  const row = page.locator(`[data-project-name="${name}"]`);
  await expect(row).toBeVisible();

  await page.getByTestId(`project-enabled-${name}`).click();
  await expect(row).toHaveCount(0);
  await page.getByTestId("project-filter-disabled").click();
  await expect(row).toBeVisible();

  await page.getByTestId(`project-enabled-${name}`).click();
  await page.getByTestId("project-filter-all").click();
  await page.getByTestId(`project-hide-${name}`).click();
  await expect(row).toHaveCount(0);
});
