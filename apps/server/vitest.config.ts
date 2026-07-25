import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { AGENT_DECK_TEST: "1" },
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.pi.test.ts"],
    passWithNoTests: true,
  },
});
