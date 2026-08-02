import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
let providerFailure = true;

test.beforeAll(async () => {
  harness = await startHarness({
    beforeResponse: () => {
      if (providerFailure) throw new Error("deterministic e2e provider outage");
    },
    reply: () => "recovered response",
    chunkDelayMs: 10,
  });
});

test.afterAll(async () => {
  await harness.close();
});

test("failed row/transcript survive restart and successful recovery clears both", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  await page.getByTestId("composer-input").fill("trigger provider failure");
  await page.getByTestId("send-button").click();

  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "failed", {
    timeout: 60_000,
  });
  const details = page.getByTestId("session-failure-details");
  await expect(details).toBeVisible();
  await expect(details).toHaveAttribute("role", "status");
  await expect(details).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("error-banner")).toHaveCount(0);

  const failedRow = page.locator('[data-testid^="chat-"][data-status="failed"]').first();
  await expect(failedRow).toBeVisible();
  await expect(failedRow).toHaveAccessibleName(/failed/i);
  await expect(failedRow.getByTestId("chat-failure-subtitle")).toContainText("Failed");

  // Leave a newer draft selected. Startup resumes only that newest row, so the
  // failed background session remains durable/observable instead of being
  // authoritatively recovered merely by automatic activation.
  await page.getByTestId("new-chat").click();
  await expect(failedRow).toHaveAttribute("data-status", "failed");

  await harness.restart();
  await page.goto(harness.baseUrl);
  const restartedRow = page.locator('[data-testid^="chat-"][data-status="failed"]').first();
  await expect(restartedRow).toBeVisible();
  await expect(restartedRow).toHaveAccessibleName(/failed/i);

  providerFailure = false;
  await restartedRow.click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });
  await page.getByTestId("composer-input").fill("recover after restart");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text").last()).toContainText("recovered response", {
    timeout: 30_000,
  });
  await expect(page.locator('[data-testid^="chat-"][data-status="failed"]')).toHaveCount(0);
  await expect(page.getByTestId("session-failure-details")).toHaveCount(0);
});
