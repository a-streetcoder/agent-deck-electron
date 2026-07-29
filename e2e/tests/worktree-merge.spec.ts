import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Slice 20 gate: the worktree review-then-merge flow in the diff panel. With
 * worktree isolation ON, selecting a git-repo project starts the session in an
 * isolated worktree; a real pi turn writes a file INTO that worktree, the diff
 * panel (the review surface — the working-tree-vs-HEAD diff IS the full
 * uncommitted branch delta) shows the branch toolbar with the Merge action, and
 * clicking Merge auto-commits + merges the work back into the source branch,
 * clearing the now-empty diff.
 */

let harness: E2eHarness;
const repo = mkdtempSync(path.join(tmpdir(), "wt-merge-e2e-"));
let worktreeFileContent = "worktree change one\nworktree change two\n";

// The absolute path pi should write to — set at test time to a path INSIDE the
// session's dynamically-named worktree (the toolCall closure is fixed at
// beforeAll, so it reads this mutable module variable).
let writeTarget = "";

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

  harness = await startHarness({
    chunkDelayMs: 20,
    reply: () => "Wrote the worktree file for you.",
    // The "write the worktree file" turn drives pi's real `write` tool once,
    // into the worktree path captured by the test (writeTarget).
    toolCall: (lastUser, body) => {
      const lastUserIndex = body.messages.map((m) => m.role).lastIndexOf("user");
      const toolRanThisTurn = body.messages.slice(lastUserIndex + 1).some((m) => m.role === "tool");
      if (toolRanThisTurn) return null;
      if (lastUser.includes("write the worktree file") && writeTarget) {
        return { name: "write", arguments: { path: writeTarget, content: worktreeFileContent } };
      }
      return null;
    },
  });

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
});

test.afterAll(async () => {
  if (harness) await harness.close();
});

test("review a worktree session's diff and merge it back from the diff panel", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(repo));

  // The session runs in its own worktree (cwd != the project root). That cwd is
  // the worktree path — the target pi writes into this turn.
  const cwdLocator = page.getByTestId("session-cwd");
  await expect(cwdLocator).not.toHaveText(repo);
  const worktreePath = (await cwdLocator.textContent())?.trim() ?? "";
  expect(worktreePath.length).toBeGreaterThan(0);
  writeTarget = path.join(worktreePath, "wt-note.txt");

  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // One turn writes the file into the worktree; the turn boundary pushes the
  // changed set and badges it.
  await page.getByTestId("composer-input").fill("please write the worktree file");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("diff-badge")).toHaveText("1", { timeout: 30_000 });

  // Open the diff panel: it hosts the worktree branch toolbar + the Merge action.
  await page.getByTestId("diff-toggle").click();
  await expect(page.getByTestId("diff-panel")).toBeVisible();
  await expect(page.getByTestId("diff-worktree-toolbar")).toBeVisible();
  const mergeButton = page.getByTestId("diff-merge");
  await expect(mergeButton).toContainText("Merge to main");
  await expect(page.getByTestId("diff-file-count")).toHaveText("1");

  // Merge: the server auto-commits the uncommitted worktree work and merges it
  // (--no-ff) into main, returning the commit count → success toast.
  await mergeButton.click();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText(/Merged 1 commit into main/, { timeout: 30_000 });
  await expect(toast).toHaveAttribute("data-kind", "success");

  // The merge committed + merged the work, so the working-tree diff is now empty
  // — the panel refreshes to the no-changes state without a user action.
  await expect(page.getByTestId("diff-file-count")).toHaveText("0", { timeout: 30_000 });
  await expect(page.getByTestId("diff-empty")).toBeVisible();

  // Default/current behavior retains the checkout and owned branch, so this
  // same session can continue and merge again.
  expect(existsSync(worktreePath)).toBe(true);
  expect(
    execFileSync("git", ["branch", "--list", "agent-deck/session-*"], { cwd: repo })
      .toString()
      .trim(),
  ).not.toBe("");

  // The persistent Git surface exposes the policy to existing users. Isolation
  // is on, so Keep is enabled, keyboard-operable, and defaults to retained.
  await page.getByTestId("nav-git").click();
  await expect(page.getByTestId("git-worktree-preferences")).toBeVisible();
  const isolationPreference = page.getByTestId("git-pref-worktree-isolation");
  const keepPreference = page.getByTestId("git-pref-keep-worktree");
  await expect(isolationPreference).toHaveAttribute("aria-checked", "true");
  await expect(keepPreference).toBeEnabled();
  await expect(keepPreference).toHaveAttribute("aria-checked", "true");
  await expect(keepPreference).toHaveAccessibleDescription(/Applies only when isolation is on/);

  // Its disabled dependency is live and persisted too.
  await isolationPreference.focus();
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
    ),
    isolationPreference.press("Space"),
  ]);
  await expect(isolationPreference).toHaveAttribute("aria-checked", "false");
  await expect(keepPreference).toBeDisabled();
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
    ),
    isolationPreference.press("Space"),
  ]);
  await expect(isolationPreference).toHaveAttribute("aria-checked", "true");
  await expect(keepPreference).toBeEnabled();

  await keepPreference.focus();
  const [policyResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
    ),
    keepPreference.press("Space"),
  ]);
  expect(policyResponse.ok()).toBe(true);
  await expect(keepPreference).toHaveAttribute("aria-checked", "false");
  const persistedPolicy = (await (await fetch(`${harness.baseUrl}/settings`)).json()) as {
    settings: { keepWorktreeAfterMerge: boolean };
  };
  expect(persistedPolicy.settings.keepWorktreeAfterMerge).toBe(false);

  // Return to the same retained session and make a second iteration.
  await page.getByTestId("sessions-expand").click();
  const expandedSessions = page.getByTestId("sessions-expanded");
  await expect(expandedSessions).toBeVisible();
  await expandedSessions.locator('[role="button"][data-testid^="chat-"]').first().click();
  await expandedSessions.getByTestId("sessions-collapse").click();
  await expect(expandedSessions).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  worktreeFileContent = "a second iteration after the retained merge\n";
  await page.getByTestId("composer-input").fill("please write the worktree file again");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("diff-badge")).toHaveText("1", { timeout: 30_000 });
  if (!(await page.getByTestId("diff-merge").isVisible())) {
    await page.getByTestId("diff-toggle").click();
  }
  await page.getByTestId("diff-merge").click();
  const cleanupToast = page.getByTestId("toast").filter({ hasText: "and removed the worktree" });
  await expect(cleanupToast).toContainText("and removed the worktree", {
    timeout: 30_000,
  });
  await expect(cleanupToast).toHaveAttribute("data-kind", "success");
  await expect(page.getByTestId("diff-worktree-toolbar")).toHaveCount(0);
  expect(existsSync(worktreePath)).toBe(false);
  expect(
    execFileSync("git", ["branch", "--list", "agent-deck/session-*"], { cwd: repo })
      .toString()
      .trim(),
  ).toBe("");

  // Both merges landed on the source branch.
  const merged = execFileSync("git", ["log", "--oneline", "main"], { cwd: repo }).toString();
  expect(merged.match(/Merge/g)?.length).toBe(2);
});
