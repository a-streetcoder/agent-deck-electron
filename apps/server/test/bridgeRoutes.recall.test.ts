import Fastify from "fastify";
import type { SemanticRecallStatus } from "@agent-deck/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerBridgeRoutes } from "../src/routes/bridge.ts";

const fastifies: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(fastifies.splice(0).map((fastify) => fastify.close()));
});

const recallStatus: SemanticRecallStatus = {
  readiness: "not_checked",
  mode: "lexical",
  reason: null,
  message: "Semantic ranking has not been checked.",
};

function harness(
  memoryEnabled: boolean,
  cwd?: string,
  project?: { id: string; path: string },
  sessionProjectId = project?.id,
  agentMemoryPreference = memoryEnabled,
  childAllowed?: readonly string[],
) {
  const fastify = Fastify();
  fastifies.push(fastify);
  const recall = vi.fn();
  let liveProject = project;
  let liveSessionProjectId = sessionProjectId;
  registerBridgeRoutes({
    fastify,
    sessions: {
      get: () =>
        cwd
          ? {
              meta: {
                cwd,
                ...(liveSessionProjectId ? { projectId: liveSessionProjectId } : {}),
              },
            }
          : undefined,
    },
    projects: {
      find: (predicate: (value: { id: string; path: string }) => boolean) =>
        liveProject && predicate(liveProject) ? liveProject : undefined,
    },
    bridge: { dispatch: vi.fn() },
    bridgeTokens: new Map([["session-a", "token-a"]]),
    askUser: {},
    supervisor: {},
    childSupervisors: new Map(),
    childAllowedTools: childAllowed ? new Map([["session-a", new Set(childAllowed)]]) : new Map(),
    pendingSupervisor: new Map(),
    memoryEnabled,
    agentMemoryEnabled: () => memoryEnabled && agentMemoryPreference,
    memoryBaseDir: "/tmp/memory",
    semanticRecall: { getStatus: () => recallStatus, recall },
  } as unknown as ServerContext);
  const invokeTool = (tool: string, params: Record<string, unknown>) =>
    fastify.inject({
      method: "POST",
      url: "/bridge",
      payload: {
        sessionId: "session-a",
        token: "token-a",
        tool,
        toolCallId: "recall-a",
        params,
      },
    });
  const invoke = (params: Record<string, unknown>) => invokeTool("__recall__", params);
  return {
    invoke,
    invokeTool,
    recall,
    setAgentMemoryPreference: (enabled: boolean) => {
      agentMemoryPreference = enabled;
    },
    setProject: (next: typeof project) => {
      liveProject = next;
    },
    setSessionProjectId: (next: string | undefined) => {
      liveSessionProjectId = next;
    },
  };
}

