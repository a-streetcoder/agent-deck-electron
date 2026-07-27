import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentCatalogDirs,
  extensionCatalogDirs,
  projectWatchDirs,
  promptCatalogDirs,
  skillCatalogDirs,
  watchDirs,
} from "../src/paths.ts";
import { ensureDirs } from "../src/watcher.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paths-home-"));
}

describe("native-compatible resource paths", () => {
  it("returns the exact agent, skill, prompt, and extension catalogs", () => {
    const home = makeHome();
    const projectPath = path.join(home, "project");
    const roots = { home, projectPath };

    expect(
      agentCatalogDirs(roots).map(({ dir, scope, legacy }) => ({ dir, scope, legacy })),
    ).toEqual([
      { dir: path.join(projectPath, ".pi", "agents"), scope: "project", legacy: undefined },
      { dir: path.join(home, ".agents"), scope: "global", legacy: true },
      { dir: path.join(home, ".pi", "agent", "agents"), scope: "global", legacy: undefined },
      {
        dir: path.join(home, ".pi", "agent", "agent-library", "agents"),
        scope: "library",
        legacy: undefined,
      },
      expect.objectContaining({ scope: "builtin" }),
    ]);
    expect(skillCatalogDirs(roots)).toEqual([
      { dir: path.join(projectPath, ".pi", "skills"), scope: "project" },
      { dir: path.join(home, ".pi", "agent", "skills"), scope: "global" },
      { dir: path.join(home, ".agents", "skills"), scope: "global", legacy: true },
    ]);
    expect(promptCatalogDirs(roots)).toEqual([
      { dir: path.join(projectPath, ".pi", "prompts"), scope: "project" },
      { dir: path.join(home, ".pi", "agent", "prompts"), scope: "global" },
      { dir: path.join(home, ".pi", "agent", "prompt-library"), scope: "library" },
    ]);
    expect(extensionCatalogDirs(roots)).toEqual([
      { dir: path.join(home, ".pi", "agent", "extensions"), scope: "global" },
      { dir: path.join(projectPath, ".pi", "extensions"), scope: "project" },
    ]);
  });

  it("watch setup does not create catalogs or include extension refresh paths", () => {
    const home = makeHome();
    const projectPath = path.join(home, "project");
    ensureDirs(watchDirs({ home, projectPath }));

    expect(existsSync(path.join(home, ".agents"))).toBe(false);
    expect(projectWatchDirs(projectPath)).toEqual([
      path.join(projectPath, ".pi", "skills"),
      path.join(projectPath, ".pi", "agents"),
      path.join(projectPath, ".pi", "prompts"),
    ]);
    expect(watchDirs({ home, projectPath })).not.toContain(
      path.join(projectPath, ".pi", "extensions"),
    );
    expect(watchDirs({ home, projectPath })).not.toContain(
      path.join(home, ".pi", "agent", "extensions"),
    );

    mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    const watched = watchDirs({ home, projectPath });
    expect(watched).toContain(path.join(home, ".agents"));
    expect(watched).toContain(path.join(home, ".agents", "skills"));
  });
});
