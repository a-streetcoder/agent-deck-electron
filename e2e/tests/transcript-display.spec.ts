import { startHarness, type E2eHarness } from "../helpers/env.ts";
import { expect, test } from "../helpers/fixtures.ts";

let harness: E2eHarness;

test.beforeAll(async () => {
  // This workflow never sends a prompt; the harness supplies the normal app
  // shell and durable settings store without launching a Pi session.
  harness = await startHarness({ reply: () => "unused", chunkDelayMs: 0 });
});

test.afterAll(async () => {
  await harness.close();
});

test("transcript display preferences persist through the accessible toolbar menu", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  const trigger = page.getByRole("button", { name: "Transcript display" });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const thinking = page.getByRole("switch", { name: "Thinking" });
  await expect(thinking).toHaveAttribute("aria-checked", "true");
  const updated = page.waitForResponse(
    (response) => response.url().endsWith("/settings") && response.request().method() === "PATCH",
  );
  await thinking.click();
  expect((await updated).ok()).toBe(true);
  await expect(thinking).toHaveAttribute("aria-checked", "false");

  const stored = (await (await fetch(`${harness.baseUrl}/settings`)).json()) as {
    settings: { piAgentTranscriptVisibility: { showThinking: boolean } };
  };
  expect(stored.settings.piAgentTranscriptVisibility.showThinking).toBe(false);

  await page.reload();
  await page.getByRole("button", { name: "Transcript display" }).click();
  await expect(page.getByRole("switch", { name: "Thinking" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});
