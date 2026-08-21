import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Session worktree isolation (native piAgentSessionsUseWorktree): with the
 * setting on, a git-repo project session starts in an isolated worktree.
 * Git stays empty until that screen has its own project picker.
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

test("a mandatory-isolation failure does not activate a phantom session", async ({ page }) => {
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
  await expect(page.getByTestId("session-cwd")).toBeVisible();
  const priorCwd = await page.getByTestId("session-cwd").textContent();

  const created = await page.evaluate(async (projectId) => {
    const response = await fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    return { ok: response.ok, text: await response.text() };
  }, project.id);

  expect(created.ok).toBe(false);
  expect(created.text).toContain(
    "Fix the project's Git state or disable worktree isolation, then try again.",
  );
  await expect(page.getByTestId("session-cwd")).toHaveText(priorCwd ?? "");
  await page.getByTestId("composer-input").fill("must not send to a phantom session");
  await expect(page.getByTestId("send-button")).toBeEnabled();

  const sessions = await fetch(
    `${harness.baseUrl}/sessions?projectId=${encodeURIComponent(project.id)}`,
  );
  expect(((await sessions.json()) as { sessions: unknown[] }).sessions).toEqual([]);

  await fetch(`${harness.baseUrl}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worktreeIsolation: false }),
  });
  await selectProject(page, path.basename(nonRepo));
  await expect(page.getByTestId("session-cwd")).toHaveText(nonRepo);
});

test("an isolated session runs in a worktree", async ({ page }) => {
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
  await selectProject(page, path.basename(repo));

  await expect(page.getByTestId("session-cwd")).not.toHaveText(repo);
  await expect.poll(() => sessionPosts).toBe(1);
  const projectSessions = async (): Promise<unknown[]> => {
    const response = await fetch(
      `${harness.baseUrl}/sessions?projectId=${encodeURIComponent(project.id)}`,
    );
    return ((await response.json()) as { sessions: unknown[] }).sessions;
  };
  await expect.poll(async () => (await projectSessions()).length).toBe(1);

  const firstWorktree = await page.getByTestId("session-cwd").textContent();
  await page.getByTestId("new-chat").click();
  await expect.poll(() => sessionPosts).toBe(2);
  await expect.poll(async () => (await projectSessions()).length).toBe(2);
  await expect.poll(() => page.getByTestId("session-cwd").textContent()).not.toBe(firstWorktree);
  const secondWorktree = (await page.getByTestId("session-cwd").textContent())!;
  const isolated = (await projectSessions()).find(
    (session) => (session as { cwd?: string }).cwd === secondWorktree,
  ) as { id: string; worktreeBranch: string };

  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("app-view-title")).toHaveText("Git");
  await expect(page.getByTestId("git-no-project")).toBeVisible();

  const deleteButton = page.getByTestId("chat-list").getByTestId(`chat-delete-${isolated.id}`);
  await page.getByTestId("chat-list").getByTestId(`chat-${isolated.id}`).hover();
  const canceledMessage = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  await deleteButton.click();
  expect(await canceledMessage).toMatch(
    /worktree and app-owned branch, including any unmerged commits, will be permanently removed/,
  );
  expect(
    (await projectSessions()).some((session) => (session as { id: string }).id === isolated.id),
  ).toBe(true);
  expect(existsSync(secondWorktree)).toBe(true);
  expect(
    execFileSync("git", ["branch", "--list", isolated.worktreeBranch], {
      cwd: repo,
      encoding: "utf8",
    }),
  ).toContain(isolated.worktreeBranch);

  const acceptedMessage = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.accept();
    });
  });
  await deleteButton.click();
  expect(await acceptedMessage).toContain("permanently removed");
  await expect
    .poll(async () =>
      (await projectSessions()).some((session) => (session as { id: string }).id === isolated.id),
    )
    .toBe(false);
  expect(existsSync(secondWorktree)).toBe(false);
  expect(
    execFileSync("git", ["branch", "--list", isolated.worktreeBranch], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
  ).toBe("");
});
