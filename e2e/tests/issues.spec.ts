import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Issues is project-scoped and currently has no local picker. Without a
 * globally selected project the screen stays on its empty state.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-issues-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!response.ok) throw new Error(await response.text());
});

test.afterAll(async () => {
  await harness.close();
});

test("the All Projects workspace prompts to pick a project", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("issues-no-project")).toBeVisible();
});

test("opening a project session does not select Issues onto that project", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("app-view-title")).toHaveText("Issues");
  await expect(page.getByTestId("issues-no-project")).toBeVisible();
  await expect(page.getByTestId("issue-7")).toHaveCount(0);
});
