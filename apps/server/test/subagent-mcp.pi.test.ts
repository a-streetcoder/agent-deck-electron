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
import { startServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

it("scopes named child MCP calls, continuation, live policy and token lifetime to the parent project", async () => {
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
  const mock = await startMockProvider({
    toolCall: (_lastUser, body) => {
      const lastUser = body.messages.findLastIndex((message) => message.role === "user");
      if (body.messages.slice(lastUser + 1).some((message) => message.role === "tool")) return null;
      return { name: "mcp__scoped_server__echo", arguments: { message: "child-sentinel" } };
    },
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
    const originalDispatch = server.bridge.dispatch.bind(server.bridge);
    const dispatch = vi.spyOn(server.bridge, "dispatch");
    let probedAccess = false;
    let revokeBeforeDispatch: (() => Promise<void>) | undefined;
    dispatch.mockImplementation(async (call, auth) => {
      if (!probedAccess && call.tool === "mcp__scoped_server__echo") {
        probedAccess = true;
        for (const tool of [
          "mcp__unlisted__echo",
          "managed_subagent",
          "__recall__",
          "__prompt_audit__",
        ]) {
          const forbidden = await fetch(`http://127.0.0.1:${server!.port}/bridge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...call, token: auth.token, tool }),
          });
          expect(forbidden.status).toBe(403);
        }
      }
      const revoke = revokeBeforeDispatch;
      if (revoke && call.tool === "mcp__scoped_server__echo") {
        revokeBeforeDispatch = undefined;
        await revoke();
        const denied = await originalDispatch(call, auth);
        expect(denied.isError).toBe(true);
        return denied;
      }
      return originalDispatch(call, auth);
    });
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
    expect(first.tools).toContain("mcp__scoped_server__echo");
    expect(JSON.stringify(first.requests)).toContain("PROJECT_A: child-sentinel");
    expect(JSON.stringify(first.requests)).not.toContain("PROJECT_B: child-sentinel");
    const call = dispatch.mock.calls.find(([call]) => call.tool === "mcp__scoped_server__echo")!;
    expect(call).toBeDefined();
    // The Pi-owned run has exited: its token cannot be reused, even for a tool
    // that remains registered for another project/session.
    const stale = await fetch(`http://127.0.0.1:${server.port}/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...call[0], token: call[1].token }),
    });
    expect(stale.status).toBe(403);
    const continued = await run(parents[0]!, undefined, first.result.runId);
    expect(continued.result.runId).toBe(first.result.runId);
    expect(continued.tools).toContain("mcp__scoped_server__echo");
    expect(
      dispatch.mock.calls.filter(([call]) => call.tool === "mcp__scoped_server__echo"),
    ).toHaveLength(2);
    const other = await run(parents[1]!, "worker");
    expect(JSON.stringify(other.requests)).toContain("PROJECT_B: child-sentinel");
    expect(JSON.stringify(other.requests)).not.toContain("PROJECT_A: child-sentinel");
    for (const agent of [undefined, "plain"]) {
      expect((await run(parents[0]!, agent)).tools.some((name) => name.startsWith("mcp__"))).toBe(
        false,
      );
    }
    for (const tools of ["tools: []", "tools: read"]) {
      writeAgent("mcpServers: scoped-server", tools);
      expect((await run(parents[0]!, undefined, first.result.runId)).tools).not.toContain(
        "mcp__scoped_server__echo",
      );
    }
    writeAgent(
      "mcpServers: scoped-server",
      "tools: read, mcp__scoped_server__echo, managed_subagent, ask_user",
    );
    expect((await run(parents[0]!, "worker")).tools).toContain("mcp__scoped_server__echo");
    // Continuation resolves the current file, not the saved child assignment.
    writeAgent("");
    expect((await run(parents[0]!, undefined, first.result.runId)).tools).not.toContain(
      "mcp__scoped_server__echo",
    );
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
    expect((await run(parents[0]!, "worker")).tools).not.toContain("mcp__scoped_server__echo");
    await api("/mcp/policy", { enabled: true }, "PATCH");
    expect((await run(parents[0]!, "worker")).tools).toContain("mcp__scoped_server__echo");
    // Revoke after Pi has received its catalog, immediately before dispatch.
    // A stale generated extension must not bypass current app authorization.
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
      revokeBeforeDispatch = revoke;
      const denied = await run(parents[0]!, "worker");
      expect(denied.tools).toContain("mcp__scoped_server__echo");
      expect(revokeBeforeDispatch).toBeUndefined();
      expect(JSON.stringify(denied.requests)).not.toContain("PROJECT_A: child-sentinel");
      writeAgent("mcpServers: scoped-server");
      await api(`/projects/${projectIds[0]}`, { assignedAgentNames: ["worker"] }, "PATCH");
      await api("/mcp/policy", { enabled: true }, "PATCH");
    }
    // No live parent uses scoped-server. Child teardown releases its catalog hold.
    const catalog = (await (
      await fetch(`http://127.0.0.1:${server.port}/mcp?projectId=${projectIds[0]}`)
    ).json()) as { servers: Array<{ id: string; connected: boolean }> };
    expect(catalog.servers.find((server) => server.id === "scoped-server")?.connected).not.toBe(
      true,
    );
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
