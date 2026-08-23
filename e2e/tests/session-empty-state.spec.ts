import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("deleting the only draft leaves a usable no-active-session state", async ({ page }) => {
  const initial = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string }>;
  };
  for (const session of initial.sessions) {
    await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
    });
  }

  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const activeRow = page.getByTestId("chat-list").locator('[data-active="true"]');
  await expect(activeRow).toHaveCount(1);
  await expect(activeRow).toContainText("Draft · All Projects");

  const id = (await activeRow.getAttribute("data-testid"))!.replace("chat-", "");
  await activeRow.hover();
  await page.getByTestId(`chat-delete-${id}`).click();

  await expect
    .poll(async () => {
      const body = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
        sessions: Array<{ id: string }>;
      };
      return body.sessions.length;
    })
    .toBe(0);
  await expect(page.getByTestId("chat-list")).toContainText("No sessions yet.");
  await expect(page.getByTestId("chat-list").locator('[data-active="true"]')).toHaveCount(0);

  const empty = page.getByTestId("no-active-session");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No active session");
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await expect(page.getByTestId("session-startup")).toHaveCount(0);

  // The empty state owns the remaining chat height, keeps sensible spacing,
  // and can scroll rather than cropping on a short window.
  await expect(empty).toHaveClass(/min-h-0/);
  await expect(empty).toHaveClass(/flex-1/);
  await expect(empty).toHaveClass(/overflow-y-auto/);
  await expect(empty).toHaveClass(/p-6/);
  const newChat = empty.getByRole("button", { name: "New chat" });
  await expect(newChat).toBeVisible();
  await newChat.click();
  await expect(page.getByTestId("session-startup")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("chat-list").locator('[data-active="true"]')).toHaveCount(1);
});
