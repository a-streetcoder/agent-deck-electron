import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Embedder } from "@agent-deck/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * The semantic-recall preference wired through the server. StartServerOptions
 * supplies an implementation only; the persisted live setting enables ranking.
 * Hermetic: a
 * concept-keyword stub embedder stands in for the real on-device model (no
 * download), pinning the native-calibrated lexical corroboration and abstention
 * gates through the complete HTTP call path.
 */

process.env.AGENT_DECK_TEST = "1";

const CONCEPTS: Array<{ dim: number; triggers: string[] }> = [
  { dim: 0, triggers: ["login", "oauth", "credentials", "token", "authenticate", "signin"] },
  { dim: 1, triggers: ["schema", "sql", "migration", "database", "postgres", "reindex"] },
];

const conceptEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((text) => {
      const words = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      const vec = new Array<number>(CONCEPTS.length).fill(0.01);
      for (const { dim, triggers } of CONCEPTS) {
        for (const word of words) if (triggers.includes(word)) vec[dim]! += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      return vec.map((x) => x / norm);
    });
  },
};

let server: AgentDeckServer | undefined;
const originalSemanticEnv = process.env.AGENT_DECK_SEMANTIC_MEMORY;

beforeEach(() => {
  delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (originalSemanticEnv === undefined) delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
  else process.env.AGENT_DECK_SEMANTIC_MEMORY = originalSemanticEnv;
});

