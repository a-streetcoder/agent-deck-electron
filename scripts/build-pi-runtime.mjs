import { rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "build", "pi-runtime");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

rmSync(output, { recursive: true, force: true });
const result = spawnSync(
  pnpm,
  ["--filter", "@agent-deck/pi-host", "deploy", "--prod", "--legacy", output],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`Bundled pinned Pi runtime: ${output}`);
