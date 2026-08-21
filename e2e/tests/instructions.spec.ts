import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Instructions: Global scope still edits ~/.pi/agent/AGENTS.md. Project scope
 * stays empty until that screen has its own picker — there is no global project.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-instructions-"));

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

test("the All Projects workspace edits Global; Project scope prompts to pick one", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-instructions").click();
  await expect(page.getByTestId("instructions-editor")).toBeVisible();
  await page.getByTestId("instructions-scope-project").click();
  await expect(page.getByTestId("instructions-no-project")).toBeVisible();
});

test("editing Global AGENTS.md writes ~/.pi/agent/AGENTS.md", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-instructions").click();
  await page.getByTestId("instructions-scope-global").click();

  const editor = page.getByTestId("instructions-editor");
  await expect(editor).toBeVisible();
  await editor.fill("# Global rules\n\nPrefer small PRs.");
  await page.getByTestId("instructions-save").click();
  await expect(page.getByTestId("instructions-save")).toHaveText("Saved");

  const globalFile = path.join(harness.piHome, ".pi", "agent", "AGENTS.md");
  await expect.poll(() => existsSync(globalFile)).toBe(true);
  expect(readFileSync(globalFile, "utf8")).toContain("Prefer small PRs.");
});

test("project-scope instructions stay empty without a globally selected project", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-instructions").click();
  await page.getByTestId("instructions-scope-project").click();
  await expect(page.getByTestId("instructions-no-project")).toBeVisible();
  expect(existsSync(path.join(project, "AGENTS.md"))).toBe(false);
});
