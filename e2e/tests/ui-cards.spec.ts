import { expect, test, type Page } from "../helpers/fixtures.ts";
import { writeUiCardsExtension } from "@agent-deck/testkit";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Tier-4 gate (ask-user card types): the remaining extension_ui_request methods
 * — input (single line), select (options), and editor (multiline, prefilled) —
 * each render the right control and their answer flows back to pi. (confirm is
 * covered in polish.spec.)
 */

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20, extraExtensions: [writeUiCardsExtension()] });
});

test.afterAll(async () => {
  await harness.close();
});

async function runCommand(page: Page, command: string): Promise<void> {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  // Fresh chat so each test's card is the only one in its transcript.
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  await page.getByTestId("composer-input").fill(command);
  await page.getByTestId("send-button").click();
}

test("the input card takes a line and sends it back", async ({ page }) => {
  await runCommand(page, "/ask-input");
  const card = page.getByTestId("question-cell");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Your handle");
  await page.getByTestId("question-input").fill("moretti");
  await page.getByTestId("question-submit").click();
  await expect(card).toHaveAttribute("data-answered", "true");
});

test("the select card offers the options and sends the pick back", async ({ page }) => {
  await runCommand(page, "/ask-select");
  const card = page.getByTestId("question-cell");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("question-option-crimson")).toBeVisible();
  await page.getByTestId("question-option-viridian").click();
  await expect(card).toHaveAttribute("data-answered", "true");
});

test("the editor card is multiline and prefilled, and sends the edit back", async ({ page }) => {
  await runCommand(page, "/ask-editor");
  const card = page.getByTestId("question-cell");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const editor = page.getByTestId("question-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("hello from prefill");
  await editor.fill("hello from prefill\nand a second line");
  await page.getByTestId("question-submit").click();
  await expect(card).toHaveAttribute("data-answered", "true");
});

test("question commands navigate answered and pending cards in order without wrapping", async ({
  page,
}) => {
  await runCommand(page, "/ask-input");
  const cards = page.getByTestId("question-cell");
  await expect(cards).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("question-input").fill("first answer");
  await page.getByTestId("question-submit").click();
  await expect(cards.first()).toHaveAttribute("data-answered", "true");
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  await page.getByTestId("composer-input").fill("/ask-select");
  await page.getByTestId("send-button").click();
  await expect(cards).toHaveCount(2, { timeout: 30_000 });

  const firstTarget = page.locator("[data-question-navigation-cell]").nth(0);
  const secondTarget = page.locator("[data-question-navigation-cell]").nth(1);
  const status = page.getByTestId("transcript").getByRole("status");
  await expect(firstTarget).toHaveAttribute("role", "group");
  await expect(firstTarget).toHaveAttribute("aria-label", "Resolved question, 1 of 2");
  await expect(secondTarget).toHaveAttribute("aria-label", "Pending question, 2 of 2");

  const runPaletteCommand = async (label: string): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-palette-input").fill(label);
    await page.getByTestId("command-palette-item").filter({ hasText: label }).click();
  };

  await runPaletteCommand("Previous Question");
  await expect(secondTarget).toBeFocused();
  await expect(status).toHaveText("Pending question 2 of 2.");

  await runPaletteCommand("Previous Question");
  await expect(firstTarget).toBeFocused();
  await expect(status).toHaveText("Question 1 of 2.");

  // Previous at the first card is a boundary no-op: no wrap and no new target.
  await runPaletteCommand("Previous Question");
  await expect(status).toHaveText("No previous question.");
  await expect(secondTarget).not.toBeFocused();
  const firstBoundaryToken = await status
    .locator("[data-announcement-token]")
    .getAttribute("data-announcement-token");

  // The same boundary message is replaced with a fresh keyed announcement so
  // assistive technology receives repeated invocations too.
  await runPaletteCommand("Previous Question");
  await expect(status).toHaveText("No previous question.");
  await expect(status.locator("[data-announcement-token]")).not.toHaveAttribute(
    "data-announcement-token",
    firstBoundaryToken ?? "",
  );

  await runPaletteCommand("Next Question");
  await expect(secondTarget).toBeFocused();
  await expect(status).toHaveText("Pending question 2 of 2.");
});

test("an open request is answerable from the composer-anchored pending panel", async ({ page }) => {
  await runCommand(page, "/ask-input");
  // The same open extension_ui_request surfaces both as the transcript card AND
  // as the composer-anchored panel (Slice 17). Answering from the composer panel
  // flows through the same ui_response path and resolves the request.
  const panel = page.getByTestId("composer-question");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText("Your handle");
  await page.getByTestId("composer-question-input").fill("moretti");
  await page.getByTestId("composer-question-submit").click();
  // The transcript card marks answered and the composer panel drops away.
  await expect(page.getByTestId("question-cell")).toHaveAttribute("data-answered", "true");
  await expect(panel).toHaveCount(0);
});
