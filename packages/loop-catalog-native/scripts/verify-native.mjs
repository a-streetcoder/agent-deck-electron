import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const directory = path.resolve(import.meta.dirname, "..", "native");
const expected = `loop-catalog-native.${process.platform}-${process.arch}.node`;
const napiOutput =
  process.platform === "linux"
    ? `loop-catalog-native.${process.platform}-${process.arch}-gnu.node`
    : process.platform === "win32"
      ? `loop-catalog-native.${process.platform}-${process.arch}-msvc.node`
      : expected;
const binaries = readdirSync(directory).filter((entry) => entry.endsWith(".node"));
if (binaries.length !== 1 || binaries[0] !== napiOutput) {
  throw new Error(`native Loop addon build did not produce exactly ${napiOutput}`);
}
if (napiOutput !== expected)
  renameSync(path.join(directory, napiOutput), path.join(directory, expected));
if (!existsSync(path.join(directory, expected))) {
  throw new Error(`native Loop addon normalization did not produce exactly ${expected}`);
}
createRequire(import.meta.url)(path.join(directory, expected));
for (const generated of ["index.js", "index.d.ts"])
  rmSync(path.join(directory, generated), { force: true });
console.log(`Verified native Loop addon ${expected}`);
