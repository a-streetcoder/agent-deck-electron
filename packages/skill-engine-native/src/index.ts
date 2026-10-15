/**
 * Loader for the vendored skill engine addon (see VENDORED.md).
 *
 * Same `<name>.<platform>-<arch>.node` filename and candidate ladder as
 * `@agent-deck/loop-catalog-native`: env override → package `native/` → cwd workspace path →
 * Electron `resourcesPath`. The binding's typings in `binding.d.ts` are the 0.2.0 NAPI-RS
 * output, byte for byte; `apps/server/src/skills/skillEngineNative.ts` narrows them to the
 * `SkillEngineNative` seam.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Binding from "./binding.js";

export type SkillEngineBinding = typeof Binding;

const binaryName = `skill-engine-native.${process.platform}-${process.arch}.node`;
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH?.trim(),
  path.join(packageRoot, "native", binaryName),
  path.join(process.cwd(), "packages", "skill-engine-native", "native", binaryName),
  resourcesPath ? path.join(resourcesPath, "skill-engine-native", binaryName) : undefined,
].filter((candidate): candidate is string => Boolean(candidate));

let loaded: SkillEngineBinding | undefined;

/** Load the addon once. Throws `RESOURCE_NATIVE_UNAVAILABLE: …` when no binary is found. */
export function loadSkillEngineBinding(): SkillEngineBinding {
  if (loaded) return loaded;
  const selected = candidates.find(existsSync);
  if (!selected) {
    throw new Error(
      `RESOURCE_NATIVE_UNAVAILABLE: skill engine addon ${binaryName} not found ` +
        `(run \`pnpm build:native\`; looked in ${candidates.join(", ")})`,
    );
  }
  loaded = createRequire(import.meta.url)(selected) as SkillEngineBinding;
  return loaded;
}

/** The binary the loader would pick, if any (tests and the packaged smoke). */
export const nativeSkillEngineBinaryPath: string | undefined = candidates.find(existsSync);
