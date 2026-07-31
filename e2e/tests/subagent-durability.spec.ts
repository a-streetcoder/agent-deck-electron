import type { ChatCompletionRequest } from "@agent-deck/testkit";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

const PARENT_PROMPT = "Delegate the durable summary task.";
const SUBAGENT_TASK = "Summarize the durable renderer evidence.";
const SUBAGENT_OUTPUT = "DURABLE_SUBAGENT_SENTINEL: renderer evidence complete.";
const FOLLOW_UP_PROMPT = "Ask the same child for a durable follow-up.";
const FOLLOW_UP_TASK = "Continue from your child history and return the latest renderer evidence.";
const FOLLOW_UP_OUTPUT = "DURABLE_CONTINUATION_SENTINEL: same child card updated.";

let harness: E2eHarness;

function allObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...allObjectKeys(nested)]);
}

function isChildRequest(body: ChatCompletionRequest): boolean {
  return body.messages
    .filter((message) => message.role === "developer" || message.role === "system")
    .some((message) =>
      (typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)
      ).includes("focused subagent launched by Agent Deck"),
    );
}

test.beforeAll(async () => {
  harness = await startHarness({
    chunkDelayMs: 20,
    toolCall: (lastUser, body) => {
      if (isChildRequest(body) || body.messages.at(-1)?.role === "tool") return null;
      if (lastUser === PARENT_PROMPT) {
        return { name: "managed_subagent", arguments: { task: SUBAGENT_TASK } };
      }
      if (lastUser === FOLLOW_UP_PROMPT) {
        const id = /Deck subagent ID: ([0-9a-f-]{36})/i.exec(JSON.stringify(body.messages))?.[1];
        if (!id) throw new Error("stable Deck subagent ID missing from parent history");
        return {
          name: "managed_subagent",
          arguments: { task: FOLLOW_UP_TASK, continueSubagentID: id },
        };
      }
      return null;
    },
    reply: (lastUser) => (lastUser === FOLLOW_UP_TASK ? FOLLOW_UP_OUTPUT : SUBAGENT_OUTPUT),
  });
});

test.afterAll(async () => {
  await harness.close();
});

