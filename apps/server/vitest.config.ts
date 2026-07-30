import { defineConfig } from "vitest/config";

const windowsCi = process.platform === "win32" && !!process.env.CI;

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
    maxWorkers: windowsCi ? 1 : undefined,
  },
});
