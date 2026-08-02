import { expect, test, type Page } from "../helpers/fixtures.ts";
import type { SessionMeta } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

const FOLDER_PATH = "/definitely-missing/ses-07/project folder";
const FOLDER_NAME = "project folder";
const FOLDER_REFERENCE = "folder: `/definitely-missing/ses-07/project folder`";

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({
    reply: () => "The folder reference was received.",
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

function sentFolderChip(page: Page) {
  return page
    .getByTestId("user-cell")
    .getByTestId("message-bubble-attachments")
    .getByRole("listitem", { name: `${FOLDER_NAME}: ${FOLDER_PATH}` });
}

test("a picked folder survives live delivery, reload, resume, fork, and a missing source", async ({
  page,
}) => {
  await page.addInitScript((folderPath) => {
    (
      globalThis as typeof globalThis & {
        agentDeck?: {
          isElectron: boolean;
          platform: string;
          chooseDirectory(): Promise<string[]>;
        };
      }
    ).agentDeck = {
      isElectron: true,
      platform: "darwin",
      chooseDirectory: async () => [folderPath],
    };
  }, FOLDER_PATH);

  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const sourceId = await activeSessionId(page);

  await page.getByTestId("composer-input").fill("Start a response before my folder follow-up.");
  await page.getByTestId("send-button").click();
  const streamingBehavior = page.getByTestId("streaming-behavior");
  await expect(streamingBehavior).toBeVisible();
  await streamingBehavior.selectOption("followUp");

  await page.getByTestId("attach-folder-button").click();
  const draftChip = page.getByTestId("folder-attachments").getByTitle(FOLDER_PATH);
  await expect(draftChip).toContainText(FOLDER_NAME);

  // Folder-only follow-ups are valid while Pi is running. The source path
  // deliberately never exists: selection and replay must not enumerate it.
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("folder-attachments")).toHaveCount(0);
  await expect(sentFolderChip(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Attached a folder.")).toBeVisible();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });
  // Idle reconciliation adds Pi's stable entry id. Its same-cell replacement
  // must retain canonical attachment fields before snapshots/reloads consume it.
  await expect(sentFolderChip(page)).toBeVisible();
  await expect(page.getByTestId("transcript")).not.toContainText("folder: `");
  const providerFolderMessage = harness.mock.requests
    .flatMap((request) => request.messages)
    .find(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content) ===
          JSON.stringify([{ type: "text", text: FOLDER_REFERENCE }]),
    );
  expect(providerFolderMessage?.content).toEqual([{ type: "text", text: FOLDER_REFERENCE }]);

  await page.reload();
  await expect(sentFolderChip(page)).toBeVisible({ timeout: 30_000 });

  const source = harness.server.sessions.get(sourceId);
  expect(source).toBeTruthy();
  await expect.poll(() => source!.meta.piSessionFile).toBeTruthy();
  await source!.stop();
  const resume = await fetch(`${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/resume`, {
    method: "POST",
  });
  expect(resume.status, await resume.text()).toBe(200);
  await page.reload();
  await expect(sentFolderChip(page)).toBeVisible({ timeout: 30_000 });

  const forkResponse = await fetch(
    `${harness.baseUrl}/sessions/${encodeURIComponent(sourceId)}/fork`,
    { method: "POST" },
  );
  expect(forkResponse.status).toBe(201);
  const { session: forkMeta } = (await forkResponse.json()) as { session: SessionMeta };
  await page.getByTestId("chat-list").getByTestId(`chat-${forkMeta.id}`).click();
  await expect(sentFolderChip(page)).toBeVisible({ timeout: 30_000 });
});

test("an unrepresentable selected folder stays out of the draft with actionable feedback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (
      globalThis as typeof globalThis & {
        agentDeck?: {
          isElectron: boolean;
          platform: string;
          chooseDirectory(): Promise<string[]>;
        };
      }
    ).agentDeck = {
      isElectron: true,
      platform: "darwin",
      chooseDirectory: async () => ["/tmp/project`draft"],
    };
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("attach-folder-button").click();

  await expect(page.getByTestId("folder-attachments")).toHaveCount(0);
  await expect(page.getByTestId("composer-submit-status")).toContainText(
    "Choose an absolute path that does not contain a backtick",
  );
});
