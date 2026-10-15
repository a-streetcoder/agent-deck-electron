import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, openNav, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Release is project-scoped. Without a globally selected project the Git
 * screen stays empty until it has its own picker.
 */

let harness: E2eHarness;
const work = mkdtempSync(path.join(tmpdir(), "rel-work-"));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test.beforeAll(async () => {
  execFileSync("git", ["init", "-b", "main", work], { encoding: "utf8" });
  gitIn(work, ["config", "user.email", "test@agent-deck.local"]);
  gitIn(work, ["config", "user.name", "Agent Deck Test"]);
  writeFileSync(path.join(work, "README.md"), "# app\n");
  gitIn(work, ["add", "-A"]);
  gitIn(work, ["commit", "-m", "initial"]);

  harness = await startHarness({ chunkDelayMs: 20 });
  const res = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: work }),
  });
  if (!res.ok) throw new Error(await res.text());
});

test.afterAll(async () => {
  await harness.close();
});

test("the Git screen preselects the active session's project", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(work));
  await openNav(page, "git");
  await expect(page.getByTestId("app-view-title")).toHaveText("Git");
  await expect(page.getByTestId("git-project-picker").locator("option:checked")).toHaveText(
    path.basename(work),
  );
});
