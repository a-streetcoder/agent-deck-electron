import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "server");

await rm(outputDirectory, { recursive: true, force: true });
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
    // Native code is rebuilt for Electron and unpacked from app.asar by
    // electron-builder. The server loads it lazily with createRequire().
    "node-pty",
    // Semantic memory is intentionally optional and runtime-installed.
    "@huggingface/transformers",
  ],
});

console.log("Bundled backend: dist/server/index.mjs");
