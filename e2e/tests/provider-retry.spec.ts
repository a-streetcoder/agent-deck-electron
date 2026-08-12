import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
let requests = 0;

test.beforeAll(async () => {
  harness = await startHarness({
    beforeResponse: () => {
      requests += 1;
      if (requests === 1) throw new Error("deterministic transient provider outage");
    },
    reply: () => "Recovered after the automatic provider retry.",
    chunkDelayMs: 20,
  });
});

test.afterAll(async () => {
  await harness.close();
});

test("shows a live retry pause, terminal recovery, and hydrated durable card", async ({
  page,
}, testInfo) => {
  // Narrowest practical three-pane desktop width; below this, the app's global
  // navigation (outside this card) intentionally consumes the transcript pane.
  await page.setViewportSize({ width: 760, height: 760 });
  await page.goto(harness.baseUrl);
  await page.getByTestId("composer-input").fill("exercise automatic retry");
  await page.getByTestId("send-button").click();

  const card = page.getByTestId("provider-retry-cell");
  await expect(card).toHaveAttribute("data-status", "retrying", { timeout: 30_000 });
  await expect(card).toContainText("Attempt 1 of 3 · Waiting to retry");
  await expect(card).toHaveAttribute("role", "status");
  await expect(card).toHaveAttribute("aria-atomic", "true");

  await expect(card).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await expect(card).toContainText("Request succeeded after retrying");
  await expect(card).toContainText("Recovered from:");
  await expect(card).not.toHaveAttribute("role", "status");
  await expect(page.getByTestId("assistant-text")).toContainText(
    "Recovered after the automatic provider retry.",
  );

  await page.reload();
  await expect(page.getByTestId("provider-retry-cell")).toHaveAttribute("data-status", "succeeded");
  await expect(page.getByTestId("provider-retry-cell")).toContainText("Recovered from:");

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: testInfo.outputPath(`provider-retry-${colorScheme}-narrow.png`),
      fullPage: true,
    });
  }
});
