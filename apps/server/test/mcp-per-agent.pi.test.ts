import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockMcpServerLaunch,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Per-session MCP scoping (native explicit-assignment model): an agent that
 * DECLARES mcpServers exposes only those servers' MCP tools to its sessions; an
 * agent that declares none (opt-in default) gets no MCP tools; a PLAIN project
 * session receives the configured All Projects/default union explicit assignment. End-to-end against real pi with a configured stdio
 * MCP server "mock" (tool mcp__mock__echo).
 */

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-per-agent-mcp-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

process.env.AGENT_DECK_TEST = "1";
process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: tmpHome });
process.env.AGENT_DECK_MCP_SERVERS = JSON.stringify([mockMcpServerLaunch("mock")]);

let mock: MockProviderServer;
let server: AgentDeckServer;
let mockExt: string;
let projectId: string;
let unassignedProjectId: string;
let activeResponseGate: Promise<void> | undefined;
let activeResponseReached: (() => void) | undefined;
const unassignedCwd = mkdtempSync(path.join(tmpdir(), "pi-unassigned-agent-mcp-"));
const env = { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" };

function writeGlobalAgent(name: string, frontmatter: string, body: string): void {
  const dir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\n${frontmatter}\n---\n\n${body}\n`,
  );
}

function toolResults(reqs: ChatCompletionRequest[]): string {
  return JSON.stringify(reqs.flatMap((r) => r.messages.filter((m) => m.role === "tool")));
}

async function runSession(
  agentName?: string,
  options: { projectId?: string; prompt?: string } = {},
): Promise<ChatCompletionRequest[]> {
  const start = mock.requests.length;
  const res = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: options.projectId ?? projectId,
      agentName,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [mockExt],
      env,
    }),
  });
  expect(res.status).toBe(201);
  const { session } = (await res.json()) as { session: { id: string } };
  await server.sessions.get(session.id)!.prompt(options.prompt ?? "use the mcp echo tool");
  await server.receipts.waitFor("idle", session.id);
  return mock.requests.slice(start);
}

beforeAll(async () => {
  writeGlobalAgent("mcp-yes", "mcpServers: mock", "You use the MCP echo tool.");
  // Declares no mcpServers at all → opt-in default is no MCP tools.
  writeGlobalAgent("mcp-none", "description: plain", "You do not use MCP.");
  writeGlobalAgent(
    "global-project-only",
    "mcpServers: projectonly",
    "You request the project-only MCP tool.",
  );
  const projectMcpDir = path.join(unassignedCwd, ".pi");
  mkdirSync(path.join(projectMcpDir, "agents"), { recursive: true });
  const projectOnly = mockMcpServerLaunch("projectonly");
  writeFileSync(
    path.join(projectMcpDir, "mcp.json"),
    `${JSON.stringify({ mcpServers: { projectonly: { command: projectOnly.command, args: projectOnly.args } } })}\n`,
  );
  writeFileSync(
    path.join(projectMcpDir, "agents", "project-local-mcp.md"),
    "---\nname: project-local-mcp\nmcpServers: projectonly\n---\n\nUse project-only MCP.\n",
  );
  mock = await startMockProvider({
    beforeResponse: async (lastUser) => {
      if (!lastUser.includes("policy-active boundary") || !activeResponseGate) return;
      activeResponseReached?.();
      await activeResponseGate;
      activeResponseGate = undefined;
    },
    toolCall: (lastUser, body) => {
      const lastUserIndex = body.messages.findLastIndex((message) => message.role === "user");
      return body.messages.slice(lastUserIndex + 1).some((message) => message.role === "tool")
        ? null
        : {
            name: lastUser.includes("project-only") ? "mcp__projectonly__echo" : "mcp__mock__echo",
            arguments: { message: "scoped" },
          };
    },
    reply: () => "streamed answer has several ordered deltas",
  });
  mockExt = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir });
  const added = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: cwd, name: "MCP project" }),
  });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
  const assigned = await fetch(`http://127.0.0.1:${server.port}/mcp/mock/default-assignment`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  expect(assigned.status).toBe(200);
  const unassigned = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: unassignedCwd, name: "Unassigned MCP project" }),
  });
  unassignedProjectId = ((await unassigned.json()) as { project: { id: string } }).project.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PI_ENV;
  delete process.env.AGENT_DECK_MCP_SERVERS;
});

