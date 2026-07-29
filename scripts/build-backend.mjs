import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "server");

// Stage the shared skill engine's platform-specific `.node` for electron-builder, exactly like
// `loop-catalog-native`: the addon is external to app.asar, copied into `resources/skill-engine-
// native/` (extraResources) and required at runtime via `process.resourcesPath` (see
// `loadSkillEngineNative`). The bundled server can't resolve the private package from inside the
// asar, so we can't rely on a bare import.
function stageSkillEngineAddon() {
  const napiTriple = {
    "win32-x64": "win32-x64-msvc",
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-x64": "linux-x64-gnu",
  }[`${process.platform}-${process.arch}`];
  if (!napiTriple) {
    console.warn(`skill engine addon: unsupported platform ${process.platform}-${process.arch}`);
    return;
  }
  const binary = `skill-engine-native.${napiTriple}.node`;
  try {
    const req = createRequire(path.join(root, "apps/server/package.json"));
    // The meta package exports `/native`; the platform package is its sibling under the scope dir.
    const nativeIndex = req.resolve("@a-streetcoder/skill-engine-native/native");
    const scopeDir = path.dirname(path.dirname(path.dirname(nativeIndex)));
    const src = path.join(scopeDir, `skill-engine-native-${napiTriple}`, binary);
    if (!existsSync(src)) throw new Error(`addon binary not found at ${src}`);
    const destDir = path.join(root, "build", "skill-engine-native");
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, path.join(destDir, binary));
    console.log(`Staged skill engine addon: build/skill-engine-native/${binary}`);
  } catch (error) {
    console.warn(`skill engine addon NOT staged: ${error.message}`);
  }
}

await rm(outputDirectory, { recursive: true, force: true });
// Keep the TypeScript native-catalog loader in this backend bundle. The
// architecture-specific `.node` binary is intentionally external to app.asar,
// shipped by electron-builder as an extraResource, and selected at runtime.
await build({
  absWorkingDir: root,
  entryPoints: ["apps/server/src/index.ts"],
  outfile: "dist/server/index.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  banner: {
    // Some bundled CommonJS dependencies use runtime requires for Node built-ins.
    // Re-create require for the ESM output instead of rewriting those packages.
    js: 'import { createRequire as __agentDeckCreateRequire } from "node:module"; const require = __agentDeckCreateRequire(import.meta.url);',
  },
  external: [
    // node-pty is rebuilt for Electron and unpacked from app.asar by
    // electron-builder. Runtime CommonJS loading is preserved.
    "node-pty",
    // Semantic memory is intentionally optional and runtime-installed.
    "@huggingface/transformers",
  ],
});

console.log("Bundled backend: dist/server/index.mjs");
stageSkillEngineAddon();
