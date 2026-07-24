import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Loop Bank (native LoopBankScreen, definition-CRUD slice): create, edit, and
 * delete a loop definition. The loop is persisted as ~/.pi/agent/loops/<slug>.loop.md.
 * The run engine is a later slice, so there's no launch here.
 */

let harness: E2eHarness;

function loopFile(): string {
  return path.join(harness.piHome, ".pi", "agent", "loops", "green-suite.loop.md");
}

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("creates, edits, and deletes a loop through the Bank", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-loops").click();
  await expect(page.getByTestId("loop-empty")).toBeVisible();

  // Create. The responsive modal is named, traps focus, closes on Escape,
  // and restores focus to its trigger.
  const newLoop = page.getByTestId("new-loop");
  await page.setViewportSize({ width: 500, height: 600 });
  await newLoop.click();
  const editor = page.getByTestId("loop-editor");
  await expect(editor).toHaveAccessibleName("New Loop");
  await expect(page.getByTestId("loop-name")).toBeFocused();
  const editorBox = await editor.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(editorBox!.x).toBeGreaterThanOrEqual(0);
  expect(editorBox!.x + editorBox!.width).toBeLessThanOrEqual(500);
  expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(600);

  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("loop-cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("loop-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(newLoop).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 720 });
  await newLoop.click();
  await page.getByTestId("loop-name").fill("Green Suite");
  await page.getByTestId("loop-goal").fill("Make the test suite pass.");
  await expect(page.getByTestId("loop-structure").locator("option")).toHaveText([
    "Single agent",
    "Maker / checker",
    "Agent pipeline",
    "Parallel agents",
    "Discovery + triage",
  ]);
  await page.getByTestId("loop-max-iterations").fill("6");
  await page.getByTestId("loop-validation").fill("pnpm test");
  await page.getByTestId("loop-save").click();

  const rowButton = page.getByRole("button", { name: /^Green Suite/ });
  const row = rowButton.locator("..");
  await expect(rowButton).toBeVisible({ timeout: 10_000 });
  await expect(rowButton).toContainText("Single agent");
  await expect(rowButton).toContainText("6×");

  // Persisted to disk in the loops catalog.
  expect(existsSync(loopFile())).toBe(true);
  const raw = readFileSync(loopFile(), "utf8");
  expect(raw).toContain("name: Green Suite");
  expect(raw).toContain("maxIterations: 6");
  expect(raw).toContain("Make the test suite pass.");

  // Edit: reopen (name is fixed once created), bump iterations.
  await rowButton.click();
  await expect(page.getByTestId("loop-name")).toBeDisabled();
  await page.getByTestId("loop-max-iterations").fill("10");
  await page.getByTestId("loop-save").click();
  await expect(row).toContainText("10×");
  expect(readFileSync(loopFile(), "utf8")).toContain("maxIterations: 10");

  // Duplicate → a "Copy of …" appears alongside the original.
  await row.getByTitle("Duplicate loop").click();
  const copyButton = page.getByRole("button", { name: /^Copy of Green Suite/ });
  await expect(copyButton).toBeVisible();
  await expect(row).toBeVisible();

  // Delete both (confirm-gated).
  page.once("dialog", (dialog) => void dialog.accept());
  await copyButton.locator("..").getByTitle("Delete loop").click();
  await expect(copyButton).toHaveCount(0);
  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByTitle("Delete loop").click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId("loop-empty")).toBeVisible();
  expect(existsSync(loopFile())).toBe(false);
});

test("wraps a long unbroken saved loop name inside the narrow editor", async ({ page }) => {
  const longName = "L".repeat(200);
  const dir = path.dirname(loopFile());
  const longFile = path.join(dir, "long-name.loop.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    longFile,
    `---\nname: ${longName}\nstructure: singleAgent\nmaxIterations: 3\n---\n\nLong name goal.\n`,
  );

  // Open while the navigation/content split is usable, then narrow the open
  // modal to exercise its independent responsive containment.
  await page.setViewportSize({ width: 500, height: 600 });
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-loops").click();
  const row = page.locator(`[data-loop-name="${longName}"]`);
  await row.getByRole("button").first().click();
  await page.setViewportSize({ width: 320, height: 600 });

  const editor = page.getByTestId("loop-editor");
  const title = page.locator("#loop-editor-title");
  await expect(editor).toHaveAccessibleName(`Edit ${longName}`);
  await expect
    .poll(() => title.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
  const editorBox = await editor.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(editorBox!.x + editorBox!.width).toBeLessThanOrEqual(320);

  await page.keyboard.press("Escape");
  await expect(row.getByRole("button").first()).toBeFocused();
  await page.setViewportSize({ width: 500, height: 600 });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId(`loop-delete-${longName}`).click();
  await expect(row).toHaveCount(0);
});

test("loads a native-shaped Maker+Checker definition without conversion", async ({ page }) => {
  const dir = path.dirname(loopFile());
  const unsupportedFile = path.join(dir, "native-review.loop.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    unsupportedFile,
    "---\nname: Native Review\nstructure: makerChecker\nmakerName: Maker\ncheckerName: Checker\ncheckerRubric: Verify evidence\nmaxIterations: 4\nwriteTarget: currentCheckout\n---\n\nReview the work.\n",
  );

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-loops").click();
  const row = page.locator('[data-loop-name="Native Review"]');
  await expect(row).toContainText("Maker / checker");

  await expect(page.getByTestId("loop-duplicate-Native Review")).toBeEnabled();
  await expect(page.getByTestId("loop-unavailable-Native Review")).toHaveCount(0);
  await page.getByTestId("loop-open-Native Review").click();
  await expect(page.getByTestId("loop-structure")).toHaveValue("makerChecker");
  await expect(page.getByTestId("loop-maker")).toHaveValue("Maker");
  await expect(page.getByTestId("loop-checker")).toHaveValue("Checker");
  await expect(page.getByTestId("loop-checker-rubric")).toHaveValue("Verify evidence");
  await expect(page.getByTestId("loop-save")).toBeEnabled();
  await page.getByTestId("loop-checker-rubric").fill("Verify tests and evidence");
  await page.getByTestId("loop-save").click();
  expect(readFileSync(unsupportedFile, "utf8")).toContain(
    "checkerRubric: Verify tests and evidence",
  );

  await page.getByTestId("loop-duplicate-Native Review").click();
  await expect(page.locator('[data-loop-name="Copy of Native Review"]')).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId("loop-delete-Copy of Native Review").click();
  await expect(page.getByTestId("loop-delete-Native Review")).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId("loop-delete-Native Review").click();
  await expect(row).toHaveCount(0);
});
