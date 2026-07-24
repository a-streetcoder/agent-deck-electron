import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { watchDirs } from "../src/paths.ts";
import { scanAgents } from "../src/scanner.ts";
import { addResourceWatchPaths, ensureDirs, watchResources } from "../src/watcher.ts";

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "watcher-home-"));
}

describe("resource watcher", () => {
  it("does not create absent catalogs", () => {
    const root = home();
    const dirs = watchDirs({ home: root, projectPath: path.join(root, "project") });
    expect(ensureDirs(dirs)).toEqual(dirs);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("watches an exact persisted collection root without creating it", async () => {
    const root = home();
    const collectionRoot = path.join(root, "managed", "selected-skill");
    mkdirSync(collectionRoot, { recursive: true });
    const skillFile = path.join(collectionRoot, "SKILL.md");
    writeFileSync(skillFile, "---\nname: selected\n---\n\nBefore.\n");
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources({ home: root }, resolveChange, 10);
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      addResourceWatchPaths(watcher, [collectionRoot]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(skillFile, "---\nname: selected\n---\n\nAfter.\n");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watcher missed collection edit")), 5_000),
        ),
      ]);
    } finally {
      await watcher.close();
    }
  });

  it("observes a catalog created after watching starts", async () => {
    const root = home();
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        if (scanAgents({ home: root }).some((agent) => agent.name === "later")) resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      // Let any ready-adjacent events settle; only a callback whose rescan sees
      // the later agent can satisfy the promise.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const catalog = path.join(root, ".pi", "agent", "agents", "nested");
      mkdirSync(catalog, { recursive: true });
      writeFileSync(path.join(catalog, "later.md"), "---\nname: later\n---\n\nLater.\n");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watcher missed later catalog creation")), 5_000),
        ),
      ]);
    } finally {
      await watcher.close();
    }
  });
});
