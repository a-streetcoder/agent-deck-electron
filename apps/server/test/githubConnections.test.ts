import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { githubEnv, type GitHubConnections } from "../src/githubConnections.ts";

describe("githubEnv (SRV-06)", () => {
  const connections = {
    read: (user: { id: string }) =>
      user.id === "c@example.com" ? { token: "gho_ownerToken0123456789" } : undefined,
  } as unknown as GitHubConnections;

  it("is empty without an owner, a store or a connection", () => {
    expect(githubEnv(undefined, connections)).toEqual({});
    expect(githubEnv({ id: "c@example.com" }, undefined)).toEqual({});
    expect(githubEnv({ id: "u@example.com" }, connections)).toEqual({});
  });

  it("makes real git answer github.com with the owner's token, and only github.com", () => {
    const env = {
      ...process.env,
      ...githubEnv({ id: "c@example.com" }, connections),
      GIT_TERMINAL_PROMPT: "0",
    };
    const filled = execFileSync("git", ["credential", "fill"], {
      env,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    expect(filled).toContain("password=gho_ownerToken0123456789");
    // Other hosts keep their own helpers (a fill there could open the OS credential UI).
    const helpers = (url: string): string => {
      try {
        return execFileSync("git", ["config", "--get-urlmatch", "credential.helper", url], {
          env,
          encoding: "utf8",
        });
      } catch {
        return ""; // no helper configured at all
      }
    };
    expect(helpers("https://example.com")).not.toContain("GH_TOKEN");
    expect(helpers("https://github.com")).toContain("GH_TOKEN");
  });
});
