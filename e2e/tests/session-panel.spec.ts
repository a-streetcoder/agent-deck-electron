import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Phase-2 gate (sidebar/session model): the pi agent is not a nav row. UI-01
 * inverts the native layering: the sessions panel is always in view and the
 * nav is the Orchestrate pull-up, one global expansion that persists while you
 * move between nav screens and across reloads.
 */

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("no Pi Agent nav row — chat is reached through the sessions panel", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  // The removed nav button is gone; Projects/Agents/Skills remain in the pull-up.
  await expect(page.getByTestId("nav-chat")).toHaveCount(0);
  await page.getByTestId("orchestrate-expand").click();
  await expect(page.getByTestId("nav-projects")).toBeVisible();
});

test("the sessions list is always in view and switches sessions without a click to open it", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // Two sessions so there's something to switch between.
  await page.getByTestId("composer-input").fill("first message");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text")).toContainText("first message", {
    timeout: 30_000,
  });
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  const layer = page.getByTestId("sessions-layer");
  const rows = page.getByTestId("sessions-panel").locator('[data-testid^="chat-"][role="button"]');
  await expect(layer).toHaveAttribute("aria-hidden", "false");
  await expect(rows).toHaveCount(2);

  // Selecting sessions never hides the list.
  await rows.nth(1).click();
  await expect(layer).toHaveAttribute("aria-hidden", "false");
  await rows.nth(0).click();
  await expect(layer).toHaveAttribute("aria-hidden", "false");
});

test("the Orchestrate pull-up stays open across nav picks and reloads", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const pullUp = page.getByTestId("orchestrate-expanded");
  const layer = page.getByTestId("sessions-layer");

  await page.getByTestId("orchestrate-expand").click();
  await expect(pullUp).toHaveAttribute("aria-hidden", "false");
  await expect(layer).toHaveAttribute("aria-hidden", "true");

  // Picking a nav screen shows it and keeps the pull-up open.
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-screen")).toBeVisible();
  await expect(pullUp).toHaveAttribute("aria-hidden", "false");

  // The explicit expand persists — a fresh load opens the pull-up the same way.
  await page.reload();
  await expect(pullUp).toHaveAttribute("aria-hidden", "false");

  // Collapsing persists too and brings the sessions list back.
  await page.getByTestId("orchestrate-collapse").click();
  await expect(layer).toHaveAttribute("aria-hidden", "false");
  await page.reload();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  await expect(pullUp).toHaveAttribute("aria-hidden", "true");
});

test("an untitled session shows a Draft · <project> display title", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("sessions-panel")).toContainText("Draft · All Projects");
});

test("the sessions panel filters sessions by title (18.1)", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // Ensure at least two sessions exist.
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  const panel = page.getByTestId("sessions-panel");
  const rows = panel.locator('[data-testid^="chat-"][role="button"]');

  // Rename two rows to distinct titles (target by "not yet renamed" so a
  // reorder-on-rename can't make us rename the same row twice).
  const renameInput = panel.locator('[data-testid^="chat-rename-input-"]');
  const rename = async (rowLocator: ReturnType<typeof panel.locator>, name: string) => {
    await rowLocator.hover();
    await rowLocator.getByTitle("Rename").click();
    await renameInput.fill(name);
    await renameInput.press("Enter");
    await expect(panel.getByText(name, { exact: true })).toBeVisible();
  };
  await rename(rows.first(), "alpha-session");
  await rename(rows.filter({ hasNotText: "alpha-session" }).first(), "beta-session");

  // Search filters to the matching title; drafts don't match so the count is
  // deterministic regardless of how many other sessions exist.
  await page.getByTestId("sessions-search").fill("alpha");
  await expect(rows).toHaveCount(1);
  await expect(panel).toContainText("alpha-session");
  await expect(panel).not.toContainText("beta-session");

  // A non-matching query shows the empty state.
  await page.getByTestId("sessions-search").fill("zzz-no-such-session");
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId("sessions-search-empty")).toBeVisible();

  // Clearing the search restores the list (both renamed sessions present).
  await page.getByTestId("sessions-search").fill("");
  await expect(panel).toContainText("alpha-session");
  await expect(panel).toContainText("beta-session");
});

test("the sessions panel shows each session's last-active time (native row caption)", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  const panel = page.getByTestId("sessions-panel");

  // Each row renders a formatted last-active caption (locale/timezone
  // vary across CI runners, so assert a real date-time rather than an exact
  // string: it contains a digit and is non-empty).
  const timestamp = panel.getByTestId("chat-timestamp").first();
  await expect(timestamp).toBeVisible();
  await expect(timestamp).toHaveText(/\d/);
});