async function setup(embedder?: Embedder): Promise<{ projectId: string; projectPath: string }> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
  const project = mkdtempSync(path.join(tmpdir(), "proj-"));
  server = await startServer({ dataDir, memoryEmbedder: embedder });
  const base = `http://127.0.0.1:${server.port}`;

  const created = (await (
    await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })
  ).json()) as { project: { id: string } };
  const projectId = created.project.id;

  const memories = [
    {
      type: "context",
      title: "Login credentials",
      summary: "Where the oauth token lives",
      body: "Keep the oauth credentials and login token in auth.json.",
    },
    {
      type: "context",
      title: "Schema migrations",
      summary: "Applying schema changes",
      body: "Apply the sql schema migration to the database.",
    },
  ];
  for (const m of memories) {
    const res = await fetch(`${base}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, ...m }),
    });
    expect(res.status).toBe(201);
  }
  return { projectId, projectPath: project };
}

async function setSemantic(enabled: boolean): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ semanticMemoryEnabled: enabled }),
  });
  expect(response.status).toBe(200);
}

async function search(projectId: string, q: string): Promise<string[]> {
  const base = `http://127.0.0.1:${server!.port}`;
  const res = await fetch(
    `${base}/memory/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}`,
  );
  const { memories } = (await res.json()) as { memories: Array<{ title: string }> };
  return memories.map((m) => m.title);
}

describe("semantic memory opt-in via /memory/search", () => {
  it("exposes a typed GET/PATCH settings contract", async () => {
    await setup(undefined);
    const url = `http://127.0.0.1:${server!.port}/settings`;
    const initial = (await (await fetch(url)).json()) as {
      settings: {
        agentMemoryEnabled: boolean;
        agentMemoryInjectionCharacterBudget: number;
        agentMemorySubagentsEnabled: boolean;
        semanticMemoryEnabled: boolean;
      };
      capabilities: { agentMemory: boolean };
    };
    expect(initial.settings.agentMemoryEnabled).toBe(true);
    expect(initial.settings.agentMemoryInjectionCharacterBudget).toBe(6000);
    expect(initial.settings.agentMemorySubagentsEnabled).toBe(true);
    expect(initial.capabilities.agentMemory).toBe(true);
    expect(initial.settings.semanticMemoryEnabled).toBe(false);

    expect(
      (
        await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ semanticMemoryEnabled: "yes" }),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentMemoryEnabled: "paused" }),
        })
      ).status,
    ).toBe(400);

    for (const invalidBudget of [999, 20001, 1000.5, "6000"]) {
      expect(
        (
          await fetch(url, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentMemoryInjectionCharacterBudget: invalidBudget }),
          })
        ).status,
      ).toBe(400);
    }

    const response = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        semanticMemoryEnabled: true,
        agentMemoryEnabled: false,
        agentMemoryInjectionCharacterBudget: 3500,
        agentMemorySubagentsEnabled: true,
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      settings: {
        semanticMemoryEnabled: true,
        agentMemoryEnabled: false,
        agentMemoryInjectionCharacterBudget: 3500,
        agentMemorySubagentsEnabled: true,
      },
      capabilities: { agentMemory: true },
    });
  });

  it.each([
    {
      name: "recalls a strong concept match corroborated by one curated term",
      query: "oauth whereabouts",
      expected: ["Login credentials"],
    },
    {
      name: "abstains from a strong concept match with no lexical corroboration",
      query: "authenticate signin",
      expected: [],
    },
    {
      name: "recalls a database match with two curated terms",
      query: "postgres schema",
      expected: ["Schema migrations"],
    },
  ])("$name", async ({ query, expected }) => {
    const { projectId } = await setup(conceptEmbedder);
    await setSemantic(true);
    expect(await search(projectId, query)).toEqual(expected);
  });

  it("keeps GET and preference PATCH passive until explicit check or search", async () => {
    await setup(conceptEmbedder);
    const base = `http://127.0.0.1:${server!.port}`;

    expect((await (await fetch(`${base}/memory/semantic-status`)).json()) as unknown).toMatchObject(
      {
        recall: { readiness: "not_requested", mode: "lexical", reason: null },
      },
    );
    await setSemantic(true);
    expect((await (await fetch(`${base}/memory/semantic-status`)).json()) as unknown).toMatchObject(
      {
        recall: { readiness: "not_checked", mode: "lexical", reason: null },
      },
    );
    const checked = await fetch(`${base}/memory/semantic-status/check`, { method: "POST" });
    expect(checked.status).toBe(200);
    expect((await checked.json()) as unknown).toMatchObject({
      recall: { readiness: "ready", mode: "semantic", reason: null },
    });
  });

  it("returns the same recall metadata from HTTP search and the memory tool", async () => {
    const { projectId, projectPath } = await setup({
      async embed() {
        throw new Error("private runtime detail");
      },
    });
    await setSemantic(true);
    const base = `http://127.0.0.1:${server!.port}`;
    const response = (await (
      await fetch(
        `${base}/memory/search?projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent("oauth token")}`,
      )
    ).json()) as { recall: unknown };
    expect(response.recall).toMatchObject({
      readiness: "error",
      mode: "lexical_fallback",
      reason: "embedding_failed",
    });
    expect(JSON.stringify(response.recall)).not.toContain("private runtime detail");

    const sessionId = "semantic-metadata-session";
    const liveSessions = (
      server!.sessions as unknown as { sessions: Map<string, { meta: { cwd: string } }> }
    ).sessions;
    liveSessions.set(sessionId, { meta: { cwd: projectPath } });
    try {
      const tool = await server!.bridge.dispatch(
        {
          tool: "agent_deck_memory_search",
          sessionId,
          toolCallId: "metadata-call",
          token: "test-token",
          params: { query: "oauth token" },
        },
        { token: "test-token" },
      );
      expect(tool.details).toMatchObject({
        recall: { mode: "lexical_fallback", reason: "embedding_failed" },
      });
    } finally {
      liveSessions.delete(sessionId);
    }
  });

  it("includes passive recall metadata when the memory tool has no project", async () => {
    await setup(conceptEmbedder);
    await setSemantic(true);

    const tool = await server!.bridge.dispatch(
      {
        tool: "agent_deck_memory_search",
        sessionId: "session-without-project",
        toolCallId: "no-project-memory",
        token: "test-token",
        params: { query: "oauth" },
      },
      { token: "test-token" },
    );

    expect(tool.details).toMatchObject({
      hits: 0,
      recall: { readiness: "not_checked", mode: "lexical", reason: null },
    });
  });

  it("toggles semantic ranking on the same server while an injected embedder only supplies implementation", async () => {
    let embedCalls = 0;
    const countingEmbedder: Embedder = {
      async embed(texts) {
        embedCalls += 1;
        return conceptEmbedder.embed(texts);
      },
    };
    const { projectId } = await setup(countingEmbedder);

    await search(projectId, "oauth whereabouts");
    expect(embedCalls).toBe(0);

    await setSemantic(true);
    expect(await search(projectId, "oauth whereabouts")).toEqual(["Login credentials"]);
    expect(embedCalls).toBeGreaterThan(0);
    const enabledCalls = embedCalls;

    await setSemantic(false);
    await search(projectId, "oauth whereabouts");
    expect(embedCalls).toBe(enabledCalls);

    await setSemantic(true);
    await search(projectId, "oauth whereabouts");
    expect(embedCalls).toBeGreaterThan(enabledCalls);
  });

  it("gates bridge-tool recall with the same live preference without launching Pi", async () => {
    let embedCalls = 0;
    const countingEmbedder: Embedder = {
      async embed(texts) {
        embedCalls += 1;
        return conceptEmbedder.embed(texts);
      },
    };
    const { projectPath } = await setup(countingEmbedder);
    const sessionId = "semantic-bridge-test-session";
    // The bridge's project resolver intentionally accepts only a live SessionManager
    // owner. Install a minimal test owner directly, then remove it before shutdown;
    // this exercises the real registered tool and shared recall closure without a
    // Pi subprocess or a test-only production option.
    const liveSessions = (
      server!.sessions as unknown as { sessions: Map<string, { meta: { cwd: string } }> }
    ).sessions;
    liveSessions.set(sessionId, { meta: { cwd: projectPath } });
    const dispatchSearch = () =>
      server!.bridge.dispatch(
        {
          tool: "agent_deck_memory_search",
          sessionId,
          toolCallId: `call-${embedCalls}`,
          token: "test-token",
          params: { query: "oauth whereabouts" },
        },
        { token: "test-token" },
      );

    try {
      expect((await dispatchSearch()).isError).not.toBe(true);
      expect(embedCalls).toBe(0);

      await setSemantic(true);
      expect((await dispatchSearch()).isError).not.toBe(true);
      expect(embedCalls).toBeGreaterThan(0);
      const enabledCalls = embedCalls;

      await setSemantic(false);
      expect((await dispatchSearch()).isError).not.toBe(true);
      expect(embedCalls).toBe(enabledCalls);
    } finally {
      liveSessions.delete(sessionId);
    }
  });

  it.each([
    { query: "authenticate signin", expected: [] },
    { query: "oauth token", expected: ["Login credentials"] },
  ])(
    "keeps lexical fallback calibration for '$query' without an embedder",
    async ({ query, expected }) => {
      const { projectId } = await setup(undefined);
      expect(await search(projectId, query)).toEqual(expected);
    },
  );
});
