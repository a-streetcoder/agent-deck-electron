import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Mirrors packages/loop-catalog-native/scripts/verify-native.mjs: one binary per build, renamed
// to `skill-engine-native.<platform>-<arch>.node` so every loader shares one naming rule.
const directory = path.resolve(import.meta.dirname, "..", "native");
const expected = `skill-engine-native.${process.platform}-${process.arch}.node`;
const napiOutput =
  process.platform === "linux"
    ? `skill-engine-native.${process.platform}-${process.arch}-gnu.node`
    : process.platform === "win32"
      ? `skill-engine-native.${process.platform}-${process.arch}-msvc.node`
      : expected;
const binaries = readdirSync(directory).filter((entry) => entry.endsWith(".node"));
if (binaries.length !== 1 || binaries[0] !== napiOutput) {
  throw new Error(`native skill engine build did not produce exactly ${napiOutput}`);
}
if (napiOutput !== expected)
  renameSync(path.join(directory, napiOutput), path.join(directory, expected));
if (!existsSync(path.join(directory, expected))) {
  throw new Error(`native skill engine normalization did not produce exactly ${expected}`);
}
const binding = createRequire(import.meta.url)(path.join(directory, expected));
for (const method of ["writeSkill", "listRecoveries", "importGitRepo", "resolveGitConflictPaths"]) {
  if (typeof binding[method] !== "function") throw new Error(`skill engine addon lacks ${method}`);
}
for (const generated of ["index.js", "index.d.ts"])
  rmSync(path.join(directory, generated), { force: true });
console.log(`Verified native skill engine addon ${expected}`);
