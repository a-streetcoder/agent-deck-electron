import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test, type Page } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-slash-universe-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
  const skillDir = path.join(project, ".pi", "skills", "deployer");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: deployer\ndescription: Deploy the app\n---\n\nHow to deploy.\n",
  );
  writeFileSync(path.join(project, "README-uniquename.md"), "# hi\n");
  const projectResponse = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!projectResponse.ok) throw new Error(await projectResponse.text());

  const promptResponse = await fetch(`${harness.baseUrl}/resources/prompts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "library",
      name: "brief",
      edit: { description: "Seeded brief", body: "Use this brief." },
    }),
  });
  if (!promptResponse.ok) throw new Error(await promptResponse.text());
});

test.afterAll(async () => {
  await harness.close();
});

async function openProjectChat(page: Page): Promise<void> {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
}

test("slash panel shows categories and searches across catalogs", async ({ page }) => {
  await openProjectChat(page);
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("/");
  const panel = page.getByTestId("slash-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("Commands");
  await expect(panel).toContainText("Prompts");
  await expect(panel).toContainText("Skills");
  await expect(panel).toContainText("Loops");

  await input.pressSequentially("brief");
  await expect(panel).toContainText("Prompts");
  await expect(panel).toContainText("brief");
});

test("accepting a prompt seeds the editor body", async ({ page }) => {
  await openProjectChat(page);
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("/");
  const panel = page.getByTestId("slash-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("slash-panel-item-cat:prompt").click();
  await page
    .locator('[data-testid^="slash-panel-item-item:prompt:"]')
    .filter({ hasText: "brief" })
    .click();
  await expect(input).toHaveValue("Use this brief.");
});

test("accepting a command leaves the composer ready for args", async ({ page }) => {
  await openProjectChat(page);
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("/");
  const panel = page.getByTestId("slash-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("slash-panel-item-cat:command").click();
  await page.locator('[data-testid^="slash-panel-item-item:command:"]').first().click();
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("slash-selection-chip")).toBeVisible();
});

test("accepting a loop opens Loop Bank", async ({ page }) => {
  await openProjectChat(page);
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("/");
  const panel = page.getByTestId("slash-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("slash-panel-item-cat:loop").click();
  await page.getByTestId("slash-panel-item-item:loop:create-new").click();
  await expect(page.getByTestId("loop-editor")).toBeVisible({ timeout: 15_000 });
});

test("no-project sessions hide the slash panel", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("/");
  await expect(page.getByTestId("slash-panel")).toHaveCount(0);
  await expect(page.getByTestId("slash-panel-loading")).toHaveCount(0);
});

test("@ file suggestions still work", async ({ page }) => {
  await openProjectChat(page);
  const input = page.getByTestId("composer-input");
  await input.click();
  await input.pressSequentially("look at @README-unique");
  const panel = page.getByTestId("file-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText("README-uniquename.md");
});
