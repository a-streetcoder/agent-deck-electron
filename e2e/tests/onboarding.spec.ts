import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Onboarding (native WelcomeOnboardingSheet): a phased first-run flow — the
 * illustrated tour, then a functional Setup Check (the /runtime/doctor
 * dependency probe), then a Final step that smart-routes to whatever still
 * needs attention. Shows while the user has no projects; auto-hides once one
 * exists. The onboarding suite imports `test` from @playwright/test directly
 * (no fixtures pre-dismiss), so it sees the modal.
 */

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("walks the tour, runs setup, and gates entry until required setup is ready", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  const overlay = page.getByTestId("onboarding");
  await expect(overlay).toBeVisible();
  await expect(overlay).not.toHaveAttribute("role", "dialog");
  await expect(page.getByTestId("onboarding-setup-summary")).toBeVisible();
  const [onboardingBox, workspaceBox] = await Promise.all([
    overlay.boundingBox(),
    page.getByTestId("workspace-row").boundingBox(),
  ]);
  expect(onboardingBox).toEqual(workspaceBox);

  // Tour: the native illustration + title, advancing through the pages.
  await expect(page.getByTestId("onboarding-image")).toBeVisible();
  await expect(page.getByTestId("onboarding-title")).toHaveText("Command Pi from Agent Deck");
  await page.getByRole("button", { name: "Next welcome slide" }).click();
  await expect(page.getByTestId("onboarding-title")).toHaveText("Work in a Coding Chat");
  await expect(page.getByTestId("onboarding-skip")).toHaveCount(0);

  // Entry is a setup gate, not a carousel progression button. This hermetic
  // environment has no provider credential, so it remains disabled.
  const getStarted = page.getByTestId("onboarding-get-started");
  await expect(getStarted).toBeDisabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "View details" }).click();

  // Setup Check: the doctor probe renders real checks, including the pi runtime.
  await expect(page.getByTestId("onboarding-setup")).toBeVisible();
  const piCheck = page.locator('[data-check-id="pi-binary"]');
  await expect(piCheck).toBeVisible();
  // pi is installed in the e2e environment, so it reads Ready. The doctor
  // probes real subprocesses and can take 4-10s under full-suite load — same
  // headroom precedent as the doctor unit tests.
  await expect(piCheck).toHaveAttribute("data-check-status", "ok", { timeout: 20_000 });

  // Missing provider auth blocks progression and offers the integrated
  // connection flow instead of revealing the main application.
  await expect(page.getByTestId("onboarding-setup-continue")).toBeDisabled();
  await expect(page.getByTestId("onboarding-connect-provider")).toBeVisible();
  await expect(overlay).toBeVisible();
});

test("the welcome carousel advances automatically", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("onboarding-title")).toHaveText("Command Pi from Agent Deck");
  await expect(page.getByTestId("onboarding-title")).toHaveText("Work in a Coding Chat", {
    timeout: 7_000,
  });
});

test("the welcome auto-hides once a project exists", async ({ page }) => {
  const project = mkdtempSync(path.join(tmpdir(), "proj-onboarding-"));
  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  expect(response.ok).toBe(true);

  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("onboarding")).toBeHidden();
});
