import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { startLinuxSandboxViolationMonitor } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-violation-monitor.js";
import { describe, expect, it } from "vitest";
import { SRT_MONITOR_DIR_PREFIX } from "../src/sandbox.ts";

// What the provider relies on in srt to bind its own files back into a
// private /tmp (sandbox.ts, srtSettings): an srt upgrade that renames or
// moves them must fail here, not leave sessions without network or monitor.
const bwrap = process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;

describe("srt's files under the host temp folder (dependency contract)", () => {
  it("exposes its proxy socket paths", () => {
    expect(typeof SandboxManager.getLinuxHttpSocketPath).toBe("function");
    expect(typeof SandboxManager.getLinuxSocksSocketPath).toBe("function");
  });

  it.skipIf(!bwrap)("puts both proxy sockets under os.tmpdir()", async () => {
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    });
    try {
      for (const socket of [
        SandboxManager.getLinuxHttpSocketPath(),
        SandboxManager.getLinuxSocksSocketPath(),
      ]) {
        expect(socket).toBeTypeOf("string");
        expect(path.dirname(socket!)).toBe(tmpdir());
      }
    } finally {
      await SandboxManager.reset();
    }
  });

  it("makes its write monitor's socket folder as <tmpdir>/srt-obs-*", () => {
    const monitor = startLinuxSandboxViolationMonitor(() => {}, {
      allowWritePaths: [],
      denyWritePaths: [],
      resolveCommandText: (key) => key,
    });
    try {
      const socket = monitor.observeSocketPath;
      expect(socket).toBeTypeOf("string");
      const dir = path.dirname(socket!);
      expect(path.dirname(dir)).toBe(tmpdir());
      expect(path.basename(dir).startsWith(SRT_MONITOR_DIR_PREFIX)).toBe(true);
    } finally {
      monitor.stop();
    }
  });
});
