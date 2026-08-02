import { expect, test, type Page } from "../helpers/fixtures.ts";
import type { SessionMeta } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

const FILE_PATH = '/definitely-missing/ses-06/notes & "plans".txt';
const FILE_NAME = 'notes & "plans".txt';
const ENCODED_TAG =
  '<file name="/definitely-missing/ses-06/notes &amp; &quot;plans&quot;.txt"></file>';

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({
    reply: () => "The file reference was received.",
    chunkDelayMs: 250,
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

function sentFileChip(page: Page) {
  return page
    .getByTestId("user-cell")
    .getByTestId("message-bubble-attachments")
    .getByRole("listitem", { name: `${FILE_NAME}: ${FILE_PATH}` });
}

test("a picked file survives live delivery, reload, resume, fork, and a missing source", async ({
  page,
}) => {
  await page.addInitScript((filePath) => {
    (
      globalThis as typeof globalThis & {
        agentDeck?: {
          isElectron: boolean;
          platform: string;
          chooseFiles(): Promise<string[]>;
        };
      }
    ).agentDeck = {
      isElectron: true,
      platform: "darwin",
      chooseFiles: async () => [filePath],
    };
  }, FILE_PATH);

  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const sourceId = await activeSessionId(page);

  await page.getByTestId("composer-input").fill("Start a response before my file follow-up.");
  await page.getByTestId("send-button").click();
  const streamingBehavior = page.getByTestId("streaming-behavior");
  await expect(streamingBehavior).toBeVisible();
  await streamingBehavior.selectOption("followUp");

  await page.getByTestId("attach-file-button").click();
  const draftChip = page.getByTestId("file-attachments").getByTitle(FILE_PATH);
  await expect(draftChip).toContainText(FILE_NAME);

  // File-only follow-ups are valid while Pi is running. The source path
  // deliberately never exists: neither selection nor replay may stat/read it.
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("file-attachments")).toHaveCount(0);
  await expect(sentFileChip(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Attached a file.")).toBeVisible();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });
  // Idle reconciliation adds Pi's stable entry id. Its same-cell replacement
  // must retain canonical attachment fields before snapshots/reloads consume it.
  await expect(sentFileChip(page)).toBeVisible();
  await expect(page.getByTestId("transcript")).not.toContainText("<file");
  const providerFileMessage = harness.mock.requests
    .flatMap((request) => request.messages)
    .find(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content) === JSON.stringify([{ type: "text", text: ENCODED_TAG }]),
    );
  expect(providerFileMessage?.content).toEqual([{ type: "text", text: ENCODED_TAG }]);

  await page.reload();
  await expect(sentFileChip(page)).toBeVisible({ timeout: 30_000 });

  const source = harness.server.sessions.get(sourceId);
  expect(source).toBeTruthy();
  await expect.poll(() => source!.meta.piSessionFile).toBeTruthy();
  await source!.stop();
  const resume = await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/resume`, {
    method: "POST",
  });
  expect(resume.status, await resume.text()).toBe(200);
  await page.reload();
  await expect(sentFileChip(page)).toBeVisible({ timeout: 30_000 });

  const forkResponse = await fetch(
    `${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/fork`,
    { method: "POST" },
  );
  expect(forkResponse.status).toBe(201);
  const { session: forkMeta } = (await forkResponse.json()) as { session: SessionMeta };
  await page.getByTestId("chat-list").getByTestId(`chat-${forkMeta.id}`).click();
  await expect(sentFileChip(page)).toBeVisible({ timeout: 30_000 });
});
