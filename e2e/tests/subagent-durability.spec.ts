import type { ChatCompletionRequest } from "@agent-deck/testkit";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

const PARENT_PROMPT = "Delegate the durable summary task.";
const SUBAGENT_TASK = "Summarize the durable renderer evidence.";
const SUBAGENT_OUTPUT = "DURABLE_SUBAGENT_SENTINEL: renderer evidence complete.";

let harness: E2eHarness;

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
      if (
        lastUser !== PARENT_PROMPT ||
        isChildRequest(body) ||
        body.messages.some((message) => message.role === "tool")
      ) {
        return null;
      }
      return { name: "managed_subagent", arguments: { task: SUBAGENT_TASK } };
    },
    reply: () => SUBAGENT_OUTPUT,
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
  await task.focus();
  await expect(task).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(output).toBeFocused();

  const listed = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; endedAt?: string }>;
  };
  const sessionId = listed.sessions.filter((session) => !session.endedAt).at(-1)!.id;
  const session = harness.server.sessions.get(sessionId)!;
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
  await expect(restoredDeckRun.getByTestId("deck-run-task")).toHaveText(SUBAGENT_TASK);
  await expect(restoredDeckRun.getByTestId("deck-run-output")).toHaveText(SUBAGENT_OUTPUT);
});
