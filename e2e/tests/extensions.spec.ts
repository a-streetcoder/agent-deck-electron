import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { writeQuestionCommandExtension } from "@agent-deck/testkit";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Tier-3 gate (Extensions screen): a pi extension added through the screen
 * loads into new sessions (its registered command shows up via pi's
 * get_commands), and disabling it excludes it from the next session.
 */

let harness: E2eHarness;
const extFile = writeQuestionCommandExtension(); // registers an /ask-test command
const extName = path.basename(extFile);

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

async function sessionIds(): Promise<Set<string>> {
  const { sessions } = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string }>;
  };
  return new Set(sessions.map((s) => s.id));
}

async function newSessionId(before: Set<string>): Promise<string> {
  const { sessions } = (await (await fetch(`${harness.baseUrl}/sessions`)).json()) as {
    sessions: Array<{ id: string }>;
  };
  return sessions.find((s) => !before.has(s.id))!.id;
}

async function commandNames(id: string): Promise<string[]> {
  const res = await fetch(`${harness.baseUrl}/sessions/${id}/commands`);
  if (!res.ok) return [];
  const { commands } = (await res.json()) as { commands: Array<{ name: string }> };
  return commands.map((c) => c.name);
}

test("adding an extension loads its command; disabling excludes it", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");

  // Add the extension via the screen.
  await page.getByTestId("nav-extensions").click();
  await page.getByTestId("extension-add").click();
  await page.getByTestId("extension-path").fill(extFile);
  await page.getByTestId("extension-add-confirm").click();
  await expect(page.locator(`[data-extension-name="${extName}"]`)).toBeVisible();

  // A new session now loads it → /ask-test is a registered command.
  const before1 = await sessionIds();
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const id1 = await newSessionId(before1);
  await expect.poll(() => commandNames(id1), { timeout: 20_000 }).toContain("ask-test");

  // Disable it → the next session excludes it.
  await page.getByTestId("nav-extensions").click();
  await page.getByTestId(`extension-toggle-${extName}`).click();
  const before2 = await sessionIds();
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const id2 = await newSessionId(before2);
  await expect.poll(() => commandNames(id2), { timeout: 20_000 }).not.toContain("ask-test");
});

test("imports, enables, and deletes one app-owned slash command", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();
  await expect(page.getByTestId("command-catalog")).toBeVisible();
  await page.getByTestId("command-file-input").setInputFiles({
    name: "e2e-command.ts",
    mimeType: "text/javascript",
    buffer: Buffer.from(`export default function (pi) {
  pi.registerCommand("e2e-command", {
    description: "E2E imported command",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage(args?.trim() || "E2E command");
    },
  });
}\n`),
  });

  const row = page.locator('[data-testid^="command-library:"]').filter({
    hasText: "/e2e-command",
  });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Enable /e2e-command" })).toBeVisible();
  await row.getByRole("button", { name: "Enable /e2e-command" }).click();
  await expect(row.getByRole("button", { name: "Disable /e2e-command" })).toBeVisible();
  await row.getByRole("button", { name: /Delete \/e2e-command/ }).click();
  await expect(row).toHaveCount(0);
});

test("flags two enabled extensions that share a filename (§16.2)", async ({ page }) => {
  // Same basename, different directories → pi would load a duplicate.
  const dupName = "dup-ext.ts";
  const a = path.join(mkdtempSync(path.join(tmpdir(), "ext-a-")), dupName);
  const b = path.join(mkdtempSync(path.join(tmpdir(), "ext-b-")), dupName);
  writeFileSync(a, "export default {};\n");
  writeFileSync(b, "export default {};\n");

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();
  for (const p of [a, b]) {
    await page.getByTestId("extension-add").click();
    await page.getByTestId("extension-path").fill(p);
    await page.getByTestId("extension-add-confirm").click();
  }

  // Both same-named rows are flagged as conflicting.
  await expect(page.getByTestId("extension-conflict")).toHaveCount(2);

  // Disabling one resolves the conflict for both (only one is loaded now).
  await page.getByTestId(`extension-toggle-${dupName}`).first().click();
  await expect(page.getByTestId("extension-conflict")).toHaveCount(0);
});

