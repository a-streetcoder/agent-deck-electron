import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Git push is project-scoped. Without a globally selected project the Git
 * screen stays empty. The no-remote HTTP path still proves the API.
 */

let harness: E2eHarness;
const work = mkdtempSync(path.join(tmpdir(), "git-work-"));
const noRemote = mkdtempSync(path.join(tmpdir(), "git-noremote-"));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test.beforeAll(async () => {
  execFileSync("git", ["init", "-b", "main", work], { encoding: "utf8" });
  gitIn(work, ["config", "user.email", "test@agent-deck.local"]);
  gitIn(work, ["config", "user.name", "Agent Deck Test"]);
  writeFileSync(path.join(work, "README.md"), "# work\n");
  gitIn(work, ["add", "-A"]);
  gitIn(work, ["commit", "-m", "initial"]);

  execFileSync("git", ["init", "-b", "main", noRemote], { encoding: "utf8" });
  gitIn(noRemote, ["config", "user.email", "t@t.local"]);
  gitIn(noRemote, ["config", "user.name", "T"]);
  writeFileSync(path.join(noRemote, "a.txt"), "a\n");
  gitIn(noRemote, ["add", "-A"]);
  gitIn(noRemote, ["commit", "-m", "init"]);

  harness = await startHarness({ chunkDelayMs: 20 });
  for (const p of [work, noRemote]) {
    const res = await fetch(`${harness.baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    if (!res.ok) throw new Error(await res.text());
  }
});

test.afterAll(async () => {
  await harness.close();
});

test("Git push stays empty without a globally selected project", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(work));
  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("app-view-title")).toHaveText("Git");
  await expect(page.getByTestId("git-no-project")).toBeVisible();
  await expect(page.getByTestId("git-commit-push")).toHaveCount(0);
});

test("push with no remote fails cleanly (502)", async () => {
  const res = await fetch(`${harness.baseUrl}/projects`);
  const { projects } = (await res.json()) as { projects: Array<{ id: string; path: string }> };
  const id = projects.find((p) => p.path === noRemote)!.id;
  const push = await fetch(`${harness.baseUrl}/projects/${id}/git/push`, { method: "POST" });
  expect(push.status).toBe(502);
  expect(await push.text()).toContain("Push failed");
});
