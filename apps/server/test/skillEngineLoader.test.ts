import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSkillEngineNative } from "../src/skills/skillEngineNative.ts";

/**
 * Guards the PACKAGED loader path. In a packaged Electron app the engine `.node` is copied into
 * `resources/skill-engine-native/` and required directly (a bare package import can't resolve
 * from inside app.asar). This exercises the same `require(<.node>)` branch via the env override,
 * so a regression in `loadSkillEngineNative` (or an incompatible binary) fails here rather than
 * only in the native-security CI job.
 */
const builtBinary = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/skill-engine-native/native",
  `skill-engine-native.${process.platform}-${process.arch}.node`,
);

describe("loadSkillEngineNative (packaged path)", () => {
  it("loads the addon by direct .node path and exposes the full surface", async () => {
    if (!existsSync(builtBinary)) return; // `pnpm build:native` not run on this platform
    const previous = process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH;
    process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH = builtBinary;
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
