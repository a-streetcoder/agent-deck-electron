import { startHarness, type E2eHarness } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({
    reply: (message) => `Parked lifecycle reply for ${message} with several streamed words.`,
    chunkDelayMs: 20,
  });
});

test.afterAll(async () => harness.close());

test("parked row/header survive listing and wake safely after server restart", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("composer-input").fill("first parked browser turn");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text")).toContainText("first parked browser turn", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  harness.server.sessions.configureIdleParking(40);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "parked", {
    timeout: 15_000,
  });
  const listed = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; parkedAt?: string; endedAt?: string; status?: string }>;
  };
  const parked = listed.sessions.find((session) => session.parkedAt);
  expect(parked).toBeTruthy();
  expect(parked?.endedAt).toBeUndefined();
  expect(parked?.status).toBeUndefined();
  await expect(page.getByTestId(`chat-parked-${parked!.id}`).first()).toContainText(
    "resumes on next command",
  );

  await harness.restart();
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("user-cell")).toContainText("first parked browser turn", {
    timeout: 30_000,
  });
  await page.getByTestId("composer-input").fill("second parked browser turn");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("user-cell")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(
    "second parked browser turn",
  );
  await expect(page.getByTestId("status-indicator")).not.toHaveAttribute("data-status", "parked");
  await expect(page.getByTestId(`chat-parked-${parked!.id}`)).toHaveCount(0);
});
