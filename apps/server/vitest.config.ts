import { defineConfig } from "vitest/config";

const isCi = !!process.env.CI;
const windowsCi = process.platform === "win32" && isCi;

export default defineConfig({
  test: {
    env: { AGENT_DECK_TEST: "1" },
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.pi.test.ts"],
    passWithNoTests: true,
    // Hosted Windows runners expose enough CPUs for Vitest to start several
    // workers, but their filesystem cannot sustain this suite's concurrent Git
    // fixtures and durable fsync tests. Run files serially there instead of
    // weakening individual assertions with load-dependent timeouts.
    //
    // The same contention, less severely, reached the Linux and macOS runners:
    // across four consecutive CI runs every job failed on exactly ONE test from
    // a rotating pool (the 1 MiB avatar upload, the attention wait, a netstat
    // lookup, a watcher subscription) — never the same one twice, and each
    // passing alone. Four vCPUs running four workers of a suite that spawns real
    // processes is the cause, so cap the workers there too rather than inflate
    // every budget those tests depend on.
    maxWorkers: windowsCi ? 1 : isCi ? 2 : undefined,
  },
});
