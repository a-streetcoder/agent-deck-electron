import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Git "Generate" is project-scoped. Without a globally selected project the
 * Git screen stays empty until it has its own picker.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-gitmsg-"));

test.beforeAll(async () => {
  execFileSync("git", ["init", "-b", "main", project]);
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: project });
  execFileSync("git", ["config", "user.name", "T"], { cwd: project });
  writeFileSync(path.join(project, "greet.js"), "export function hello() {}\n");
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["commit", "-m", "init"], { cwd: project });
  writeFileSync(path.join(project, "greet.js"), "export function hello() {\n  return 'hi';\n}\n");

  harness = await startHarness({ chunkDelayMs: 20, reply: () => "Refine greet.js greeting" });
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

test("Git generate stays unavailable without a selected project", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("app-view-title")).toHaveText("Git");
  await expect(page.getByTestId("git-no-project")).toBeVisible();
  await expect(page.getByTestId("git-generate-message")).toHaveCount(0);
});
