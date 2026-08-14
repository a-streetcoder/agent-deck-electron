import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InjectedCommandError, InjectedCommandStore } from "../src/injectedCommands.ts";
import { SettingsStore } from "../src/persistence.ts";

const commandSource = (name: string, prompt = "hello") => `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("${name}", {
    description: "Test command",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage(args?.trim() ? "${prompt}: " + args.trim() : "${prompt}");
    },
  });
}
`;

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "deck-injected-commands-"));
  const settings = new SettingsStore(dataDir);
  return { dataDir, settings, store: new InjectedCommandStore(dataDir, settings) };
}

describe("InjectedCommandStore", () => {
  it("materializes enabled bundled commands and persists per-command toggles", () => {
    const { dataDir, store } = setup();
    expect(store.list().filter((entry) => entry.source === "built-in")).toMatchObject([
      { id: "built-in:optimize-agents-md", slashName: "/optimize-agents-md", status: "enabled" },
      {
        id: "built-in:create-agent-deck-command",
        slashName: "/create-agent-deck-command",
        status: "enabled",
      },
    ]);
    for (const file of store.enabledExtensionPaths()) {
      expect(readFileSync(file, "utf8")).toContain("await ctx.waitForIdle()");
      expect(readFileSync(file, "utf8")).toContain("pi.sendUserMessage(");
    }

    store.setEnabled("built-in:optimize-agents-md", false);
    const restarted = new InjectedCommandStore(dataDir, new SettingsStore(dataDir));
    expect(
      restarted.list().find((entry) => entry.id === "built-in:optimize-agents-md")?.status,
    ).toBe("disabled");
    expect(restarted.enabledExtensionPaths().some((file) => file.includes("optimize"))).toBe(false);
  });

  it("copies one validated command without retaining its source path and keeps imports disabled", () => {
    const { dataDir, store } = setup();
    const imported = store.import("from-browser.ts", commandSource("review-work"));
    expect(imported).toMatchObject({
      slashName: "/review-work",
      source: "library",
      status: "disabled",
    });
    expect(imported).not.toHaveProperty("path");
    expect(imported).not.toHaveProperty("fileName");
    expect(JSON.stringify(imported)).not.toContain(dataDir);
    expect(JSON.stringify(new SettingsStore(dataDir).get())).not.toContain("from-browser");

    store.setEnabled(imported.id, true);
    const restarted = new InjectedCommandStore(dataDir, new SettingsStore(dataDir));
    expect(restarted.enabledExtensionPaths()).toHaveLength(3);
    expect(restarted.enabledExtensionPaths().at(-1)).toContain(
      path.join(dataDir, "injected-commands", "library"),
    );
    restarted.delete(imported.id);
    expect(restarted.list().some((entry) => entry.id === imported.id)).toBe(false);
    expect(new SettingsStore(dataDir).get().enabledLibraryCommandIDs).not.toContain(imported.id);
  });

  it("sanitizes compatibility settings and leaves stale library ids fail-closed", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "deck-command-settings-"));
    writeFileSync(
      path.join(dataDir, "app-settings.json"),
      JSON.stringify({
        disabledInjectedCommandIDs: [
          "built-in:optimize-agents-md",
          "bad id",
          42,
          "built-in:optimize-agents-md",
        ],
        enabledLibraryCommandIDs: [
          "library:0123456789abcdef0123456789abcdef",
          "library:not-a-hash",
        ],
      }),
    );
    const settings = new SettingsStore(dataDir);
    expect(settings.get().disabledInjectedCommandIDs).toEqual(["built-in:optimize-agents-md"]);
    expect(settings.get().enabledLibraryCommandIDs).toEqual([
      "library:0123456789abcdef0123456789abcdef",
    ]);
    const store = new InjectedCommandStore(dataDir, settings);
    expect(store.enabledExtensionPaths().some((file) => file.includes("0123456789abcdef"))).toBe(
      false,
    );
  });

  it("caps and sanitizes ids in settings mutators as well as on load", () => {
    const { settings } = setup();
    settings.setInjectedCommandDisabled("not-a-built-in", true);
    settings.setLibraryCommandEnabled("library:../../outside", true);
    for (let index = 0; index < 300; index += 1) {
      settings.setLibraryCommandEnabled(`library:${index.toString(16).padStart(32, "0")}`, true);
    }
    expect(settings.get().disabledInjectedCommandIDs).toEqual([]);
    expect(settings.get().enabledLibraryCommandIDs).toHaveLength(256);
    expect(settings.get().enabledLibraryCommandIDs).not.toContain("library:../../outside");
  });

  it("rejects dynamic imports and alternate command-registration access", () => {
    const { store } = setup();
    const variants = [
      `${commandSource("one")}\nconst load = () => import("node:fs");`,
      `${commandSource("one")}\nconst load = () => import   ("safe-package");`,
      `${commandSource("one")}\nconst load = () => import /* computed */ ("safe-package");`,
      `${commandSource("one")}\nconst load = () => import // computed\n("safe-package");`,
      `${commandSource("one")}\npi["registerCommand"]("two", {});`,
      `${commandSource("one")}\npi /* computed */ ["registerCommand"]("two", {});`,
      `${commandSource("one")}\nconst sibling = pi.registerCommand.bind(pi); sibling("two", {});`,
      `${commandSource("one")}\nconst method = "registerCommand"; pi[method]("two", {});`,
      `${commandSource("one")}\npi["register" + "Command"]("two", {});`,
      `${commandSource("one")}\nconst { registerCommand: sibling } = pi; sibling("two", {});`,
    ];
    for (const [index, source] of variants.entries()) {
      expect(() => store.import(`unsafe-${index}.ts`, source)).toThrow(InjectedCommandError);
    }
  });

  it("rejects collisions, multi-command files, bridge tools, privileged imports, and linked files", () => {
    const { store } = setup();
    expect(() => store.import("collision.ts", commandSource("optimize-agents-md"))).toThrow(
      InjectedCommandError,
    );
    expect(() =>
      store.import(
        "many.ts",
        `${commandSource("one")}\nexport const extra = (pi: any) => pi.registerCommand("two", {});`,
      ),
    ).toThrow("exactly one");
    expect(() =>
      store.import(
        "tool.ts",
        `${commandSource("one")}\nexport const extra = (pi: any) => pi.registerTool({});`,
      ),
    ).toThrow("cannot register tools");
    expect(() =>
      store.import("fs.ts", `import { readFile } from "node:fs";\n${commandSource("one")}`),
    ).toThrow("privileged runtime access");

    const imported = store.import("safe.ts", commandSource("safe-command"));
    const importedPath = path.join(store.libraryDir, `${imported.id.slice("library:".length)}.ts`);
    store.delete(imported.id);
    const outside = `${importedPath}.outside`;
    writeFileSync(outside, commandSource("safe-command"));
    symlinkSync(outside, importedPath);
    expect(store.list().some((entry) => entry.id === imported.id)).toBe(false);
    expect(() => store.delete(imported.id)).toThrow("no longer exists");
    expect(readFileSync(outside, "utf8")).toContain("safe-command");
    expect(() => store.delete("library:../../outside")).toThrow("no longer exists");
    expect(readFileSync(outside, "utf8")).toContain("safe-command");
  });
});
