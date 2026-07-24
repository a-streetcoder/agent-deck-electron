import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Session worktree isolation (native piAgentSessionsUseWorktree): with the
 * setting on, selecting a git-repo project starts the session in an isolated
 * worktree, and the Git screen offers a Merge action to bring the work back.
 */

let harness: E2eHarness;
const repo = mkdtempSync(path.join(tmpdir(), "wt-e2e-"));
const nonRepo = mkdtempSync(path.join(tmpdir(), "wt-e2e-nonrepo-"));

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

test.beforeAll(async () => {
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("a mandatory-isolation failure announces a practical error without activating a phantom session", async ({
  page,
}) => {
  await fetch(`${harness.baseUrl}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worktreeIsolation: true }),
  });
  const added = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: nonRepo }),
  });
  const { project } = (await added.json()) as { project: { id: string } };

  await page.goto(harness.baseUrl);
  // Let bootstrap activate its All Projects session first; this is the prior
  // transport the failed project activation must disconnect.
  await expect(page.getByTestId("session-cwd")).toBeVisible();
  let delayed = false;
  await page.route(`${harness.baseUrl}/sessions`, async (route) => {
    if (route.request().method() !== "POST" || delayed) {
      await route.continue();
      return;
    }
    delayed = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  const picker = page.getByTestId("project-picker");
  await picker.focus();
  await expect(picker).toHaveAttribute("aria-haspopup", "dialog");
  await picker.press("Enter");
  await expect(page.getByRole("dialog", { name: "Choose a project" })).toBeVisible();
  const allProjectsItem = page.getByTestId("project-all-projects");
  await expect(allProjectsItem).toHaveAttribute("aria-pressed", "true");
  await expect(allProjectsItem).toBeFocused();
  await allProjectsItem.press("ArrowDown");
  const projectItem = page.getByTestId(`project-${path.basename(nonRepo)}`);
  await expect(projectItem).toHaveAttribute("aria-pressed", "false");
  await expect(projectItem).toBeFocused();
  await projectItem.press("Enter");

  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("error-banner")).toContainText(
    "Fix the project's Git state or disable worktree isolation, then try again.",
  );
  await expect(page.getByTestId("error-banner")).not.toContainText('{"code"');
  await expect(page.getByTestId("session-cwd")).toHaveCount(0);
  await expect(picker).toContainText(path.basename(nonRepo));
  await expect(picker).toBeFocused();
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveAttribute("aria-busy", "false");
  await page.getByTestId("composer-input").fill("must not send to the prior session");
  await expect(page.getByTestId("send-button")).toBeDisabled();
  await page.getByTestId("composer-input").press("Enter");

  const sessions = await fetch(
    `${harness.baseUrl}/sessions?projectId=${encodeURIComponent(project.id)}`,
  );
  expect(((await sessions.json()) as { sessions: unknown[] }).sessions).toEqual([]);

  // Existing selection + the global alert are the retry path: after disabling
  // isolation, keyboard-selecting the same project succeeds and restores focus.
  await page.unroute(`${harness.baseUrl}/sessions`);
  await fetch(`${harness.baseUrl}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worktreeIsolation: false }),
  });
  await picker.press("Enter");
  await expect(projectItem).toHaveAttribute("aria-pressed", "true");
  await expect(projectItem).toBeFocused();
  await projectItem.press("Enter");
  await expect(page.getByTestId("session-cwd")).toHaveText(nonRepo);
  await expect(picker).toBeFocused();
});

test("an isolated session runs in a worktree and offers Merge on the Git screen", async ({
  page,
}) => {
  // Turn on worktree isolation and register the git repo, then select it — which
  // starts a session that (because the setting is on) runs in its own worktree.
  await fetch(`${harness.baseUrl}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worktreeIsolation: true }),
  });
  const added = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: repo }),
  });
  expect(added.ok).toBe(true);
  const { project } = (await added.json()) as { project: { id: string } };

  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("session-cwd")).toBeVisible();
  let sessionPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url() === `${harness.baseUrl}/sessions`) {
      sessionPosts += 1;
    }
  });
  const picker = page.getByTestId("project-picker");
  await picker.click();
  const projectItem = page.getByTestId(`project-${path.basename(repo)}`);
  await projectItem.evaluate((element) => {
    const button = element as unknown as { click(): void };
    button.click();
    button.click();
  });

  // Same-turn duplicate activation produces exactly one request/worktree/session.
  await expect(page.getByTestId("session-cwd")).not.toHaveText(repo);
  await expect.poll(() => sessionPosts).toBe(1);
  const projectSessions = async (): Promise<unknown[]> => {
    const response = await fetch(
      `${harness.baseUrl}/sessions?projectId=${encodeURIComponent(project.id)}`,
    );
    return ((await response.json()) as { sessions: unknown[] }).sessions;
  };
  await expect.poll(async () => (await projectSessions()).length).toBe(1);

  // New Chat still works after activation disconnected the prior transport.
  const firstWorktree = await page.getByTestId("session-cwd").textContent();
  await page.getByTestId("new-chat").click();
  await expect.poll(() => sessionPosts).toBe(2);
  await expect.poll(async () => (await projectSessions()).length).toBe(2);
  await expect.poll(() => page.getByTestId("session-cwd").textContent()).not.toBe(firstWorktree);

  // The Git screen surfaces the worktree + a Merge action back to `main`.
  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("git-worktree-banner")).toBeVisible();
  await expect(page.getByTestId("git-merge")).toContainText("Merge to main");
});