test("restores one completed generic subagent card after end and resume", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  await page.getByTestId("composer-input").fill(PARENT_PROMPT);
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });

  const card = page.getByTestId("subagent-cell");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-status", "done");
  const deckRun = page.getByTestId("deck-run");
  await expect(deckRun).toHaveCount(1);
  await expect(deckRun).toHaveAttribute("data-status", "done");
  await deckRun.getByTestId("deck-run-toggle").click();
  const task = deckRun.getByTestId("deck-run-task");
  const output = deckRun.getByTestId("deck-run-output");
  await expect(task).toHaveText(SUBAGENT_TASK);
  await expect(output).toHaveText(SUBAGENT_OUTPUT);
  await card.getByRole("button", { name: "Open child transcript" }).click();
  const childDialog = page.getByRole("dialog", { name: "Child transcript" });
  await expect(childDialog).toBeVisible();
  const childContent = childDialog.getByTestId("child-transcript-content");
  await expect(childContent.getByText(SUBAGENT_TASK, { exact: true })).toBeVisible();
  await expect(childContent.getByText(SUBAGENT_OUTPUT, { exact: true })).toBeVisible();
  await childDialog.getByRole("button", { name: "Close child transcript" }).click();
  await expect(childDialog).toBeHidden();
  await task.focus();
  await expect(task).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(output).toBeFocused();

  const transcriptToggle = card.getByRole("button", { name: /Subagent/i });
  if ((await transcriptToggle.getAttribute("aria-expanded")) === "true") {
    await transcriptToggle.click();
  }
  await deckRun.getByTestId("deck-run-toggle").click();
  await expect(deckRun).toHaveAttribute("data-expanded", "false");

  await page.getByTestId("composer-input").fill(FOLLOW_UP_PROMPT);
  await page.getByTestId("send-button").click();
  // The mock turn can finish between browser polls, so assert the durable effect
  // of terminal→running rather than requiring observation of the brief status.
  await expect(deckRun).toHaveAttribute("data-expanded", "true", { timeout: 30_000 });
  await expect(transcriptToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("subagent-cell")).toHaveCount(1);
  await expect(page.getByTestId("deck-run")).toHaveCount(1);
  await transcriptToggle.click();
  await expect(transcriptToggle).toHaveAttribute("aria-expanded", "false");
  await expect(task).toHaveText(FOLLOW_UP_TASK);
  await expect(output).toHaveText(FOLLOW_UP_OUTPUT);

  const listed = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; endedAt?: string }>;
  };
  const sessionId = listed.sessions.filter((session) => !session.endedAt).at(-1)!.id;
  const session = harness.server.sessions.get(sessionId)!;
  const runId = session.snapshot().state.cells.find((cell) => cell.kind === "subagent")!.id;
  const transcriptResponse = await fetch(
    `${harness.baseUrl}/sessions/${sessionId}/subagent-runs/${runId}/transcript`,
  );
  expect(transcriptResponse.status).toBe(200);
  const transcriptJson = (await transcriptResponse.json()) as unknown;
  const returnedKeys = allObjectKeys(transcriptJson);
  expect(returnedKeys).not.toEqual(
    expect.arrayContaining([
      "sessionFile",
      "artifactRootToken",
      "artifactRootId",
      "worktreePath",
      "turnDirectory",
      "sessionsDirectory",
      "agentStatus",
      "pendingInput",
      "plan",
      "contextRevision",
    ]),
  );
  expect(
    (await fetch(`${harness.baseUrl}/sessions/not-a-uuid/subagent-runs/${runId}/transcript`))
      .status,
  ).toBe(400);
  const otherParentResponse = await fetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(otherParentResponse.status).toBe(201);
  const otherParentId = ((await otherParentResponse.json()) as { session: { id: string } }).session
    .id;
  const foreignResponse = await fetch(
    `${harness.baseUrl}/sessions/${otherParentId}/subagent-runs/${runId}/transcript`,
  );
  expect(foreignResponse.status).toBe(404);
  expect(await foreignResponse.text()).not.toContain(sessionId);
  expect(
    (await fetch(`${harness.baseUrl}/sessions/${otherParentId}`, { method: "DELETE" })).status,
  ).toBe(200);

  await expect.poll(() => session.meta.piSessionFile).toBeTruthy();
  await session.stop();

  const resumed = await fetch(
    `${harness.baseUrl}/sessions/${encodeURIComponent(sessionId)}/resume`,
    {
      method: "POST",
    },
  );
  expect(resumed.status, await resumed.text()).toBe(200);
  await page.reload();

  const restoredCard = page.getByTestId("subagent-cell");
  await expect(restoredCard).toHaveCount(1, { timeout: 30_000 });
  await expect(restoredCard).toHaveAttribute("data-status", "done");
  const restoredDeckRun = page.getByTestId("deck-run");
  await expect(restoredDeckRun).toHaveCount(1);
  await expect(restoredDeckRun).toHaveAttribute("data-status", "done");
  await restoredDeckRun.getByTestId("deck-run-toggle").click();
  await expect(restoredDeckRun.getByTestId("deck-run-task")).toHaveText(FOLLOW_UP_TASK);
  await expect(restoredDeckRun.getByTestId("deck-run-output")).toHaveText(FOLLOW_UP_OUTPUT);
  const restoredToggle = restoredCard.getByRole("button", { name: /Subagent result/i });
  if ((await restoredToggle.getAttribute("aria-expanded")) !== "true") await restoredToggle.click();
  const restoredTranscriptTrigger = restoredCard.getByRole("button", {
    name: "Open child transcript",
  });
  await restoredTranscriptTrigger.click();
  const restoredDialog = page.getByRole("dialog", { name: "Child transcript" });
  const restoredContent = restoredDialog.getByTestId("child-transcript-content");
  await expect(restoredContent.getByText(SUBAGENT_TASK, { exact: true })).toBeVisible();
  await expect(restoredContent.getByText(SUBAGENT_OUTPUT, { exact: true })).toBeVisible();
  await expect(restoredContent.getByText(FOLLOW_UP_TASK, { exact: true })).toBeVisible();
  await expect(restoredContent.getByText(FOLLOW_UP_OUTPUT, { exact: true })).toBeVisible();
  await restoredDialog.getByRole("button", { name: "Close child transcript" }).focus();
  await page.keyboard.press("Escape");
  await expect(restoredDialog).toBeHidden();
  await expect(restoredTranscriptTrigger).toBeFocused();
});
