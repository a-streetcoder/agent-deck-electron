import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  // A provider available ONLY through AGENT_DECK_DEFAULT_EXTENSIONS. Keep it
  // outside the harness piHome so enabledExtensionPaths() cannot discover it,
  // and do not add it to AGENT_DECK_PROVIDER_EXTENSIONS.
  const defaultExtensionDir = mkdtempSync(path.join(tmpdir(), "agent-deck-default-ext-"));
  const defaultExtension = path.join(defaultExtensionDir, "default-provider.ts");
  writeFileSync(
    defaultExtension,
    `export default function (pi) {
  pi.registerProvider("default-only", {
    name: "Default Extension Provider",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "local-catalog-only",
    api: "openai-completions",
    models: [{
      id: "default-only-model",
      name: "Default-only Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 2048,
    }],
  });
}
`,
  );

  harness = await startHarness({
    chunkDelayMs: 20,
    extraExtensions: [defaultExtension],
    prepare: ({ piHome }) => {
      const extensionDir = path.join(piHome, ".pi", "agent", "extensions");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "ordinary-provider.ts"),
        `export default function (pi) {
  pi.registerProvider("ordinary", {
    name: "Ordinary Extension Provider",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "local-catalog-only",
    api: "openai-completions",
    models: [{
      id: "ordinary-model",
      name: "Ordinary Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 2048,
    }],
  });
}
`,
      );
    },
  });
});

test.afterAll(async () => {
  await harness.close();
});

