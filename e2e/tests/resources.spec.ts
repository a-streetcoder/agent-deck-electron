import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Slice-7 gate: the resource read path is live — builtin agents are listed,
 * scope filters work, and a file created ON DISK while the app is open shows
 * up via the watcher → resources_changed → refetch loop, no reload.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-res-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

/** Register the project via REST (idempotent) so each test is self-contained. */
async function registerProject(): Promise<void> {
  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!response.ok) throw new Error(await response.text());
}

test("agents screen lists builtins and live-updates when files appear on disk", async ({
  page,
}) => {
  await registerProject();
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);

  await page.getByTestId("nav-agents").click();

  // Builtins are present.
  for (const name of ["coder", "explorer", "planner", "reviewer"]) {
    await expect(page.locator(`[data-agent-name="${name}"]`)).toBeVisible();
  }

  // Create a project agent ON DISK while the screen is open → live update.
  const agentsDir = path.join(project, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "tester.md"),
    "---\nname: tester\ndescription: A live-created test agent\ntools: read, grep\n---\n\nYou are tester.\n",
  );
  const testerRow = page.locator('[data-agent-name="tester"]');
  await expect(testerRow).toBeVisible({ timeout: 15_000 });
  await expect(testerRow.getByTestId("scope-chip")).toHaveAttribute("data-scope", "project");

  // Scope filter: "project" shows only the new agent; builtins hidden.
  await page.getByTestId("agent-filter-project").click();
  await expect(page.getByTestId("agent-row")).toHaveCount(1);
  await page.getByTestId("agent-filter-builtin").click();
  await expect(page.locator('[data-agent-name="tester"]')).toHaveCount(0);

  // The "overridden" chip renders and filters: no builtin here carries a
  // settings.json override, so it lists nothing (the true-positive path is
  // unit + resources-integration tested).
  await page.getByTestId("agent-filter-overridden").click();
  await expect(page.getByTestId("agent-row")).toHaveCount(0);

  // Global Pi settings are an exact watch target even when the file did not
  // exist at startup. An editor-style atomic replacement refreshes the open
  // catalog without a page reload.
  const settingsFile = path.join(harness.piHome, ".pi", "agent", "settings.json");
  const settingsTmp = `${settingsFile}.external-edit`;
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(
    settingsTmp,
    JSON.stringify({
      subagents: {
        agentOverrides: {
          coder: { description: "Externally customized coder" },
        },
      },
    }),
  );
  renameSync(settingsTmp, settingsFile);
  await expect(page.locator('[data-agent-name="coder"]')).toBeVisible({ timeout: 15_000 });

  // A malformed manual edit fails closed to pristine builtins; it neither
  // crashes the resource scan nor destroys the user's file.
  writeFileSync(settingsTmp, "{ incomplete json");
  renameSync(settingsTmp, settingsFile);
  await expect(page.getByTestId("agent-row")).toHaveCount(0, { timeout: 15_000 });
  expect(readFileSync(settingsFile, "utf8")).toBe("{ incomplete json");

  writeFileSync(
    settingsTmp,
    JSON.stringify({
      subagents: { agentOverrides: { coder: { description: "Recovered override" } } },
    }),
  );
  renameSync(settingsTmp, settingsFile);
  await expect(page.locator('[data-agent-name="coder"]')).toBeVisible({ timeout: 15_000 });
  unlinkSync(settingsFile);
  await expect(page.getByTestId("agent-row")).toHaveCount(0, { timeout: 15_000 });
});

test("skills screen live-updates when a SKILL.md appears on disk", async ({ page }) => {
  await registerProject();
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);

  await page.getByTestId("nav-skills").click();

  const skillDir = path.join(project, ".pi", "skills", "release-notes");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: release-notes\ndescription: Draft release notes for this project\n---\n\nHow to draft.\n",
  );
  const row = page.locator('[data-skill-name="release-notes"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByTestId("scope-chip")).toHaveAttribute("data-scope", "project");

  // Rename the skill via the detail pane: the whole directory moves on disk.
  await row.click();
  await expect(page.getByTestId("skill-detail")).toBeVisible();
  // The invocation reflects the current name before the rename.
  await expect(page.getByTestId("skill-invocation")).toHaveText("/skill:release-notes");
  await page.getByTestId("skill-rename").click();
  await page.getByTestId("skill-rename-input").fill("changelog");
  await page.getByTestId("skill-rename-confirm").click();

  await expect(page.locator('[data-skill-name="changelog"]')).toBeVisible({ timeout: 15_000 });
  // …and the detail stays on the renamed skill (no re-click), so the invocation
  // follows the new name automatically.
  await expect(page.getByTestId("skill-invocation")).toHaveText("/skill:changelog");
  await expect(page.locator('[data-skill-name="release-notes"]')).toHaveCount(0);
  const movedSkill = path.join(project, ".pi", "skills", "changelog", "SKILL.md");
  await expect.poll(() => existsSync(movedSkill)).toBe(true);
  expect(existsSync(path.join(project, ".pi", "skills", "release-notes"))).toBe(false);
});

