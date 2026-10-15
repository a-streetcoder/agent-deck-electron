import { randomUUID } from "node:crypto";
import {
  applyPlanUpdates,
  carryPlanProgress,
  sameAgent,
  validatePlanGraph,
  type SessionPlanItem,
} from "@agent-deck/domain";
import { z } from "zod";
import type { BridgeRegistry } from "./bridge.ts";
import {
  MAX_DECLARED_READS,
  MAX_DECLARED_READ_BYTES,
  MAX_DECLARED_READS_TOTAL_BYTES,
  MAX_MANAGED_SUBAGENT_TASK_BYTES,
  normalizeDeclaredReads,
} from "./declaredReads.ts";
import type { EventLog } from "./eventLog.ts";
import { runValidationCommand } from "./loopEngine.ts";
import type { BridgeRouteHandles } from "./routes/bridge.ts";
import type { SessionManager } from "./SessionManager.ts";
import { ChildRunError } from "./services/sessionManager.ts";
import { filesChanged, renderSubagentDelta, type SubagentDeltaReader } from "./subagentDelta.ts";
import {
  awaitSubagentRuns,
  DEFAULT_AWAIT_TIMEOUT_MS,
  MAX_AWAIT_TIMEOUT_MS,
} from "./subagentRunStore.ts";
import { supervisorRequestTitle, type SupervisorLog } from "./supervisor.ts";
import { launchVerifier, VERIFIER_PROFILE, type VerifierDeps } from "./verifier.ts";

