import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Stage-B gate (composer parity): the model chip reflects pi's live state,
 * the model menu lists pi's available models, and the thinking picker
 * round-trips through pi itself (verified via get_state).
 */

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("thinking picker does not speculate while the model catalog is loading", async ({ page }) => {
  await page.route("**/sessions/*/models", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("thinking-chip-label")).not.toContainText("unavailable");
  await expect(page.getByTestId("thinking-chip")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("thinking-chip")).toHaveAttribute("aria-busy", "true");
  await page.getByTestId("thinking-chip").focus();
  await expect(page.getByTestId("thinking-chip")).toBeFocused();
  await page.getByTestId("thinking-chip").press("ArrowDown");
  await expect(page.getByTestId("thinking-menu")).toHaveCount(0);
  await expect(page.getByTestId("thinking-chip")).toHaveAttribute("aria-disabled", "false");
});

test("catalog-first loading does not mark an unknown Pi model unavailable", async ({ page }) => {
  await page.route("**/sessions/*/state", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.continue();
  });
  const catalogResponse = page.waitForResponse(
    (response) => response.url().includes("/sessions/") && response.url().endsWith("/models"),
  );
  await page.goto(harness.baseUrl);
  await catalogResponse;

  await expect(page.getByTestId("thinking-chip-label")).not.toContainText("unavailable");
  await expect(page.getByTestId("thinking-chip")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("thinking-chip")).toHaveAttribute("aria-busy", "true");
  await page.getByTestId("thinking-chip").press("ArrowDown");
  await expect(page.getByTestId("thinking-menu")).toHaveCount(0);
  await expect(page.getByTestId("thinking-chip")).toHaveAttribute("aria-disabled", "false");
});

test("model chip shows pi's current model and lists available models", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // Current model comes from pi get_state (the mock provider's model).
  await expect(page.getByTestId("model-chip-label")).toHaveText("mock-model");
  // The chip carries the provider's brand logo (the "mock" provider has no bundled mark → monogram fallback).
  await expect(page.getByTestId("model-chip").getByTestId("provider-logo-mock")).toBeVisible();

  await page.getByTestId("model-chip").click();
  await expect(page.getByTestId("model-menu")).toBeVisible();
  await expect(page.getByTestId("model-option-mock-model")).toBeVisible();
  await page.getByTestId("model-option-mock-model").click();
  await expect(page.getByTestId("model-menu")).toHaveCount(0);
});

test("thinking picker round-trips through pi", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  await page.getByTestId("thinking-chip").click();
  // Exact pinned-Pi ladder evidence: this model explicitly omits minimal and adds max.
  await expect(page.getByTestId("thinking-option-minimal")).toHaveCount(0);
  await expect(page.getByTestId("thinking-option-max")).toBeVisible();
  await page.getByTestId("thinking-option-high").click();
  await expect(page.getByTestId("thinking-chip-label")).toHaveText("high");

  // pi itself must report the new level.
  const sessionId = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; endedAt?: string }>;
  };
  const live = sessionId.sessions.filter((s) => !s.endedAt).at(-1)!;
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.baseUrl}/sessions/${live.id}/state`);
      if (!response.ok) return "";
      const { state } = (await response.json()) as { state: { thinkingLevel: string } };
      return state.thinkingLevel;
    })
    .toBe("high");
});

test("thinking picker restricts a non-reasoning model to 'off' (native supportsThinking gate)", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // The default model is reasoning-capable → the full ladder is offered.
  await page.getByTestId("thinking-chip").click();
  await expect(page.getByTestId("thinking-menu")).toBeVisible();
  await expect(page.getByTestId("thinking-option-high")).toBeVisible();

  // Switch to the non-reasoning "basic-model" (clicking the model chip also
  // dismisses the open thinking menu).
  await page.getByTestId("model-chip").click();
  await page.getByTestId("model-option-basic-model").click();
  await expect(page.getByTestId("model-chip-label")).toHaveText("basic-model");

  // Wait for the scheduled refresh to observe Pi's authoritative post-switch state.
  const sessionsResponse = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string; endedAt?: string }>;
  };
  const liveSession = sessionsResponse.sessions.filter((session) => !session.endedAt).at(-1)!;
  await expect
    .poll(async () => {
      const response = await fetch(`${harness.baseUrl}/sessions/${liveSession.id}/state`);
      if (!response.ok) return "";
      const { state } = (await response.json()) as {
        state: { model?: { id: string }; thinkingLevel: string };
      };
      return `${state.model?.id}:${state.thinkingLevel}`;
    })
    .toBe("basic-model:off");
  // Pinned Pi clamps the prior high value, and the refreshed chip reflects that truth.
  await expect(page.getByTestId("thinking-chip-label")).toHaveText("off");

  // Keyboard selection opens the exact off-only list and restores trigger focus.
  await page.getByTestId("thinking-chip").focus();
  await page.getByTestId("thinking-chip").press("ArrowDown");
  await expect(page.getByTestId("thinking-option-off")).toBeFocused();
  await page.getByTestId("thinking-option-off").press("Enter");
  await expect(page.getByTestId("thinking-chip")).toBeFocused();
  await expect(page.getByTestId("thinking-chip-label")).toHaveText("off");

  // Now the thinking picker offers only "off" — no reasoning levels.
  await page.getByTestId("thinking-chip").click();
  await expect(page.getByTestId("thinking-menu")).toBeVisible();
  await expect(page.getByTestId("thinking-option-off")).toBeVisible();
  await expect(page.getByTestId("thinking-option-high")).toHaveCount(0);
  await expect(page.getByTestId("thinking-option-minimal")).toHaveCount(0);

  // Switching back restores that model's exact reported subset, including max.
  await page.getByTestId("model-chip").click();
  await page.getByTestId("model-option-mock-model").click();
  await page.getByTestId("thinking-chip").click();
  await expect(page.getByTestId("thinking-option-max")).toBeVisible();
  await expect(page.getByTestId("thinking-option-minimal")).toHaveCount(0);
});
