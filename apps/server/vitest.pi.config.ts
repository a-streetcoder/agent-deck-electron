import { defineConfig } from "vitest/config";

// Integration tests that spawn a REAL pi binary through the full HTTP+WS stack.
export default defineConfig({
  test: {
    include: ["test/**/*.pi.test.ts"],
    // CRB-02: a shared-server test's credential broker on loopback, any free port.
    env: { AGENT_DECK_BROKER_HOST: "127.0.0.1", AGENT_DECK_BROKER_PORT: "0" },
    passWithNoTests: true,
    fileParallelism: false,
    // A single test here spawns a real pi, runs turns through the full HTTP+WS
    // stack, and may restart the server. 60 s left no room above the 60 s
    // receipt waits inside those tests, so a slow runner failed the wait and the
    // test together.
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
