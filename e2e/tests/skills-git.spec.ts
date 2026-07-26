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

test("tracks concurrent conflict resolutions independently with action-specific labels", async ({
  page,
}) => {
  const id = "concurrent-conflicts";
  const pending = new Map<string, () => void>();
  const requestCounts = new Map<string, number>();

  await page.route(/\/resources\/skill-repos$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        repos: [
          {
            id,
            remoteUrl: "https://example.invalid/concurrent.git",
            skillNames: ["conflict-a", "conflict-b"],
            lastSyncedCommit: "abc123",
            importedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
  });
  await page.route(`**/resources/skill-repos/${id}/check`, async (route) => {
    await route.fulfill({ status: 200, json: { updateAvailable: true } });
  });
  await page.route(`**/resources/skill-repos/${id}/update`, async (route) => {
    await route.fulfill({ status: 200, json: { conflicts: ["conflict-a", "conflict-b"] } });
  });
  await page.route(`**/resources/skill-repos/${id}/resolve`, async (route) => {
    const { name } = route.request().postDataJSON() as { name: string };
    requestCounts.set(name, (requestCounts.get(name) ?? 0) + 1);
    await new Promise<void>((resolve) => pending.set(name, resolve));
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  await page.getByTestId(`skill-repo-update-${id}`).click();

  const mineA = page.getByTestId(`skill-conflict-mine-${id}-conflict-a`);
  const remoteB = page.getByTestId(`skill-conflict-remote-${id}-conflict-b`);
  await mineA.click();
  await remoteB.click();
  await expect.poll(() => requestCounts.get("conflict-a")).toBe(1);
  await expect.poll(() => requestCounts.get("conflict-b")).toBe(1);
  await expect(mineA).toBeDisabled();
  await expect(mineA).toHaveAccessibleName("Keeping mine for conflict-a…");
  await expect(remoteB).toBeDisabled();
  await expect(remoteB).toHaveAccessibleName("Taking remote folder for conflict-b…");

  pending.get("conflict-b")!();
  await expect(remoteB).toHaveCount(0);
  await expect(mineA).toBeDisabled();
  const update = page.getByTestId(`skill-repo-update-${id}`);
  await expect(update).toBeFocused();
  await mineA.evaluate((button: { click(): void }) => button.click());
  expect(requestCounts.get("conflict-a")).toBe(1);

  pending.get("conflict-a")!();
  await expect(mineA).toHaveCount(0);
  await expect(update).toBeFocused();
});

test("restores keyboard focus after conflict success and rejected retry", async ({ page }) => {
  const id = "conflict-focus";
  let alphaAttempts = 0;
  await page.route(/\/resources\/skill-repos$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        repos: [
          {
            id,
            remoteUrl: "https://example.invalid/focus.git",
            skillNames: ["alpha", "beta", "gamma"],
            lastSyncedCommit: "focus123",
            importedAt: new Date(0).toISOString(),
          },
        ],
      },
    });
  });
  await page.route(`**/resources/skill-repos/${id}/check`, async (route) => {
    await route.fulfill({ status: 200, json: { updateAvailable: true } });
  });
  await page.route(`**/resources/skill-repos/${id}/update`, async (route) => {
    await route.fulfill({ status: 200, json: { conflicts: ["alpha", "beta", "gamma"] } });
  });
  await page.route(`**/resources/skill-repos/${id}/resolve`, async (route) => {
    const { name } = route.request().postDataJSON() as { name: string };
    if (name === "alpha" && alphaAttempts++ === 0) {
      await route.fulfill({ status: 409, json: { error: "Temporary resolution failure." } });
      return;
    }
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  const update = page.getByTestId(`skill-repo-update-${id}`);
  await update.click();

  const betaMine = page.getByTestId(`skill-conflict-mine-${id}-beta`);
  await betaMine.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`skill-conflict-mine-${id}-gamma`)).toBeFocused();

  const gammaRemote = page.getByTestId(`skill-conflict-remote-${id}-gamma`);
  await gammaRemote.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`skill-conflict-mine-${id}-alpha`)).toBeFocused();

  const alphaRemote = page.getByTestId(`skill-conflict-remote-${id}-alpha`);
  await alphaRemote.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`skill-conflict-mine-${id}-alpha`)).toBeEnabled();
  await expect(alphaRemote).toBeEnabled();
  await expect(alphaRemote).toBeFocused();
  await expect(page.getByTestId("error-banner")).toContainText(
    "Couldn't resolve alpha. Temporary resolution failure. Try again.",
  );

  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`skill-repo-conflicts-${id}`)).toHaveCount(0);
  await expect(update).toBeFocused();
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
