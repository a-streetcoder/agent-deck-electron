import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Provider login sheet (native PiProviderLoginService), UI half. The login HTTP
 * endpoints are scripted with page.route so the interactive flow (device code →
 * prompt → done) is exercised hermetically, without a real OAuth provider. The
 * relay state machine itself is covered by the resources unit test.
 */

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("signing in shows the device code, accepts a code, and reports success", async ({ page }) => {
  const { providers } = (await (await fetch(`${harness.baseUrl}/runtime/providers`)).json()) as {
    providers: Array<{ id: string; supportsOAuth: boolean; supportsAPIKey: boolean }>;
  };
  const id = providers.find((provider) => provider.supportsOAuth && !provider.supportsAPIKey)!.id;

  // Script the login flow: start → poll (device_code + prompt) → respond → poll (done).
  await page.route("**/runtime/providers/*/login", async (route) => {
    await route.fulfill({ status: 201, json: { loginId: "test-login" } });
  });
  await page.route("**/runtime/providers/login/*", async (route) => {
    const since = Number(new URL(route.request().url()).searchParams.get("since") ?? "0");
    const body =
      since === 0
        ? {
            events: [
              {
                type: "device_code",
                userCode: "WXYZ-1234",
                verificationUri: "https://ex.test/dev",
              },
              { type: "prompt", message: "Paste the code shown in your browser" },
            ],
            status: "running",
            nextCursor: 2,
          }
        : { events: [{ type: "done", ok: true }], status: "done", nextCursor: 3 };
    await route.fulfill({ status: 200, json: body });
  });
  await page.route("**/runtime/providers/login/*/respond", async (route) => {
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-providers").click();
  await page.locator(`[data-provider-id="${id}"]`).click();

  // The sheet opens and shows the device code + a prompt.
  const sheet = page.getByTestId("provider-login-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAccessibleName(/Sign in to/);
  await expect(page.getByTestId("login-device-code")).toHaveText("WXYZ-1234");
  await expect(page.getByTestId("login-auth-url")).toHaveCount(0);

  // The field gets a full row and conventional Cancel → Submit footer actions.
  const input = page.getByTestId("login-prompt-input");
  const actions = page.getByTestId("provider-login-actions");
  const cancel = actions.getByRole("button", { name: "Cancel" });
  const submit = actions.getByRole("button", { name: "Submit" });
  await expect(cancel).toBeVisible();
  await expect(submit).toBeVisible();
  const [inputBox, actionsBox, cancelBox, submitBox] = await Promise.all([
    input.boundingBox(),
    actions.boundingBox(),
    cancel.boundingBox(),
    submit.boundingBox(),
  ]);
  expect(inputBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(cancelBox).not.toBeNull();
  expect(submitBox).not.toBeNull();
  expect(actionsBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height);
  expect(cancelBox!.x).toBeLessThan(submitBox!.x);

  // Enter still submits the prompt → the flow completes with success + a toast.
  await input.fill("hunter2");
  await input.press("Enter");
  await expect(page.getByTestId("login-done")).toContainText("Connected");
  await expect(page.getByTestId("toast")).toContainText(/connected/);
  await expect(actions.getByRole("button", { name: "Close" })).toBeVisible();
});

test("providers with two login methods use a labelled, dismissible chooser", async ({ page }) => {
  const { providers } = (await (await fetch(`${harness.baseUrl}/runtime/providers`)).json()) as {
    providers: Array<{ id: string; supportsOAuth: boolean; supportsAPIKey: boolean; name: string }>;
  };
  const provider = providers.find((entry) => entry.supportsOAuth && entry.supportsAPIKey)!;

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-providers").click();
  await page.locator(`[data-provider-id="${provider.id}"]`).click();

  const chooser = page.getByRole("dialog", { name: `Connect ${provider.name}` });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("button", { name: "Use a subscription" })).toBeVisible();
  await expect(chooser.getByRole("button", { name: "Use an API key" })).toBeVisible();
  await chooser.getByRole("button", { name: "Cancel" }).click();
  await expect(chooser).toHaveCount(0);
});
