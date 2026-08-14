import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanExtensions } from "../src/scanner.ts";

/**
 * scanExtensions discovers the user's own extension files in the standard pi
 * locations (global ~/.pi/agent/extensions + the project's .pi/extensions), so
 * they surface without being added by hand — the extension-management gap the
 * port had (only a manual registry, no discovery).
 */

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "res-home-"));
}
function makeProject(): string {
  return mkdtempSync(path.join(tmpdir(), "res-proj-"));
}
function write(dir: string, name: string, contents = "export default {};\n"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), contents);
}

describe("scanExtensions", () => {
  it("discovers global + project extensions with their scope", () => {
    const home = makeHome();
    const projectPath = makeProject();
    write(path.join(home, ".pi", "agent", "extensions"), "logger.ts");
    write(path.join(projectPath, ".pi", "extensions"), "linter.js");

    const found = scanExtensions({ home, projectPath });
    const byName = new Map(found.map((e) => [e.name, e]));
    expect(byName.get("logger.ts")?.scope).toBe("global");
    expect(byName.get("linter.js")?.scope).toBe("project");
    expect(byName.get("logger.ts")?.path).toBe(
      path.join(home, ".pi", "agent", "extensions", "logger.ts"),
    );
  });

  it("only matches TS/JS extension files, skipping other files and directories", () => {
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "extensions");
    write(dir, "keep.mjs");
    write(dir, "README.md");
    write(dir, "notes.txt");
    mkdirSync(path.join(dir, "a-directory.ts"), { recursive: true }); // a dir named like a .ts

    const names = scanExtensions({ home }).map((e) => e.name);
    expect(names).toEqual(["keep.mjs"]);
  });

  it("excludes app-generated bridges listed in .agent-deck-manifest.json", () => {
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "extensions");
    write(dir, "my-ext.ts"); // the user's own extension
    write(dir, "agent-deck-web-fetch.ts"); // an app-generated bridge
    write(dir, "agent-deck-memory-bridge.ts"); // another app bridge
    writeFileSync(
      path.join(dir, ".agent-deck-manifest.json"),
      JSON.stringify({ "agent-deck-web-fetch.ts": "sha1", "agent-deck-memory-bridge.ts": "sha2" }),
    );

    // Only the user's extension is discovered; the manifest-listed bridges aren't.
    expect(scanExtensions({ home }).map((e) => e.name)).toEqual(["my-ext.ts"]);
  });

  it("still excludes known app bridges when the manifest exists but is corrupt", () => {
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "extensions");
    write(dir, "my-ext.ts");
    write(dir, "agent-deck-web-fetch.ts"); // a known app bridge
    writeFileSync(path.join(dir, ".agent-deck-manifest.json"), "{ not valid json"); // mid-write/corrupt

    // The manifest's presence means this dir holds app bridges; the known-names
    // fallback keeps the app bridge out while still surfacing the user's ext.
    const names = scanExtensions({ home }).map((e) => e.name);
    expect(names).toContain("my-ext.ts");
    expect(names).not.toContain("agent-deck-web-fetch.ts");
  });

  it("returns nothing when the extension dirs don't exist (no throw)", () => {
    expect(scanExtensions({ home: makeHome(), projectPath: makeProject() })).toEqual([]);
  });

  it("discovers settings.json extension entries with provenance (EXT-01)", () => {
    // native PiExtensionDiscoveryService: settings.json `extensions` paths are
    // candidates too, resolved against the settings FILE's directory
    const home = makeHome();
    const project = makeProject();
    const piAgent = path.join(home, ".pi", "agent");
    mkdirSync(piAgent, { recursive: true });
    write(path.join(home, "somewhere"), "global-listed.ts");
    writeFileSync(
      path.join(piAgent, "settings.json"),
      JSON.stringify({ extensions: ["../../somewhere/global-listed.ts"] }),
    );
    mkdirSync(path.join(project, ".pi"), { recursive: true });
    write(path.join(project, "tools"), "proj-listed.ts");
    writeFileSync(
      path.join(project, ".pi", "settings.json"),
      JSON.stringify({ extensions: ["../tools/proj-listed.ts", 42, ""] }),
    );

    const found = scanExtensions({ home, projectPath: project });
    const globalEntry = found.find((e) => e.name === "global-listed.ts")!;
    expect(globalEntry.scope).toBe("global");
    expect(globalEntry.source).toBe("settings");
    expect(globalEntry.path).toBe(path.resolve(piAgent, "../../somewhere/global-listed.ts"));
    const projEntry = found.find((e) => e.name === "proj-listed.ts")!;
    expect(projEntry.scope).toBe("project");
    expect(projEntry.source).toBe("settings");
    // malformed entries never become candidates
    expect(found.filter((e) => e.source === "settings")).toHaveLength(2);
  });

  it("dedupe is case-insensitive on Windows: one file, one candidate (review, Codex)", () => {
    if (process.platform !== "win32") return;
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "extensions");
    write(dir, "Cased.ts");
    writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ extensions: ["./extensions/cased.ts"] }),
    );
    const found = scanExtensions({ home });
    expect(found.filter((e) => e.name.toLowerCase() === "cased.ts")).toHaveLength(1);
  });

  it("a settings entry already auto-discovered stays ONE candidate (EXT-01)", () => {
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "extensions");
    write(dir, "twice.ts");
    writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ extensions: ["./extensions/twice.ts"] }),
    );
    const found = scanExtensions({ home });
    expect(found.filter((e) => e.name === "twice.ts")).toHaveLength(1);
  });

  it("discovers PACKAGE extensions: declarations, conventional dir, index expansion (EXT-02)", () => {
    const home = makeHome();
    const piAgent = path.join(home, ".pi", "agent");
    mkdirSync(piAgent, { recursive: true });
    const pkg = path.join(home, "node_modules", "tool-pack");
    // declared: a single .ts file AND a directory-with-index; plus a child-level dir
    mkdirSync(path.join(pkg, "bundled", "sub"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "tool-pack", pi: { extensions: ["single.ts", "bundled"] } }),
    );
    writeFileSync(path.join(pkg, "single.ts"), "export default () => {};");
    writeFileSync(path.join(pkg, "bundled", "flat.ts"), "export default () => {};");
    writeFileSync(path.join(pkg, "bundled", "sub", "index.ts"), "export default () => {};");
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const found = scanExtensions({ home });
    const pkgEntries = found.filter((e) => e.source === "package");
    const paths = pkgEntries.map((e) => e.path).sort();
    expect(paths).toEqual(
      [
        path.join(pkg, "single.ts"),
        path.join(pkg, "bundled", "flat.ts"),
        path.join(pkg, "bundled", "sub", "index.ts"),
      ].sort(),
    );
    expect(pkgEntries.every((e) => e.scope === "package")).toBe(true);
    expect(pkgEntries.every((e) => e.packageRef === pkg)).toBe(true);

    // a dir WITH its own index.ts contributes only that index (native rule)
    const pkg2 = path.join(home, "node_modules", "indexed-pack");
    mkdirSync(path.join(pkg2, "extensions"), { recursive: true });
    writeFileSync(path.join(pkg2, "package.json"), JSON.stringify({ name: "indexed-pack" }));
    writeFileSync(path.join(pkg2, "extensions", "index.ts"), "export default () => {};");
    writeFileSync(path.join(pkg2, "extensions", "ignored.ts"), "export default () => {};");
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg2] }));
    const conventional = scanExtensions({ home }).filter((e) => e.source === "package");
    expect(conventional.map((e) => e.path)).toEqual([path.join(pkg2, "extensions", "index.ts")]);
  });

  it("a DIRECTORY named index.ts never suppresses real children (review, Codex)", () => {
    const home = makeHome();
    const piAgent = path.join(home, ".pi", "agent");
    mkdirSync(piAgent, { recursive: true });
    const pkg = path.join(home, "node_modules", "weird-pack");
    mkdirSync(path.join(pkg, "extensions", "index.ts"), { recursive: true }); // a DIR
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "weird-pack" }));
    writeFileSync(path.join(pkg, "extensions", "real.ts"), "export default () => {};");
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const found = scanExtensions({ home }).filter((e) => e.source === "package");
    expect(found.map((e) => e.path)).toEqual([path.join(pkg, "extensions", "real.ts")]);
  });

  it("an aliased path to an already-discovered file stays ONE candidate (Windows, review Codex)", async () => {
    if (process.platform !== "win32") return;
    const { spawnSync } = await import("node:child_process");
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "extensions");
    write(dir, "shared.ts");
    const linkDir = path.join(home, "alias-dir");
    const link = spawnSync("cmd", ["/c", "mklink", "/J", linkDir, dir]);
    expect(link.status).toBe(0);
    writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ extensions: [path.join(linkDir, "shared.ts")] }),
    );
    const found = scanExtensions({ home });
    expect(found.filter((e) => e.name === "shared.ts")).toHaveLength(1);
  });

  it("refuses a declared package extension path escaping its package (EXT-02)", () => {
    const home = makeHome();
    const piAgent = path.join(home, ".pi", "agent");
    mkdirSync(piAgent, { recursive: true });
    const pkg = path.join(home, "node_modules", "evil-pack");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "evil-pack", pi: { extensions: ["../outside.ts"] } }),
    );
    writeFileSync(path.join(home, "node_modules", "outside.ts"), "export default () => {};");
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const warnings: string[] = [];
    const found = scanExtensions({ home }, (w) => warnings.push(w));
    expect(found.filter((e) => e.source === "package")).toEqual([]);
    expect(warnings.some((w) => w.includes("outside itself"))).toBe(true);
  });

  it("has no project entries when no project path is set", () => {
    const home = makeHome();
    write(path.join(home, ".pi", "agent", "extensions"), "g.ts");
    const found = scanExtensions({ home });
    expect(found.every((e) => e.scope === "global")).toBe(true);
    expect(found).toHaveLength(1);
  });
});
