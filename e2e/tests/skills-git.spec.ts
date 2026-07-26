import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Skills git-import (native SkillRepositorySync, import half): a real local git
 * repo is the hermetic fixture — `git clone` accepts a filesystem path, so the
 * whole flow runs with no network. The repo holds a skill in a subdirectory.
 */

let harness: E2eHarness;
const sourceRepo = path.join(tmpdir(), `skillsrc-${path.basename(tmpdir())}-${Date.now()}`);

function git(args: string[]): void {
  execFileSync("git", args, { cwd: sourceRepo, encoding: "utf8" });
}

test.beforeAll(async () => {
  // A committed source repo with one skill under web-scraper/.
  mkdirSync(path.join(sourceRepo, "web-scraper"), { recursive: true });
  writeFileSync(
    path.join(sourceRepo, "web-scraper", "SKILL.md"),
    "---\nname: web-scraper\ndescription: Scrape web pages\n---\nHow to scrape.\n",
  );
  writeFileSync(path.join(sourceRepo, "web-scraper", "helper.py"), "print('hi')\n");
  execFileSync("git", ["init", "-b", "main", sourceRepo], { encoding: "utf8" });
  git(["config", "user.email", "test@agent-deck.local"]);
  git(["config", "user.name", "Agent Deck Test"]);
  git(["add", "-A"]);
  git(["commit", "-m", "add web-scraper skill"]);

  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("imports a skill from a git repository and it lands in the catalog", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();

  // Open the git-import input and clone from the local repo path (no network).
  await page.getByTestId("skill-import-git").click();
  await page.getByTestId("skill-import-git-url").fill(sourceRepo);
  await page.getByTestId("skill-import-git-confirm").click();

  // The imported skill appears in the list…
  await expect(page.locator('[data-skill-name="web-scraper"]')).toBeVisible();

  // …and its whole directory is exposed from an app-private immutable snapshot,
  // never copied into or read from the global catalog.
  const { skills } = (await (await fetch(`${harness.baseUrl}/resources/skills`)).json()) as {
    skills: Array<{ name: string; baseDir: string }>;
  };
  const snapshot = skills.find((skill) => skill.name === "web-scraper")!.baseDir;
  expect(snapshot).toContain(`${path.sep}SkillRepositorySnapshots${path.sep}`);
  expect(existsSync(path.join(snapshot, "SKILL.md"))).toBe(true);
  expect(existsSync(path.join(snapshot, "helper.py"))).toBe(true);
  expect(readFileSync(path.join(snapshot, "SKILL.md"), "utf8")).toContain("Scrape web pages");
  expect(existsSync(path.join(harness.piHome, ".pi", "agent", "skills", "web-scraper"))).toBe(
    false,
  );
});

test("shows readable skill inventory load failures", async ({ page }) => {
  await page.route(/\/resources\/skills(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "Skill inventory is temporarily unavailable." },
    });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  await expect(page.getByTestId("error-banner")).toHaveText(
    "Error: Skill inventory is temporarily unavailable.",
  );
});

test("shows readable skill repository load failures", async ({ page }) => {
  await page.route(/\/resources\/skill-repos$/, async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "Skill repositories are temporarily unavailable." },
    });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  await expect(page.getByTestId("error-banner")).toHaveText(
    "Error: Skill repositories are temporarily unavailable.",
  );
});

test("quarantined repository skips checks and supports record-only removal with focus restoration", async ({
  page,
}) => {
  const unavailableId = "unavailable-repo";
  const safeId = "safe-repo";
  const checked: string[] = [];
  await page.route(/\/resources\/skill-repos$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        repos: [
          {
            id: unavailableId,
            remoteUrl: "https://example.invalid/unavailable.git",
            storageMode: "collection-v1",
            skillNames: [],
            lastSyncedCommit: "abc",
            importedAt: new Date(0).toISOString(),
            available: false,
            unavailable: {
              code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE",
              message: "Restore the original directory and restart Agent Deck.",
            },
          },
          {
            id: safeId,
            remoteUrl: "https://example.invalid/safe.git",
            storageMode: "collection-v1",
            skillNames: [],
            lastSyncedCommit: "def",
            importedAt: new Date(0).toISOString(),
            available: true,
          },
        ],
      },
    });
  });
  await page.route("**/resources/skill-repos/*/check", async (route) => {
    checked.push(route.request().url());
    await route.fulfill({ status: 200, json: { updateAvailable: false } });
  });
  await page.route(`**/resources/skill-repos/${unavailableId}/record`, async (route) => {
    await route.fulfill({ status: 200, json: { ok: true, removedRecordOnly: true } });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  await expect(page.getByTestId(`skill-repo-unavailable-${unavailableId}`)).toBeVisible();
  await expect(page.getByTestId(`skill-repo-unavailable-guidance-${unavailableId}`)).toContainText(
    "restart Agent Deck",
  );
  await expect(page.getByTestId(`skill-repo-update-${unavailableId}`)).toBeDisabled();
  await expect(page.getByTestId(`skill-repo-forget-${unavailableId}`)).toBeDisabled();
  await expect.poll(() => checked.some((url) => url.includes(safeId))).toBe(true);
  expect(checked.some((url) => url.includes(unavailableId))).toBe(false);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId(`skill-repo-remove-record-${unavailableId}`).click();
  await expect(page.getByTestId(`skill-repo-${unavailableId}`)).toHaveCount(0);
  await expect(page.getByTestId("skill-repo-record-removal-status")).toHaveText(
    "Unavailable repository record removed. Clone files were left untouched.",
  );
  await expect(page.getByTestId(`skill-repo-update-${safeId}`)).toBeFocused();
});

