import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Providers screen: lists the providers Pi knows about and reflects whether a
 * provider has a configured credential.
 */

let harness: E2eHarness;

function authPath(): string {
  return path.join(harness.piHome, ".pi", "agent", "auth.json");
}
function seedOAuth(providerId: string): void {
  mkdirSync(path.dirname(authPath()), { recursive: true });
  writeFileSync(
    authPath(),
    JSON.stringify({
      [providerId]: { type: "oauth", refresh: "r", access: "a", expires: 4102444800000 },
    }),
  );
}

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("lists providers and can explicitly sign out of a seeded credential", async ({ page }) => {
  // Discover a real provider id from the running server (built-ins are stable,
  // but don't hard-code the set).
  const res = await fetch(`${harness.baseUrl}/runtime/providers`);
  const { providers } = (await res.json()) as { providers: Array<{ id: string }> };
  const first = providers[0];
  expect(first).toBeDefined();
  const id = first!.id;

  // Fresh home → nothing signed in.
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-providers").click();
  const row = page.locator(`[data-provider-id="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-configured", "false");

  // Seed a stored OAuth credential → the provider is shown as configured.
  seedOAuth(id);
  await page.getByTestId("nav-environment").click(); // leave + return to force a reload
  await page.getByTestId("nav-providers").click();
  await expect(row).toHaveAttribute("data-configured", "true");
  const signOut = page.getByTestId(`provider-signout-${id}`);
  await expect(signOut).toBeVisible();

  // Native sign-out is direct (no confirmation): Pi removes the stored
  // credential, the provider list refreshes, and the action disappears.
  await signOut.click();
  await expect(row).toHaveAttribute("data-configured", "false");
  await expect(signOut).toHaveCount(0);

  rmSync(authPath(), { force: true });
});

test("renders native provider logos (and a monogram fallback for unknowns)", async ({ page }) => {
  await page.route("**/runtime/providers", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            signedIn: false,
            configured: true,
            supportsOAuth: true,
            supportsAPIKey: true,
          },
          {
            id: "openai",
            name: "OpenAI",
            signedIn: false,
            configured: true,
            supportsOAuth: false,
            supportsAPIKey: true,
          },
          {
            id: "github-copilot",
            name: "GitHub Copilot",
            signedIn: false,
            configured: true,
            supportsOAuth: true,
            supportsAPIKey: false,
          },
          {
            id: "acme-unknown",
            name: "Acme",
            signedIn: false,
            configured: true,
            supportsOAuth: false,
            supportsAPIKey: true,
          },
        ],
      },
    });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-providers").click();

  // Real brand logos render as inline SVGs (anthropic → the claude mark).
  const anthropic = page.getByTestId("provider-logo-anthropic");
  await expect(anthropic).toHaveAttribute("data-logo", "claude");
  await expect(anthropic.locator("svg path").first()).toBeVisible();
  await expect(page.getByTestId("provider-logo-openai")).toHaveAttribute("data-logo", "openai");
  await expect(page.getByTestId("provider-logo-github-copilot")).toHaveAttribute(
    "data-logo",
    "copilot",
  );
  // An unknown provider falls back to a monogram tile.
  await expect(page.getByTestId("provider-logo-acme-unknown")).toHaveAttribute(
    "data-logo",
    "fallback",
  );
  // A provider configured only by environment/default resolution has no stored
  // auth.json credential for logout to remove.
  await expect(
    page.getByTestId("provider-list").getByRole("button", { name: /Sign out/ }),
  ).toHaveCount(0);
});

test("keeps a stored provider connected and reports a logout failure", async ({ page }) => {
  await page.route("**/runtime/providers", async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        providers: [
          {
            id: "failure-provider",
            name: "Failure Provider",
            signedIn: true,
            configured: true,
            supportsOAuth: true,
            supportsAPIKey: false,
          },
        ],
      },
    });
  });
  await page.route("**/runtime/providers/*/logout", async (route) => {
    await route.fulfill({ status: 503, body: "credential store unavailable" });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-providers").click();
  const row = page.locator('[data-provider-id="failure-provider"]');
  const signOut = page.getByTestId("provider-signout-failure-provider");
  await signOut.click();

  await expect(page.getByTestId("error-banner")).toContainText("credential store unavailable");
  await expect(row).toHaveAttribute("data-configured", "true");
  await expect(signOut).toBeEnabled();
});
