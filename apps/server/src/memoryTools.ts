import type { SemanticRecallStatus } from "@agent-deck/contracts";
import {
  markStale,
  renderRecalledMemories,
  searchMemories,
  writeMemory,
  type MemorySearchHit,
  type MemoryStore,
  type MemoryType,
} from "@agent-deck/memory";
import { z } from "zod";
import type { BridgeRegistry } from "./bridge.ts";

/** Ranks a project's memories for a query. Async so a semantic (embedding-backed)
 *  ranker can be injected; defaults to the lexical+fuzzy searchMemories. */
export interface MemorySearchResult {
  hits: MemorySearchHit[];
  recall: SemanticRecallStatus;
}

export type MemorySearch = (
  store: MemoryStore,
  query: string,
  limit?: number,
) => Promise<MemorySearchResult>;

/**
 * Registers the native memory tools (agent_deck_memory_write / _search /
 * _mark_stale) on the bridge, backed by the project-scoped Markdown store. Each
 * call is scoped to the calling session's project via resolveProjectPath — so a
 * session only ever reads/writes its own project's memory. When a session has
 * no project path, writes are refused and search is empty (memory.md: no
 * project ⇒ no memory).
 */

const MEMORY_TYPES = ["context", "decision", "runbook", "failure", "preference"] as const;

const writeParams = z.object({
  type: z.enum(MEMORY_TYPES),
  title: z.string().min(1),
  summary: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
  id: z.string().optional(),
  confirmNew: z.boolean().optional(),
  writeReason: z.string().optional(),
});

const searchParams = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(10).optional(),
});

const markStaleParams = z.object({ id: z.string().min(1) });

