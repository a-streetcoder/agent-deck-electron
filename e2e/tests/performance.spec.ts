import { startHarness, type E2eHarness } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ reply: () => "unused", chunkDelayMs: 0 });
});

test.afterAll(async () => harness.close());

test("performance navigation persists idle parking preferences", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-performance").click();
  await expect(page.getByTestId("performance-ready")).toBeVisible();
  await expect(page.getByTestId("app-view-title")).toHaveText("Performance");

  const toggle = page.getByRole("switch", { name: "Pause idle chats" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(page.getByTestId("performance-save-status")).toHaveText("Saved");

  const minutes = page.getByTestId("idle-parking-minutes");
  await toggle.click();
  await minutes.fill("23");
  await minutes.press("Enter");
  await expect(page.getByTestId("performance-save-status")).toHaveText("Saved");

  const stored = (await (await fetch(`${harness.baseUrl}/settings`)).json()) as {
    settings: {
      piAgentIdleParkingEnabled: boolean;
      piAgentIdleParkingTimeoutMinutes: number;
    };
  };
  expect(stored.settings).toMatchObject({
    piAgentIdleParkingEnabled: true,
    piAgentIdleParkingTimeoutMinutes: 23,
  });

  await page.reload();
  await page.getByTestId("nav-performance").click();
  await expect(page.getByTestId("idle-parking-minutes")).toHaveValue("23");
});

test("performance load error offers an accessible retry", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-projects").click();
  let fail = true;
  await page.route("**/settings", async (route) => {
    if (route.request().method() === "GET" && fail) {
      fail = false;
      await route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
      return;
    }
    await route.fallback();
  });
  await page.getByTestId("nav-performance").click();
  await expect(page.getByTestId("performance-error")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("performance-ready")).toBeVisible();
});