test("refreshes externally added, changed, and deleted extension files in place", async ({
  page,
}) => {
  const extensionDir = path.join(harness.piHome, ".pi", "agent", "extensions");
  const extensionName = "external-refresh.ts";
  const extensionPath = path.join(extensionDir, extensionName);

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();
  await expect(page.locator(`[data-extension-name="${extensionName}"]`)).toHaveCount(0);

  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(extensionPath, "export default {};\n");
  await page.getByTestId("extension-refresh").click();
  const row = page.locator(`[data-extension-name="${extensionName}"]`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId(`extension-source-${extensionName}`)).toHaveText(
    "global · discovered",
  );

  // The same explicit refresh also rereads content-derived conflict metadata.
  writeFileSync(extensionPath, 'const tool = "agent_deck_memory_write";\nexport default tool;\n');
  await page.getByTestId("extension-refresh").click();
  await expect(page.getByTestId(`extension-bridge-conflict-${extensionName}`)).toBeVisible();

  unlinkSync(extensionPath);
  await page.getByTestId("extension-refresh").click();
  await expect(row).toHaveCount(0);
});

test("shows a discovered extension with its source label + a bridge-conflict warning", async ({
  page,
}) => {
  // Script the list so it returns a discovered extension and a bridge-conflicting
  // one, exercising the discovery UI without touching the real filesystem scan.
  await page.route("**/resources/extensions*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      json: {
        extensions: [
          {
            path: "/proj/.pi/extensions/logger.ts",
            name: "logger.ts",
            exists: true,
            disabled: false,
            scope: "project",
            source: "discovered",
            bridgeConflict: null,
          },
          {
            path: "/proj/.pi/extensions/rogue.ts",
            name: "rogue.ts",
            exists: true,
            disabled: false,
            scope: "project",
            source: "discovered",
            bridgeConflict: "agent_deck_memory_write",
          },
        ],
      },
    });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();

  // The discovered extension is labeled by scope + source, and (being discovered,
  // not added) has no Remove button.
  await expect(page.getByTestId("extension-source-logger.ts")).toHaveText("project · discovered");
  await expect(page.getByTestId("extension-remove-logger.ts")).toHaveCount(0);

  // The bridge-conflicting one is flagged as shadowed.
  await expect(page.getByTestId("extension-bridge-conflict-rogue.ts")).toBeVisible();
});

test("shows the read-only Agent Deck bridges inventory (memory active)", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();

  // The app-bridges section lists what Agent Deck injects over its own bridge.
  await expect(page.getByTestId("app-bridges")).toBeVisible();
  await expect(page.getByTestId("bridge-memory")).toBeVisible();
  await expect(page.getByTestId("bridge-state-memory")).toHaveText("active");
  await expect(page.getByTestId("bridge-memory")).toContainText("agent_deck_memory_write");
  // Deck-agents bridge is always on; MCP is off with no server configured.
  await expect(page.getByTestId("bridge-state-deck_agents")).toHaveText("active");
  await expect(page.getByTestId("bridge-state-mcp")).toHaveText("off");
});

test("shows readable extension load, toggle, and remove failures", async ({ page }) => {
  await page.route("**/resources/extensions*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 503,
      json: { error: "Extension inventory is temporarily unavailable." },
    });
  });
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();
  await expect(page.getByTestId("error-banner")).toHaveText(
    "Error: Extension inventory is temporarily unavailable.",
  );

  await page.unroute("**/resources/extensions*");
  await page.route("**/resources/extensions*", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        json: {
          extensions: [
            {
              path: "/tmp/failing-extension.ts",
              name: "failing-extension.ts",
              exists: true,
              disabled: false,
              source: "added",
            },
          ],
        },
      });
      return;
    }
    if (method === "DELETE") {
      await route.fulfill({ status: 409, json: { error: "Extension removal was refused." } });
      return;
    }
    return route.fallback();
  });
  await page.route("**/resources/extensions/disabled", async (route) => {
    await route.fulfill({ status: 409, json: { error: "Extension toggle was refused." } });
  });
  await page.reload();
  await page.getByTestId("nav-extensions").click();

  await page.getByTestId("extension-toggle-failing-extension.ts").click();
  await expect(page.getByTestId("error-banner")).toHaveText("Error: Extension toggle was refused.");
  await page.getByTestId("extension-remove-failing-extension.ts").click();
  await expect(page.getByTestId("error-banner")).toHaveText(
    "Error: Extension removal was refused.",
  );
});