export function registerMemoryTools(
  bridge: BridgeRegistry,
  baseDir: string,
  resolveProjectPath: (sessionId: string) => string | undefined,
  search: MemorySearch = (store, query, limit) =>
    Promise.resolve({
      hits: searchMemories(store, query, limit),
      recall: {
        readiness: "not_requested",
        mode: "lexical",
        reason: null,
        message: "Semantic ranking is not requested. Recall is using lexical ranking.",
      },
    }),
  getRecallStatus: () => SemanticRecallStatus = () => ({
    readiness: "not_requested",
    mode: "lexical",
    reason: null,
    message: "Semantic ranking is not requested. Recall is using lexical ranking.",
  }),
  isAgentMemoryEnabled: () => boolean = () => true,
  characterBudget: () => number = () => 6000,
  /** MEM-11 provenance: the agent whose DELEGATED RUN is writing, or undefined
   * for a parent session's own write. Native draws the line the same way — it
   * passes the run's agent name for a child write (AppViewModel.swift:6303) and
   * nil for the parent's (:6297), even when that parent is itself a named-agent
   * chat. So this answers "a delegated run authored this", not "an agent was
   * involved somewhere". */
  resolveSourceAgentName: (sessionId: string) => string | undefined = () => undefined,
): void {
  const storeFor = (sessionId: string): MemoryStore | null => {
    const projectPath = resolveProjectPath(sessionId);
    return projectPath ? { baseDir, projectPath } : null;
  };

  bridge.register(
    {
      name: "agent_deck_memory_write",
      label: "Write memory",
      description:
        "Store durable project memory a future session can't rediscover from the repo — a decision and its rationale, a failed approach, a user correction, a runbook, or a non-obvious gotcha. Pass an existing id to update in place; omit it to create. Never store secrets or transient task state.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...MEMORY_TYPES] },
          title: { type: "string", description: "Short title." },
          summary: {
            type: "string",
            description: "A retrieval key: the words a future question about this would use.",
          },
          body: { type: "string", description: "The durable content." },
          tags: { type: "array", items: { type: "string" } },
          id: { type: "string", description: "Update this memory in place instead of creating." },
          confirmNew: {
            type: "boolean",
            description: "Store as distinct even if it looks like a near-duplicate.",
          },
          writeReason: { type: "string" },
        },
        required: ["type", "title", "summary", "body"],
        additionalProperties: false,
      },
      promptSnippet:
        "agent_deck_memory_write — persist a durable project fact (decision/failure/runbook/context/preference).",
    },
    (params, ctx) => {
      if (!isAgentMemoryEnabled()) {
        return { content: "Agent Deck memory is paused", isError: true };
      }
      const store = storeFor(ctx.sessionId);
      if (!store) {
        return { content: "Memory needs a project; none is set for this session.", isError: true };
      }
      const parsed = writeParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid memory_write arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      // The store keeps the FIRST author on an update (native sets provenance
      // once at creation and its updateMemory never carries it), so passing this
      // on an edit cannot relabel someone else's memory.
      const sourceAgentName = resolveSourceAgentName(ctx.sessionId);
      const result = writeMemory(store, {
        ...parsed.data,
        type: parsed.data.type as MemoryType,
        ...(sourceAgentName ? { sourceAgentName } : {}),
      });
      if (result.ok) {
        return {
          content: `${result.created ? "Stored" : "Updated"} memory ${result.record.id}: ${result.record.title}`,
          details: { id: result.record.id, created: result.created },
        };
      }
      if (result.reason === "duplicate") {
        // Actionable guidance, not a failure: the model should update or confirm.
        return { content: result.message, details: { existingId: result.existing.id } };
      }
      return { content: result.message, isError: true };
    },
  );

  bridge.register(
    {
      name: "agent_deck_memory_search",
      label: "Search memory",
      description:
        "Recall relevant project memory on demand when the conversation moves to a topic beyond what launch-time recall covered. Returns matching memories ranked by relevance.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you're trying to recall." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Max results (default 5).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      promptSnippet: "agent_deck_memory_search — pull relevant project memory mid-conversation.",
    },
    async (params, ctx) => {
      if (!isAgentMemoryEnabled()) {
        return { content: "Agent Deck memory is paused", isError: true };
      }
      const store = storeFor(ctx.sessionId);
      if (!store) {
        return {
          content: "No project memory (no project set).",
          details: { hits: 0, recall: getRecallStatus() },
        };
      }
      const parsed = searchParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid memory_search arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const result = await search(store, parsed.data.query, parsed.data.limit ?? 5);
      // The preference can change while semantic ranking is in flight. Never
      // leak ranked content from a call admitted before a live pause.
      if (!isAgentMemoryEnabled()) {
        return { content: "Agent Deck memory is paused", isError: true };
      }
      if (resolveProjectPath(ctx.sessionId) !== store.projectPath) {
        return { content: "Memory project access changed; retry the search.", isError: true };
      }
      if (result.hits.length === 0)
        return {
          content: "No matching project memory.",
          details: { hits: 0, recall: result.recall },
        };
      // Read after async ranking so the next call and an in-flight call both
      // honor the latest preference without replacing Pi or refreshing resources.
      const rendered = renderRecalledMemories(
        result.hits.map((hit) => hit.record),
        characterBudget(),
      );
      return {
        content: rendered.content,
        details: { hits: rendered.includedRecords.length, recall: result.recall },
      };
    },
  );

  bridge.register(
    {
      name: "agent_deck_memory_mark_stale",
      label: "Mark memory stale",
      description:
        "Mark a project memory stale when the current repository or a user correction proves it wrong. It stops being injected but stays inspectable.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The memory id to mark stale." } },
        required: ["id"],
        additionalProperties: false,
      },
      promptSnippet:
        "agent_deck_memory_mark_stale — retire a memory the repo has since contradicted.",
    },
    (params, ctx) => {
      if (!isAgentMemoryEnabled()) {
        return { content: "Agent Deck memory is paused", isError: true };
      }
      const store = storeFor(ctx.sessionId);
      if (!store) return { content: "No project memory (no project set).", isError: true };
      const parsed = markStaleParams.safeParse(params);
      if (!parsed.success) {
        return { content: `Invalid mark_stale arguments: ${parsed.error.message}`, isError: true };
      }
      const result = markStale(store, parsed.data.id);
      return result.ok
        ? { content: `Marked memory ${result.record.id} stale.` }
        : { content: result.message, isError: true };
    },
  );
}
