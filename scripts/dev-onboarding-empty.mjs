import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-empty-onboarding-"));
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

console.log("Launching an isolated empty-setup onboarding preview.");
console.log(`Temporary app data: ${dataDir}`);
console.log("Your real Agent Deck data and system setup will not be changed.\n");

const child = spawn(command, ["dev"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    AGENT_DECK_DATA_DIR: dataDir,
    VITE_AGENT_DECK_ONBOARDING_PREVIEW: "empty",
  },
});

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

child.on("exit", (code, signal) => {
  rmSync(dataDir, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
