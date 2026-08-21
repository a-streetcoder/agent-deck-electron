import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Git is project-scoped and currently has no local picker. Without a globally
 * selected project the screen stays on its empty state. Commit still works
 * over HTTP against a registered project.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-git-"));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: project, encoding: "utf8" });
}

test.beforeAll(async () => {
  execFileSync("git", ["init", "-b", "main", project], { encoding: "utf8" });
  git(["config", "user.email", "test@agent-deck.local"]);
  git(["config", "user.name", "Agent Deck Test"]);
  writeFileSync(path.join(project, "README.md"), "# project\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);

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

test("Git stays empty until the screen has its own project picker", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("app-view-title")).toHaveText("Git");
  await expect(page.getByTestId("git-no-project")).toBeVisible();
  await expect(page.getByTestId("git-commit-message")).toHaveCount(0);
});

test("rejects an empty commit and reports it", async () => {
  const response = await fetch(`${harness.baseUrl}/projects`);
  const { projects } = (await response.json()) as { projects: Array<{ id: string; path: string }> };
  const id = projects.find((p) => p.path === project)!.id;
  const commit = await fetch(`${harness.baseUrl}/projects/${id}/git/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "nothing here" }),
  });
  expect(commit.status).toBe(400);
  expect(await commit.text()).toContain("no changes to commit");
});
