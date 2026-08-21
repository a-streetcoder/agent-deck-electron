import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Issues filters are project-scoped. Without a globally selected project the
 * screen stays empty — there is no board to facet.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-issues-filter-"));

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

test("Issues filters stay unavailable without a globally selected project", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("issues-no-project")).toBeVisible();
  await expect(page.getByTestId("issues-label-bug")).toHaveCount(0);
  await expect(page.getByTestId("issues-search")).toHaveCount(0);
});
