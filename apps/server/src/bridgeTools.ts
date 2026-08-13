import { randomUUID } from "node:crypto";
import type { SessionPlanItem } from "@agent-deck/domain";
import { z } from "zod";
import type { BridgeRegistry } from "./bridge.ts";
import {
  MAX_DECLARED_READS,
  MAX_DECLARED_READ_BYTES,
  MAX_DECLARED_READS_TOTAL_BYTES,
  MAX_MANAGED_SUBAGENT_TASK_BYTES,
  normalizeDeclaredReads,
} from "./declaredReads.ts";
import type { BridgeRouteHandles } from "./routes/bridge.ts";
import type { SessionManager } from "./SessionManager.ts";
import { ChildRunError } from "./services/sessionManager.ts";
import { supervisorRequestTitle, type SupervisorLog } from "./supervisor.ts";

/**
 * The parent Deck-agent bridge tools — subagent launch and the session activity
 * plan — registered on the app bridge at startup. Moved
 * verbatim from server.ts (Slice 2 decomposition).
 */
export function registerDeckBridgeTools(bridge: BridgeRegistry, sessions: SessionManager): void {
  // Native subagents (native-subagent-bridge.md): a parent session can launch a
  // focused child pi to complete one task and report back. v1 is text-returning
  // (managed_subagent); parallel / supervisor / plan tools + the deck UI follow.
  const subagentParams = z
    .object({
      task: z
        .string()
        .trim()
        .min(1)
        .refine(
          (value) => Buffer.byteLength(value, "utf8") <= MAX_MANAGED_SUBAGENT_TASK_BYTES,
          `task cannot exceed ${MAX_MANAGED_SUBAGENT_TASK_BYTES} UTF-8 bytes`,
        ),
      agent: z.string().trim().min(1).optional(),
      continueSubagentID: z.string().uuid().optional(),
      reads: z.array(z.string()).max(MAX_DECLARED_READS).optional(),
    })
    .strict();
  bridge.register(
    {
      name: "managed_subagent",
      label: "Subagent",
      description:
        "Delegate a self-contained task to a Deck subagent and get its result plus a stable Deck run ID. Optionally declare current project-relative file paths in `reads` for the child to read first as hints; Agent Deck does not preload their contents. Omit `continueSubagentID` for a fresh isolated child with no parent conversation. For a direct follow-up, pass that stable ID: Agent Deck resumes only that child's history, never the parent conversation, and updates the same transcript card.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "A complete, self-contained description of the task for the subagent (maximum 50,000 UTF-8 bytes).",
          },
          agent: {
            type: "string",
            description:
              "Optional: the name of an installed agent to delegate to; the subagent adopts its persona. Omit for a plain anonymous subagent.",
          },
          continueSubagentID: {
            type: "string",
            description:
              "Stable Deck run ID for a direct follow-up. Restores only that child's session and updates the same card; omit to start fresh.",
          },
          reads: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_DECLARED_READS,
            description: `Optional current project-relative file paths the child should read first as hints. File contents are not preloaded. Maximum ${MAX_DECLARED_READ_BYTES} UTF-8 bytes per path and ${MAX_DECLARED_READS_TOTAL_BYTES.toLocaleString("en-US")} UTF-8 bytes total after trimming and stable deduplication.`,
          },
        },
        required: ["task"],
        additionalProperties: false,
      },
      promptSnippet:
        "managed_subagent(task, agent?, continueSubagentID?, reads?) — start fresh or directly follow up using a stable Deck run ID; reads are project-relative read-first hints.",
    },
    async (params, ctx) => {
      const parsed = subagentParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid managed_subagent arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      let reads: string[] | undefined;
      try {
        reads = normalizeDeclaredReads(parsed.data.reads);
      } catch (error) {
        return {
          content: `Invalid managed_subagent arguments: ${error instanceof Error ? error.message : "invalid reads"}`,
          isError: true,
        };
      }
      try {
        const result = await sessions.runManagedSubagent(
          ctx.sessionId,
          parsed.data.task,
          parsed.data.agent,
          parsed.data.continueSubagentID,
          reads,
        );
        return {
          content: `Deck subagent ID: ${result.runId}\n\n${result.text || "(the subagent returned no output)"}`,
        };
      } catch (error) {
        // Only execution failures after the durable identity was accepted carry
        // an authoritative ID. Never echo an untrusted/unknown caller ID as if
        // Agent Deck had claimed or started that run.
        const errorRunId = error instanceof ChildRunError ? error.runId : undefined;
        const idLine = errorRunId ? `\nDeck subagent ID: ${errorRunId}` : "";
        return { content: `Subagent failed.${idLine}\n\n${String(error)}`, isError: true };
      }
    },
  );

  // Fan out several subagents at once. Each runs as its own child pi; the count
  // is capped so a single call can't spawn an unbounded number of processes.
  const parallelParams = z
    .object({
      concurrency: z.number().int().min(1).max(8).optional(),
      worktree: z.boolean().optional(),
      tasks: z
        .array(
          // `.strict()` matches the item schema's additionalProperties:false, so an
          // unexpected field is rejected rather than silently stripped.
          z
            .object({
              task: z.string().trim().min(1),
              agent: z.string().trim().min(1).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict();
  bridge.register(
    {
      name: "managed_parallel",
      label: "Parallel subagents",
      description:
        "Run several self-contained tasks with bounded concurrency, each in its own fresh subagent, and get all their results back together in task order. Use when the tasks are independent. Optional `concurrency` is an integer from 1 to 8 and defaults to 4. Set top-level `worktree: true` to require a distinct app-owned detached Git worktree for every child; allocation failures never fall back to the parent checkout. Each task may optionally name an `agent` to delegate to (it adopts that agent's persona).",
      parameters: {
        type: "object",
        properties: {
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 8,
            description:
              "Optional maximum number of children running at once (integer 1-8). Defaults to 4 and is capped by the task count.",
          },
          worktree: {
            type: "boolean",
            description:
              "Optional. When true, every child must run in its own retained app-owned detached Git worktree. Defaults to false.",
          },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                task: {
                  type: "string",
                  description: "A complete, self-contained task description.",
                },
                agent: {
                  type: "string",
                  description:
                    "Optional: the name of an installed agent to delegate this task to; the subagent adopts its persona.",
                },
              },
              required: ["task"],
              additionalProperties: false,
            },
            minItems: 1,
            maxItems: 8,
            description: "Independent, self-contained tasks to run in parallel (max 8).",
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
      promptSnippet:
        "managed_parallel(tasks, concurrency?, worktree?) — run independent tasks with bounded concurrency (default 4); worktree:true isolates every child checkout.",
    },
    async (params, ctx) => {
      const parsed = parallelParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid managed_parallel arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      // Keep allSettled semantics without eagerly allocating every child's run,
      // artifacts, or optional worktree. Workers claim in input order and remain
      // work-conserving until the queue is empty or its parent is torn down.
      const settled: PromiseSettledResult<string>[] = new Array(parsed.data.tasks.length);
      const workerCount = Math.min(parsed.data.concurrency ?? 4, parsed.data.tasks.length);
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        while (nextIndex < parsed.data.tasks.length) {
          // The manager retains a parent during stop, so isRunning is required as
          // well as existence. On teardown, reject every unclaimed task without
          // entering runSubagent (where durable child allocation begins).
          const parent = sessions.get(ctx.sessionId);
          if (!parent?.isRunning) {
            const reason = new Error(
              "parent session is no longer running; queued subagent cancelled",
            );
            while (nextIndex < parsed.data.tasks.length) {
              settled[nextIndex] = { status: "rejected", reason };
              nextIndex += 1;
            }
            return;
          }

          const index = nextIndex;
          nextIndex += 1;
          const task = parsed.data.tasks[index]!;
          try {
            const value = await sessions.runSubagent(
              ctx.sessionId,
              task.task,
              task.agent,
              undefined,
              undefined,
              "parallel",
              parsed.data.worktree ?? false,
            );
            settled[index] = { status: "fulfilled", value };
          } catch (reason) {
            settled[index] = { status: "rejected", reason };
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      const anyOk = settled.some((r) => r.status === "fulfilled");
      const rendered = settled
        .map((result, index) => {
          const label = `### Subagent ${index + 1}`;
          return result.status === "fulfilled"
            ? `${label}\n${result.value || "(no output)"}`
            : `${label} (failed)\n${String(result.reason)}`;
        })
        .join("\n\n");
      return { content: rendered, isError: !anyOk };
    },
  );

  // Session activity plan (native activity-sidebar "Plan"): a PARENT agent
  // maintains a per-session checklist. set_session_plan REPLACES the list;
  // update_session_plan patches items by id. The plan rides the session's push
  // bus as domain state (plan_set / plan_update), so clients mirror it.
  const planStatus = z.enum(["todo", "in_progress", "done", "blocked", "skipped"]);
  const setPlanParams = z.object({
    items: z
      .array(
        z.object({
          id: z.string().trim().min(1).optional(),
          title: z.string().trim().min(1),
          status: planStatus.optional(),
        }),
      )
      .max(50),
  });
  const updatePlanParams = z.object({
    updates: z
      .array(
        z.object({
          id: z.string().trim().min(1),
          title: z.string().trim().min(1).optional(),
          status: planStatus.optional(),
        }),
      )
      .min(1)
      .max(50),
  });
  const renderPlan = (items: SessionPlanItem[]): string =>
    items.length === 0
      ? "(empty plan)"
      : items.map((it) => `- [${it.status}] ${it.id}: ${it.title}`).join("\n");
  bridge.register(
    {
      name: "set_session_plan",
      label: "Set plan",
      description:
        "Set (replace) this session's activity plan — a short checklist of the steps you'll take. Each item has a title and an optional status (todo/in_progress/done/blocked/skipped, default todo). The result lists each item's assigned id; use those ids with update_session_plan.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Optional stable id; assigned if omitted." },
                title: { type: "string" },
                status: {
                  type: "string",
                  enum: ["todo", "in_progress", "done", "blocked", "skipped"],
                },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      promptSnippet: "set_session_plan — set/replace the session's activity plan checklist.",
    },
    (params, ctx) => {
      const parsed = setPlanParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid set_session_plan arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const session = sessions.get(ctx.sessionId);
      if (!session) return { content: "No such session for the plan.", isError: true };
      // Ids MUST be unique: a duplicate id would make update_session_plan patch
      // every matching item and collides React keys in the panel. Coin a fresh
      // id for anything missing or duplicated.
      const seen = new Set<string>();
      const items: SessionPlanItem[] = parsed.data.items.map((it) => {
        let id = it.id ?? randomUUID();
        if (seen.has(id)) id = randomUUID();
        seen.add(id);
        return { id, title: it.title, status: it.status ?? "todo" };
      });
      session.setPlan(items);
      return { content: `Plan set (${items.length} item(s)):\n${renderPlan(items)}` };
    },
  );
  bridge.register(
    {
      name: "update_session_plan",
      label: "Update plan",
      description:
        "Update items in this session's activity plan by id (from set_session_plan). Each update carries an id and a new status and/or title. Unknown ids are ignored.",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                status: {
                  type: "string",
                  enum: ["todo", "in_progress", "done", "blocked", "skipped"],
                },
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
        required: ["updates"],
        additionalProperties: false,
      },
      promptSnippet: "update_session_plan — patch plan items by id (status/title).",
    },
    (params, ctx) => {
      const parsed = updatePlanParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid update_session_plan arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const session = sessions.get(ctx.sessionId);
      if (!session) return { content: "No such session for the plan.", isError: true };
      session.updatePlan(parsed.data.updates);
      return { content: `Plan updated.\n${renderPlan(session.plan)}` };
    },
  );
}

/** Register the parent-only portable answer flow after its route coordinator exists. */
export function registerSupervisorAnswerBridgeTool(
  bridge: BridgeRegistry,
  routes: Pick<BridgeRouteHandles, "answerSupervisor">,
): void {
  const paramsSchema = z
    .object({
      requestID: z.string(),
      response: z.string(),
    })
    .strict();
  bridge.register(
    {
      name: "answer_supervisor_request",
      label: "Answer supervisor request",
      description:
        "Answer one pending question or decision from this session's Deck subagents. Use a requestID returned by list_supervisor_requests. The response is delivered to the blocked child.",
      parameters: {
        type: "object",
        properties: {
          requestID: {
            type: "string",
            description: "The pending requestID returned by list_supervisor_requests.",
          },
          response: {
            type: "string",
            description: "The response to deliver to the blocked child.",
          },
        },
        required: ["requestID", "response"],
        additionalProperties: false,
      },
      promptSnippet:
        "answer_supervisor_request(requestID, response) — answer one pending request from this parent session's subagent.",
    },
    (params, ctx) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid answer_supervisor_request arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const response = parsed.data.response.trim();
      if (!response) return { content: "Supervisor response is empty." };
      const answered = routes.answerSupervisor(parsed.data.requestID, response, ctx.sessionId);
      if (!answered) {
        return {
          content: `No pending supervisor request found for id \`${parsed.data.requestID}\`.`,
        };
      }
      return {
        content: `Supervisor response sent to child request \`${parsed.data.requestID}\`.`,
      };
    },
  );
}

/** Register the parent-only, runtime-only view of unresolved child blockers. */
export function registerSupervisorListBridgeTool(
  bridge: BridgeRegistry,
  supervisor: SupervisorLog,
): void {
  const paramsSchema = z.object({}).strict();
  bridge.register(
    {
      name: "list_supervisor_requests",
      label: "List supervisor requests",
      description:
        "List pending questions and decisions from this session's Deck subagents. Call this when supervising delegated work or when a subagent may be blocked. Returns a JSON array; use the requestID with the supervisor answer flow.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      promptSnippet:
        "list_supervisor_requests() — review pending questions and decisions from this parent session's subagents.",
    },
    (params, ctx) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid list_supervisor_requests arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const requests = supervisor
        .list(ctx.sessionId)
        .filter((request) => request.status === "pending")
        .map((request) => ({
          requestID: request.id,
          kind: request.method,
          title: supervisorRequestTitle(request.method, request.title),
          message: request.message,
          runID: request.cellId,
        }));
      return { content: JSON.stringify(requests) };
    },
  );
}
