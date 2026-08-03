import { expect, test, type Page } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
let replyNumber = 0;

test.beforeAll(async () => {
  harness = await startHarness({
    reply: () =>
      `Fresh answer ${++replyNumber} streams in several ordered pieces for history actions`,
    chunkDelayMs: 40,
  });
});

test.afterAll(async () => harness.close());

const waitIdle = async (page: Page): Promise<void> => {
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 60_000,
  });
};

const send = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-button").click();
  await waitIdle(page);
};

// Both compact and expanded session panels stay mounted during the native-style
// transition. Navigation must target the one currently presented to the user.
const visibleChatList = (page: Page) => page.getByTestId("chat-list").filter({ visible: true });

test("Fork creates and selects an editable target draft and focuses its composer", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await waitIdle(page);
  await send(page, "fork this exact turn");
  await send(page, "later turn excluded from the fork");
  const before = (await (await page.request.get(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; piSessionFile?: string }>;
  };
  const sourceBefore = before.sessions.at(-1)!;

  const sourceRows = await page
    .getByTestId("chat-list")
    .locator(":scope > [data-testid^='chat-']")
    .count();
  const chosen = page.getByTestId("user-cell").filter({ hasText: "fork this exact turn" });
  await chosen.getByTestId("message-fork").click();

  const composer = page.getByTestId("composer-input");
  await expect(composer).toHaveValue("fork this exact turn", { timeout: 60_000 });
  await expect(composer).toBeFocused();
  await composer.fill("fork this exact turn, edited");
  await expect(composer).toHaveValue("fork this exact turn, edited");
  await expect(
    page.getByTestId("chat-list").locator(":scope > [data-testid^='chat-']"),
  ).toHaveCount(sourceRows + 1);
  await expect(page.getByTestId("transcript")).not.toContainText(
    "later turn excluded from the fork",
  );
  const after = (await (await page.request.get(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{
      id: string;
      piSessionFile?: string;
      endedAt?: string;
      worktreePath?: string;
      worktreeIdentity?: string;
    }>;
  };
  const sourceAfter = after.sessions.find((item) => item.id === sourceBefore.id)!;
  const targetAfter = after.sessions.find((item) => item.id !== sourceBefore.id)!;
  expect(sourceAfter.piSessionFile).toBe(sourceBefore.piSessionFile);
  expect(sourceAfter.endedAt).toBeTruthy();
  expect(targetAfter.piSessionFile).not.toBe(sourceBefore.piSessionFile);
  expect(targetAfter.worktreePath).toBeUndefined();
  expect(targetAfter.worktreeIdentity).toBeUndefined();

  // Provenance is published with the target and remains usable across reload.
  const card = page.getByTestId("fork-provenance-card");
  await expect(card).toBeVisible();
  await page.reload();
  await expect(card).toBeVisible();
  const recapTrigger = card.getByRole("button", { name: "View recap" });
  await recapTrigger.focus();
  await recapTrigger.click();
  await expect(page.getByRole("dialog", { name: "Inherited conversation recap" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fork-recap-dialog")).toHaveCount(0);
  await expect(recapTrigger).toBeFocused();

  // The durable immediate-source id uses the existing session switch path.
  await card.getByRole("button", { name: "Open source" }).click();
  await expect(visibleChatList(page).getByTestId(`chat-${sourceBefore.id}`)).toHaveAttribute(
    "data-active",
    "true",
  );
  await visibleChatList(page).getByTestId(`chat-${targetAfter.id}`).click();
  await expect(visibleChatList(page).getByTestId(`chat-${targetAfter.id}`)).toHaveAttribute(
    "data-active",
    "true",
  );

  // Source deletion is allowed; the captured title/recap remain honest and
  // durable on the independently owned target.
  const deleted = await page.request.delete(`${harness.baseUrl}/sessions/${sourceBefore.id}`);
  expect(deleted.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("fork-provenance-card")).toContainText(
    "Source chat is no longer available.",
  );
  await expect(page.getByRole("button", { name: "Open source" })).toHaveCount(0);
  await page.getByRole("button", { name: "View recap" }).click();
  await expect(page.getByRole("dialog", { name: "Inherited conversation recap" })).toBeVisible();
});

test("DELETE and merge lose deterministically to an already-started history transaction", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await waitIdle(page);
  await send(page, "serialize this history action");
  const list = (await (await page.request.get(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string }>;
  };
  const source = list.sessions.at(-1)!;
  const chosen = page.getByTestId("user-cell").filter({ hasText: "serialize this history action" });
  await chosen.getByTestId("message-fork").click({ noWaitAfter: true });
  const [deletion, merge] = await Promise.all([
    page.request.delete(`${harness.baseUrl}/sessions/${source.id}`),
    page.request.post(`${harness.baseUrl}/sessions/${source.id}/merge`),
  ]);
  expect(deletion.status()).toBe(409);
  await expect(deletion.json()).resolves.toMatchObject({ code: "session_mutation_busy" });
  expect(merge.status()).toBe(409);
  await expect(merge.json()).resolves.toMatchObject({ code: "session_mutation_busy" });
  await expect(page.getByTestId("composer-input")).toHaveValue("serialize this history action", {
    timeout: 60_000,
  });
});

test("Re-run traps confirmation focus, restores on Escape, keeps one row, and gets a fresh answer", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await waitIdle(page);
  await send(page, "rerun this exact turn");
  await send(page, "conversation that will be abandoned");
  const before = (await (await page.request.get(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; piSessionFile?: string }>;
  };
  const activeBefore = before.sessions.at(-1)!;

  const rowsBefore = await page
    .getByTestId("chat-list")
    .locator(":scope > [data-testid^='chat-']")
    .count();
  const chosen = page.getByTestId("user-cell").filter({ hasText: "rerun this exact turn" });
  const trigger = chosen.getByTestId("message-rerun");
  await trigger.focus();
  await trigger.click();
  await expect(page.getByTestId("rerun-confirm")).toContainText(
    "Later conversation messages will be abandoned. Workspace files are not changed.",
  );
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rerun-confirm")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByTestId("rerun-confirm-button").click();
  await waitIdle(page);
  await expect(
    page.getByTestId("chat-list").locator(":scope > [data-testid^='chat-']"),
  ).toHaveCount(rowsBefore);
  await expect(page.getByTestId("transcript")).not.toContainText(
    "conversation that will be abandoned",
  );
  await expect(page.getByTestId("assistant-cell").last()).toContainText("Fresh answer", {
    timeout: 60_000,
  });
  const after = (await (await page.request.get(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; piSessionFile?: string }>;
  };
  const activeAfter = after.sessions.find((item) => item.id === activeBefore.id)!;
  expect(activeAfter.id).toBe(activeBefore.id);
  expect(activeAfter.piSessionFile).not.toBe(activeBefore.piSessionFile);
});

test("Copy uses one gutter action per seeded user or assistant message", async ({ page }) => {
  await page.addInitScript(() => {
    const browser = globalThis as typeof globalThis & {
      navigator: object;
      transcriptCopiedText?: string;
    };
    Object.defineProperty(browser.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          browser.transcriptCopiedText = text;
        },
      },
    });
  });
  await page.setViewportSize({ width: 720, height: 640 });
  await page.goto(harness.baseUrl);
  await waitIdle(page);
  const prompt = `copy this exact narrow message ${"without-clipping-".repeat(18)}`;
  await send(page, prompt);

  const assistant = page.getByTestId("assistant-cell").last();
  await expect(assistant).toHaveAttribute("data-streaming", "false", { timeout: 60_000 });

  const user = page.getByTestId("user-cell").filter({ hasText: prompt });
  const userCopy = user.getByTestId("message-copy");
  await expect(userCopy).toHaveCount(1);
  await user.hover();
  await expect(userCopy).toBeVisible();
  await userCopy.click();
  await expect(userCopy).toHaveAccessibleName("Copied");
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { transcriptCopiedText?: string }).transcriptCopiedText,
    ),
  ).toBe(prompt);

  const assistantCopy = assistant.locator("..").getByTestId("message-copy");
  await expect(assistantCopy).toHaveCount(1);
  await assistant.hover();
  await expect(assistantCopy).toBeVisible();
});
