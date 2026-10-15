import type { spawn } from "node:child_process";

/**
 * Terminate a process and everything it started: `taskkill /t /f` on Windows,
 * SIGTERM then SIGKILL to the process group elsewhere (the child must have been
 * spawned with `detached: true`). Callers await the child's `close`, which fires
 * once the whole tree has released its stdio.
 *
 * Self-contained on purpose: checkerShell.ts inlines this function's source
 * into a generated Pi extension, so it may use only its parameters and Node
 * globals, and no named inner functions.
 */
export function killProcessTree(pid: number, spawnProcess: typeof spawn): void {
  try {
    if (process.platform === "win32") {
      const killer = spawnProcess("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {});
    } else {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }, 2_000).unref();
    }
  } catch {
    // Already exited.
  }
}
