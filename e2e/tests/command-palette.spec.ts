import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Command palette + user keybindings (Slice 14). The palette opens on the
 * rebindable Ctrl/⌘+K chord, fuzzy-filters commands, and runs the selection;
 * the keybindings editor rebinds a command live (store update → the same global
 * handler picks it up) and persists to the settings store.
 */

let harness: E2eHarness;

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
});

test.afterAll(async () => {
  await harness.close();
});

test("opens on ⌘K, filters to a nav command, and runs it", async ({ page }) => {
  await page.goto(harness.baseUrl);
  const palette = page.getByTestId("command-palette");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette).toBeVisible();

  await page.getByTestId("command-palette-input").fill("skills");
  // The top match is "Go to Skills"; Enter runs it and navigates.
  await expect(page.getByTestId("command-palette-item").first()).toContainText("Skills");
  await page.keyboard.press("Enter");

  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("app-view-title")).toHaveText("Skills");
});

test("discovers all resource workflow commands without fixed shortcuts", async ({ page }) => {
  await page.goto(harness.baseUrl);

  for (const label of [
    "New Agent",
    "Open Selected Agent File",
    "Reveal Selected Agent",
    "Enable/Disable Selected Agent",
    "Import Skills",
    "New Prompt",
    "Copy Selected Prompt Invocation",
    "Open Selected Prompt File",
    "Reveal Selected Prompt",
  ]) {
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByTestId("command-palette-input");
    await input.fill(label);
    const item = page.getByTestId("command-palette-item").first();
    await expect(item).toContainText(label);
    await expect(item).not.toContainText(/Ctrl|⌘/);
    await page.keyboard.press("Escape");
  }
});

test("resource creation and import commands open their existing screen-owned UI", async ({
  page,
}) => {
  for (const [label, testId] of [
    ["New Agent", "agent-editor"],
    ["Import Skills", "skill-import-path"],
    ["New Prompt", "prompt-editor"],
  ] as const) {
    await page.goto(harness.baseUrl);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-palette-input").fill(label);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(testId)).toBeVisible();
    if (label === "New Agent") await expect(page.getByTestId("editor-name")).toBeFocused();
    if (label === "New Prompt") await expect(page.getByTestId("prompt-name")).toBeFocused();
  }
});

test("a selected-resource command never infers the screen's fallback row", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Enable/Disable Selected Agent");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toast")).toContainText("Select an agent first.");
});

test("prompt rows support explicit keyboard selection without firing row actions", async ({
  page,
}) => {
  await fetch(`${harness.baseUrl}/resources/prompts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      name: "keyboard-select-check",
      edit: { description: "keyboard selection test", body: "Review this." },
    }),
  });
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-prompts").click();
  const row = page.locator('[data-prompt-name="keyboard-select-check"]');
  await expect(row).toBeVisible();

  await row.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("prompt-editor")).toHaveCount(0);
  await page.keyboard.press("Space");
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("prompt-editor")).toHaveCount(0);
});

test("copies the explicitly selected prompt invocation with clipboard feedback", async ({
  page,
}) => {
  await fetch(`${harness.baseUrl}/resources/prompts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      name: "command-copy-check",
      edit: { description: "copy command test", body: "Review this." },
    }),
  });
  await page.addInitScript(() => {
    const browser = globalThis as typeof globalThis & {
      navigator: object;
      commandCopiedText?: string;
    };
    Object.defineProperty(browser.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          browser.commandCopiedText = text;
        },
      },
    });
  });
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-prompts").click();
  const row = page.locator('[data-prompt-name="command-copy-check"]');
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
  await page.getByTestId("prompt-editor").getByRole("button", { name: "Cancel" }).click();

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Copy Selected Prompt Invocation");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("toast")).toContainText("Copied /command-copy-check");
  expect(
    await page.evaluate(
      () => (globalThis as typeof globalThis & { commandCopiedText?: string }).commandCopiedText,
    ),
  ).toBe("/command-copy-check");
});

test("enable/disable command reuses the selected agent toggle workflow", async ({ page }) => {
  await fetch(`${harness.baseUrl}/resources/agents`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      name: "command-toggle-check",
      edit: { description: "toggle command test", body: "Help." },
    }),
  });
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-agents").click();
  const row = page.locator('[data-agent-name="command-toggle-check"]');
  await expect(row).toBeVisible();
  await row.click();

  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("Enable/Disable Selected Agent");
  await page.keyboard.press("Enter");
  await expect(row.getByTestId("disabled-badge")).toBeVisible();
});

test("discovers all Git workflow commands without fixed shortcuts", async ({ page }) => {
  await page.goto(harness.baseUrl);

  for (const label of ["Commit all", "Push branch", "Merge worktree", "Release…"]) {
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByTestId("command-palette-input");
    await input.fill(label);
    const item = page.getByTestId("command-palette-item").first();
    await expect(item).toContainText(label.replace("…", ""));
    await expect(item).not.toContainText(/Ctrl|⌘/);
    await page.keyboard.press("Escape");
  }
});

test("closes on Escape without running anything", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  // Still on the default chat surface — nothing fired.
  await expect(page.getByTestId("chat-layer")).toHaveAttribute("aria-hidden", "false");
});

test("traps Tab on the search input (arrow-key navigation model)", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  // The palette navigates by arrow keys (handler is on the input, selection is
  // `highlight` state). Tab must stay on the input so it can't move DOM focus
  // onto a command row and silence arrow navigation / split the selection.
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(input).toBeFocused();
});

test("rebinds a command live through the editor", async ({ page }) => {
  await page.goto(harness.baseUrl);

  // Open the editor via the palette.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByTestId("command-palette-input").fill("keybind");
  await page.keyboard.press("Enter");
  const editor = page.getByTestId("keybindings-editor");
  await expect(editor).toBeVisible();

  // "Go to Git" ships without a chord — bind it and confirm the row updates.
  const gitRow = page.locator('[data-testid="keybindings-editor-row"][data-command="view.git"]');
  const gitChord = gitRow.getByTestId("keybindings-editor-chord");
  await expect(gitChord).toHaveText("Unassigned");
  await gitChord.click();
  await expect(gitChord).toHaveAttribute("data-capturing", "true");
  await page.keyboard.press("Control+Alt+g");
  await expect(gitChord).toHaveAttribute("data-overridden", "true");
  await expect(gitChord).toContainText("G");

  // Close the editor; the newly-bound chord now navigates.
  await page.getByTestId("keybindings-editor-close").click();
  await expect(editor).toHaveCount(0);
  await page.keyboard.press("Control+Alt+g");
  await expect(page.getByTestId("app-view-title")).toHaveText("Git");

  // The override persisted to the settings store.
  const response = await fetch(`${harness.baseUrl}/settings`);
  const data = (await response.json()) as {
    settings: { keybindings: Array<{ command: string; key: string }> };
  };
  const browserPlatform = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { navigator: { platform: string } }).navigator.platform,
  );
  expect(data.settings.keybindings).toContainEqual({
    command: "view.git",
    key: /mac/i.test(browserPlatform) ? "ctrl+alt+g" : "mod+alt+g",
  });
});