/** A7: the verifier role over the session manager (bridge tools and the plan dispatcher). */
export function sessionVerifierDeps(
  sessions: SessionManager,
  warn: (message: string, error?: unknown) => void,
): VerifierDeps {
  return {
    run: (parentSessionId, runId) => sessions.subagentRunRecord(parentSessionId, runId),
    cwd: (parentSessionId) => sessions.get(parentSessionId)?.meta.cwd,
    filesChanged: async (target) =>
      target.worktreePath ? (await filesChanged(target, warn)).filesChangedSinceBase : undefined,
    runValidation: (cwd, command, signal) => runValidationCommand(cwd, command, signal),
    spawn: (
      parentSessionId,
      task,
      { agentName, targetRunId, detached, signal, parentToolCallId },
    ) =>
      sessions.spawnSubagent(parentSessionId, task, {
        ...(agentName ? { agentName } : {}),
        ...(detached ? { detached } : {}),
        ...(signal ? { signal } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
        toolPolicy: VERIFIER_PROFILE.toolPolicy,
        overrides: {
          checkerShell: VERIFIER_PROFILE.checkerShell,
          defaultExpectedOutcome: VERIFIER_PROFILE.defaultExpectedOutcome,
          durable: true,
          verifyTarget: targetRunId,
        },
      }),
    recordVerdict: (parentSessionId, targetRunId, verdict) =>
      sessions.recordSubagentVerdict(parentSessionId, targetRunId, verdict),
    warn,
  };
}

const MAX_VALIDATION_COMMAND_CHARS = 2_000;

/** A7: `role: "verify"` on managed_subagent / spawn_subagent. */
const verifyFields = {
  role: z.literal("verify").optional(),
  targetRunId: z.string().uuid().optional(),
  validationCommand: z.string().trim().min(1).max(MAX_VALIDATION_COMMAND_CHARS).optional(),
};
const verifyRule = (value: {
  role?: "verify";
  targetRunId?: string;
  validationCommand?: string;
  continueSubagentID?: string;
  reads?: string[];
  worktree?: boolean;
}): boolean =>
  value.role === "verify"
    ? Boolean(value.targetRunId) && !value.continueSubagentID && !value.reads && !value.worktree
    : !value.targetRunId && !value.validationCommand;
const VERIFY_RULE_MESSAGE =
  'role "verify" needs targetRunId and takes no continueSubagentID, reads or worktree; targetRunId and validationCommand need role "verify"';
const VERIFY_SCHEMA_PROPERTIES = {
  role: {
    type: "string",
    enum: ["verify"],
    description:
      'Optional. "verify": a read-only verifier reviews a FINISHED run of this session (targetRunId) and answers with a typed verdict: APPROVE, REJECT, CONTINUE or ASK_HUMAN plus a reason. It gets the producer\'s summary, its changed files and, with validationCommand, the validation result run by Agent Deck first. Choose an agent other than the producer.',
  },
  targetRunId: {
    type: "string",
    description: 'With role "verify": the Deck run ID of the finished run to verify.',
  },
  validationCommand: {
    type: "string",
    description:
      'Optional, with role "verify": a shell command Agent Deck runs before the verifier starts (in the target\'s worktree, else the session checkout); its result is handed to the verifier.',
  },
} as const;

/**
 * The parent Deck-agent bridge tools — subagent launch and the session activity
 * plan — registered on the app bridge at startup. Moved
 * verbatim from server.ts (Slice 2 decomposition).
 */
export function registerDeckBridgeTools(
  bridge: BridgeRegistry,
  sessions: SessionManager,
  events: Pick<EventLog, "subscribe"> & Partial<Pick<EventLog, "writable">> = {
    subscribe: () => () => {},
  },
  // A3: a result hand-back moves the parent's delta cursor past the finished event.
  results: Pick<SubagentDeltaReader, "resultsDelivered"> = { resultsDelivered: () => {} },
  verifierDeps?: VerifierDeps,
): void {
  let defaultVerifier: VerifierDeps | undefined;
  const verifier = (): VerifierDeps =>
    verifierDeps ??
    (defaultVerifier ??= sessionVerifierDeps(sessions, (message, error) =>
      console.warn(message, error),
    ));
  // Native subagents (native-subagent-bridge.md): a parent session can launch a
  // focused child pi to complete one task and report back. v1 is text-returning
  // (managed_subagent); parallel / supervisor / plan tools + the deck UI follow.
  const subagentBase = z
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
      ...verifyFields,
    })
    .strict();
  const subagentParams = subagentBase.refine(verifyRule, { message: VERIFY_RULE_MESSAGE });
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
          ...VERIFY_SCHEMA_PROPERTIES,
        },
        required: ["task"],
        additionalProperties: false,
      },
      promptSnippet:
        'managed_subagent(task, agent?, continueSubagentID?, reads?, role?, targetRunId?, validationCommand?) — start fresh or directly follow up using a stable Deck run ID; reads are project-relative read-first hints; role "verify" + targetRunId returns a typed verdict on a finished run.',
    },
    async (params, ctx) => {
      const parsed = subagentParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid managed_subagent arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      if (parsed.data.role === "verify") {
        try {
          const { runId, done } = await launchVerifier(verifier(), {
            parentSessionId: ctx.sessionId,
            targetRunId: parsed.data.targetRunId!,
            task: parsed.data.task,
            agentName: parsed.data.agent,
            validationCommand: parsed.data.validationCommand,
            signal: ctx.signal,
            parentToolCallId: ctx.toolCallId,
          });
          const { decision, reason, verifierRunId } = await done;
          if (!ctx.signal?.aborted) results.resultsDelivered(ctx.sessionId, [runId]);
          return {
            content: JSON.stringify({
              runId,
              targetRunId: parsed.data.targetRunId,
              verdict: { decision, reason, verifierRunId },
            }),
          };
        } catch (error) {
          return { content: `Verifier failed.\n\n${String(error)}`, isError: true };
        }
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
          ctx.signal,
          ctx.toolCallId,
        );
        if (!ctx.signal?.aborted) results.resultsDelivered(ctx.sessionId, [result.runId]);
        return {
          content: `Deck subagent ID: ${result.runId}\n\n${result.text || "(the subagent returned no output)"}`,
        };
      } catch (error) {
        // Only execution failures after the durable identity was accepted carry
        // an authoritative ID. Never echo an untrusted/unknown caller ID as if
        // Agent Deck had claimed or started that run.
        const errorRunId = error instanceof ChildRunError ? error.runId : undefined;
        const idLine = errorRunId ? `\nDeck subagent ID: ${errorRunId}` : "";
        if (errorRunId && !ctx.signal?.aborted) {
          results.resultsDelivered(ctx.sessionId, [errorRunId]);
        }
        return { content: `Subagent failed.${idLine}\n\n${String(error)}`, isError: true };
      }
    },
  );

  // A4: spawn / await / cancel. spawn_subagent returns once the child's run record
  // is committed, so the parent's turn continues while the child works; the child
  // keeps its own Pi process, worktree and policy exactly as managed_subagent's.
  const spawnParams = z
    .object({
      task: subagentBase.shape.task,
      agentName: z.string().trim().min(1).optional(),
      continueSubagentID: z.string().uuid().optional(),
      reads: z.array(z.string()).max(MAX_DECLARED_READS).optional(),
      worktree: z.boolean().optional(),
      ...verifyFields,
    })
    .strict()
    .refine((value) => !(value.worktree && value.continueSubagentID), {
      message: "worktree cannot be combined with continueSubagentID",
    })
    .refine(verifyRule, { message: VERIFY_RULE_MESSAGE });
  bridge.register(
    {
      name: "spawn_subagent",
      label: "Spawn subagent",
      description:
        "Start a Deck subagent on a self-contained task WITHOUT waiting for it, and get its stable Deck run ID back at once. Keep working, then collect the result with await_subagents, or stop it with cancel_subagent. Use it to run independent work alongside your own, or to start several children and await them together. Optional `agentName` delegates to an installed agent; `continueSubagentID` follows up on a finished single child; `reads` lists project-relative files for the child to read first; `worktree: true` runs a fresh child in its own app-owned detached Git worktree. At most 8 spawned children run at once per session. A spawned child keeps running after your turn ends, until it finishes, is cancelled, or the user presses Stop, which cancels every running child, including ones spawned in earlier turns.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "A complete, self-contained description of the task for the subagent (maximum 50,000 UTF-8 bytes).",
          },
          agentName: {
            type: "string",
            description:
              "Optional: the name of an installed agent to delegate to; the subagent adopts its persona.",
          },
          continueSubagentID: {
            type: "string",
            description:
              "Optional stable Deck run ID of a finished single child to follow up on; omit to start fresh.",
          },
          reads: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_DECLARED_READS,
            description:
              "Optional current project-relative file paths the child should read first as hints. File contents are not preloaded.",
          },
          worktree: {
            type: "boolean",
            description:
              "Optional. When true, the fresh child runs in its own retained app-owned detached Git worktree. Not allowed with continueSubagentID.",
          },
          ...VERIFY_SCHEMA_PROPERTIES,
        },
        required: ["task"],
        additionalProperties: false,
      },
      promptSnippet:
        'spawn_subagent(task, agentName?, continueSubagentID?, reads?, worktree?, role?, targetRunId?, validationCommand?) — start a child without waiting; returns {runId} for await_subagents / cancel_subagent; role "verify" + targetRunId starts a verifier whose awaited result carries the verdict.',
    },
    async (params, ctx) => {
      const parsed = spawnParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid spawn_subagent arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      if (parsed.data.role === "verify") {
        try {
          const { runId } = await launchVerifier(verifier(), {
            parentSessionId: ctx.sessionId,
            targetRunId: parsed.data.targetRunId!,
            task: parsed.data.task,
            agentName: parsed.data.agentName,
            validationCommand: parsed.data.validationCommand,
            detached: true,
            signal: ctx.signal,
            parentToolCallId: ctx.toolCallId,
          });
          return { content: JSON.stringify({ runId, targetRunId: parsed.data.targetRunId }) };
        } catch (error) {
          return { content: `Verifier spawn failed.\n\n${String(error)}`, isError: true };
        }
      }
      let reads: string[] | undefined;
      try {
        reads = normalizeDeclaredReads(parsed.data.reads);
      } catch (error) {
        return {
          content: `Invalid spawn_subagent arguments: ${error instanceof Error ? error.message : "invalid reads"}`,
          isError: true,
        };
      }
      try {
        const { runId } = await sessions.spawnSubagent(ctx.sessionId, parsed.data.task, {
          agentName: parsed.data.agentName,
          continueSubagentId: parsed.data.continueSubagentID,
          declaredReads: reads,
          worktree: parsed.data.worktree,
          signal: ctx.signal,
          parentToolCallId: ctx.toolCallId,
          detached: true,
        });
        return { content: JSON.stringify({ runId }) };
      } catch (error) {
        const errorRunId = error instanceof ChildRunError ? error.runId : undefined;
        const idLine = errorRunId ? `\nDeck subagent ID: ${errorRunId}` : "";
        return { content: `Subagent spawn failed.${idLine}\n\n${String(error)}`, isError: true };
      }
    },
  );

  const awaitParams = z
    .object({
      runIds: z.array(z.string().trim().min(1)).min(1).max(32),
      timeoutMs: z.number().int().min(0).optional(),
    })
    .strict();
  bridge.register(
    {
      name: "await_subagents",
      label: "Await subagents",
      description: `Wait for Deck subagents started with spawn_subagent and get their structured results: per run its id, status (completed, failed, stopped or interrupted; still starting or running after a timeout; not_found for an id this session did not start), summary (the child's full answer), error, tokens, durationMs and model. Returns when every run has finished, or after timeoutMs (default ${DEFAULT_AWAIT_TIMEOUT_MS}, clamped to ${MAX_AWAIT_TIMEOUT_MS}) with timedOut: true and the partial results; await again to keep waiting.`,
      parameters: {
        type: "object",
        properties: {
          runIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 32,
            description: "Deck run IDs returned by spawn_subagent.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            description: `Optional wait limit in milliseconds (default ${DEFAULT_AWAIT_TIMEOUT_MS}; larger values are clamped to ${MAX_AWAIT_TIMEOUT_MS}).`,
          },
        },
        required: ["runIds"],
        additionalProperties: false,
      },
      promptSnippet:
        "await_subagents(runIds, timeoutMs?) — wait for spawned subagents; returns {results, timedOut}.",
    },
    async (params, ctx) => {
      const parsed = awaitParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid await_subagents arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const outcome = await awaitSubagentRuns(
        [...new Set(parsed.data.runIds)],
        {
          subscribe: (subscriber) => events.subscribe(subscriber),
          read: (runId) => sessions.subagentRunRecord(ctx.sessionId, runId),
          settled: (runId) => sessions.subagentRunSettled(ctx.sessionId, runId),
        },
        {
          timeoutMs: Math.min(
            parsed.data.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS,
            MAX_AWAIT_TIMEOUT_MS,
          ),
          signal: ctx.signal,
        },
      );
      if (!ctx.signal?.aborted) {
        results.resultsDelivered(
          ctx.sessionId,
          outcome.results.map((result) => result.id),
        );
      }
      return { content: JSON.stringify(outcome) };
    },
  );

  const cancelParams = z.object({ runId: z.string().trim().min(1) }).strict();
  bridge.register(
    {
      name: "cancel_subagent",
      label: "Cancel subagent",
      description:
        "Stop one running Deck subagent of this session that was started with spawn_subagent or managed_subagent, and wait until it has stopped. Returns {status}: stopped when it was cancelled, or its final status when it had already finished. Returns {ok: false, reason} when the run is unknown or could not be cancelled here (managed_parallel children, or runs owned by another server process).",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string", description: "The Deck run ID to cancel." },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      promptSnippet: "cancel_subagent(runId) — stop a running subagent; returns {status}.",
    },
    async (params, ctx) => {
      const parsed = cancelParams.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid cancel_subagent arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const status = await sessions.cancelSubagent(ctx.sessionId, parsed.data.runId);
      const reason = !status
        ? `No Deck subagent ${parsed.data.runId} in this session.`
        : status === "starting" || status === "running"
          ? `Deck subagent ${parsed.data.runId} is still ${status}: it was not started by spawn_subagent or managed_subagent in this server process, so it cannot be cancelled here.`
          : undefined;
      if (reason) return { content: JSON.stringify({ ok: false, reason }), isError: true };
      return { content: JSON.stringify({ status }) };
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
              task: z
                .string()
                .trim()
                .min(1)
                .refine(
                  (value) => Buffer.byteLength(value, "utf8") <= MAX_MANAGED_SUBAGENT_TASK_BYTES,
                  `task cannot exceed ${MAX_MANAGED_SUBAGENT_TASK_BYTES} UTF-8 bytes`,
                ),
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
          if (ctx.signal?.aborted || !parent?.isRunning) {
            const reason = new Error(
              ctx.signal?.aborted
                ? "delegation aborted; queued subagent cancelled"
                : "parent session is no longer running; queued subagent cancelled",
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
              ctx.signal,
              ctx.toolCallId,
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
      if (!ctx.signal?.aborted)
        results.resultsDelivered(ctx.sessionId, { toolCallId: ctx.toolCallId });
      return { content: rendered, isError: ctx.signal?.aborted || !anyOk };
    },
  );

  // Session activity plan (native activity-sidebar "Plan"): a PARENT agent
  // maintains a per-session checklist. set_session_plan REPLACES the list;
  // update_session_plan patches items by id. The plan rides the session's push
  // bus as domain state (plan_set / plan_update), so clients mirror it.
  const planStatus = z.enum(["todo", "in_progress", "done", "blocked", "skipped"]);
  // A5: the graph fields. dependsOn holds item ids; assignee / verifiedBy are agent names.
  const agentName = z.string().trim().min(1).max(200);
  const taskText = z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_MANAGED_SUBAGENT_TASK_BYTES,
      `task cannot exceed ${MAX_MANAGED_SUBAGENT_TASK_BYTES} UTF-8 bytes`,
    );
  const graphFields = {
    dependsOn: z.array(z.string().trim().min(1)).max(50).optional(),
    task: taskText.optional(),
    isolated: z.boolean().optional(),
  };
  const setPlanParams = z.object({
    items: z
      .array(
        z.object({
          id: z.string().trim().min(1).optional(),
          title: z.string().trim().min(1),
          status: planStatus.optional(),
          assignee: agentName.optional(),
          verifiedBy: agentName.optional(),
          ...graphFields,
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
          // null clears the field.
          assignee: agentName.nullable().optional(),
          verifiedBy: agentName.nullable().optional(),
          ...graphFields,
          task: taskText.nullable().optional(),
        }),
      )
      .min(1)
      .max(50),
  });
  const graphSchema = (clearable: boolean) => {
    const orNull = (schema: Record<string, unknown>) =>
      clearable ? { anyOf: [schema, { type: "null" }] } : schema;
    return {
      dependsOn: {
        type: "array",
        items: { type: "string" },
        maxItems: 50,
        description: "Optional ids of the items this one waits for (no cycles).",
      },
      assignee: {
        ...orNull({ type: "string" }),
        description: `Optional installed agent name. Agent Deck runs an assigned item AUTOMATICALLY as a subagent of that agent once every dependency is done or skipped, spending the session owner's model budget, and marks it done or blocked from the result.${clearable ? " null clears it." : ""}`,
      },
      verifiedBy: {
        ...orNull({ type: "string" }),
        description: `Optional installed agent name that reviews the assignee's result read-only and answers APPROVE or REJECT; must differ from assignee. Only the server marks such an item done.${clearable ? " null clears it." : ""}`,
      },
      task: {
        ...orNull({ type: "string" }),
        description: "Optional prompt for the assignee; without it the title is the whole prompt.",
      },
      isolated: {
        type: "boolean",
        description:
          "Optional. When true the assigned item runs in its own Git worktree and may run in parallel with other isolated items; otherwise assigned items run one at a time in the session's checkout.",
      },
    };
  };
  const renderPlan = (items: SessionPlanItem[]): string =>
    items.length === 0
      ? "(empty plan)"
      : items
          .map((it) => {
            const graph = [
              it.dependsOn?.length ? `after ${it.dependsOn.join(", ")}` : "",
              it.assignee ? `assignee ${it.assignee}` : "",
              it.verifiedBy ? `verified by ${it.verifiedBy}` : "",
              it.isolated ? "isolated" : "",
              it.runId ? `run ${it.runId}` : "",
              it.note ? `note: ${it.note}` : "",
            ].filter(Boolean);
            return `- [${it.status}] ${it.id}: ${it.title}${graph.length ? ` (${graph.join("; ")})` : ""}`;
          })
          .join("\n");
  /** The graph, every named agent and the dispatch preconditions must hold before a plan is stored. */
  const planError = (
    sessionId: string,
    items: readonly SessionPlanItem[],
    previous: readonly SessionPlanItem[],
  ): string | undefined => {
    const graph = validatePlanGraph(items);
    if (graph) return graph;
    const before = new Map(previous.map((item) => [item.id, item]));
    for (const item of items) {
      // Principle 4: a verified item is marked done by the server after APPROVE only.
      if (item.verifiedBy && item.status === "done" && before.get(item.id)?.status !== "done") {
        return `plan item ${item.id} has verifiedBy: only its verifier's APPROVE marks it done`;
      }
    }
    // A new or changed assignment must be able to run (an unchanged one may stay).
    if (
      items.some(
        (item) => item.assignee && !sameAgent(before.get(item.id)?.assignee, item.assignee),
      )
    ) {
      const meta = sessions.get(sessionId)?.meta;
      if (meta && !sessions.delegationAllowed(meta)) {
        return "assigned items need subagent delegation, which is turned off for this session (Settings)";
      }
      if (events.writable === false) {
        return "assigned items cannot run now: another Agent Deck process owns the event log";
      }
    }
    for (const name of new Set(items.flatMap((it) => [it.assignee, it.verifiedBy]))) {
      const error = name ? sessions.agentResolutionError(sessionId, name) : undefined;
      if (error) return error;
    }
    return undefined;
  };
  bridge.register(
    {
      name: "set_session_plan",
      label: "Set plan",
      description:
        "Set (replace) this session's activity plan — a short checklist of the steps you'll take. Each item has a title and an optional status (todo/in_progress/done/blocked/skipped, default todo). Items may form a dependency graph: `dependsOn` lists the ids of items that must be done (or skipped) first; a blocked dependency blocks its dependants. An item with an `assignee` runs AUTOMATICALLY as a subagent of that agent once ready (its `task`, or else its title, is the whole prompt, plus its dependencies' results), spending the session owner's model budget; it is marked done or blocked from the result, and `verifiedBy` names a different agent that must APPROVE it first. Assigned items run one at a time unless `isolated`. Re-sending an unchanged item without a status keeps its done (or running) state. You are not prompted when items finish: read the plan on your next turn. The result lists each item's assigned id; use those ids with update_session_plan.",
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
                ...graphSchema(false),
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      promptSnippet:
        "set_session_plan — set/replace the session's activity plan (checklist, or a graph with dependsOn / assignee / verifiedBy; assigned items run automatically).",
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
      // id for anything missing or duplicated — except in a graph, where a
      // dependsOn would silently point at the wrong item.
      const graph = parsed.data.items.some((it) => it.dependsOn?.length);
      const seen = new Set<string>();
      const stated = new Set<string>();
      const sent: SessionPlanItem[] = [];
      for (const it of parsed.data.items) {
        let id = it.id ?? randomUUID();
        if (seen.has(id)) {
          if (graph) {
            return { content: `Invalid set_session_plan: duplicate item id ${id}.`, isError: true };
          }
          id = randomUUID();
        }
        seen.add(id);
        if (it.status) stated.add(id);
        sent.push({
          id,
          title: it.title,
          status: it.status ?? "todo",
          ...(it.dependsOn?.length ? { dependsOn: [...new Set(it.dependsOn)] } : {}),
          ...(it.assignee ? { assignee: it.assignee } : {}),
          ...(it.verifiedBy ? { verifiedBy: it.verifiedBy } : {}),
          ...(it.task ? { task: it.task } : {}),
          ...(it.isolated ? { isolated: true } : {}),
        });
      }
      const previous = session.plan;
      const items = carryPlanProgress(previous, sent, stated);
      const error = planError(ctx.sessionId, items, previous);
      if (error) return { content: `Invalid set_session_plan: ${error}.`, isError: true };
      session.setPlan(items);
      return { content: `Plan set (${items.length} item(s)):\n${renderPlan(items)}` };
    },
  );
  bridge.register(
    {
      name: "update_session_plan",
      label: "Update plan",
      description:
        "Update items in this session's activity plan by id (from set_session_plan). Each update carries an id and a new status, title, task, dependsOn, assignee, verifiedBy and/or isolated (null clears assignee, verifiedBy or task). Unknown ids are ignored; an update that would create a dependency cycle is refused, and an item with verifiedBy cannot be marked done here (its verifier's APPROVE does that). Assigned items run automatically when ready and spend the session owner's model budget.",
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
                ...graphSchema(true),
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
        required: ["updates"],
        additionalProperties: false,
      },
      promptSnippet:
        "update_session_plan — patch plan items by id (status/title/task/dependsOn/assignee/verifiedBy/isolated).",
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
      const previous = session.plan;
      const error = planError(
        ctx.sessionId,
        applyPlanUpdates(previous, parsed.data.updates),
        previous,
      );
      if (error) return { content: `Invalid update_session_plan: ${error}.`, isError: true };
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

/**
 * A3: the parent-only delta of one of its subagent runs (VISION_ORCHESTRATION
 * principle 5): what changed since this parent last looked, not the transcript.
 */
export function registerSubagentDeltaBridgeTool(
  bridge: BridgeRegistry,
  reader: Pick<SubagentDeltaReader, "read" | "delivered">,
): void {
  const paramsSchema = z
    .object({ runId: z.string().uuid(), full: z.boolean().optional() })
    .strict();
  bridge.register(
    {
      name: "subagent_delta",
      label: "Subagent delta",
      description:
        "Get what changed in one of this session's Deck subagent runs since you last saw its result or looked: status, the newest result, completed turns, tool calls per tool, open questions, answered decisions and the files changed in its worktree. Results from managed_subagent, managed_parallel and await_subagents count as seen. The first look is a full summary; pass `full: true` to read the whole run again. Pass the Deck subagent ID from those tools.",
      parameters: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description: "The Deck subagent ID (a UUID) of a run this session started.",
          },
          full: {
            type: "boolean",
            description: "Optional: summarize the whole run from the start instead of what is new.",
          },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      promptSnippet:
        "subagent_delta(runId, full?) — what changed in a subagent run since you last looked (first look: full summary).",
    },
    async (params, ctx) => {
      const parsed = paramsSchema.safeParse(params);
      if (!parsed.success) {
        return {
          content: `Invalid subagent_delta arguments: ${parsed.error.message}`,
          isError: true,
        };
      }
      const { runId, full } = parsed.data;
      const read = await reader.read(ctx.sessionId, runId, {
        from: full ? "start" : "cursor",
        privateResult: true,
      });
      if (!read.ok) {
        return {
          content: `not_found: no subagent run \`${runId}\` belongs to this session.`,
          isError: true,
        };
      }
      // An aborted call never reaches the model: its look must not move the cursor.
      if (read.hasEvents && !ctx.signal?.aborted) {
        reader.delivered(ctx.sessionId, runId, read.delta.uptoSeq);
      }
      return { content: renderSubagentDelta(read.delta, read.hasEvents) };
    },
  );
}
