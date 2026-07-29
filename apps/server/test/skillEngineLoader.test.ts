import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillEngineNative } from "../src/skills/skillEngineNative.ts";

/**
 * Guards the PACKAGED loader path. In a packaged Electron app the engine `.node` is staged into
 * `resources/skill-engine-native/` and required directly (a bare package import can't resolve
 * from inside app.asar). This exercises the same `require(<.node>)` branch via the env override,
 * so a regression in `loadSkillEngineNative` (or an incompatible binary) fails here rather than
 * only in the native-security CI job.
 */
function prebuiltEngineBinary(): string | undefined {
  const triples: Record<string, string> = {
    "win32-x64": "win32-x64-msvc",
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-x64": "linux-x64-gnu",
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  if (!triple) return undefined;
  const req = createRequire(import.meta.url);
  const nativeIndex = req.resolve("@a-streetcoder/skill-engine-native/native");
  const scopeDir = path.dirname(path.dirname(path.dirname(nativeIndex)));
  const binary = path.join(
    scopeDir,
    `skill-engine-native-${triple}`,
    `skill-engine-native.${triple}.node`,
  );
  return existsSync(binary) ? binary : undefined;
}

describe("loadSkillEngineNative (packaged path)", () => {
  it("loads the addon by direct .node path and exposes the full surface", async () => {
    const binary = prebuiltEngineBinary();
    if (!binary) return; // platform without a published binary — skip rather than fail
    const previous = process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH;
    process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH = binary;
    try {
      const engine = await loadSkillEngineNative();
      for (const method of [
        "writeSkill",
        "listRecoveries",
        "importGitRepo",
        "resolveGitConflictPaths",
      ]) {
        expect(typeof (engine as unknown as Record<string, unknown>)[method]).toBe("function");
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH;
      else process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH = previous;
    }
  });
});
