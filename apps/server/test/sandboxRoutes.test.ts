import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { sandboxPolicy } from "@agent-deck/domain";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerSandboxRoutes } from "../src/routes/sandbox.ts";
import {
  createSandboxViolationReporter,
  SandboxHostGrants,
  sandboxViolationNotice,
} from "../src/sandbox.ts";
import { setRequestUser } from "../src/trustedProxy.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ALICE = { id: "alice@example.com", email: "alice@example.com" };
const BOB = { id: "bob@example.com", email: "bob@example.com" };
const OPS = { id: "ops@example.com", email: "ops@example.com" };

function harness(location: "server" | "local" = "server") {
  const root = mkdtempSync(path.join(tmpdir(), "sandbox-routes-"));
  roots.push(root);
  const project = path.join(root, "project");
  mkdirSync(project);
  const meta: SessionMeta = {
    id: "s1",
    cwd: path.join(root, "worktree"),
    createdAt: "2026-10-17T00:00:00Z",
    projectId: "p1",
    workspace: { path: path.join(root, "worktree") },
    location: location === "server" ? { kind: "server", owner: ALICE } : { kind: "local" },
  };
  const fastify = Fastify();
  // Stands in for the Access hook: the test names who is asking.
  fastify.addHook("onRequest", async (request) => {
    const who = request.headers["x-user"];
    const user = [ALICE, BOB, OPS].find((candidate) => candidate.id === who);
    if (user) setRequestUser(request.raw, user);
  });
  const grants = new SandboxHostGrants(path.join(root, "data", "sandbox-hosts.json"));
  registerSandboxRoutes(
    {
      fastify,
      sessions: { get: () => undefined, mutationClaims: { owner: () => undefined } },
      index: {
        find: (match: (session: SessionMeta) => boolean) => (match(meta) ? meta : undefined),
      },
      projects: {
        find: (match: (p: { id: string; path: string }) => boolean) =>
          [{ id: "p1", path: project }].find(match),
      },
      userAgentDirs: { isOperator: (user: { id: string }) => user.id === OPS.id },
    } as unknown as ServerContext,
    grants,
  );
  const allow = (host: unknown, user?: string) =>
    fastify.inject({
      method: "POST",
      url: "/sessions/s1/sandbox/allowed-hosts",
      headers: user ? { "x-user": user } : {},
      payload: { host },
    });
  const revoke = (host: string, user?: string) =>
    fastify.inject({
      method: "DELETE",
      url: `/sessions/s1/sandbox/allowed-hosts/${encodeURIComponent(host)}`,
      headers: user ? { "x-user": user } : {},
    });
  const file = path.join(project, ".agent-deck", "sandbox.json");
  return { fastify, allow, revoke, file, grants, root };
}

describe("POST /sessions/:id/sandbox/allowed-hosts (ADR 0007)", () => {
  it("lets the owner allow a host: server state only, nothing written to the project", async () => {
    const h = harness();
    const reply = await h.allow("api.example.com", ALICE.id);
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ ok: true, added: true, appliesAfterRestart: true });
    expect(h.grants.hosts("p1")).toEqual(["api.example.com"]);
    // Neither the project's file nor a worktree is written.
    expect(existsSync(h.file)).toBe(false);
    expect(existsSync(path.join(h.root, "worktree"))).toBe(false);
    // Again: nothing new, still fine.
    expect((await h.allow("API.example.com", ALICE.id)).json()).toMatchObject({ added: false });
    expect(h.grants.hosts("p1")).toEqual(["api.example.com"]);
  });

  it("lets the operator allow for the owner; refuses anyone else with 403", async () => {
    const h = harness();
    const refused = await h.allow("api.example.com", BOB.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "sandbox_allow_forbidden" });
    expect((await h.allow("api.example.com")).statusCode).toBe(403);
    expect(existsSync(h.file)).toBe(false);
    expect((await h.allow("api.example.com", OPS.id)).statusCode).toBe(200);
  });

  it("refuses an invalid host with 400", async () => {
    const h = harness();
    for (const host of ["localhost", "10.0.0.1", "http://x.example", "*.com", ""]) {
      const reply = await h.allow(host, ALICE.id);
      expect(reply.statusCode).toBe(400);
    }
    expect(h.grants.hosts("p1")).toEqual([]);
  });

  it("DELETE takes a grant back, with the same authorization", async () => {
    const h = harness();
    await h.allow("api.example.com", ALICE.id);
    await h.allow("cdn.example.com", ALICE.id);
    expect((await h.revoke("api.example.com", BOB.id)).statusCode).toBe(403);
    expect((await h.revoke("API.example.com", ALICE.id)).statusCode).toBe(200);
    expect(h.grants.hosts("p1")).toEqual(["cdn.example.com"]);
    expect((await h.revoke("api.example.com", ALICE.id)).statusCode).toBe(404);
    expect((await h.revoke("cdn.example.com", OPS.id)).statusCode).toBe(200);
    expect(h.grants.hosts("p1")).toEqual([]);
  });

  it("on a desktop the one person may allow", async () => {
    const h = harness("local");
    expect((await h.allow("api.example.com")).statusCode).toBe(200);
  });
});

