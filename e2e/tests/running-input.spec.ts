import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;

const LONG_REPLY =
  "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";

test.beforeAll(async () => {
  harness = await startHarness({ reply: () => LONG_REPLY, chunkDelayMs: 150 });
});

test.afterAll(async () => {
  await harness.close();
});

test("running composer queues guidance and follow-ups while Stop remains separate", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  const composer = page.getByTestId("composer-input");
  await composer.fill("start streaming");
  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-menu")).toBeVisible();
  // Programmatic activation avoids the document mousedown dismiss path: the
  // running transition itself must close and disable the already-open picker.
  await page
    .getByTestId("send-button")
    .evaluate((button) => (button as unknown as { click(): void }).click());

  await expect(page.getByTestId("abort-button")).toBeVisible();
  await expect(page.getByTestId("model-menu")).toHaveCount(0);
  await expect(page.getByTestId("model-chip")).toBeDisabled();
  await expect(page.getByTestId("send-button")).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId("streaming-behavior")).toHaveValue("steer");

  await composer.fill("guide first line");
  await composer.press("Shift+Enter");
  await composer.type("guide second line");
  await expect(composer).toHaveValue("guide first line\nguide second line");
  await composer.press("Enter");
  await expect(page.getByTestId("composer-submit-status")).toContainText("Guidance queued");
  await expect(composer).toHaveValue("");

  await page.getByTestId("streaming-behavior").selectOption("followUp");
  await composer.fill("do this next");
  // Two same-frame clicks must share one correlated in-flight request.
  await page.getByTestId("send-button").evaluate((button) => {
    const clickable = button as unknown as { click(): void };
    clickable.click();
    clickable.click();
  });
  await expect(page.getByTestId("composer-submit-status")).toContainText("Follow-up queued");
  await expect(page.getByTestId("pending-input")).toContainText("Follow-ups");
  await expect(page.getByTestId("pending-input").getByRole("listitem")).toHaveCount(1);

  await page.getByTestId("abort-button").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });
});
