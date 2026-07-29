import { expect, test, type Page } from "../helpers/fixtures.ts";
import type { SessionMeta } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

async function sessions(): Promise<SessionMeta[]> {
  const response = await fetch(`${harness.baseUrl}/sessions`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessions: SessionMeta[] }).sessions;
}

async function renameActive(page: Page, title: string): Promise<string> {
  const active = page.getByTestId("chat-list").locator('[data-active="true"]').first();
  const testId = await active.getAttribute("data-testid");
  if (!testId) throw new Error("no active session");
  const id = testId.replace("chat-", "");
  await active.hover();
  await active.getByTitle("Rename").click();
  await page.getByTestId(`chat-rename-input-${id}`).fill(title);
  await page.getByTestId(`chat-rename-input-${id}`).press("Enter");
  await expect(page.getByTestId("chat-list").getByText(title, { exact: true })).toBeVisible();
  return id;
}

async function createNamedSession(title: string): Promise<string> {
  const created = await fetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { session: SessionMeta }).session.id;
  const renamed = await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  expect(renamed.status).toBe(200);
  return id;
}

test("pinning is durable, idempotent, and promotes within the project without changing activity", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const olderId = await renameActive(page, "older pinned session");
  const beforePin = (await sessions()).find((session) => session.id === olderId)!;

  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const newerId = await renameActive(page, "newer ordinary session");

  const list = page.getByTestId("chat-list");
  const titles = list.getByTestId("chat-title");
  await expect(titles.first()).toHaveText("newer ordinary session");

  const older = list.getByTestId(`chat-${olderId}`);
  await older.hover();
  await older.getByRole("button", { name: "Pin session" }).click();
  await expect(list.getByTestId(`chat-pinned-${olderId}`)).toBeVisible();
  await expect(titles.first()).toHaveText("older pinned session");

  const pinned = (await sessions()).find((session) => session.id === olderId)!;
  expect(pinned.pinnedAt).toBeTruthy();
  expect(pinned.updatedAt).toBe(beforePin.updatedAt);

  const repeated = await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(olderId)}/pin`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  expect(repeated.status).toBe(200);
  expect(((await repeated.json()) as { session: SessionMeta }).session.pinnedAt).toBe(
    pinned.pinnedAt,
  );

  await page.reload();
  await expect(list.getByTestId(`chat-pinned-${olderId}`)).toBeVisible();
  await expect(titles.first()).toHaveText("older pinned session");

  await list.getByTestId(`chat-${olderId}`).hover();
  await list.getByTestId(`chat-${olderId}`).getByRole("button", { name: "Unpin session" }).click();
  await expect(list.getByTestId(`chat-pinned-${olderId}`)).toHaveCount(0);
  await expect(titles.first()).toHaveText("newer ordinary session");
  expect((await sessions()).find((session) => session.id === olderId)?.pinnedAt).toBeUndefined();
  expect((await sessions()).find((session) => session.id === newerId)).toBeTruthy();
});

test("keyboard pinning keeps a reordered row focused and visible in a long list", async ({
  page,
}) => {
  let targetId = "";
  for (let index = 0; index < 14; index += 1) {
    const id = await createNamedSession(`long list ${String(index).padStart(2, "0")}`);
    if (index === 0) targetId = id;
  }

  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  await page.getByTestId("sessions-expand").click();

  const scroller = page.getByTestId("sessions-scroll");
  const row = scroller.getByTestId(`chat-${targetId}`);
  const pin = scroller.getByTestId(`chat-pin-${targetId}`);
  await row.scrollIntoViewIfNeeded();
  await pin.focus();
  await pin.press("Enter");

  await expect(scroller.getByTestId(`chat-pinned-${targetId}`)).toBeVisible();
  await expect(pin).toBeFocused();
  await expect
    .poll(async () => {
      const scrollRect = await scroller.boundingBox();
      const rowRect = await row.boundingBox();
      if (!scrollRect || !rowRect) return { top: false, bottom: false };
      return {
        top: rowRect.y >= scrollRect.y,
        bottom: rowRect.y + rowRect.height <= scrollRect.y + scrollRect.height,
      };
    })
    .toEqual({ top: true, bottom: true });
});