describe("sandbox violation reporter (ADR 0007)", () => {
  const meta: SessionMeta = {
    id: "s1",
    cwd: "/data/worktrees/s1",
    createdAt: "2026-10-17T00:00:00Z",
    projectId: "p1",
    workspace: { path: "/data/worktrees/s1" },
  };
  const policy = sandboxPolicy(meta, "server", {
    dataDir: "/data",
    projectPath: "/data/projects/app",
    piAgentDir: "/data/home/.pi/agent",
    agentDir: "/data/home/.pi/agent",
    sessionDir: "/data/home/.pi/agent/sessions/--x--",
  });

  it("emits each refused target once per session, and drops writes the policy allowed", () => {
    const emitted: unknown[] = [];
    const { report } = createSandboxViolationReporter({
      sessionOf: (given) => (given === policy ? meta : undefined),
      emit: (record, violation) => emitted.push([record.id, violation]),
      truncated: () => emitted.push("truncated"),
    });
    report({ policy, line: "deny network-outbound evil.example:443 (not allowed)" });
    report({ policy, line: "deny network-outbound evil.example:80 (not allowed)" });
    report({ policy, line: "deny openat /data/worktrees/s1/src/a.ts" }); // allowed: srt's observer noise
    report({ policy, line: "deny openat /data/worktrees/s1/.vscode/settings.json" }); // srt's own deny
    report({ policy, line: "deny openat /data/projects/app/.git/config" });
    report({ policy: { ...policy }, line: "deny openat /etc/passwd" }); // no session
    report({ policy, line: "something else" });
    expect(emitted).toEqual([
      ["s1", { kind: "network", target: "evil.example", operation: "network-outbound" }],
      [
        "s1",
        { kind: "write", target: "/data/worktrees/s1/.vscode/settings.json", operation: "openat" },
      ],
      ["s1", { kind: "write", target: "/data/projects/app/.git/config", operation: "openat" }],
    ]);
  });

  it("stops after the cap with one truncation line, and forgets a deleted session", () => {
    const emitted: unknown[] = [];
    const reporter = createSandboxViolationReporter({
      sessionOf: () => meta,
      emit: (_record, violation) => emitted.push(violation.target),
      truncated: () => emitted.push("truncated"),
      limit: 2,
    });
    for (const host of ["a.example", "b.example", "c.example", "d.example"]) {
      reporter.report({ policy, line: `deny network-outbound ${host}:443 (no)` });
    }
    expect(emitted).toEqual(["a.example", "b.example", "truncated"]);
    reporter.forget("s1");
    reporter.report({ policy, line: "deny network-outbound a.example:443 (no)" });
    expect(emitted.at(-1)).toBe("a.example");
  });

  it("renders the transcript line, with the allow action only when given", () => {
    const network = { kind: "network" as const, target: "evil.example" };
    expect(sandboxViolationNotice(network, "evil.example", "n1")).toEqual({
      kind: "notice",
      id: "n1",
      level: "warning",
      message: "Sandbox refused: network to evil.example",
      sandbox: { violation: network, allowHost: "evil.example" },
    });
    expect(
      sandboxViolationNotice({ kind: "write", target: "/etc/x" }, undefined, "n2").message,
    ).toBe("Sandbox refused: write to /etc/x");
    expect(
      sandboxViolationNotice(
        { kind: "proposal", target: "api.example.com" },
        "api.example.com",
        "n3",
      ),
    ).toMatchObject({
      message: "sandbox.json proposes host api.example.com",
      sandbox: { allowHost: "api.example.com" },
    });
  });
});