test("record-only removal failure restores focus and reports an actionable error", async ({
  page,
}) => {
  const id = "unavailable-error";
  await page.route(/\/resources\/skill-repos$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        repos: [
          {
            id,
            remoteUrl: "https://example.invalid/unavailable.git",
            storageMode: "collection-v1",
            skillNames: [],
            lastSyncedCommit: "abc",
            importedAt: new Date(0).toISOString(),
            available: false,
          },
        ],
      },
    });
  });
  await page.route(`**/resources/skill-repos/${id}/record`, async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "Persistence is temporarily unavailable." },
    });
  });
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  const remove = page.getByTestId(`skill-repo-remove-record-${id}`);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(page.getByTestId("error-banner")).toContainText(
    "Persistence is temporarily unavailable.",
  );
  await expect(remove).toBeFocused();
});

test("a bad repo URL reports a clone error", async () => {
  const res = await fetch(`${harness.baseUrl}/resources/skills/import-git`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", url: path.join(tmpdir(), "does-not-exist-repo") }),
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("clone");
});

test("lists the imported repo, badges an upstream update, and pulls it", async ({ page }) => {
  // Import happened in the first test (shared harness). Fetch the repo id.
  const { repos } = (await (await fetch(`${harness.baseUrl}/resources/skill-repos`)).json()) as {
    repos: Array<{ id: string }>;
  };
  const id = repos[0]!.id;

  // Upstream advances.
  writeFileSync(
    path.join(sourceRepo, "web-scraper", "SKILL.md"),
    "---\nname: web-scraper\ndescription: Scrape web pages\n---\nHow to scrape MUCH faster.\n",
  );
  git(["commit", "-am", "faster"]);

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();

  // The repo is listed and the mount check badges it as updatable.
  await expect(page.getByTestId(`skill-repo-${id}`)).toBeVisible();
  await expect(page.getByTestId(`skill-repo-updatable-${id}`)).toBeVisible();

  // Update pulls the change; the badge clears and the catalog skill reflects it.
  await page.getByTestId(`skill-repo-update-${id}`).click();
  await expect(page.getByTestId(`skill-repo-updatable-${id}`)).toHaveCount(0);
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.baseUrl}/resources/skills`);
      const body = (await response.json()) as {
        skills: Array<{ name: string; baseDir: string }>;
      };
      const root = body.skills.find((skill) => skill.name === "web-scraper")?.baseDir;
      return root
        ? readFileSync(path.join(root, "SKILL.md"), "utf8").includes("MUCH faster")
        : false;
    })
    .toBe(true);
});

test("tracks concurrent repository operations with independent accessible busy labels", async ({
  page,
}) => {
  const updateId = "concurrent-update";
  const forgetId = "concurrent-forget";
  let updateRequests = 0;
  let forgetRequests = 0;
  let releaseUpdate!: () => void;
  let releaseForget!: () => void;
  const updatePending = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const forgetPending = new Promise<void>((resolve) => {
    releaseForget = resolve;
  });

  await page.route(/\/resources\/skill-repos$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        repos: [
          {
            id: updateId,
            remoteUrl: "https://example.invalid/update.git",
            skillNames: ["update-skill"],
            lastSyncedCommit: "abc123",
            importedAt: new Date(0).toISOString(),
          },
          {
            id: forgetId,
            remoteUrl: "https://example.invalid/forget.git",
            skillNames: ["forget-skill"],
            lastSyncedCommit: "def456",
            importedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
  });
  await page.route("**/resources/skill-repos/*/check", async (route) => {
    await route.fulfill({ status: 200, json: { updateAvailable: false } });
  });
  await page.route(`**/resources/skill-repos/${updateId}/update`, async (route) => {
    updateRequests += 1;
    await updatePending;
    await route.fulfill({ status: 200, json: { conflicts: [] } });
  });
  await page.route(`**/resources/skill-repos/${forgetId}`, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    forgetRequests += 1;
    await forgetPending;
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  const update = page.getByTestId(`skill-repo-update-${updateId}`);
  const forget = page.getByTestId(`skill-repo-forget-${forgetId}`);
  await update.click();
  await forget.click();

  await expect.poll(() => updateRequests).toBe(1);
  await expect.poll(() => forgetRequests).toBe(1);
  await expect(update).toBeDisabled();
  await expect(update).toHaveAccessibleName("Updating…");
  await expect(forget).toBeDisabled();
  await expect(forget).toHaveAccessibleName("Forgetting…");
  await expect(page.getByTestId(`skill-repo-${updateId}`)).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId(`skill-repo-${forgetId}`)).toHaveAttribute("aria-busy", "true");

  // Programmatic duplicate clicks exercise the synchronous guards rather than
  // relying only on the disabled presentation.
  await update.evaluate((button: { dispatchEvent(event: Event): boolean }) => {
    button.dispatchEvent(new Event("click", { bubbles: true }));
  });
  await forget.evaluate((button: { dispatchEvent(event: Event): boolean }) => {
    button.dispatchEvent(new Event("click", { bubbles: true }));
  });
  expect(updateRequests).toBe(1);
  expect(forgetRequests).toBe(1);

  releaseUpdate();
  await expect(update).toBeEnabled();
  await expect(update).toHaveAccessibleName("Update");
  await expect(forget).toBeDisabled();
  await expect(forget).toHaveAccessibleName("Forgetting…");

  releaseForget();
  await expect(page.getByTestId(`skill-repo-${forgetId}`)).toHaveCount(0);
});

test("supports accessible mixed path choices, busy guards, failure focus, and persisted reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  const id = "path-conflicts";
  const longPath = `nested/${"very-long-segment-".repeat(12)}asset.txt`;
  let persisted = false;
  let attempts = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releaseMovedFailure!: () => void;
  const movedFailure = new Promise<void>((resolve) => {
    releaseMovedFailure = resolve;
  });
  const merge = {
    name: "conflicted-skill",
    mergeId: "merge-generation-one",
    paths: [
      { path: "alpha.txt", local: "file", remote: "file" },
      { path: longPath, local: "file", remote: "missing" },
    ],
  };
  let activeMerge = merge;
  const nextMerge = {
    name: "next-conflicted-skill",
    mergeId: "merge-generation-two",
    paths: Array.from({ length: 12 }, (_, index) => ({
      path: `next-${index}.txt`,
      local: "file" as const,
      remote: "file" as const,
    })),
  };
  await page.route(/\/resources\/skill-repos$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        repos: [
          {
            id,
            remoteUrl: "https://example.invalid/path.git",
            skillNames: [merge.name],
            lastSyncedCommit: "abc123",
            importedAt: new Date(0).toISOString(),
            pendingMerges: persisted ? [activeMerge, nextMerge] : [],
          },
        ],
      },
    });
  });
  await page.route(`**/resources/skill-repos/${id}/check`, (route) =>
    route.fulfill({ status: 200, json: { updateAvailable: true } }),
  );
  await page.route(`**/resources/skill-repos/${id}/update`, async (route) => {
    persisted = true;
    await route.fulfill({
      status: 200,
      json: {
        conflicts: [merge.name, nextMerge.name],
        mergeConflicts: [activeMerge, nextMerge],
      },
    });
  });
  await page.route(`**/resources/skill-repos/${id}/refresh-merge`, async (route) => {
    activeMerge = { ...merge, mergeId: "merge-generation-refreshed" };
    await route.fulfill({ status: 200, json: { mergeConflict: activeMerge } });
  });
  await page.route(`**/resources/skill-repos/${id}/resolve`, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 409,
        json: { code: "LEGACY_MERGE_STALE", error: "Prepared state is stale." },
      });
      return;
    }
    if (attempts === 2) {
      await movedFailure;
      await route.fulfill({ status: 409, json: { error: "Second stale response." } });
      return;
    }
    await pending;
    persisted = false;
    await route.fulfill({ status: 200, json: { ok: true, conflicts: [] } });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  await page.getByTestId(`skill-repo-update-${id}`).click();
  const group = page.getByRole("group", { name: `Conflicting paths for ${merge.name}` });
  const mine = group.getByLabel("Keep Mine for alpha.txt");
  const remote = group.getByLabel("Take Remote for alpha.txt");
  await expect(mine).toBeChecked();
  await remote.focus();
  await page.keyboard.press("Space");
  await expect(remote).toBeChecked();
  const longRow = group.getByTitle(longPath);
  await expect(longRow).toBeVisible();
  await expect(longRow).toHaveClass(/truncate/);

  const apply = page.getByTestId(`skill-conflict-apply-${id}-${merge.name}`);
  await apply.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("error-banner")).toContainText("Prepared state is stale");
  await expect(apply).toBeFocused();
  const refresh = page.getByTestId(`skill-conflict-refresh-${id}-${merge.name}`);
  await refresh.click();
  await expect(page.getByTestId("skill-merge-status")).toContainText("Choices reset to Keep Mine");
  await expect(group.getByLabel("Keep Mine for alpha.txt")).toBeChecked();
  await expect(apply).toBeFocused();
  const panels = page.getByTestId("skill-management-panels");
  await expect
    .poll(() => panels.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();

  await page.reload();
  await page.getByTestId("nav-skills").click();
  const restoredApply = page.getByTestId(`skill-conflict-apply-${id}-${merge.name}`);
  await expect(restoredApply).toBeVisible();
  await restoredApply.click();
  await expect.poll(() => attempts).toBe(2);
  const updateButton = page.getByTestId(`skill-repo-update-${id}`);
  await updateButton.focus();
  releaseMovedFailure();
  await expect(page.getByTestId("error-banner")).toContainText("Second stale response");
  await expect(updateButton).toBeFocused();

  await restoredApply.click();
  await expect(restoredApply).toBeDisabled();
  await restoredApply.evaluate((button: { click(): void }) => button.click());
  expect(attempts).toBe(3);
  release();
  await expect(restoredApply).toHaveCount(0);
  const nextApply = page.getByTestId(`skill-conflict-apply-${id}-${nextMerge.name}`);
  await expect(nextApply).toBeFocused();
  await expect(page.getByTestId("skill-merge-status")).toHaveText(
    `Conflict choices applied for ${merge.name}.`,
  );
  await nextApply.click();
  await expect(page.getByTestId(`skill-repo-conflicts-${id}`)).toHaveCount(0);
  await expect(page.getByTestId(`skill-repo-update-${id}`)).toBeFocused();
});

test("keeps browser recovery visible when OS Trash is unavailable and allows restore", async ({
  page,
}) => {
  const recovery = {
    token: ".agent-deck-resource-recovery-v1-8-recovery-0123456789abcdef0123456789abcdef",
    skillName: "recovery",
  };
  await page.route(/\/resources\/skill-recoveries$/, (route) =>
    route.fulfill({ status: 200, json: { recoveries: [recovery] } }),
  );
  await page.route(`**/resources/skill-recoveries/${recovery.token}/restore`, (route) =>
    route.fulfill({ status: 200, json: { ok: true } }),
  );
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  const card = page.getByTestId("skill-recovery-recovery");
  await expect(card).toContainText("Removed from the active catalog but retained safely");
  await page.getByTestId("skill-recovery-trash-recovery").click();
  await expect(page.getByTestId("error-banner")).toContainText(
    "Move to Trash is available in the desktop app",
  );
  await expect(card).toBeVisible();
  await page.getByTestId("skill-recovery-restore-recovery").click();
  await expect(card).toHaveCount(0);
});

// Obsolete collection-v1 behavior: managed skills are discovered from native,
// app-private snapshots and no editable global catalog copy exists. Legacy copy
// conflict behavior remains covered by server skill-repo-legacy tests.
test.skip("holds a locally-edited skill as a conflict and resolves it Take Remote", async ({
  page,
}) => {
  const { repos } = (await (await fetch(`${harness.baseUrl}/resources/skill-repos`)).json()) as {
    repos: Array<{ id: string }>;
  };
  const id = repos[0]!.id;
  const skillMd = path.join(harness.piHome, ".pi", "agent", "skills", "web-scraper", "SKILL.md");

  // The user edits the catalog copy locally; upstream also changes it.
  writeFileSync(
    skillMd,
    "---\nname: web-scraper\ndescription: Scrape web pages\n---\nLOCAL EDIT.\n",
  );
  writeFileSync(
    path.join(sourceRepo, "web-scraper", "SKILL.md"),
    "---\nname: web-scraper\ndescription: Scrape web pages\n---\nUPSTREAM V3.\n",
  );
  git(["commit", "-am", "v3"]);

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();

  // Update holds the edit → a conflict block with Keep-Mine / Take-Remote.
  await page.getByTestId(`skill-repo-update-${id}`).click();
  await expect(page.getByTestId(`skill-repo-conflicts-${id}`)).toBeVisible();
  await expect(page.getByTestId(`skill-conflict-remote-${id}-web-scraper`)).toBeVisible();
  expect(readFileSync(skillMd, "utf8")).toContain("LOCAL EDIT"); // not overwritten

  // Take Remote → the upstream version wins and the conflict clears.
  await page.getByTestId(`skill-conflict-remote-${id}-web-scraper`).click();
  await expect(page.getByTestId(`skill-repo-conflicts-${id}`)).toHaveCount(0);
  await expect.poll(() => readFileSync(skillMd, "utf8").includes("UPSTREAM V3")).toBe(true);
});
