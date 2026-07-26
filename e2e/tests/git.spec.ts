import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Git screen (native GitRepositoryService, status + commit-all half): a real
 * temp git repo is the hermetic fixture — no network, deterministic. The screen
 * lists the working-tree changes and commits them.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-git-"));
const secondProject = mkdtempSync(path.join(tmpdir(), "proj-git-second-"));

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: project, encoding: "utf8" });
}

test.beforeAll(async () => {
  // A real repo with an initial commit, then an uncommitted new file.
  execFileSync("git", ["init", "-b", "main", project], { encoding: "utf8" });
  git(["config", "user.email", "test@agent-deck.local"]);
  git(["config", "user.name", "Agent Deck Test"]);
  writeFileSync(path.join(project, "README.md"), "# project\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);
  writeFileSync(path.join(project, "feature.ts"), "export const x = 1;\n");

  execFileSync("git", ["init", "-b", "second", secondProject], { encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test@agent-deck.local"], {
    cwd: secondProject,
  });
  execFileSync("git", ["config", "user.name", "Agent Deck Test"], { cwd: secondProject });
  writeFileSync(path.join(secondProject, "README.md"), "# second project\n");
  execFileSync("git", ["add", "-A"], { cwd: secondProject });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: secondProject });

  harness = await startHarness({ chunkDelayMs: 20 });
  for (const projectPath of [project, secondProject]) {
    const response = await fetch(`${harness.baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
    if (!response.ok) throw new Error(await response.text());
  }
});

test.afterAll(async () => {
  await harness.close();
});

test("shows working-tree changes and commits them", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);

  // Invoke Commit all from another view. GitScreen owns the guard: with no
  // message it navigates to Git and focuses the existing message field without
  // issuing a commit request.
  await page.getByTestId("nav-projects").click();
  let commitRequests = 0;
  let releaseRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && /\/git\/commit$/.test(url.pathname)) commitRequests += 1;
    if (request.method() === "POST" && /\/release$/.test(url.pathname)) releaseRequests += 1;
  });
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Commit all");
  await page.locator('[data-command="command:git.commit"]').click();

  // The branch and the uncommitted new file are surfaced after status settles.
  await expect(page.getByTestId("git-branch")).toHaveText("main");
  await expect(page.locator('[data-git-path="feature.ts"]')).toBeVisible();
  const commitMessage = page.getByTestId("git-commit-message");
  await expect(commitMessage).toBeFocused();
  expect(commitRequests).toBe(0);
  await expect(page.getByTestId("toast")).toContainText("Enter a commit message");
  await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 6_000 });

  // A valid message uses the existing commit-all handler. The one-shot request
  // is cleared before dispatch, so rerenders cannot duplicate the POST.
  await commitMessage.fill("Add feature.ts");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Commit all");
  await page.locator('[data-command="command:git.commit"]').click();
  await expect.poll(() => commitRequests).toBe(1);

  // A success toast confirms the commit, then auto-dismisses.
  const toast = page.getByTestId("toast");
  await expect(toast).toHaveText(/Committed/);
  await expect(toast).toHaveAttribute("data-kind", "success");
  await expect(toast).toHaveCount(0, { timeout: 6_000 }); // auto-dismissed

  // The working tree goes clean and the file leaves the list.
  await expect(page.getByTestId("git-clean")).toBeVisible();
  await expect(page.locator('[data-git-path="feature.ts"]')).toHaveCount(0);

  // The commit really landed in the repo.
  expect(git(["log", "--oneline"])).toContain("Add feature.ts");
  expect(git(["status", "--porcelain"]).trim()).toBe("");
  expect(commitRequests).toBe(1);

  // Release commands open the existing preflight panel; they never perform the
  // release POST directly. Exercise this from another view as well.
  await page.getByTestId("nav-projects").click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Release");
  await page.locator('[data-command="command:git.release"]').click();
  await expect(page.getByTestId("git-release-panel")).toBeVisible();
  expect(releaseRequests).toBe(0);
  await page.getByTestId("git-release-close").click();
});

test("a delayed status cannot mutate or overwrite a newly selected project", async ({ page }) => {
  const response = await fetch(`${harness.baseUrl}/projects`);
  const { projects } = (await response.json()) as {
    projects: Array<{ id: string; path: string }>;
  };
  const firstId = projects.find((entry) => entry.path === project)!.id;

  let releaseFirstStatus!: () => void;
  const firstStatusReleased = new Promise<void>((resolve) => {
    releaseFirstStatus = resolve;
  });
  let markFirstStatusStarted!: () => void;
  const firstStatusStarted = new Promise<void>((resolve) => {
    markFirstStatusStarted = resolve;
  });
  let pushRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/git\/push$/.test(new URL(request.url()).pathname)) {
      pushRequests += 1;
    }
  });
  await page.route("**/projects/*/git/status", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === `/projects/${firstId}/git/status`) {
      markFirstStatusStarted();
      await firstStatusReleased;
    }
    await route.continue();
  });

  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-projects").click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Push branch");
  await page.locator('[data-command="command:git.push"]').click();
  await firstStatusStarted;
  await expect(page.getByTestId("git-status-loading")).toBeVisible();
  await expect(page.getByTestId("git-push")).toHaveCount(0);

  await selectProject(page, path.basename(secondProject));
  await expect(page.getByTestId("git-branch")).toHaveText("second");
  await expect(page.getByTestId("toast")).toContainText("selected project changed");
  expect(pushRequests).toBe(0);

  // Let the old project's response arrive last. It must not replace the second
  // project's ready status or revive the cleared one-shot command.
  const staleResponse = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === `/projects/${firstId}/git/status`,
  );
  releaseFirstStatus();
  await staleResponse;
  await page.waitForTimeout(50);
  await expect(page.getByTestId("git-branch")).toHaveText("second");
  await expect.poll(() => pushRequests).toBe(0);
  await page.unroute("**/projects/*/git/status");
});

test("rejects an empty commit and reports it", async () => {
  // Nothing left to commit after the previous test.
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

test("git-automation setting gates the commit/push actions (native piAgentGitAutomationEnabled)", async ({
  page,
}) => {
  const settings = `${harness.baseUrl}/settings`;
  const setGit = (on: boolean) =>
    fetch(settings, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gitAutomation: on }),
    });

  // Off → the screen becomes a read-only status view (no commit box).
  await setGit(false);
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("git-actions-off")).toBeVisible();
  await expect(page.getByTestId("git-commit-message")).toHaveCount(0);

  // On → the commit action returns. Restored on so the setting is left enabled.
  await setGit(true);
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("git-commit-message")).toBeVisible();
});
