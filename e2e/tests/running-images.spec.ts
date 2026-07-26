import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;

const IMAGE = { name: "same.png", mimeType: "image/png", buffer: Buffer.from("fake-png") };

test.beforeAll(async () => {
  harness = await startHarness({
    reply: () => "one two three four five six seven eight nine ten eleven twelve",
    chunkDelayMs: 150,
  });
});

test.afterAll(async () => {
  await harness.close();
});

test("running transition discards late image reads but retains pre-existing images", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  const peer = await page.context().newPage();
  await peer.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // Delay File.arrayBuffer so Pi can start between selection and completion.
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    Object.defineProperty(globalThis, "__restoreArrayBuffer", {
      value: original,
      configurable: true,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(globalThis, "__releaseArrayBuffer", {
      value: release,
      configurable: true,
    });
    File.prototype.arrayBuffer = async function () {
      await gate;
      return await original.call(this);
    };
  });
  await page.getByTestId("attach-input").setInputFiles(IMAGE);
  await peer.getByTestId("composer-input").fill("start while image loads");
  await peer.getByTestId("send-button").click();
  await expect(page.getByTestId("abort-button")).toBeVisible();
  await page.evaluate(() =>
    (globalThis as unknown as { __releaseArrayBuffer(): void }).__releaseArrayBuffer(),
  );
  await expect(page.getByTestId("composer-submit-status")).toContainText(
    "Image loading finished after Pi started",
  );
  await expect(page.getByTestId("attachments")).toHaveCount(0);
  await peer.getByTestId("abort-button").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });

  await page.evaluate(() => {
    const original = (
      globalThis as unknown as { __restoreArrayBuffer: typeof File.prototype.arrayBuffer }
    ).__restoreArrayBuffer;
    File.prototype.arrayBuffer = original;
  });
  await page.getByTestId("attach-input").setInputFiles(IMAGE);
  await expect(page.getByTestId("attachments")).toBeVisible();

  await peer.getByTestId("composer-input").fill("start with image already selected elsewhere");
  await peer.getByTestId("send-button").click();
  await expect(page.getByTestId("abort-button")).toBeVisible();
  await expect(page.getByTestId("attachments")).toBeVisible();
  await expect(page.getByTestId("attach-input")).toBeDisabled();

  await page.getByTestId("composer-input").fill("text must not omit image");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("composer-submit-status")).toContainText(
    "Remove attached images or wait",
  );
  await expect(page.getByTestId("composer-input")).toHaveValue("text must not omit image");
  await peer.getByTestId("abort-button").click();
  await peer.close();
});
