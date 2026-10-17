import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockMcpServerLaunch,
  startMockProvider,
  writeMockProviderExtension,
} from "@agent-deck/testkit";
import { expect, it, vi } from "vitest";
import type * as ChildMemory from "../src/childMemory.ts";
import { startServer } from "../src/index.ts";

// Every child bridge's session id, so the test can call the bridge as a live
// child (and again after it ended).
const bridges = vi.hoisted(() => [] as Array<{ sessionId: string }>);
vi.mock("../src/childMemory.ts", async (importOriginal) => {
  const original = await importOriginal<typeof ChildMemory>();
  return {
    ...original,
    registerChildBridgeAccess: (
      options: Parameters<typeof original.registerChildBridgeAccess>[0],
    ) => {
      bridges.push({ sessionId: options.sessionId });
      return original.registerChildBridgeAccess(options);
    },
  };
});

process.env.AGENT_DECK_TEST = "1";

const ECHO = "mcp__scoped_server__echo";

it("scopes named child MCP calls, continuation and live policy to the parent project", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "deck-child-mcp-"));
  const home = path.join(root, "home");
  const agents = path.join(home, ".pi", "agent", "agents");
  mkdirSync(agents, { recursive: true });
  const writeAgent = (assignment: string, tools = "") =>
    writeFileSync(
      path.join(agents, "worker.md"),
      `---\nname: worker\n${assignment}\n${tools}\n---\nReport the echo.\n`,
    );
  writeAgent("mcpServers: scoped-server");
  writeFileSync(path.join(agents, "plain.md"), "---\nname: plain\n---\nNo MCP assignment.\n");
  // Runs once, after Pi received its tool list and before it calls the tool:
  // a stale generated extension must not bypass current app authorization.
  let revokeBeforeCall: (() => Promise<void>) | undefined;
  // Calls the bridge as the live child once (forbidden tools, then the policy hook).
  let callBridge: (body: {
    sessionId: string;
    tool: string;
    toolCallId: string;
    params: Record<string, unknown>;
  }) => Promise<{ status: number; body: unknown }> = async () => {
    throw new Error("server not started");
  };
  let childAuthorize: Parameters<typeof callBridge>[0] | undefined;
  let probeChildAccess = true;
  const postBridge = (body: Parameters<typeof callBridge>[0]) => callBridge(body);
  const firstTurn = (body: { messages: Array<{ role: string }> }) => {
    const lastUser = body.messages.findLastIndex((message) => message.role === "user");
    return !body.messages.slice(lastUser + 1).some((message) => message.role === "tool");
  };
  const mock = await startMockProvider({
    beforeResponse: async (_lastUser, body) => {
      const revoke = revokeBeforeCall;
      const offered = JSON.stringify(body.tools ?? []).includes(`"${ECHO}"`);
      if (probeChildAccess && offered && firstTurn(body)) {
        probeChildAccess = false;
        const child = bridges.at(-1)!;
        const call = { sessionId: child.sessionId, toolCallId: "probe" };
        for (const tool of [
          "mcp__unlisted__echo",
          "managed_subagent",
          "__recall__",
          "__prompt_audit__",
        ]) {
          expect((await postBridge({ ...call, tool, params: {} })).status).toBe(403);
        }
        childAuthorize = {
          ...call,
          tool: "__mcp_authorize__",
          params: { serverId: "scoped-server", server: "scoped-server", toolName: ECHO },
        };
        const allowed = await postBridge(childAuthorize);
        expect(allowed.status).toBe(200);
        expect(allowed.body).toEqual({ allow: true });
      }
      if (revoke && offered && firstTurn(body)) {
        revokeBeforeCall = undefined;
        await revoke();
      }
    },
    toolCall: (_lastUser, body) =>
      firstTurn(body) ? { name: ECHO, arguments: { message: "child-sentinel" } } : null,
    reply: () => "Child answer arrives in several streamed deltas.",
  });
  const extension = writeMockProviderExtension(mock.baseUrl);
  const env = { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" };
  const previousEnv = process.env.AGENT_DECK_PI_ENV;
  const previousExtensions = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify(env);
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = extension;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ dataDir: path.join(root, "data") });
    const started = server;
    callBridge = ({ sessionId, ...call }) =>
      started.bridgeCall(sessionId, call, new AbortController().signal);
    const api = async (route: string, body: unknown, method = "POST") => {
      const response = await fetch(`http://127.0.0.1:${server!.port}${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.ok).toBe(true);
      return (await response.json()) as { project: { id: string }; session: { id: string } };
    };
    const parents: string[] = [];
    const projectIds: string[] = [];
    for (const label of ["PROJECT_A", "PROJECT_B"]) {
      const cwd = path.join(root, label);
      mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      const launch = mockMcpServerLaunch();
      const config = {
        command: launch.command,
        args: launch.args,
        env: { AGENT_DECK_MOCK_MCP_LABEL: label },
      };
      writeFileSync(
        path.join(cwd, ".pi", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "scoped-server": config,
            unlisted: config,
          },
        }),
      );
      const { project } = await api("/projects", { path: cwd, name: label });
      projectIds.push(project.id);
      // An ordinary parent's assignment must not bleed into a plain child.
      await api(`/projects/${project.id}`, { assignedMcpServers: ["unlisted"] }, "PATCH");
      const { session } = await api("/sessions", {
        startImmediately: true,
        projectId: project.id,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [extension],
        env,
        // Catalog ownership follows projectId, not this alternate runtime cwd.
        cwd: root,
      });
      parents.push(session.id);
    }
    const run = async (parent: string, agent?: string, continueId?: string) => {
      const start = mock.requests.length;
      const result = await server!.sessions.runManagedSubagent(
        parent,
        "Echo for this turn",
        agent,
        continueId,
      );
      const requests = mock.requests.slice(start);
      const tools =
        (requests[0]?.tools as Array<{ function: { name: string } }> | undefined)?.map(
          (tool) => tool.function.name,
        ) ?? [];
      expect(tools).not.toContain("mcp__unlisted__echo");
      for (const forbidden of [
        "managed_subagent",
        "managed_parallel",
        "ask_user",
        "list_subagents",
        "__recall__",
        "__prompt_audit__",
      ]) {
        expect(tools).not.toContain(forbidden);
      }
      expect(tools).toContain("contact_supervisor");
      return { result, requests, tools };
    };
    const deltas: number[] = [];
    let finalized = false;
    const unsubscribe = server.sessions.get(parents[0]!)!.bus.subscribe(({ seq, event }) => {
      if (event.type === "subagent_delta") {
        expect(finalized).toBe(false);
        deltas.push(seq);
      }
      if (event.type === "cell_final" && event.cell.kind === "subagent") finalized = true;
    });
    const first = await run(parents[0]!, "worker").finally(unsubscribe);
    expect(finalized).toBe(true);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((seq, index) => index === 0 || seq > deltas[index - 1]!)).toBe(true);
    expect(first.tools).toContain(ECHO);
    expect(JSON.stringify(first.requests)).toContain("PROJECT_A: child-sentinel");
    expect(JSON.stringify(first.requests)).not.toContain("PROJECT_B: child-sentinel");
    // The Pi-owned run has exited: its bridge is gone.
    expect(childAuthorize).toBeDefined();
    expect((await postBridge(childAuthorize!)).status).toBe(403);
    const continued = await run(parents[0]!, undefined, first.result.runId);
    expect(continued.result.runId).toBe(first.result.runId);
    expect(continued.tools).toContain(ECHO);
    expect(JSON.stringify(continued.requests)).toContain("PROJECT_A: child-sentinel");
    const other = await run(parents[1]!, "worker");
    expect(JSON.stringify(other.requests)).toContain("PROJECT_B: child-sentinel");
    expect(JSON.stringify(other.requests)).not.toContain("PROJECT_A: child-sentinel");
    for (const agent of [undefined, "plain"]) {
      expect((await run(parents[0]!, agent)).tools).not.toContain(ECHO);
    }
    for (const tools of ["tools: []", "tools: read"]) {
      writeAgent("mcpServers: scoped-server", tools);
      expect((await run(parents[0]!, undefined, first.result.runId)).tools).not.toContain(ECHO);
    }
    writeAgent(
      "mcpServers: scoped-server",
      "tools: read, mcp__scoped_server__echo, managed_subagent, ask_user",
    );
    // A legacy exact grant keeps the server's tool under an authored list.
    expect((await run(parents[0]!, "worker")).tools).toContain(ECHO);
    // Continuation resolves the current file, not the saved child assignment.
    writeAgent("");
    expect((await run(parents[0]!, undefined, first.result.runId)).tools).not.toContain(ECHO);
    writeAgent("mcpServers: scoped-server\ndisabled: true");
    await expect(
      server.sessions.runManagedSubagent(
        parents[0]!,
        "Disabled continuation",
        undefined,
        first.result.runId,
      ),
    ).rejects.toThrow("unknown agent");
    writeAgent("mcpServers: scoped-server");
    await api("/mcp/policy", { enabled: false }, "PATCH");
    expect((await run(parents[0]!, "worker")).tools).not.toContain(ECHO);
    await api("/mcp/policy", { enabled: true }, "PATCH");
    expect((await run(parents[0]!, "worker")).tools).toContain(ECHO);
    // Revoke after Pi has received its tool list, immediately before the call:
    // the policy hook refuses it live.
    for (const revoke of [
      async () => writeAgent(""),
      async () => writeAgent("mcpServers: scoped-server\ndisabled: true"),
      async () => {
        await api(`/projects/${projectIds[0]}`, { assignedAgentNames: [] }, "PATCH");
      },
      async () => {
        await api("/mcp/policy", { enabled: false }, "PATCH");
      },
    ]) {
      revokeBeforeCall = revoke;
      const denied = await run(parents[0]!, "worker");
      expect(denied.tools).toContain(ECHO);
      expect(revokeBeforeCall).toBeUndefined();
      expect(JSON.stringify(denied.requests)).not.toContain("PROJECT_A: child-sentinel");
      writeAgent("mcpServers: scoped-server");
      await api(`/projects/${projectIds[0]}`, { assignedAgentNames: ["worker"] }, "PATCH");
      await api("/mcp/policy", { enabled: true }, "PATCH");
    }
  } finally {
    await server?.close();
    await mock.close();
    if (previousEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
    else process.env.AGENT_DECK_PI_ENV = previousEnv;
    if (previousExtensions === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previousExtensions;
    rmSync(path.dirname(extension), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
