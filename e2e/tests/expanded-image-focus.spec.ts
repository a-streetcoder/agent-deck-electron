import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

// ROAD-S19: keyboard a11y of the transcript's expanded-image dialog — focus
// moves into the dialog on open, Escape closes it, focus returns to the trigger.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ reply: () => "ok", chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("expanded image dialog takes focus, closes on Escape, and restores focus to the trigger", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  await page.getByTestId("attach-input").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await page.getByTestId("composer-input").fill("look at this");
  await page.getByTestId("send-button").click();

  const trigger = page
    .getByTestId("sent-image-gallery")
    .getByRole("button", { name: "Preview pixel.png" });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });

  // Keyboard activation, so the trigger is the focused element the dialog
  // must hand focus back to.
  await trigger.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Expanded image preview" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("expanded-image-close")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
