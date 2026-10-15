import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  it("keeps the name, code, first stderr line and one cause, on one line", () => {
    vi.stubEnv("AGENT_DECK_DEBUG", "");
    const git = Object.assign(new Error("git exited with code 128"), {
      code: 128,
      stderr: "fatal: not a git repository\nhint: run git init\n",
    });
    expect(formatServerLog("sessions", "cleanup failed", git)).toBe(
      "[sessions] cleanup failed: git exited with code 128 [code 128] (stderr: fatal: not a git repository)",
    );
    const chained = new TypeError("outer", {
      cause: new Error("inner", { cause: new Error("deep") }),
    });
    expect(formatServerLog("x", "m", chained)).toBe("[x] m: TypeError: outer (cause: inner)");
    expect(formatServerLog("x", "two\nlines", new Error("bad\r\ntoken"))).toBe(
      "[x] two\nlines: bad\r\ntoken",
    );
  });

  it("appends the stack only when AGENT_DECK_DEBUG=1", () => {
    vi.stubEnv("AGENT_DECK_DEBUG", "1");
    const error = new Error("boom");
    expect(formatServerLog("loops", "failed", error)).toBe(`[loops] failed: boom\n${error.stack}`);
  });

  it("writes warnings and errors to stderr and info to stdout as one line", () => {
    vi.stubEnv("AGENT_DECK_DEBUG", "");
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

  it("leaves no call to fastify's silenced logger in the server or package sources", () => {
    const repo = path.join(import.meta.dirname, "../../..");
    const roots = [
      path.join(repo, "apps/server/src"),
      ...readdirSync(path.join(repo, "packages")).map((name) =>
        path.join(repo, "packages", name, "src"),
      ),
    ].filter((root) => existsSync(root));
    const allowed = new Set([path.join(repo, "apps/server/src/serverLog.ts")]);
    const offenders = roots.flatMap((root) =>
      (readdirSync(root, { recursive: true }) as string[])
        .map((file) => path.join(root, file))
        .filter((file) => /\.tsx?$/.test(file) && !allowed.has(file))
        .filter((file) =>
          /\b\w+\.log\.(warn|error|info|debug|trace|fatal)\(/.test(readFileSync(file, "utf8")),
        ),
    );
    expect(offenders).toEqual([]);
  });
});
