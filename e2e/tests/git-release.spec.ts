import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Release (native ReleaseService, generalized to any repo): the Git screen's
 * Release panel proposes the next version off the latest tag, drafts notes from
 * commits via the mock provider, and tags + pushes to a hermetic bare origin.
 */

let harness: E2eHarness;
const bare = mkdtempSync(path.join(tmpdir(), "rel-bare-"));
const work = mkdtempSync(path.join(tmpdir(), "rel-work-"));

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

test.beforeAll(async () => {
  execFileSync("git", ["init", "--bare", bare], { encoding: "utf8" });
  execFileSync("git", ["init", "-b", "main", work], { encoding: "utf8" });
  gitIn(work, ["config", "user.email", "test@agent-deck.local"]);
  gitIn(work, ["config", "user.name", "Agent Deck Test"]);
  gitIn(work, ["remote", "add", "origin", bare]);
  writeFileSync(path.join(work, "README.md"), "# app\n");
  gitIn(work, ["add", "-A"]);
  gitIn(work, ["commit", "-m", "initial"]);
  gitIn(work, ["tag", "v1.0.0"]);
  gitIn(work, ["push", "-u", "origin", "main"]);
  gitIn(work, ["push", "origin", "v1.0.0"]);
  // A commit after the tag so there is something to release.
  writeFileSync(path.join(work, "export.ts"), "export const x = 1;\n");
  gitIn(work, ["add", "-A"]);
  gitIn(work, ["commit", "-m", "add export feature"]);
  gitIn(work, ["push", "origin", "main"]);

  harness = await startHarness({
    chunkDelayMs: 20,
    reply: () => "### ✨ New features\n- Add an export feature",
  });
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

test("Release proposes the next version, drafts notes, and tags the origin", async ({ page }) => {
  let failNextPreflight = false;
  let overlapPreflight = false;
  let overlapRequestCount = 0;
  let releaseFirstOverlap!: () => void;
  let markFirstOverlapComplete!: () => void;
  const firstOverlapGate = new Promise<void>((resolve) => {
    releaseFirstOverlap = resolve;
  });
  const firstOverlapComplete = new Promise<void>((resolve) => {
    markFirstOverlapComplete = resolve;
  });
  await page.route("**/release/preflight", async (route) => {
    if (overlapPreflight) {
      overlapRequestCount += 1;
      if (overlapRequestCount === 1) {
        await firstOverlapGate;
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              state: "ready",
              branch: "stale-branch",
              upstream: "origin/stale-branch",
              remote: "origin",
              remoteRef: "refs/heads/stale-branch",
              ahead: 0,
              behind: 0,
              headSha: "1".repeat(40),
              blocker: null,
              latestTag: "v9.9.8",
              nextVersions: { patch: "v9.9.9", minor: "v9.10.0", major: "v10.0.0" },
            }),
          })
          .catch(() => {});
        markFirstOverlapComplete();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "detached",
          branch: null,
          upstream: null,
          remote: null,
          remoteRef: null,
          ahead: null,
          behind: null,
          headSha: null,
          blocker: { code: "detached", message: "Second request is the current blocker." },
          latestTag: "v1.0.0",
          nextVersions: { patch: "v1.0.1", minor: "v1.1.0", major: "v2.0.0" },
        }),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (failNextPreflight) {
      failNextPreflight = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            "Release preflight failed for a deliberately long remote https://example.invalid/very/long/remote/path/that/must/wrap/without/overflowing/the/application/window",
        }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(work));
  await expect(page.getByTestId("session-cwd")).toHaveText(work);
  await page.getByTestId("nav-git").click();

  // Opening transfers focus into the panel. Cancel aborts the delayed request,
  // restores the trigger, and a newer response cannot be replaced by the stale one.
  overlapPreflight = true;
  const releaseTrigger = page.getByTestId("git-release");
  await releaseTrigger.focus();
  await releaseTrigger.press("Enter");
  const releaseCancel = page.getByTestId("git-release-close");
  await expect(releaseCancel).toBeFocused();
  await expect(page.getByTestId("git-release-sync-loading")).toBeVisible();
  await releaseCancel.press("Enter");
  await expect(releaseTrigger).toBeFocused();
  await releaseTrigger.press("Enter");
  await expect(page.getByTestId("git-release-blocker")).toHaveText(
    "Second request is the current blocker.",
  );
  await expect(page.getByTestId("git-release-confirm")).toBeDisabled();
  releaseFirstOverlap();
  await firstOverlapComplete;
  await expect(page.getByTestId("git-release-blocker")).toHaveText(
    "Second request is the current blocker.",
  );
  await expect(page.getByTestId("git-release-version-patch")).not.toContainText("v9.9.9");
  overlapPreflight = false;
  await releaseCancel.focus();
  await releaseCancel.press("Enter");
  await expect(releaseTrigger).toBeFocused();

  // A dirty preflight is actionable and cannot be confirmed.
  const dirtyPath = path.join(work, "release-wip.txt");
  writeFileSync(dirtyPath, "wip\n");
  await page.getByTestId("git-release").click();
  await expect(page.getByTestId("git-release-panel")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("git-release-sync-loading")).toHaveText(
    "Checking branch and remote synchronization…",
  );
  await expect(page.getByTestId("git-release-version-patch")).not.toContainText("v1.0.1");
  await expect(page.getByTestId("git-release-blocker")).toContainText("Commit or stash");
  await expect(page.getByTestId("git-release-version-patch")).toBeFocused();
  await expect(page.getByTestId("git-release-confirm")).toBeDisabled();
  await expect(page.getByTestId("git-release-sync")).toContainText("origin/main");
  rmSync(dirtyPath);
  await page.getByTestId("git-release-close").click();

  // A remote branch advance is rendered as an actionable behind blocker.
  const peer = mkdtempSync(path.join(tmpdir(), "release-e2e-peer-"));
  execFileSync("git", ["clone", "--branch", "main", bare, peer]);
  gitIn(peer, ["config", "user.email", "peer@agent-deck.local"]);
  gitIn(peer, ["config", "user.name", "Release Peer"]);
  writeFileSync(path.join(peer, "remote.ts"), "export const remote = true;\n");
  gitIn(peer, ["add", "-A"]);
  gitIn(peer, ["commit", "-m", "remote advance"]);
  gitIn(peer, ["push", "origin", "main"]);
  await page.getByTestId("git-release").click();
  await expect(page.getByTestId("git-release-blocker")).toContainText("1 commit behind");
  await expect(page.getByTestId("git-release-confirm")).toBeDisabled();
  await page.getByTestId("git-release-close").click();
  gitIn(work, ["merge", "--ff-only", "origin/main"]);

  // A failed preflight keeps the panel open, clears versions, and wraps its long error.
  failNextPreflight = true;
  await page.getByTestId("git-release").click();
  await expect(page.getByTestId("git-release-sync-loading")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toContainText("deliberately long remote");
  await expect(page.getByTestId("git-release-close")).toBeFocused();
  await expect(page.getByTestId("git-release-panel")).toBeVisible();
  await expect(page.getByTestId("git-release-confirm")).toBeDisabled();
  await expect(page.getByTestId("error-banner")).toHaveCSS("overflow-wrap", "anywhere");
  await page.getByTestId("git-release-close").click();
  await page.getByTestId("git-release").click();

  // Preflight proposed the next patch off v1.0.0.
  await expect(page.getByTestId("git-release-version-patch")).toContainText("v1.0.1");
  await expect(page.getByTestId("git-release-version-minor")).toContainText("v1.1.0");

  // Pressed-button semantics and keyboard activation select a minor bump.
  const minorBump = page.getByTestId("git-release-version-minor");
  await expect(minorBump).toHaveAttribute("aria-pressed", "false");
  await minorBump.focus();
  await minorBump.press("Enter");
  await expect(minorBump).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("textbox", { name: "Release notes" })).toBeVisible();

  // Draft notes from the commits since the tag.
  await page.getByTestId("git-release-generate").click();
  await expect(page.getByTestId("git-release-notes")).toHaveValue(/New features/, {
    timeout: 15_000,
  });

  await page.getByTestId("git-release-confirm").click();

  // The annotated tag reached the bare origin and closing the successful panel
  // restores keyboard focus to the Release trigger.
  await expect.poll(() => gitIn(bare, ["tag", "-l"])).toContain("v1.1.0");
  await expect(page.getByTestId("git-release")).toBeFocused();

  // A tag created remotely after preflight produces the specific remote
  // conflict (not a generic 409 mapping) and keeps the panel open.
  await page.getByTestId("git-release").click();
  await expect(page.getByTestId("git-release-version-patch")).toContainText("v1.1.1");
  await page.getByTestId("git-release-version-patch").focus();
  await page.getByTestId("git-release-version-patch").press("Space");
  await expect(page.getByTestId("git-release-version-patch")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const head = gitIn(bare, ["rev-parse", "refs/heads/main"]).trim();
  gitIn(bare, ["update-ref", "refs/tags/v1.1.1", head]);
  await page.getByTestId("git-release-confirm").click();
  await expect(page.getByTestId("error-banner")).toContainText(
    "Tag v1.1.1 already exists on origin",
  );
  await expect(page.getByTestId("git-release-panel")).toBeVisible();
});
