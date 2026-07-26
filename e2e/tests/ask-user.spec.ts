import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({
    toolCall: (_message, body) =>
      body.messages.some((entry) => entry.role === "tool")
        ? null
        : {
            name: "ask_user",
            arguments: {
              question: "Choose a deployment path",
              context: "The safe path runs all checks.",
              options: [{ title: "Safe", description: "Run all checks" }, "Fast"],
              allowComment: true,
            },
          },
    reply: () => "Thanks, I have the decision.",
  });
});

test.afterAll(async () => {
  await harness.close();
});

test("parent ask_user survives reload and is keyboard-answerable without subagent wording", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("composer-input").fill("ask me");
  await page.getByTestId("send-button").click();

  const card = page.getByTestId("ask-user-cell");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Agent needs your input");
  await expect(card).toContainText("Run all checks");
  await expect(card).not.toContainText(/subagent/i);

  await page.reload();
  await expect(card).toHaveAttribute("data-status", "pending", { timeout: 15_000 });
  const safe = card.getByRole("radio", { name: /Safe/ });
  await safe.focus();
  await page.keyboard.press("Space");
  await card.getByLabel("Optional comment").fill("Approved after review");
  await card.getByRole("button", { name: "Answer", exact: true }).focus();
  await page.keyboard.press("Enter");

  await expect(card).toHaveAttribute("data-status", "answered", { timeout: 15_000 });
  await expect(card.getByTestId("ask-user-audit")).toContainText("Answered: Safe");
  await expect(page.getByTestId("assistant-text")).toContainText("Thanks, I have the decision.");
});