test("serializes mode and extension mutations and reconciles partial bulk failures", async ({
  page,
}) => {
  const entries = [
    {
      path: "/tmp/overlap-a.ts",
      name: "overlap-a.ts",
      exists: true,
      disabled: false,
      source: "added",
    },
    {
      path: "/tmp/overlap-b.ts",
      name: "overlap-b.ts",
      exists: true,
      disabled: false,
      source: "added",
    },
  ];
  let modeRequests = 0;
  let releaseMode: (() => void) | undefined;
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    modeRequests += 1;
    if (modeRequests === 1) await new Promise<void>((resolve) => (releaseMode = resolve));
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.route("**/resources/extensions*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, json: { extensions: entries } });
      return;
    }
    return route.fallback();
  });

  let mutationPhase: "individual" | "bulk" = "individual";
  let individualRequests = 0;
  let releaseIndividual: (() => void) | undefined;
  let releaseBulk: (() => void) | undefined;
  await page.route("**/resources/extensions/disabled", async (route) => {
    const body = route.request().postDataJSON() as { path: string; disabled: boolean };
    if (mutationPhase === "individual") {
      individualRequests += 1;
      await new Promise<void>((resolve) => (releaseIndividual = resolve));
      await route.fulfill({ status: 409, json: { error: "Individual update failed." } });
      return;
    }
    if (body.path.endsWith("overlap-a.ts")) {
      await new Promise<void>((resolve) => (releaseBulk = resolve));
      entries[0]!.disabled = body.disabled;
      await route.fulfill({ status: 200, json: { ok: true } });
    } else {
      await route.fulfill({ status: 409, json: { error: "One extension stayed enabled." } });
    }
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();

  const managedMode = page.getByTestId("extension-mode-agentDeckManaged");
  await managedMode.click();
  await expect(page.getByTestId("extension-mode-useMyExtensions")).toBeDisabled();
  await managedMode.evaluate((button: { click(): void }) => button.click());
  expect(modeRequests).toBe(1);
  releaseMode!();
  await expect(managedMode).toBeEnabled();
  await page.getByTestId("extension-mode-useMyExtensions").click();

  const toggleA = page.getByTestId("extension-toggle-overlap-a.ts");
  await toggleA.click();
  await expect(toggleA).toBeDisabled();
  await expect(toggleA).toHaveAccessibleName("Disabling…");
  await expect(page.getByTestId("extension-remove-overlap-a.ts")).toBeDisabled();
  await expect(page.getByTestId("extension-disable-all")).toBeDisabled();
  await toggleA.evaluate((button: { click(): void }) => button.click());
  expect(individualRequests).toBe(1);
  releaseIndividual!();
  await expect(page.getByTestId("error-banner")).toHaveText("Error: Individual update failed.");
  await expect(toggleA).toBeEnabled();

  mutationPhase = "bulk";
  await page.getByTestId("extension-disable-all").click();
  await expect(page.getByTestId("extension-disable-all")).toHaveAccessibleName("Disabling all…");
  await expect(page.getByTestId("extension-toggle-overlap-a.ts")).toBeDisabled();
  releaseBulk!();
  await expect(page.getByTestId("error-banner")).toHaveText("Error: One extension stayed enabled.");
  await expect(page.getByTestId("extension-toggle-overlap-a.ts")).toHaveText("Enable");
  await expect(page.getByTestId("extension-toggle-overlap-b.ts")).toHaveText("Disable");
});

test("loading-mode picker + bulk enable/disable (native PiAgentExtensionLoadingMode)", async ({
  page,
}) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-extensions").click();

  // The mode picker offers both native modes.
  await expect(page.getByTestId("extension-mode-useMyExtensions")).toBeVisible();
  await expect(page.getByTestId("extension-mode-agentDeckManaged")).toBeVisible();

  // Bulk enable flips the extension (left disabled by the first test) to enabled;
  // bulk disable flips it back.
  await page.getByTestId("extension-enable-all").click();
  await expect(page.getByTestId(`extension-toggle-${extName}`)).toContainText("Disable");
  await page.getByTestId("extension-disable-all").click();
  await expect(page.getByTestId(`extension-toggle-${extName}`)).toContainText("Enable");

  // Managed mode hides the bulk actions (user extensions stay off); restore the
  // default so the setting is left as "use my extensions".
  await page.getByTestId("extension-mode-agentDeckManaged").click();
  await expect(page.getByTestId("extension-mode-agentDeckManaged")).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.getByTestId("extension-enable-all")).toHaveCount(0);
  await page.getByTestId("extension-mode-useMyExtensions").click();
  await expect(page.getByTestId("extension-enable-all")).toBeVisible();
});