test("discovers the configured model without creating a session", async () => {
  const response = await fetch(`${harness.baseUrl}/runtime/models/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    models: Array<{
      provider: string;
      id: string;
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      input: string[];
      disabled: boolean;
    }>;
  };
  expect(body.models).toContainEqual(
    expect.objectContaining({
      provider: "mock",
      id: "mock-model",
      contextWindow: 128_000,
      maxTokens: 4_100,
      reasoning: true,
      input: ["text", "image"],
      disabled: false,
    }),
  );
  // This provider comes from a normally discovered/enabled global extension,
  // not AGENT_DECK_PROVIDER_EXTENSIONS. Discovery must match ordinary sessions.
  expect(body.models).toContainEqual(
    expect.objectContaining({ provider: "ordinary", id: "ordinary-model", disabled: false }),
  );
  // This provider is only in AGENT_DECK_DEFAULT_EXTENSIONS (the harness's
  // extraExtensions seam), not the scanned catalog or providerExtensions.
  expect(body.models).toContainEqual(
    expect.objectContaining({
      provider: "default-only",
      id: "default-only-model",
      disabled: false,
    }),
  );

  const disable = async (disabled: boolean): Promise<void> => {
    const result = await fetch(`${harness.baseUrl}/runtime/models/disabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", id: "mock-model", disabled }),
    });
    expect(result.ok).toBe(true);
  };
  await disable(true);
  const filtered = await fetch(`${harness.baseUrl}/runtime/models/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const filteredBody = (await filtered.json()) as {
    models: Array<{ provider: string; id: string; disabled: boolean }>;
  };
  expect(filteredBody.models).toContainEqual(
    expect.objectContaining({ provider: "mock", id: "mock-model", disabled: true }),
  );
  await disable(false);

  const sessions = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: unknown[];
  };
  expect(sessions.sessions).toEqual([]);
});

test("walks the tour, runs setup, and gates entry until required setup is ready", async ({
  page,
}) => {
  const doctor = (await (await fetch(`${harness.baseUrl}/runtime/doctor`)).json()) as {
    report: { checks: Array<{ id: string; status: string }> };
  };
  const auth = doctor.report.checks.find((check) => check.id === "auth");
  if (auth) auth.status = "warn";
  await page.route("**/runtime/doctor", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(doctor) });
  });
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

  // Entry is a setup action, not a carousel progression button. This hermetic
  // environment has no provider connection, so the CTA opens that setup flow.
  const setupAction = page.getByTestId("onboarding-get-started");
  await expect(setupAction).toHaveText(/Connect an AI model/, { timeout: 20_000 });
  await setupAction.click();

  // The missing item opens its dedicated in-onboarding action page instead of
  // exposing diagnostics or revealing the main application.
  await expect(page.getByTestId("onboarding-provider")).toBeVisible();
  await expect(overlay).toBeVisible();
});

test("reaches preferences and discovers/persists a model before any session", async ({ page }) => {
  const setBasicDisabled = async (disabled: boolean): Promise<void> => {
    const response = await fetch(`${harness.baseUrl}/runtime/models/disabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "mock", id: "basic-model", disabled }),
    });
    expect(response.ok).toBe(true);
  };
  await setBasicDisabled(true);

  await page.route("**/runtime/doctor", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        report: {
          checks: [
            { id: "pi-binary", label: "Pi", status: "ok", detail: "ready" },
            { id: "pi-version", label: "Pi version", status: "ok", detail: "0.82.0" },
            { id: "node", label: "Node", status: "ok", detail: "ready" },
            { id: "bash", label: "Shell", status: "ok", detail: "ready" },
            { id: "auth", label: "Models", status: "ok", detail: "1 connected" },
            { id: "github", label: "GitHub", status: "warn", detail: "optional" },
          ],
        },
      }),
    });
  });

  let releaseDiscovery!: () => void;
  const discoveryGate = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  await page.route("**/runtime/models/discover", async (route) => {
    await discoveryGate;
    await route.continue();
  });

  await page.goto(harness.baseUrl);
  const getStarted = page.getByTestId("onboarding-get-started");
  await expect(getStarted).toHaveText(/Get Started/);
  await getStarted.click();
  await expect(page.getByTestId("onboarding-preferences")).toBeVisible();
  await expect(page.getByText("Discovering available models…")).toBeVisible();
  await expect(page.getByTestId("pref-model")).toBeDisabled();

  releaseDiscovery();
  const model = page.getByTestId("pref-model");
  await expect(model).toBeEnabled();
  await model.click();
  await expect(page.getByTestId("pref-model-dialog")).toBeVisible();
  await page.getByTestId("pref-model-provider-mock").click();
  await expect(page.getByTestId("pref-model-option-mock:mock-model")).toHaveCount(1);
  await expect(page.getByTestId("pref-model-option-mock:basic-model")).toHaveCount(0);
  await page.getByTestId("pref-model-option-mock:mock-model").click();
  await expect(model).toHaveAttribute("data-value", "mock:mock-model");

  await expect
    .poll(async () => {
      const response = await fetch(`${harness.baseUrl}/settings`);
      const body = (await response.json()) as { settings: { defaultModel: string | null } };
      return body.settings.defaultModel;
    })
    .toBe("mock:mock-model");
  await setBasicDisabled(false);
});

test("shows discovery errors and retries from the keyboard", async ({ page }) => {
  await page.route("**/runtime/doctor", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        report: {
          checks: ["pi-binary", "pi-version", "node", "bash", "auth"].map((id) => ({
            id,
            label: id,
            status: "ok",
            detail: "ready",
          })),
        },
      }),
    });
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
  await page.getByTestId("onboarding-get-started").click();
  await expect(page.getByText("Models could not be discovered.")).toBeVisible();
  const retry = page.getByTestId("pref-model-retry");
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  await expect(page.getByText("Trying model discovery again…")).toBeVisible();
  await expect(page.getByTestId("pref-model")).toBeEnabled();
  const modelSelect = page.getByTestId("pref-model");
  await expect(modelSelect).toBeFocused();
  await modelSelect.click();
  await expect(page.getByTestId("pref-model-dialog")).toBeVisible();
  await page.getByTestId("pref-model-provider-mock").click();
  await expect(page.getByTestId("pref-model-option-mock:mock-model")).toHaveCount(1);
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
