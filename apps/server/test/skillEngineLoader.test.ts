import type * as NodeFs from "node:fs";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Guards the PACKAGED loader path. In a packaged Electron app the engine `.node` is copied into
 * `resources/skill-engine-native/` and named by `AGENT_DECK_SKILL_ENGINE_NATIVE_PATH` (a bare
 * package import can't resolve from inside app.asar). The override test loads a COPY in a temp
 * dir, so it cannot pass by falling through to the package's own `native/` candidate.
 *
 * The package resolves its candidate ladder at import, so each test re-imports it fresh.
 */
const builtBinary = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/skill-engine-native/native",
  `skill-engine-native.${process.platform}-${process.arch}.node`,
);
// The four napi targets (package.json `napi.targets`); elsewhere the addon cannot be built.
const buildable = ["win32-x64", "linux-x64", "darwin-arm64", "darwin-x64"].includes(
  `${process.platform}-${process.arch}`,
);
const ENV = "AGENT_DECK_SKILL_ENGINE_NATIVE_PATH";
const previous = process.env[ENV];

afterEach(() => {
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("loadSkillEngineNative (packaged path)", () => {
  it.skipIf(!buildable)(
    "loads the addon from the env override path and exposes the full surface (skipped: no napi target for this platform)",
    async () => {
      expect(existsSync(builtBinary), "run `pnpm build:native` first").toBe(true);
      const copy = path.join(
        mkdtempSync(path.join(tmpdir(), "skill-engine-loader-")),
        path.basename(builtBinary),
      );
      copyFileSync(builtBinary, copy);
      process.env[ENV] = copy;
      vi.resetModules();

      const { nativeSkillEngineBinaryPath } = await import("@agent-deck/skill-engine-native");
      expect(nativeSkillEngineBinaryPath).toBe(copy);
      const { loadSkillEngineNative } = await import("../src/skills/skillEngineNative.ts");
      const engine = await loadSkillEngineNative();
      for (const method of [
        "writeSkill",
        "listRecoveries",
        "importGitRepo",
        "resolveGitConflictPaths",
      ]) {
        expect(typeof (engine as unknown as Record<string, unknown>)[method]).toBe("function");
      }
      // The copy stays loaded (Windows locks it); the OS temp dir owns cleanup.
    },
  );

  it("rejects with RESOURCE_NATIVE_UNAVAILABLE when no binary exists", async () => {
    process.env[ENV] = path.join(tmpdir(), "missing", "skill-engine-native.node");
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof NodeFs>()),
      existsSync: () => false,
    }));
    vi.resetModules();

    const { loadSkillEngineNative } = await import("../src/skills/skillEngineNative.ts");
    await expect(loadSkillEngineNative()).rejects.toThrow(/^RESOURCE_NATIVE_UNAVAILABLE: /);
  });
});
