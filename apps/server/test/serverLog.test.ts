import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatServerLog, serverLog } from "../src/serverLog.ts";

describe("serverLog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefixes the scope and appends the error message without a stack", () => {
    vi.stubEnv("AGENT_DECK_DEBUG", "");
    expect(formatServerLog("loops", "plain")).toBe("[loops] plain");
    expect(formatServerLog("loops", "failed", new Error("boom"))).toBe("[loops] failed: boom");
    expect(formatServerLog("loops", "failed", "text")).toBe("[loops] failed: text");
  });

  it("appends the stack only when AGENT_DECK_DEBUG=1", () => {
    vi.stubEnv("AGENT_DECK_DEBUG", "1");
    const error = new Error("boom");
    expect(formatServerLog("loops", "failed", error)).toBe(`[loops] failed: boom\n${error.stack}`);
  });

  it("writes warnings and errors to stderr and info to stdout as one line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    serverLog.warn("a", "w", new Error("x"));
    serverLog.error("b", "e");
    serverLog.info("c", "i");
    expect(warn).toHaveBeenCalledWith("[a] w: x");
    expect(error).toHaveBeenCalledWith("[b] e");
    expect(info).toHaveBeenCalledWith("[c] i");
  });

  it("leaves no call to fastify's silenced logger in the server source", () => {
    const root = path.join(import.meta.dirname, "../src");
    const offenders = (readdirSync(root, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        /\b(fastify|request)\.log\./.test(readFileSync(path.join(root, file), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
