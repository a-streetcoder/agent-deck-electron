import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(workspaceRoot, "apps", "desktop");
const requireFromDesktop = createRequire(path.join(desktopDir, "package.json"));
const electronPath = requireFromDesktop("electron");
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-electron-smoke-"));
const expectedMarker = "[agent-deck startup] main window created";
const timeoutMs = 90_000;

let output = "";
let settled = false;
let timeout;

const child = spawn(electronPath, ["--no-sandbox", desktopDir], {
  cwd: workspaceRoot,
  env: {
    ...process.env,
    AGENT_DECK_DATA_DIR: dataDir,
    AGENT_DECK_E2E_STARTUP_TRACE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const cleanup = () => {
  if (child.pid && child.exitCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
};

const finish = (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  cleanup();
  if (error) {
    console.error(output);
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.log("Electron launch smoke passed: server healthy and main window created");
};

const collect = (chunk) => {
  output = `${output}${chunk}`.slice(-64_000);
  if (output.includes(expectedMarker)) finish();
};

child.stdout.on("data", collect);
child.stderr.on("data", collect);
child.once("error", (error) => finish(new Error(`Electron failed to start: ${error.message}`)));
child.once("exit", (code, signal) => {
  if (!settled) {
    finish(
      new Error(`Electron exited before creating its window (code=${code}, signal=${signal})`),
    );
  }
});

timeout = setTimeout(() => {
  finish(new Error(`Electron did not create its window within ${timeoutMs}ms`));
}, timeoutMs);
