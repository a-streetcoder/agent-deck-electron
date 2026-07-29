import { expect, test, type Page } from "../helpers/fixtures.ts";
import type { SessionMeta } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

const PASTED_TEXT = Array.from({ length: 11 }, (_, index) =>
  index === 0 ? "first\tline" : `line ${index + 1}`,
).join("\r\n");
const NORMALIZED_TEXT = PASTED_TEXT.replaceAll("\r\n", "\n").replaceAll("\t", "    ");
const MARKER = "[paste #1 +11 lines]";

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({
    reply: () => "The pasted text was received.",
    chunkDelayMs: 10,
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

async function pasteText(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").evaluate((element, pastedText) => {
    const browser = globalThis as unknown as {
      DataTransfer: new () => { setData(type: string, value: string): void };
      ClipboardEvent: new (
        type: string,
        init: {
          bubbles: boolean;
          cancelable: boolean;
          clipboardData: unknown;
        },
      ) => Parameters<typeof element.dispatchEvent>[0];
    };
    const clipboardData = new browser.DataTransfer();
    clipboardData.setData("text/plain", pastedText);
    element.dispatchEvent(
      new browser.ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, text);
}

function sentPasteChip(page: Page) {
  return page
    .getByTestId("user-cell")
    .getByTestId("message-bubble-attachments")
    .getByRole("listitem", { name: `${MARKER}: Preview pasted text` });
}

test("a large paste stays compact and recoverable through reload, resume, and fork", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const sourceId = await activeSessionId(page);

  const input = page.getByTestId("composer-input");
  await input.focus();
  await pasteText(page, PASTED_TEXT);
  await expect(input).toHaveValue(MARKER);
  await expect(page.getByTestId("composer-submit-status")).toContainText("Large paste attached");

  await page.getByTestId("send-button").click();
  await expect(sentPasteChip(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Attached a paste.")).toBeVisible();
  await expect(page.getByTestId("transcript")).not.toContainText(NORMALIZED_TEXT);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });

  const providerMessage = harness.mock.requests
    .flatMap((request) => request.messages)
    .find(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content) ===
          JSON.stringify([{ type: "text", text: NORMALIZED_TEXT }]),
    );
  expect(providerMessage?.content).toEqual([{ type: "text", text: NORMALIZED_TEXT }]);

  await sentPasteChip(page)
    .getByRole("button", { name: `Preview ${MARKER}` })
    .click();
  await expect(page.getByRole("dialog", { name: "Pasted text preview" })).toBeVisible();
  await expect(page.getByTestId("paste-preview-content")).toHaveText(NORMALIZED_TEXT);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("paste-preview-dialog")).toHaveCount(0);

  await page.reload();
  await expect(sentPasteChip(page)).toBeVisible({ timeout: 30_000 });

  const source = harness.server.sessions.get(sourceId);
  expect(source).toBeTruthy();
  await expect.poll(() => source!.meta.piSessionFile).toBeTruthy();
  await source!.stop();
  const resume = await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/resume`, {
    method: "POST",
  });
  expect(resume.status, await resume.text()).toBe(200);
  await page.reload();
  await expect(sentPasteChip(page)).toBeVisible({ timeout: 30_000 });

  const forkResponse = await fetch(
    `${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/fork`,
    { method: "POST" },
  );
  expect(forkResponse.status).toBe(201);
  const { session: forkMeta } = (await forkResponse.json()) as { session: SessionMeta };
  await page.getByTestId("chat-list").getByTestId(`chat-${forkMeta.id}`).click();
  await expect(sentPasteChip(page)).toBeVisible({ timeout: 30_000 });
});

test("deleting a large-paste marker removes its hidden payload", async ({ page }) => {
  await page.goto(harness.baseUrl);
  const input = page.getByTestId("composer-input");
  await input.focus();
  await pasteText(page, "z".repeat(1_001));
  await expect(input).toHaveValue("[paste #1 1001 chars]");

  await input.fill("marker deleted");
  await page.getByTestId("send-button").click();
  await expect(page.getByText("marker deleted")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      harness.mock.requests
        .flatMap((request) => request.messages)
        .some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content) ===
              JSON.stringify([{ type: "text", text: "marker deleted" }]),
        ),
    )
    .toBe(true);
  await expect(
    page
      .getByTestId("user-cell")
      .last()
      .getByTestId("message-bubble-attachments")
      .getByRole("listitem"),
  ).toHaveCount(0);
});
