import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "server");

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