describe("__recall__ bridge metadata", () => {
  it("denies app tools outside a child token's exact allowlist", async () => {
    const { invokeTool } = harness(
      true,
      "/project",
      { id: "project-a", path: "/project" },
      "project-a",
      true,
      ["contact_supervisor", "agent_deck_memory_search"],
    );
    const response = await invokeTool("ask_user", {});
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "tool is not authorized for this child" });
  });

  it("uses the registered project path and returns bounded payload-free hit metadata", async () => {
    const { invoke, recall } = harness(true, "/worktrees/session", {
      id: "project-a",
      path: "/registered/project",
    });
    recall.mockResolvedValue({
      recall: recallStatus,
      hits: [
        {
          record: {
            id: "decision-oauth",
            title: "OAuth callback",
            type: "decision",
            body: "private body",
          },
        },
      ],
    });

    const response = await invoke({ query: "oauth callback" });

    expect(recall).toHaveBeenCalledWith(
      { baseDir: "/tmp/memory", projectPath: "/registered/project" },
      "oauth callback",
      5,
    );
    expect(response.json()).toEqual({
      content: expect.any(String),
      recall: recallStatus,
      recalled: [{ id: "decision-oauth", title: "OAuth callback", type: "decision" }],
    });
    expect(JSON.stringify(response.json().recalled)).not.toContain("private body");
  });

  it("injects legacy cwd recall content without unrenderable navigation metadata", async () => {
    const { invoke, recall } = harness(true, "/legacy/project");
    recall.mockResolvedValue({
      recall: recallStatus,
      hits: [
        {
          record: {
            id: "decision-oauth",
            title: "OAuth callback",
            type: "decision",
            body: "legacy recall body",
          },
        },
      ],
    });

    const response = await invoke({ query: "oauth callback" });

    expect(recall).toHaveBeenCalledWith(
      { baseDir: "/tmp/memory", projectPath: "/legacy/project" },
      "oauth callback",
      5,
    );
    expect(response.json()).toEqual({
      content: expect.stringContaining("legacy recall body"),
      recall: recallStatus,
    });
    expect(response.json()).not.toHaveProperty("recalled");
  });

  it("discards completed ranking when memory pauses during recall", async () => {
    const project = { id: "project-a", path: "/registered/project" };
    const { invoke, recall, setAgentMemoryPreference } = harness(
      true,
      "/worktrees/session",
      project,
    );
    let resolveRecall!: (value: {
      recall: SemanticRecallStatus;
      hits: Array<{
        record: { id: string; title: string; type: string; body: string };
      }>;
    }) => void;
    recall.mockReturnValue(
      new Promise((resolve) => {
        resolveRecall = resolve;
      }),
    );

    const response = invoke({ query: "oauth callback" });
    await vi.waitFor(() => expect(recall).toHaveBeenCalledTimes(1));
    setAgentMemoryPreference(false);
    resolveRecall({
      recall: { ...recallStatus, readiness: "ready", mode: "semantic" },
      hits: [
        {
          record: {
            id: "decision-oauth",
            title: "Should not inject",
            type: "decision",
            body: "private recalled body",
          },
        },
      ],
    });

    const completed = await response;
    expect(completed.json()).toEqual({ content: "", recall: recallStatus });
    expect(JSON.stringify(completed.json())).not.toContain("Should not inject");
    expect(JSON.stringify(completed.json())).not.toContain("private recalled body");
  });

  it("discards ranking when authoritative project identity changes in flight", async () => {
    const project = { id: "project-a", path: "/registered/project" };
    const { invoke, recall, setProject, setSessionProjectId } = harness(
      true,
      "/worktrees/session",
      project,
    );
    let resolveRecall!: (value: { recall: SemanticRecallStatus; hits: never[] }) => void;
    recall.mockReturnValue(new Promise((resolve) => (resolveRecall = resolve)));

    const response = invoke({ query: "oauth callback" });
    await vi.waitFor(() => expect(recall).toHaveBeenCalledTimes(1));
    setProject({ id: "project-b", path: "/other/project" });
    setSessionProjectId("project-b");
    resolveRecall({ recall: recallStatus, hits: [] });

    expect((await response).json()).toEqual({ content: "", recall: recallStatus });
  });

  it("returns no card and never ranks while agent memory is paused", async () => {
    const { invoke, recall } = harness(
      true,
      "/worktrees/session",
      { id: "project-a", path: "/registered/project" },
      "project-a",
      false,
    );

    const response = await invoke({ query: "oauth callback" });

    expect(response.json()).toEqual({ content: "", recall: recallStatus });
    expect(recall).not.toHaveBeenCalled();
  });

  it("fails closed when an authoritative project id is stale", async () => {
    const { invoke, recall } = harness(true, "/mismatched/session-cwd", undefined, "stale-id");

    const response = await invoke({ query: "oauth callback" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ content: "", recall: recallStatus });
    expect(recall).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "memory is disabled",
      memoryEnabled: false,
      cwd: "/project",
      params: { query: "oauth" },
    },
    {
      name: "the session has no project",
      memoryEnabled: true,
      cwd: undefined,
      params: { query: "oauth" },
    },
    { name: "the query is empty", memoryEnabled: true, cwd: "/project", params: { query: "  " } },
  ])("returns passive recall metadata when $name", async ({ memoryEnabled, cwd, params }) => {
    const { invoke, recall } = harness(memoryEnabled, cwd);
    const response = await invoke(params);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ content: "", recall: recallStatus });
    expect(recall).not.toHaveBeenCalled();
  });
});
