import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Stage-F gate (runtime screens): the Environment inspector shows masked
 * .env values with scope + override flags, and Doctor reports a healthy pi
 * binary (the harness resolves the real pi) with version.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-runtime-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
  mkdirSync(path.join(harness.piHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(harness.piHome, ".pi", "agent", ".env"),
    "OPENAI_API_KEY=sk-secret-value-1234\nSHARED_KEY=global-value\n",
  );
  writeFileSync(
    path.join(harness.piHome, ".pi", "agent", "settings.json"),
    JSON.stringify({ packages: ["runtime-global-package"] }),
  );
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  writeFileSync(
    path.join(project, ".pi", "settings.json"),
    JSON.stringify({ prompts: ["runtime-project-prompt"] }),
  );
  writeFileSync(
    path.join(project, ".pi", ".env"),
    "SHARED_KEY=project-value\nEXA_API_KEY=exa-project-super-secret-7890\n",
  );

  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!response.ok) throw new Error(await response.text());
});

test.afterAll(async () => {
  await harness.close();
});

test("environment inspector masks values and flags overrides", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);

  await page.getByTestId("nav-environment").click();

  const apiKeyRow = page.locator('[data-env-key="OPENAI_API_KEY"]');
  await expect(apiKeyRow).toBeVisible();
  // The full secret is never rendered — only a masked tail.
  await expect(apiKeyRow).not.toContainText("sk-secret-value-1234");
  await expect(apiKeyRow).toContainText("1234");
  // Each row names its source .env file (native 5.2).
  await expect(apiKeyRow.getByTestId("env-source")).toContainText(".env");

  // SHARED_KEY exists globally (overridden) and in the project.
  const sharedRows = page.locator('[data-env-key="SHARED_KEY"]');
  await expect(sharedRows).toHaveCount(2);
});

test("doctor reports a healthy pi binary with a version", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-doctor").click();

  const binCheck = page.locator('[data-check-id="pi-binary"]');
  await expect(binCheck).toBeVisible();
  await expect(binCheck).toHaveAttribute("data-check-status", "ok");

  const versionCheck = page.locator('[data-check-id="pi-version"]');
  await expect(versionCheck).toHaveAttribute("data-check-status", "ok");
  await expect(versionCheck).toContainText("0.82.0");

  // Node.js runtime check: pi is a Node CLI, so it's a first-class preflight.
  // The e2e runner is on Node ≥ pi's minimum, so it reports ok.
  const nodeCheck = page.locator('[data-check-id="node"]');
  await expect(nodeCheck).toBeVisible();
  await expect(nodeCheck).toHaveAttribute("data-check-status", "ok");
  await expect(nodeCheck).toContainText("Node.js");

  // Global settings provenance is always visible, including its exact source.
  const settingsCheck = page.locator('[data-check-id="settings"]');
  await expect(settingsCheck).toBeVisible();
  await expect(settingsCheck).toHaveAttribute("data-check-status", "ok");
  await expect(settingsCheck).toContainText(
    path.join(harness.piHome, ".pi", "agent", "settings.json"),
  );
  await expect(page.locator('[data-check-id="settings-project"]')).toHaveCount(0);

  // The GitHub CLI check is surfaced (its ok/warn verdict depends on the host's
  // gh install/auth, so only its presence is asserted here).
  const githubCheck = page.locator('[data-check-id="github"]');
  await expect(githubCheck).toBeVisible();
  await expect(githubCheck).toContainText("GitHub CLI");

  const exaCheck = page.locator('[data-check-id="web-access-exa"]');
  await expect(exaCheck).toBeVisible();
  await expect(exaCheck).toHaveAttribute("data-check-status", "warn");
  await expect(exaCheck).toContainText("Warning");
  await expect(exaCheck).toContainText(/optional.*EXA_API_KEY/i);
  await expect(exaCheck).toContainText(/unavailable in this Electron build/i);
  await expect(exaCheck).toContainText(/no network or credential validity test ran/i);

  const urlFetchCheck = page.locator('[data-check-id="web-access-url-fetch"]');
  await expect(urlFetchCheck).toBeVisible();
  await expect(urlFetchCheck).toHaveAttribute("data-check-status", "warn");
  await expect(urlFetchCheck).toContainText("Warning");
  await expect(urlFetchCheck).toContainText(/known-URL fetching is unavailable/i);
  await expect(urlFetchCheck).toContainText(/no network test ran/i);

  // Re-check button works.
  await page.getByTestId("doctor-refresh").click();
  await expect(page.locator('[data-check-id="pi-binary"]')).toBeVisible();
});

