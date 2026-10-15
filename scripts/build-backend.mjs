import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "server");

await rm(outputDirectory, { recursive: true, force: true });
// Keep the TypeScript native loaders (loop-catalog-native, skill-engine-native) in this
// backend bundle. The architecture-specific `.node` binaries are intentionally external
// to app.asar, shipped by electron-builder as extraResources, and selected at runtime.
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
  // ANA-01: the public PostHog project key is baked in at build time; no key, no analytics.
  define: process.env.AGENT_DECK_POSTHOG_KEY
    ? { "process.env.AGENT_DECK_POSTHOG_KEY": JSON.stringify(process.env.AGENT_DECK_POSTHOG_KEY) }
    : {},
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
    // posthog-node's optional OpenTelemetry peer (error tracking, unused here).
    "@opentelemetry/api",
  ],
});

console.log("Bundled backend: dist/server/index.mjs");
