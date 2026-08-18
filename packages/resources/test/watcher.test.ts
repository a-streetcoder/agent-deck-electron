import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectWatchDirs, watchDirs } from "../src/paths.ts";
import {
  addResourceWatchPaths,
  ensureDirs,
  isWatchPathContained,
  removeResourceWatchPaths,
  watchResources,
} from "../src/watcher.ts";

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "watcher-home-"));
}

function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("resource watcher", () => {
  it("rejects Windows cross-volume and cross-share containment", () => {
    expect(isWatchPathContained("C:\\home", "C:\\home\\project", path.win32)).toBe(true);
    expect(isWatchPathContained("C:\\home", "D:\\outside", path.win32)).toBe(false);
    expect(
      isWatchPathContained(
        "\\\\server\\home\\andrea",
        "\\\\other-server\\share\\outside",
        path.win32,
      ),
    ).toBe(false);
  });

  it("does not create absent catalogs", () => {
    const root = home();
    const dirs = watchDirs({ home: root, projectPath: path.join(root, "project") });
    expect(ensureDirs(dirs)).toEqual(dirs);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("does not observe a catalog through an escaping linked ancestor", async () => {
    const root = home();
    const outside = home();
    const outsideAgents = path.join(outside, "agent", "agents");
    mkdirSync(outsideAgents, { recursive: true });
    linkDirectory(outside, path.join(root, ".pi"));

    let changes = 0;
    let resolveLocalChange!: () => void;
    const localChanged = new Promise<void>((resolve) => {
      resolveLocalChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveLocalChange();
      },
      10,
    );
    try {
      await Promise.race([
        new Promise<void>((resolve) => watcher.on("ready", resolve)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watcher did not become ready")), 5_000),
        ),
      ]);

      writeFileSync(path.join(outsideAgents, "outside.md"), "outside");
      await delay(800);
      expect(changes).toBe(0);
      expect(
        Object.keys(watcher.getWatched()).some((watched) =>
          watched.startsWith(path.join(root, ".pi")),
        ),
      ).toBe(false);

      rmSync(path.join(root, ".pi"), { force: true });
      const localCatalog = path.join(root, ".pi", "agent", "agents");
      mkdirSync(localCatalog, { recursive: true });
      writeFileSync(path.join(localCatalog, "local.md"), "local");
      await Promise.race([
        localChanged,
        new Promise<never>((_, reject) =>
          // 15 s inside a 25 s budget. The give-up deadline was 5 s inside
          // vitest's DEFAULT 5 s test timeout, so this message could never fire —
          // the suite timed out first — and a loaded macOS runner exceeds 5 s of
          // watch-backend subscription latency anyway.
          setTimeout(() => reject(new Error("watcher missed contained catalog creation")), 15_000),
        ),
      ]);
      expect(changes).toBe(1);
    } finally {
      await watcher.close();
    }
  }, 25_000);

  it("contains dynamically added project targets inside the project boundary", async () => {
    const root = home();
    const project = path.join(root, "project");
    const outside = home();
    mkdirSync(project);
    mkdirSync(outside, { recursive: true });
    linkDirectory(outside, path.join(project, ".pi"));

    let changes = 0;
    let resolveContainedChange!: () => void;
    const containedChanged = new Promise<void>((resolve) => {
      resolveContainedChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveContainedChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      addResourceWatchPaths(watcher, projectWatchDirs(project), project);
      await delay(500);

      const containedCatalog = path.join(project, ".agents", "skills");
      mkdirSync(containedCatalog, { recursive: true });
      writeFileSync(path.join(containedCatalog, "local.md"), "local");
      await Promise.race([
        containedChanged,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("dynamic project watcher was not active")), 5_000),
        ),
      ]);
      await delay(300);
      changes = 0;

      writeFileSync(path.join(outside, "settings.json"), "{}");
      await delay(800);
      expect(changes).toBe(0);
      expect(
        Object.keys(watcher.getWatched()).some((watched) =>
          watched.startsWith(path.join(project, ".pi")),
        ),
      ).toBe(false);
    } finally {
      await watcher.close();
    }
  }, 15_000);

  it("observes missing targets beneath an explicitly trusted linked boundary", async () => {
    const container = home();
    const physicalHome = home();
    const linkedHome = path.join(container, "home-link");
    linkDirectory(physicalHome, linkedHome);

    const catalog = path.join(physicalHome, ".pi", "agent", "agents");
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: linkedHome },
      () => {
        // The missing catalog itself is the target under test. Requiring a file
        // created immediately inside it adds a second backend-subscription race
        // without proving anything more about the trusted linked boundary.
        if (existsSync(catalog)) resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      mkdirSync(catalog, { recursive: true });
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          // Backend subscription for a junction/symlinked boundary is the slow
          // part, and on a loaded Windows runner it exceeded the old 5 s inner
          // deadline while the test's own 15 s budget sat unused. The deadline
          // now leaves headroom under that budget, so a real miss still fails
          // with this message instead of the suite timing out.
          setTimeout(() => reject(new Error("watcher missed a trusted linked boundary")), 15_000),
        ),
      ]);
    } finally {
      await watcher.close();
    }
  }, 25_000);

  it("does not rescan for an unrelated sibling directory", async () => {
    const root = home();
    let changes = 0;
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      mkdirSync(path.join(root, "unrelated"));
      await delay(300);
      expect(changes).toBe(0);
    } finally {
      await watcher.close();
    }
  });

  it("fails closed when a contained catalog ancestor is replaced by an escaping link", async () => {
    const root = home();
    const outside = home();
    const catalog = path.join(root, ".pi", "agent", "agents");
    const outsideCatalog = path.join(outside, "agent", "agents");
    mkdirSync(catalog, { recursive: true });
    mkdirSync(outsideCatalog, { recursive: true });

    let changes = 0;
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      await delay(100);
      writeFileSync(path.join(catalog, "before.md"), "before");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watcher was not active before link swap")), 5_000),
        ),
      ]);
      await delay(300);

      rmSync(path.join(root, ".pi"), { recursive: true, force: true });
      linkDirectory(outside, path.join(root, ".pi"));
      await delay(800);
      changes = 0;

      writeFileSync(path.join(outsideCatalog, "outside.md"), "outside");
      await delay(800);
      expect(changes).toBe(0);
    } finally {
      await watcher.close();
    }
  });

  it("treats a linked descendant as a leaf and still observes local siblings", async () => {
    const root = home();
    const outside = home();
    const catalog = path.join(root, ".pi", "agent", "agents");
    mkdirSync(catalog, { recursive: true });
    linkDirectory(outside, path.join(catalog, "escape"));

    let changes = 0;
    let resolveLocalChange!: () => void;
    const localChanged = new Promise<void>((resolve) => {
      resolveLocalChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveLocalChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      writeFileSync(path.join(outside, "outside.md"), "outside");
      await delay(800);
      expect(changes).toBe(0);

      writeFileSync(path.join(catalog, "local.md"), "local");
      await Promise.race([
        localChanged,
        new Promise<never>((_, reject) =>
          // 15 s inside a 25 s budget. The give-up deadline was 5 s inside
          // vitest's DEFAULT 5 s test timeout, so this message could never fire —
          // the suite timed out first — and a loaded macOS runner exceeds 5 s of
          // watch-backend subscription latency anyway.
          setTimeout(() => reject(new Error("watcher missed contained sibling edit")), 15_000),
        ),
      ]);
      expect(changes).toBe(1);
    } finally {
      await watcher.close();
    }
  }, 25_000);

  it("releases the effective project root when dynamic targets are removed", async () => {
    const root = home();
    const project = home();
    const projectTargets = projectWatchDirs(project);
    const settingsFile = path.join(project, ".pi", "settings.json");
    let changes = 0;
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      addResourceWatchPaths(watcher, projectTargets, project);
      await delay(500);
      mkdirSync(path.dirname(settingsFile), { recursive: true });
      writeFileSync(settingsFile, "{}");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("dynamic project watcher was not active")), 5_000),
        ),
      ]);

      const canonicalProject = realpathSync.native(project);
      expect(
        Object.keys(watcher.getWatched()).some((watched) => watched.startsWith(canonicalProject)),
      ).toBe(true);
      const unwatch = vi.spyOn(watcher, "unwatch");
      await removeResourceWatchPaths(watcher, projectTargets);
      expect(unwatch).toHaveBeenCalledWith(expect.arrayContaining([canonicalProject]));
      await delay(300);
      changes = 0;
      writeFileSync(settingsFile, '{"changed":true}');
      await delay(800);
      expect(changes).toBe(0);
    } finally {
      await watcher.close();
    }
  }, 15_000);

  it("keeps overlapping dynamic roots active when one registration is removed", async () => {
    const root = home();
    const project = home();
    const firstTarget = path.join(project, "a", "first");
    const secondTarget = path.join(project, "a", "b", "second");
    let changes = 0;
    let resolveChange!: () => void;
    let changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      addResourceWatchPaths(watcher, [firstTarget], project);
      await delay(500);
      mkdirSync(firstTarget, { recursive: true });
      writeFileSync(path.join(firstTarget, "first.md"), "first");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("first dynamic root was not active")), 5_000),
        ),
      ]);

      addResourceWatchPaths(watcher, [secondTarget], project);
      await delay(500);
      await removeResourceWatchPaths(watcher, [firstTarget]);

      changed = new Promise<void>((resolve) => {
        resolveChange = resolve;
      });
      mkdirSync(secondTarget, { recursive: true });
      writeFileSync(path.join(secondTarget, "second.md"), "second");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("overlapping dynamic root was disabled by removal")),
            5_000,
          ),
        ),
      ]);

      const canonicalProject = realpathSync.native(project);
      expect(
        Object.keys(watcher.getWatched()).some((watched) => watched.startsWith(canonicalProject)),
      ).toBe(true);
      const unwatch = vi.spyOn(watcher, "unwatch");
      await removeResourceWatchPaths(watcher, [secondTarget]);
      expect(unwatch).toHaveBeenCalledWith(expect.arrayContaining([canonicalProject]));
      await delay(300);
      changes = 0;
      writeFileSync(path.join(secondTarget, "after-removal.md"), "after removal");
      await delay(800);
      expect(changes).toBe(0);
    } finally {
      await watcher.close();
    }
  }, 15_000);

  it("revives a released ancestor when a dynamic target is re-added", async () => {
    const root = home();
    const project = home();
    const target = path.join(project, "a", "b", "target");
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources({ home: root }, resolveChange, 10);
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      addResourceWatchPaths(watcher, [target], project);
      await delay(500);
      await removeResourceWatchPaths(watcher, [target]);

      mkdirSync(path.dirname(target), { recursive: true });
      addResourceWatchPaths(watcher, [target], project);
      await delay(500);
      mkdirSync(target);
      writeFileSync(path.join(target, "after-readd.md"), "after re-add");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("re-added dynamic target remained ignored")), 5_000),
        ),
      ]);
    } finally {
      await watcher.close();
    }
  }, 15_000);

  it("does not expand a linked directory loop or repeat a contained change", async () => {
    const root = home();
    const catalog = path.join(root, ".pi", "agent", "agents");
    const nested = path.join(catalog, "nested");
    mkdirSync(nested, { recursive: true });
    linkDirectory(catalog, path.join(nested, "loop"));

    let changes = 0;
    let errors = 0;
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveChange();
      },
      10,
    );
    watcher.on("error", () => {
      errors += 1;
    });
    try {
      await Promise.race([
        new Promise<void>((resolve) => watcher.on("ready", resolve)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("linked loop prevented watcher readiness")), 5_000),
        ),
      ]);
      expect(
        Object.keys(watcher.getWatched()).filter((watched) =>
          watched.split(path.sep).includes("loop"),
        ),
      ).toHaveLength(0);

      writeFileSync(path.join(catalog, "local.md"), "local");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          // 15 s inside a 25 s budget. The give-up deadline was 5 s inside
          // vitest's DEFAULT 5 s test timeout, so this message could never fire —
          // the suite timed out first — and a loaded macOS runner exceeds 5 s of
          // watch-backend subscription latency anyway.
          setTimeout(() => reject(new Error("watcher missed contained loop sibling")), 15_000),
        ),
      ]);
      await delay(100);
      expect(changes).toBe(1);
      expect(errors).toBe(0);
    } finally {
      await watcher.close();
    }
  }, 25_000);

  it("watches an exact project settings file without reacting to sibling files", async () => {
    const root = home();
    const project = path.join(root, "project");
    mkdirSync(project);
    const settingsFile = path.join(project, ".pi", "settings.json");
    let changes = 0;
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        if (existsSync(settingsFile)) resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      addResourceWatchPaths(watcher, projectWatchDirs(project), project);
      await new Promise((resolve) => setTimeout(resolve, 100));

      mkdirSync(path.dirname(settingsFile), { recursive: true });
      writeFileSync(settingsFile, JSON.stringify({ prompts: ["review"] }));
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          // 15 s inside a 25 s budget. The give-up deadline was 5 s inside
          // vitest's DEFAULT 5 s test timeout, so this message could never fire —
          // the suite timed out first — and a loaded macOS runner exceeds 5 s of
          // watch-backend subscription latency anyway.
          setTimeout(() => reject(new Error("watcher missed project settings creation")), 15_000),
        ),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 300));
      changes = 0;
      writeFileSync(path.join(project, ".pi", ".env"), "IRRELEVANT=1\n");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changes).toBe(0);
    } finally {
      await watcher.close();
    }
  }, 25_000);

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
      addResourceWatchPaths(watcher, [collectionRoot], collectionRoot);
      await new Promise((resolve) => setTimeout(resolve, 100));
      writeFileSync(skillFile, "---\nname: selected\n---\n\nAfter.\n");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          // 15 s inside a 25 s budget. The give-up deadline was 5 s inside
          // vitest's DEFAULT 5 s test timeout, so this message could never fire —
          // the suite timed out first — and a loaded macOS runner exceeds 5 s of
          // watch-backend subscription latency anyway.
          setTimeout(() => reject(new Error("watcher missed collection edit")), 15_000),
        ),
      ]);
    } finally {
      await watcher.close();
    }
  }, 25_000);

  it("debounces every watcher error into an authoritative rescan", async () => {
    const root = home();
    let changes = 0;
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
        resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      for (const code of ["ENOENT", "ENOTDIR", "EISDIR", "EACCES"]) {
        watcher.emit("error", Object.assign(new Error("deterministic watcher error"), { code }));
      }
      await changed;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(changes).toBe(1);
    } finally {
      await watcher.close();
    }
  });

  it("excludes retained private deletion quarantines from watching", async () => {
    const root = home();
    const catalog = path.join(root, ".pi", "agent", "skills");
    mkdirSync(catalog, { recursive: true });
    let changes = 0;
    const watcher = watchResources(
      { home: root },
      () => {
        changes += 1;
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      const quarantine = path.join(
        catalog,
        ".agent-deck-resource-recovery-v1-5-skill-0123456789abcdef0123456789abcdef",
      );
      mkdirSync(quarantine);
      writeFileSync(path.join(quarantine, "SKILL.md"), "private");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changes).toBe(0);
    } finally {
      await watcher.close();
    }
  });

  it("observes a catalog created after watching starts", async () => {
    const root = home();
    const catalog = path.join(root, ".pi", "agent", "agents", "nested");
    const agentFile = path.join(catalog, "later.md");
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const watcher = watchResources(
      { home: root },
      () => {
        // Scanner behavior has separate coverage; this assertion only needs to
        // prove that an event created after readiness reaches the callback.
        if (existsSync(agentFile)) resolveChange();
      },
      10,
    );
    try {
      await new Promise<void>((resolve) => watcher.on("ready", resolve));
      mkdirSync(catalog, { recursive: true });
      writeFileSync(agentFile, "---\nname: later\n---\n\nLater.\n");
      await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          // 15 s inside a 25 s budget. The give-up deadline was 5 s inside
          // vitest's DEFAULT 5 s test timeout, so this message could never fire —
          // the suite timed out first — and a loaded macOS runner exceeds 5 s of
          // watch-backend subscription latency anyway.
          setTimeout(() => reject(new Error("watcher missed later catalog creation")), 15_000),
        ),
      ]);
    } finally {
      await watcher.close();
    }
  }, 25_000);
});