test("Doctor inspects the selected project's effective environment without leaking it", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  const doctorRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith("/runtime/doctor"),
  );
  await page.getByTestId("nav-doctor").click();
  const request = await doctorRequest;
  expect(new URL(request.url()).searchParams.get("projectId")).toBeTruthy();

  const globalSettingsCheck = page.locator('[data-check-id="settings"]');
  const projectSettingsCheck = page.locator('[data-check-id="settings-project"]');
  await expect(globalSettingsCheck).toContainText(
    path.join(harness.piHome, ".pi", "agent", "settings.json"),
  );
  await expect(projectSettingsCheck).toContainText(path.join(project, ".pi", "settings.json"));
  await expect(projectSettingsCheck).toContainText(/selected project's settings candidate/i);
  await expect(projectSettingsCheck).toContainText(
    /new trusted Pi sessions load a valid candidate.*matching values then override global settings/i,
  );

  const exaCheck = page.locator('[data-check-id="web-access-exa"]');
  await expect(exaCheck).toContainText("EXA_API_KEY is configured");
  await expect(exaCheck).toContainText(/tools are unavailable/i);
  await expect(page.getByTestId("doctor-screen")).not.toContainText(
    "exa-project-super-secret-7890",
  );
  await expect(exaCheck.getByTestId("doctor-fix-copy")).toHaveCount(0);

  // Switching project while Doctor remains mounted triggers a fresh request
  // and re-reads the effective global environment.
  const globalRequest = page.waitForRequest((next) =>
    new URL(next.url()).pathname.endsWith("/runtime/doctor"),
  );
  await page.getByTestId("project-picker").click();
  await page.getByTestId("project-all-projects").click();
  const nextRequest = await globalRequest;
  expect(new URL(nextRequest.url()).searchParams.has("projectId")).toBe(false);
  await expect(exaCheck).toContainText(/optional.*EXA_API_KEY/i);
  await expect(projectSettingsCheck).toHaveCount(0);
  await expect(globalSettingsCheck).toContainText(
    path.join(harness.piHome, ".pi", "agent", "settings.json"),
  );
});

test("Doctor preserves results across a retryable refresh failure", async ({ page }) => {
  let requestCount = 0;
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const report = {
    report: {
      checks: [
        {
          id: "web-access-exa",
          label: "Web Access — Exa search",
          status: "warn",
          detail:
            "Optional: add EXA_API_KEY in Environment. Exa web tools are unavailable in this Electron build, and no network or credential validity test ran.",
        },
        {
          id: "web-access-url-fetch",
          label: "Web Access — URL fetch",
          status: "warn",
          detail:
            "Optional known-URL fetching is unavailable in this Electron build. No network test ran.",
        },
      ],
    },
  };
  // OnboardingOverlay fetches Doctor unconditionally even when dismissed by the
  // shared fixture. Let that real response finish before intercepting so request
  // #1 below deterministically belongs to DoctorScreen.
  const onboardingDoctor = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/runtime/doctor"),
  );
  await page.goto(harness.baseUrl);
  await onboardingDoctor;

  await page.route("**/runtime/doctor*", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await firstPending;
      await route.fulfill({ status: 200, json: report });
    } else if (requestCount === 2) {
      await route.fulfill({ status: 503, json: { error: "private server detail" } });
    } else {
      await route.fulfill({ status: 200, json: report });
    }
  });

  await page.getByTestId("nav-doctor").click();
  await expect(page.getByTestId("doctor-screen").locator("[aria-busy=true]")).toBeVisible();
  await expect(page.getByTestId("doctor-status")).toHaveText("Checking diagnostics…");
  const refresh = page.getByTestId("doctor-refresh");
  await expect(refresh).toBeDisabled();
  releaseFirst!();
  await expect(page.locator('[data-check-id="web-access-exa"]')).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(page.locator('[data-check-id="web-access-exa"] svg')).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  // Re-check uses a native button: keyboard activation starts request #2.
  await refresh.focus();
  await refresh.press("Enter");
  const error = page.getByTestId("doctor-error");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).toContainText("HTTP 503");
  await expect(error).not.toContainText("private server detail");
  // A failed refresh does not replace the last successful rows.
  await expect(page.locator('[data-check-id="web-access-url-fetch"]')).toBeVisible();

  const retry = error.getByRole("button", { name: "Retry" });
  await retry.focus();
  await retry.press("Enter");
  await expect(error).toHaveCount(0);
  await expect(page.getByTestId("doctor-status")).toHaveText("Diagnostics up to date.");
  await expect(refresh).toBeFocused();
  expect(requestCount).toBe(3);
});

test("Doctor offers a copyable fix command for a failing check", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-write"]);
  const onboardingDoctor = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/runtime/doctor"),
  );
  await page.goto(harness.baseUrl);
  await onboardingDoctor;
  await page.route("**/runtime/doctor*", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        report: {
          checks: [
            {
              id: "pi-binary",
              label: "Pi binary",
              status: "ok",
              detail: "available",
            },
            {
              id: "auth",
              label: "AI model connection",
              status: "warn",
              detail: "Connect an AI model provider to run coding sessions",
              fixCommand: "export ANTHROPIC_API_KEY=YOUR_KEY_HERE",
            },
          ],
        },
      },
    });
  });
  await page.getByTestId("nav-doctor").click();

  // A failing provider check exposes a copyable placeholder command; an ok
  // check does not. The response is scripted because the E2E mock provider is
  // intentionally configured and would otherwise make the real auth check OK.
  const authCheck = page.locator('[data-check-id="auth"]');
  await expect(authCheck).toHaveAttribute("data-check-status", "warn");
  const copyBtn = authCheck.getByTestId("doctor-fix-copy");
  await expect(copyBtn).toHaveAttribute("data-fix-command", /API_KEY/);
  await expect(
    page.locator('[data-check-id="pi-binary"]').getByTestId("doctor-fix-copy"),
  ).toHaveCount(0);

  // Clicking copies the command and flips the label to "Copied".
  await copyBtn.click();
  await expect(copyBtn).toHaveText(/Copied/);
});
