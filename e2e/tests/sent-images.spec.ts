import { expect, test, type Page } from "../helpers/fixtures.ts";
import type { SessionMeta } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG = Buffer.from(PNG_BASE64, "base64");

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({
    reply: (message) => `image received: ${message}`,
    chunkDelayMs: 20,
  });
});

test.afterAll(async () => {
  await harness.close();
});

async function activeSessionId(page: Page): Promise<string> {
  const testId = await page
    .getByTestId("chat-list")
    .locator('[data-active="true"]')
    .first()
    .getAttribute("data-testid");
  if (!testId) throw new Error("no active session");
  return testId.replace("chat-", "");
}

async function deleteSession(id: string): Promise<void> {
  const response = await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  expect(response.ok, await response.text()).toBe(true);
}

function absoluteImageUrl(src: string): string {
  return new URL(src, harness.baseUrl).toString();
}

test("sent image survives live delivery, reconnect, resume, fork ownership, and source deletion", async ({
  page,
}) => {
  const receivedFrames: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => receivedFrames.push(String(payload)));
  });

  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const sourceId = await activeSessionId(page);

  await page.getByTestId("attach-input").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(
    page.getByTestId("attachments").getByRole("img", { name: "pixel.png" }),
  ).toBeVisible();
  await page.getByTestId("composer-input").fill("keep this pixel");
  await page.getByTestId("send-button").click();

  const gallery = page.getByTestId("sent-image-gallery");
  const thumbnail = gallery.getByRole("img", { name: "Sent image 1" });
  await expect(thumbnail).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });
  const sourceSrc = await thumbnail.getAttribute("src");
  expect(sourceSrc).toBeTruthy();
  expect((await fetch(absoluteImageUrl(sourceSrc!))).status).toBe(200);

  await gallery.getByRole("button", { name: "Expand Sent image 1" }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "Sent image 1" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A renderer reload forces a fresh WebSocket hello/token bootstrap and a
  // snapshot/replay. The transcript must still resolve the lazy app-data URL.
  await page.reload();
  await expect(
    page.getByTestId("sent-image-gallery").getByRole("img", { name: "Sent image 1" }),
  ).toBeVisible({
    timeout: 30_000,
  });

  // Stop the Pi owner, relaunch it from its session file, then reconnect the
  // renderer. This exercises get_entries history reconstruction, not the live cell.
  const source = harness.server.sessions.get(sourceId);
  expect(source).toBeTruthy();
  await expect.poll(() => source!.meta.piSessionFile).toBeTruthy();
  await source!.stop();
  const resume = await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/resume`, {
    method: "POST",
  });
  expect(resume.status, await resume.text()).toBe(200);
  await page.reload();
  const resumedThumbnail = page
    .getByTestId("sent-image-gallery")
    .getByRole("img", { name: "Sent image 1" });
  await expect(resumedThumbnail).toBeVisible({ timeout: 30_000 });
  expect(await resumedThumbnail.getAttribute("src")).toBe(sourceSrc);

  const forkResponse = await fetch(
    `${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/fork`,
    { method: "POST" },
  );
  expect(forkResponse.status).toBe(201);
  const { session: forkMeta } = (await forkResponse.json()) as { session: SessionMeta };
  await page.getByTestId("chat-list").getByTestId(`chat-${forkMeta.id}`).click();
  const forkThumbnail = page
    .getByTestId("sent-image-gallery")
    .getByRole("img", { name: "Sent image 1" });
  await expect(forkThumbnail).toBeVisible({ timeout: 30_000 });
  const forkSrc = await forkThumbnail.getAttribute("src");
  expect(forkSrc).toBeTruthy();
  expect(new URL(forkSrc!, harness.baseUrl).pathname.split("/").at(-1)).toBe(
    new URL(sourceSrc!, harness.baseUrl).pathname.split("/").at(-1),
  );
  expect((await fetch(absoluteImageUrl(forkSrc!))).status).toBe(200);

  await deleteSession(sourceId);
  expect((await fetch(absoluteImageUrl(sourceSrc!))).status).toBe(404);
  await expect(forkThumbnail).toBeVisible();
  expect((await fetch(absoluteImageUrl(forkSrc!))).status).toBe(200);

  await deleteSession(forkMeta.id);
  expect((await fetch(absoluteImageUrl(forkSrc!))).status).toBe(404);

  // Base64 necessarily travels in the client prompt request, but no server
  // event/replay/snapshot frame may echo image bytes back into the transcript.
  expect(receivedFrames.some((frame) => frame.includes(PNG_BASE64))).toBe(false);
});