describe("per-session MCP scoping by an agent's declared mcpServers", () => {
  it("exposes the declared server's MCP tool to its agent session", async () => {
    // The server has the MCP tool registered globally.
    expect(server.bridge.specs().some((s) => s.name === "mcp__mock__echo")).toBe(true);
    const reqs = await runSession("mcp-yes");
    // The agent declared mock, so mcp__mock__echo ran and its result came back.
    expect(toolResults(reqs)).toContain("mcp stdio echo: scoped");
  });

  it("hides all MCP tools from an agent that declares none (opt-in)", async () => {
    const reqs = await runSession("mcp-none");
    // mcp__mock__echo was NOT exposed to this session, so it never produced output.
    expect(toolResults(reqs)).not.toContain("mcp stdio echo");
  });

  it("exposes an All Projects default to an ordinary project session", async () => {
    const reqs = await runSession();
    // No agent → the configured All Projects default is available.
    expect(toolResults(reqs)).toContain("mcp stdio echo: scoped");
  });

  it("does not expose All Projects defaults to a no-project chat", async () => {
    const start = mock.requests.length;
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [mockExt],
        env,
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    await server.sessions.get(session.id)!.prompt("use the mcp echo tool in no-project chat");
    await server.receipts.waitFor("idle", session.id);
    expect(toolResults(mock.requests.slice(start))).not.toContain("mcp stdio echo");
  });

  it.each(["project-local-mcp", "global-project-only"])(
    "lets bound agent %s use exactly its configured project-local declaration",
    async (agentName) => {
      const catalog = (await (
        await fetch(`http://127.0.0.1:${server.port}/mcp?projectId=${unassignedProjectId}`)
      ).json()) as {
        servers: Array<{ id: string; connected: boolean; toolNames: string[] }>;
      };
      expect(catalog.servers.find((entry) => entry.id === "projectonly")?.id).toBe("projectonly");
      const reqs = await runSession(agentName, {
        projectId: unassignedProjectId,
        prompt: "use the project-only MCP echo tool",
      });
      expect(toolResults(reqs)).toContain("mcp stdio echo: scoped");
      const after = (await (
        await fetch(`http://127.0.0.1:${server.port}/mcp?projectId=${unassignedProjectId}`)
      ).json()) as {
        servers: Array<{ id: string; connected: boolean; toolNames: string[] }>;
      };
      expect(after.servers.find((entry) => entry.id === "projectonly")).toMatchObject({
        connected: true,
      });
    },
  );

  it("rebinds ordinary, named, and no-project runtimes across a global on-off-on policy at safe boundaries", async () => {
    const ensureDefault = await fetch(
      `http://127.0.0.1:${server.port}/mcp/mock/default-assignment`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(ensureDefault.status).toBe(200);
    const create = async (options: { projectId?: string; agentName?: string }) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...options,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [mockExt],
          env,
        }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { session: { id: string } }).session.id;
    };
    const ordinaryId = await create({ projectId });
    const namedId = await create({ projectId, agentName: "mcp-yes" });
    const noProjectId = await create({});
    const promptTurn = async (id: string, prompt: string): Promise<number> => {
      const managed = server.sessions.get(id)!;
      let deltas = 0;
      let settle!: () => void;
      const idle = new Promise<void>((resolve) => (settle = resolve));
      const unsubscribe = managed.bus.subscribe((item) => {
        if (item.event.type === "cell_delta") deltas += 1;
        if (item.event.type === "agent_status" && item.event.status === "idle") settle();
      });
      await managed.prompt(prompt);
      await idle;
      unsubscribe();
      return deltas;
    };
    const original = {
      ordinary: server.sessions.get(ordinaryId)!.meta.launchResourceFingerprint,
      named: server.sessions.get(namedId)!.meta.launchResourceFingerprint,
      noProject: server.sessions.get(noProjectId)!.meta.launchResourceFingerprint,
    };

    await promptTurn(ordinaryId, "policy-on ordinary echo");
    await promptTurn(namedId, "policy-on named echo");
    await promptTurn(noProjectId, "policy-on no-project boundary");
    expect(
      toolResults(mock.requests.filter((r) => JSON.stringify(r).includes("policy-on ordinary"))),
    ).toContain("mcp stdio echo: scoped");
    expect(
      toolResults(mock.requests.filter((r) => JSON.stringify(r).includes("policy-on named"))),
    ).toContain("mcp stdio echo: scoped");

    // Pause during an active streamed turn. RES-12 must retain the current owner
    // until authoritative idle rather than cancelling or replacing mid-stream.
    const active = server.sessions.get(ordinaryId)!;
    let releaseActiveResponse!: () => void;
    let markActiveResponseReached!: () => void;
    const responseReached = new Promise<void>((resolve) => (markActiveResponseReached = resolve));
    activeResponseReached = markActiveResponseReached;
    activeResponseGate = new Promise<void>((resolve) => (releaseActiveResponse = resolve));
    let settleActiveIdle!: () => void;
    const activeIdle = new Promise<void>((resolve) => (settleActiveIdle = resolve));
    const unsubscribeActive = active.bus.subscribe((item) => {
      if (item.event.type === "agent_status" && item.event.status === "idle") settleActiveIdle();
    });
    await active.prompt("policy-active boundary");
    await responseReached;
    expect(active.snapshot().state.agentStatus).not.toBe("idle");
    const paused = await fetch(`http://127.0.0.1:${server.port}/mcp/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(paused.status).toBe(200);
    expect(active.meta.launchResourceFingerprint).toBe(original.ordinary);
    releaseActiveResponse();
    activeResponseReached = undefined;
    await activeIdle;
    unsubscribeActive();
    // The in-flight turn is allowed to finish; pausing does not cancel it. Its
    // already-advertised MCP call may be denied immediately, so text deltas are
    // asserted on the restored streamed turn below rather than fabricated here.

    await vi.waitFor(
      () => {
        expect(server.sessions.get(ordinaryId)!.meta.launchResourceFingerprint).not.toBe(
          original.ordinary,
        );
        expect(server.sessions.get(namedId)!.meta.launchResourceFingerprint).not.toBe(
          original.named,
        );
        expect(server.sessions.get(noProjectId)!.meta.launchResourceFingerprint).not.toBe(
          original.noProject,
        );
      },
      { timeout: 15_000, interval: 25 },
    );
    expect(server.bridge.specs().some((spec) => spec.name === "mcp__mock__echo")).toBe(false);

    await promptTurn(ordinaryId, "policy-off ordinary echo");
    await promptTurn(namedId, "policy-off named echo");
    const offRequests = (marker: string) =>
      mock.requests.filter((request) => JSON.stringify(request).includes(marker));
    const successfulEchoes = (requests: ChatCompletionRequest[]) =>
      Math.max(
        0,
        ...requests.map(
          (request) =>
            request.messages.filter(
              (message) =>
                message.role === "tool" &&
                typeof message.content === "string" &&
                message.content.includes("mcp stdio echo: scoped"),
            ).length,
        ),
      );
    for (const marker of ["policy-off ordinary", "policy-off named"]) {
      const requests = offRequests(marker);
      expect(JSON.stringify(requests.at(-1)?.tools ?? [])).not.toContain("mcp__mock__echo");
      // One successful result is historical from the on turn; pause adds none.
      expect(successfulEchoes(requests)).toBe(1);
    }

    const enabled = await fetch(`http://127.0.0.1:${server.port}/mcp/policy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    await vi.waitFor(
      () =>
        expect(server.bridge.specs().some((spec) => spec.name === "mcp__mock__echo")).toBe(true),
      { timeout: 15_000, interval: 25 },
    );
    await vi.waitFor(
      () => {
        expect(server.sessions.get(ordinaryId)!.meta.launchResourceFingerprint).toBe(
          original.ordinary,
        );
        expect(server.sessions.get(namedId)!.meta.launchResourceFingerprint).toBe(original.named);
        expect(server.sessions.get(noProjectId)!.meta.launchResourceFingerprint).toBe(
          original.noProject,
        );
      },
      { timeout: 15_000, interval: 25 },
    );

    const restoredStart = mock.requests.length;
    await promptTurn(ordinaryId, "policy-restored ordinary echo");
    const restoredDeltas = await promptTurn(namedId, "policy-restored named echo");
    const restoredRequests = mock.requests.slice(restoredStart);
    expect(JSON.stringify(restoredRequests.flatMap((request) => request.tools ?? []))).toContain(
      "mcp__mock__echo",
    );
    expect(toolResults(restoredRequests)).toContain("mcp stdio echo: scoped");
    expect(restoredDeltas).toBeGreaterThan(1);
  });

  it("rebinds a running ordinary session after default removal while named and no-project scopes stay stable", async () => {
    const create = async (options: { projectId?: string; agentName?: string }) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...options,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [mockExt],
          env,
        }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { session: { id: string } }).session.id;
    };
    const ordinaryId = await create({ projectId });
    const namedId = await create({ projectId, agentName: "mcp-yes" });
    const noProjectId = await create({});
    const ordinary = server.sessions.get(ordinaryId)!;
    const named = server.sessions.get(namedId)!;
    const noProject = server.sessions.get(noProjectId)!;
    const ordinaryFingerprint = ordinary.meta.launchResourceFingerprint;
    const namedFingerprint = named.meta.launchResourceFingerprint;
    const noProjectFingerprint = noProject.meta.launchResourceFingerprint;

    await ordinary.prompt("res12-before ordinary tool");
    await server.receipts.waitFor("idle", ordinaryId);
    expect(
      toolResults(
        mock.requests.filter((request) => JSON.stringify(request).includes("res12-before")),
      ),
    ).toContain("mcp stdio echo: scoped");

    const removed = await fetch(`http://127.0.0.1:${server.port}/mcp/mock/default-assignment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(removed.status).toBe(200);
    await vi.waitFor(
      () =>
        expect(server.sessions.get(ordinaryId)?.meta.launchResourceFingerprint).not.toBe(
          ordinaryFingerprint,
        ),
      { timeout: 15_000, interval: 25 },
    );
    expect(server.sessions.get(namedId)?.meta.launchResourceFingerprint).toBe(namedFingerprint);
    expect(server.sessions.get(noProjectId)?.meta.launchResourceFingerprint).toBe(
      noProjectFingerprint,
    );

    let orderedDeltas = 0;
    let settleIdle!: () => void;
    const nextIdle = new Promise<void>((resolve) => (settleIdle = resolve));
    const unsubscribe = server.sessions.get(ordinaryId)!.bus.subscribe((item) => {
      if (item.event.type === "cell_delta") orderedDeltas += 1;
      if (item.event.type === "agent_status" && item.event.status === "idle") settleIdle();
    });
    await server.sessions.get(ordinaryId)!.prompt("res12-after ordinary tool removed");
    await nextIdle;
    unsubscribe();
    await named.prompt("res12-named tool remains");
    await server.receipts.waitFor("idle", namedId);
    await noProject.prompt("res12-no-project tool remains absent");
    await server.receipts.waitFor("idle", noProjectId);

    const requests = (marker: string) =>
      mock.requests.filter((request) => JSON.stringify(request).includes(marker));
    const successfulToolMessageCount = (marker: string) =>
      Math.max(
        0,
        ...requests(marker).map(
          (request) =>
            request.messages.filter(
              (message) =>
                message.role === "tool" &&
                typeof message.content === "string" &&
                message.content.includes("mcp stdio echo: scoped"),
            ).length,
        ),
      );
    // The ordinary transcript retains its one historical tool result, but the
    // post-refresh turn must not add another one.
    expect(successfulToolMessageCount("res12-after")).toBe(1);
    expect(JSON.stringify(requests("res12-after").at(-1)?.tools ?? [])).not.toContain(
      "mcp__mock__echo",
    );
    expect(toolResults(requests("res12-named"))).toContain("mcp stdio echo: scoped");
    expect(JSON.stringify(requests("res12-named").at(-1)?.tools ?? [])).toContain(
      "mcp__mock__echo",
    );
    expect(toolResults(requests("res12-no-project"))).not.toContain("mcp stdio echo");
    expect(JSON.stringify(requests("res12-no-project").at(-1)?.tools ?? [])).not.toContain(
      "mcp__mock__echo",
    );
    expect(orderedDeltas).toBeGreaterThan(1);
  });
});