test("multi-select bulk-deletes skills (7.5)", async ({ page }) => {
  await registerProject();
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-skills").click();

  // Two project skills on disk.
  for (const name of ["bulk-a", "bulk-b"]) {
    const dir = path.join(project, ".pi", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: A bulk-delete test skill\n---\n\nbody\n`,
    );
  }
  await expect(page.locator('[data-skill-name="bulk-a"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-skill-name="bulk-b"]')).toBeVisible({ timeout: 15_000 });

  // Select both via the row checkboxes, then bulk delete.
  await page.getByTestId("skill-check-bulk-a").check();
  await page.getByTestId("skill-check-bulk-b").check();
  await expect(page.getByTestId("skills-bulk-bar")).toContainText("2 selected");
  // Bulk delete is confirm-gated (native parity, like single-skill delete).
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Delete 2 skills");
    void dialog.accept();
  });
  await page.getByTestId("skills-bulk-delete").click();

  await expect(page.locator('[data-skill-name="bulk-a"]')).toHaveCount(0);
  await expect(page.locator('[data-skill-name="bulk-b"]')).toHaveCount(0);
  await expect(page.getByTestId("skills-bulk-bar")).toHaveCount(0);
  expect(existsSync(path.join(project, ".pi", "skills", "bulk-a"))).toBe(false);
  expect(existsSync(path.join(project, ".pi", "skills", "bulk-b"))).toBe(false);
});

test("imports a local .md file as a skill (7.3)", async ({ page }) => {
  await registerProject();
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-skills").click();

  // A source .md on disk (outside any catalog).
  const source = path.join(mkdtempSync(path.join(tmpdir(), "skill-src-")), "anything.md");
  writeFileSync(
    source,
    "---\nname: imported-skill\ndescription: An imported skill\n---\n\nDo the thing.\n",
  );

  await page.getByTestId("skill-import").click();
  await page.getByTestId("skill-import-path").fill(source);
  await page.getByTestId("skill-import-confirm").click();

  // The imported (global) skill appears, written into the global catalog.
  await expect(page.locator('[data-skill-name="imported-skill"]')).toBeVisible({ timeout: 15_000 });
  const imported = path.join(harness.piHome, ".agents", "skills", "imported-skill", "SKILL.md");
  await expect.poll(() => existsSync(imported)).toBe(true);
  expect(readFileSync(imported, "utf8")).toContain("Do the thing.");
});

test("skill detail flags disable-model-invocation as 'manual only' (native 7.6)", async ({
  page,
}) => {
  await registerProject();
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);
  await page.getByTestId("nav-skills").click();

  // A skill the model must NOT auto-invoke (disable-model-invocation) and a
  // normal one that it may.
  const manualDir = path.join(project, ".pi", "skills", "manual-op");
  mkdirSync(manualDir, { recursive: true });
  writeFileSync(
    path.join(manualDir, "SKILL.md"),
    "---\nname: manual-op\ndescription: Only run when asked\ndisable-model-invocation: true\n---\n\nRun the op.\n",
  );
  const autoDir = path.join(project, ".pi", "skills", "auto-helper");
  mkdirSync(autoDir, { recursive: true });
  writeFileSync(
    path.join(autoDir, "SKILL.md"),
    "---\nname: auto-helper\ndescription: The model may use this freely\n---\n\nHelp.\n",
  );

  // The manual-only skill shows the badge in its detail pane, and its explicit
  // /skill:<name> invocation (native: pi's _expandSkillCommand).
  const manualRow = page.locator('[data-skill-name="manual-op"]');
  await expect(manualRow).toBeVisible({ timeout: 15_000 });
  await manualRow.click();
  await expect(page.getByTestId("skill-detail")).toBeVisible();
  await expect(page.getByTestId("skill-manual-only-badge")).toBeVisible();
  await expect(page.getByTestId("skill-invocation")).toHaveText("/skill:manual-op");

  // The normal skill shows no badge but still shows its invocation.
  await page.locator('[data-skill-name="auto-helper"]').click();
  await expect(page.getByTestId("skill-detail")).toBeVisible();
  await expect(page.getByTestId("skill-manual-only-badge")).toHaveCount(0);
  await expect(page.getByTestId("skill-invocation")).toHaveText("/skill:auto-helper");
});

test("renaming keeps the detail on the renamed skill in a multi-skill list", async ({ page }) => {
  await registerProject();

  // Two skills; select the one that is NOT alphabetically first, so a
  // filePath-keyed selection that fell back to visible[0] would show the wrong
  // skill after rename (the exact gap this guards).
  for (const name of ["alpha-skill", "zeta-skill"]) {
    const dir = path.join(project, ".pi", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: A rename-selection test skill\n---\n\nbody\n`,
    );
  }
  // Seed before opening the screen so no watcher refresh can replace the inline
  // rename form while Playwright is typing (notably on Windows).
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);
  await page.getByTestId("nav-skills").click();
  await expect(page.locator('[data-skill-name="zeta-skill"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-skill-name="zeta-skill"]').click();
  await expect(page.getByTestId("skill-invocation")).toHaveText("/skill:zeta-skill");

  // Rename zeta-skill → mid-skill. Without the pending-select fix the detail
  // would fall back to alpha-skill (visible[0]); with it, the detail follows.
  await page.getByTestId("skill-rename").click();
  await page.getByTestId("skill-rename-input").fill("mid-skill");
  await page.getByTestId("skill-rename-confirm").click();

  await expect(page.locator('[data-skill-name="mid-skill"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("skill-invocation")).toHaveText("/skill:mid-skill");
});
