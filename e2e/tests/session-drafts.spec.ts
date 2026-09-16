import path from "node:path";
import type { SessionMeta } from "@agent-deck/domain";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});
test.afterAll(async () => {
  await harness.close();
});
async function sessions(): Promise<SessionMeta[]> {
  return (
    (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as { sessions: SessionMeta[] }
  ).sessions;
}

test("unsent text survives reload and app restart without launching Pi", async ({ page }) => {
  await page.goto(harness.baseUrl);
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeVisible();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/composer-draft") &&
      response.request().method() === "PUT" &&
      response.ok(),
  );
  await composer.fill("Keep this unsent message across restarts");
  await saved;
  const draft = (await sessions())[0]!;
  expect(draft.lifecycle).toBe("draft");
  expect(harness.server.sessions.get(draft.id)).toBeUndefined();
  await page.reload();
  await expect(composer).toHaveValue("Keep this unsent message across restarts");
  expect(harness.server.sessions.get(draft.id)).toBeUndefined();
  await page.goto("about:blank");
  await harness.restart();
  await page.goto(harness.baseUrl);
  await expect(composer).toHaveValue("Keep this unsent message across restarts");
  expect((await sessions()).find((s) => s.id === draft.id)?.lifecycle).toBe("draft");
  expect(harness.server.sessions.get(draft.id)).toBeUndefined();
});

test("failed first launch keeps the message available for retry", async ({ page }) => {
  await page.goto(harness.baseUrl);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/sessions") &&
      response.request().method() === "POST" &&
      response.status() === 201,
  );
  await page.getByTestId("new-chat").click();
  const { session: draft } = (await (await created).json()) as { session: SessionMeta };
  const composer = page.getByTestId("composer-input");
  await composer.fill("Retry this exact draft message");
  const previous = process.env.AGENT_DECK_PI_PATH;
  process.env.AGENT_DECK_PI_PATH = path.join(harness.dataDir, "missing-pi");
  try {
    await page.getByTestId("send-button").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Not acknowledged — draft retained" }),
    ).toBeVisible();
    await expect(composer).toHaveValue("Retry this exact draft message");
    expect((await sessions()).find((s) => s.id === draft.id)?.lifecycle).toBe("draft");
    expect(harness.server.sessions.get(draft.id)).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.AGENT_DECK_PI_PATH;
    else process.env.AGENT_DECK_PI_PATH = previous;
  }
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text").last()).toContainText(
    "Retry this exact draft message",
    { timeout: 30_000 },
  );
  await expect(composer).toHaveValue("");
  expect(harness.server.sessions.get(draft.id)?.isRunning).toBe(true);
});
