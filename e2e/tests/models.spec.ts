import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Tier-3 gate (Models screen): the provider/model catalog pi offers for the
 * current session renders grouped with metadata, and the active model is
 * marked. The mock provider registers one reasoning-capable model.
 */

let harness: E2eHarness;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("browses and curates the full catalog before a session, with retry and no activation", async ({
  page,
}) => {
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  await page.route("**/sessions", async (route) => {
    if (route.request().method() === "POST") await sessionGate;
    await route.continue();
  });

  let attempts = 0;
  await page.route("**/runtime/models/discover", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 502, contentType: "application/json", body: "{}" });
    } else {
      await route.continue();
    }
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-models").click();
  await expect(page.getByTestId("models-error")).toHaveAttribute("role", "alert");
  const retry = page.getByTestId("models-retry");
  await retry.focus();
  await retry.press("Enter");
  await expect(page.getByTestId("models-loading")).toHaveAttribute("role", "status");

  const search = page.getByTestId("models-search");
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  const model = page.getByTestId("model-mock-model");
  await expect(model).toContainText("128K ctx");
  await expect(model).toContainText("4K out");
  await expect(model.getByTestId("reasoning-badge")).toBeVisible();
  await expect(model).toContainText("image");
  await expect(model).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("model-select-mock-model")).toBeDisabled();
  await expect(model.getByLabel("Active model")).toHaveCount(0);
  await expect(page.getByTestId("model-activation-help-mock-model")).toContainText(
    "Start a session to activate",
  );

  // Curation remains available, and discovery rows remain visible while disabled.
  // Hold the first write to prove the same row serializes rapid activation.
  let curationWrites = 0;
  let releaseCuration!: () => void;
  const curationGate = new Promise<void>((resolve) => {
    releaseCuration = resolve;
  });
  await page.route("**/runtime/models/disabled", async (route) => {
    curationWrites += 1;
    if (curationWrites === 1) await curationGate;
    await route.continue();
  });
  const toggle = page.getByTestId("model-toggle-mock-model");
  await expect(toggle).toContainText("Shown in pickers");
  await toggle.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(toggle).toBeDisabled();
  await expect(model).toHaveAttribute("data-disabled", "false");
  await expect.poll(() => curationWrites).toBe(1);
  releaseCuration();
  await expect(model).toHaveAttribute("data-disabled", "true");
  await expect(toggle).toHaveAccessibleName("Enable model");
  await expect(toggle).toContainText("Hidden from pickers");
  await toggle.click();
  await expect(model).toHaveAttribute("data-disabled", "false");

  const sessions = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: unknown[];
  };
  expect(sessions.sessions).toEqual([]);

  // Once startup obtains a real session, the screen switches back to the
  // authoritative live routes and restores active-model behavior.
  releaseSession();
  await expect(page.getByTestId("model-select-mock-model")).toBeEnabled();
  await expect(model).toHaveAttribute("data-active", "true");
  await expect(model.getByLabel("Active model")).toBeVisible();
});

test("the Models screen lists the provider catalog and marks the active model", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // Send a message so a session exists with a resolved model.
  await page.getByTestId("composer-input").fill("hi");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text").last()).toContainText("hi", {
    timeout: 30_000,
  });

  await page.getByTestId("nav-models").click();
  await expect(page.getByTestId("models-screen")).toBeVisible();

  const model = page.getByTestId("model-mock-model");
  await expect(model).toBeVisible();
  await expect(model).toContainText("Mock Model");
  await expect(model.getByTestId("reasoning-badge")).toBeVisible();
  await expect(model).toContainText("128K ctx");
  // Max output tokens badge (native model row "ctx … · out …"): mock model is 4096.
  await expect(model).toContainText("4K out");
  // It's the session's active model.
  await expect(model).toHaveAttribute("data-active", "true");
});

test("the Models catalog search filters by name/id/provider", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  await page.getByTestId("composer-input").fill("hi");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text").last()).toContainText("hi", {
    timeout: 30_000,
  });
  await page.getByTestId("nav-models").click();

  const model = page.getByTestId("model-mock-model");
  await expect(model).toBeVisible();

  // Each provider group carries its brand logo (the "mock" provider has no bundled
  // mark, so it renders the monogram fallback — the wiring is what's asserted).
  await expect(page.getByTestId("provider-logo-mock").first()).toBeVisible();

  // A matching query keeps the model; a non-match shows the empty state.
  await page.getByTestId("models-search").fill("mock");
  await expect(model).toBeVisible();
  await page.getByTestId("models-search").fill("nonexistent-xyz");
  await expect(model).toHaveCount(0);
  await expect(page.getByTestId("models-search-empty")).toBeVisible();

  // Clearing restores it.
  await page.getByTestId("models-search").fill("");
  await expect(model).toBeVisible();
});
