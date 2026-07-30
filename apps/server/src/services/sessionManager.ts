import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  createIngestState,
  emptyTranscript,
  ingestPiEvent,
  reduceTranscript,
  type AskUserAnswer,
  type AskUserCell,
  type DomainEvent,
  type IngestState,
  type SessionPlanItem,
  type SessionPlanUpdate,
  type SubagentCell,
  type TranscriptState,
} from "@agent-deck/domain";
import {
  buildLaunchArgs,
  resolvePiBinary,
  type AgentSessionPlan,
  type ModelSelection,
  type PiInboundEvent,
  type PiProcessExit,
  type ThinkingLevel,
} from "@agent-deck/pi-host";
import type { Scope } from "effect";
import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import type { ReceiptBus } from "../receipts.ts";
import { SubagentArtifactCapabilityError } from "@agent-deck/loop-catalog-native";
import type { SubagentRunSource, SubagentRunRecord } from "../subagentRunStore.ts";
import { PiHost, type PiHostHandle, type PiSpawnOptions, type PiStreamItem } from "./piHost.ts";
import { SessionPushBuses, type SessionPushBusHandle } from "./pushBus.ts";

/**
 * SessionManager as an Effect service (Slice 5) — the coordinator that makes the
 * ManagedRuntime carry production traffic. Every live chat session is built here
 * from the Slice 3+4 leaf services:
 *
 *   - its pi subprocess comes from the {@link PiHost} service (a scoped resource);
 *   - its ordered event log comes from the {@link SessionPushBuses} service;
 *   - domain ingestion (`@agent-deck/domain`) stays a pure function call.
 *
 * File anatomy follows the services/pushBus.ts + services/piHost.ts template:
 *   1. shared types (session-launch inputs, the child/agent bridge factories)
 *   2. `makeManagedSessionRuntime` — the scoped per-session build (acquire pi +
 *      bus, wire the ingestion loop, expose every operation as an Effect)
 *   3. `Context.Tag` service class ({@link SessionManagerService})
 *   4. `SessionManagerServiceLive` Layer — joined into `serverLayers`
 *      (../runtime.ts) with PiHost + SessionPushBuses provided.
 *
 * ## Per-session Scope
 *
 * Each session owns a {@link Scope.CloseableScope} (created by the class facade
 * in ../SessionManager.ts). The pi subprocess is acquired into that scope, so
 * **session close == scope close == pi killed** (PiHost's release is a
 * process-tree kill). The facade runs `spawn` synchronously through the
 * ManagedRuntime (`create()` stays a synchronous factory), because every step
 * of the build — Queue/Deferred allocation, `proc.start()`, bus creation — is a
 * non-suspending effect.
 *
 * ## The ingestion loop (the long-lived single consumer)
 *
 * `ingest` drains `PiHost.events` — the one long-lived consumer PiHost's
 * scope-tied, single-consumer stream was hardened for. Each pi event is folded
 * through `ingestPiEvent` and stamped onto the bus via {@link emit}, which is a
 * SINGLE synchronous unit (transcript reduce + `bus.append`) so stdout order is
 * preserved end-to-end — leaning on the S3 sync-dispatch guarantee. Synthetic
 * domain events (native subagent cards, the activity plan, supervisor question
 * cards) reach the bus through the exact same `emit`, so they interleave with pi
 * events in arrival order just as the legacy monolith did.
 *
 * The stream terminates with a `ProcessExit` item (whether pi crashed on its own
 * or was killed by a scope close); the ingestion fiber processes it and runs the
 * idempotent exit handling (endedAt, exit listeners, temp-dir cleanup) — the one
 * place session-death side effects fire, matching the legacy `pi.on("exit")`
 * handler's ordering (session_meta before session_exit).
 *
 * ## Resume ordering without a seed gate
 *
 * PiHost buffers stdout from spawn time in an unbounded queue, so a resumed
 * session doesn't need the legacy `seedGate`: the facade seeds the transcript
 * from the active ancestry returned by `get_entries` (an RPC, correlated
 * independently of the event queue) FIRST, then forks `ingest`, which drains the buffered live events strictly
 * after the seed. Order preserved, no queue plumbing.
 *
 * ## Helper / subagent launches
 *
 * Title generation and native subagents spawn their own pi through the SAME
 * PiHost service under a short-lived `Effect.scoped` block (the child is killed
 * when the block ends). Idle is detected by draining the child's event stream to
 * `agent_end`; token/model metadata and streamed deltas are captured off the
 * same stream. This retires the last legacy `new PiSession()` path — production
 * no longer touches the pi-host class directly.
 */

// ---------------------------------------------------------------------------
// 1. Shared types
// ---------------------------------------------------------------------------

/**
 * Builds a child subagent's `contact_supervisor` bridge for one run: returns the
 * generated extension path (loaded via --extension) and a dispose() that tears
 * down the child's bridge token + supervisor route + temp dir. Returns undefined
 * when no supervisor channel is available (e.g. the bridge endpoint isn't bound),
 * in which case the child runs tool-less as before. The server implements this;
 * `route` tells it which parent transcript cell the child's progress flows into.
 */
export type ChildBridgeFactory = (
  childSessionId: string,
  route: { parentSessionId: string; cellId: string },
) => { extension: string; dispose: () => void } | undefined;

/** Resolves a named agent (for `managed_subagent{agent}`) to the launch inputs a
 * delegated child adopts — its persona body, model, thinking level, declared
 * tools, and resolved skill dirs — scoped to the delegating session's project.
 * Returns undefined if not found. `tools` are the agent's real pi tools (the
 * child adds `contact_supervisor` and drops parent-only bridge tools itself);
 * skills only surface when the child also has the `read` tool, so the two are
 * threaded together. */
export type AgentResolver = (
  name: string,
  projectId?: string,
) =>
  | {
      body: string;
      model?: string;
      thinking?: AgentSessionPlan["thinking"];
      tools?: string[];
      skillDirs?: string[];
    }
  | undefined;

/** Provider/model/extensions + env for the isolated title-helper + subagent launches. */
export type HelperContext = ModelSelection & {
  extensions?: string[];
  env?: Record<string, string | undefined>;
};

/** Everything one session's build needs from its manager (the class facade). */
export interface SpawnSessionParams {
  readonly meta: SessionMeta;
  /** The pi spawn options for THIS session (args already built by the facade). */
  readonly spawn: PiSpawnOptions;
  readonly receipts: ReceiptBus;
  readonly onMetaChange: (meta: SessionMeta) => void;
  readonly helperContext: HelperContext;
  /** Temp dirs generated for this launch; removed once pi has exited. */
  readonly tempDirs: readonly string[];
  readonly childBridgeFactory?: ChildBridgeFactory;
  readonly resolveAgent?: AgentResolver;
  /** Required durable lifecycle sink for generic managed_subagent/managed_parallel runs. */
  readonly childRuns?: {
    create: (record: SubagentRunRecord) => void;
    update: (
      id: string,
      patch: Partial<Omit<SubagentRunRecord, "id" | "parentSessionId" | "createdAt">>,
    ) => void;
    prepareTurn?: (
      record: SubagentRunRecord,
      systemPrompt: string,
      continuation?: Pick<SubagentRunRecord, "artifactRootId" | "artifactRootToken">,
    ) => {
      artifactRootId: string;
      identityToken: string;
      turnId: string;
      turnDirectory: string;
      sessionsDirectory: string;
      systemPrompt: string;
    };
    writeOutput?: (id: string, output: string, error?: string) => void;
    markOwnedSession?: (id: string, sessionFile: string) => string;
  };
  /** Live-read autoTitle preference (native autoTitle). */
  readonly autoTitle: () => boolean;
  /**
   * Turn-boundary hook (Slice 9): forked into the session Scope at each
   * agent-idle, the same fire-and-forget shape as captureSessionFile /
   * generateTitle — it must never fail or die (the facade wraps it in a
   * catch). Used for the diff engine's changed-file refresh.
   */
  readonly onIdle?: Effect.Effect<void>;
  /**
   * Checkpoint-capture hook (Slice 18a): forked at each agent-idle AFTER the
   * session-file handle is flushed (chained after captureSessionFile, so
   * `meta.piSessionFile` is resolved by the time it runs — the design doc pins
   * this ordering). Receives the turn's first user message as a short label.
   * Like {@link onIdle} it must never fail or die (the facade wraps it in a
   * catch); it is fire-and-forget so it never perturbs the idle receipt timing.
   */
  readonly captureCheckpoint?: (label: string) => Effect.Effect<void>;
  /** Replace a Pi user message's image bytes with session-scoped opaque refs. */
  readonly decorateUserCell?: (
    cell: Extract<TranscriptState["cells"][number], { kind: "user" }>,
    rawMessage: unknown,
  ) => Extract<TranscriptState["cells"][number], { kind: "user" }>;
  readonly reconcileImages?: (
    users: readonly { entryId: string; cellId: string; text: string; rawMessage: unknown }[],
  ) => void;
  readonly expirePendingImages?: () => void;
}

/** Inputs for a one-shot pi helper launch (native commit-message / release notes). */
export interface RunHelperOptions {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  provider?: string;
  model?: string;
  extensions?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * One session's effectful surface — every operation the class facade exposes,
 * as an Effect (run through the ManagedRuntime) or, for the two dispatch-order
 * critical paths (bus subscribe, exit listeners), a plain synchronous closure.
 */
export interface ManagedSessionRuntime {
  /** The live meta object (mutated in place, same reference semantics as legacy). */
  readonly meta: SessionMeta;
  /** The underlying push-bus handle (wsHandler subscribes/replays synchronously). */
  readonly bus: SessionPushBusHandle;

  /** The ingestion loop; the facade forks it (immediately, or after seeding). */
  readonly ingest: Effect.Effect<void>;
  /** Rebuild the transcript from Pi's stable, active session-entry ancestry
   * (resume/fork path). A get_entries failure surfaces as a defect. */
  readonly seedFromHistory: Effect.Effect<void>;
  readonly seedSyntheticCells: (cells: readonly SubagentCell[]) => Effect.Effect<void>;

  readonly snapshot: Effect.Effect<{ seq: number; state: TranscriptState }>;
  readonly isRunning: Effect.Effect<boolean>;
  readonly plan: Effect.Effect<SessionPlanItem[]>;
  /** Run exit handling now if the stream hasn't already (post scope-close guard). */
  readonly ensureExitHandled: Effect.Effect<void>;

  // Synthetic domain-event emitters (synchronous, stamped onto the bus in order).
  readonly setPlan: (items: SessionPlanItem[]) => Effect.Effect<void>;
  readonly updatePlan: (updates: SessionPlanUpdate[]) => Effect.Effect<void>;
  readonly restorePlan: (items: SessionPlanItem[]) => Effect.Effect<void>;
  readonly appendSubagentProgress: (cellId: string, message: string) => Effect.Effect<void>;
  readonly openSupervisorQuestion: (req: {
    requestId: string;
    subagentCellId: string;
    method: "need_decision" | "interview_request";
    title: string;
    message?: string;
    options?: string[];
  }) => Effect.Effect<void>;
  readonly answerSupervisorQuestion: (requestId: string, answer: string) => Effect.Effect<void>;
  readonly closeSupervisorQuestion: (requestId: string, reason: string) => Effect.Effect<void>;
  readonly openAskUser: (cell: AskUserCell) => Effect.Effect<void>;
  readonly answerAskUser: (requestId: string, answer: AskUserAnswer) => Effect.Effect<void>;
  readonly closeAskUser: (
    requestId: string,
    status: "cancelled" | "timed_out",
    reason: string,
  ) => Effect.Effect<void>;
  /** Fails (Error) on an invalid/unknown UI-request id — surfaced to the caller. */
  readonly respondToUiRequest: (raw: Record<string, unknown>) => Effect.Effect<void, Error>;

  // pi RPC operations.
  readonly prompt: (
    message: string,
    images?: PromptImages,
    streamingBehavior?: "steer" | "followUp",
  ) => Effect.Effect<void>;
  readonly steer: (message: string) => Effect.Effect<void>;
  readonly followUp: (message: string) => Effect.Effect<void>;
  readonly compact: Effect.Effect<void>;
  readonly abort: Effect.Effect<void>;
  readonly getState: Effect.Effect<StateData>;
  readonly getSessionStats: Effect.Effect<StatsData>;
  readonly getAvailableModels: Effect.Effect<AvailableModels>;
  readonly getCommands: Effect.Effect<SlashCommands>;
  readonly setModel: (provider: string, modelId: string) => Effect.Effect<void>;
  readonly setThinkingLevel: (level: ThinkingLevelArg) => Effect.Effect<void>;
  readonly rename: (title: string) => Effect.Effect<void>;

  /** Run a native subagent; returns its final assistant text. */
  readonly runChildAgent: (
    task: string,
    agentName?: string,
    toolPolicy?: ChildToolPolicy,
    overrides?: ChildLaunchOverrides,
    runOptions?: ChildRunOptions,
  ) => Effect.Effect<ChildRunResult, Error>;

  /** Subscribe to process exit; fires immediately if already exited. */
  readonly onExit: (listener: (exit: PiProcessExit) => void) => () => void;
}

// Aliases derived from the PiHost handle so the facade stays typed without
// re-importing every pi command type.
type PromptImages = Parameters<PiHostHandle["prompt"]>[1];
type StateData = Effect.Effect.Success<PiHostHandle["getState"]>;
type StatsData = Effect.Effect.Success<PiHostHandle["getSessionStats"]>;
type AvailableModels = Effect.Effect.Success<PiHostHandle["getAvailableModels"]>;
type SlashCommands = Effect.Effect.Success<PiHostHandle["getCommands"]>;
type EntriesData = Effect.Effect.Success<PiHostHandle["getEntries"]>;
type ThinkingLevelArg = Parameters<PiHostHandle["setThinkingLevel"]>[0];

/** `get_entries` returns the append-only tree; transcript history is only the
 * current leaf's ancestry, in root-to-leaf order. */
function activeEntryChain(data: EntriesData): EntriesData["entries"] {
  if (!data.leafId) return [];
  const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
  const reversed: EntriesData["entries"] = [];
  const seen = new Set<string>();
  let id: string | null = data.leafId;
  while (id) {
    if (seen.has(id)) throw new Error("cyclic Pi session entry ancestry");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`missing Pi session entry ancestor: ${id}`);
    reversed.push(entry);
    id = entry.parentId;
  }
  return reversed.reverse();
}

const TITLE_SYSTEM_PROMPT =
  "You generate a session title. Reply with ONLY a short title (max 8 words) " +
  "summarizing the user's message. No quotes, no punctuation at the end.";

const TITLE_TIMEOUT_MS = 20_000;

const SUBAGENT_SYSTEM_PROMPT =
  "You are a focused subagent launched by Agent Deck to complete one task and " +
  "report back. You have no conversation history. Do the task, then give a " +
  "concise, self-contained result the parent agent can use directly.";

const SUBAGENT_CONTINUATION_SYSTEM_PROMPT =
  "You are a focused subagent launched by Agent Deck. This is a continuation of " +
  "your own child session: prior child messages are available, but no parent " +
  "conversation is present. The new task is the only active assignment and its " +
  "result supersedes earlier assignments. Give a concise, self-contained result.";

const SUBAGENT_TIMEOUT_MS = 120_000;

/** Bridge tools a delegated child must never receive: parent-only channels and
 * the subagent spawners (a child can't recurse). `contact_supervisor` is its one
 * allowed bridge tool and is added back explicitly. */
const CHILD_FORBIDDEN_TOOLS = new Set([
  "managed_subagent",
  "managed_parallel",
  "set_session_plan",
  "update_session_plan",
  "contact_supervisor",
  "ask_user",
]);

/** Purpose-built child capability restriction. Omitted preserves legacy behavior. */
export type ChildToolPolicy = "configured" | "readOnly" | "none";
const CHILD_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Pure capability boundary, exported for focused policy tests. */
export function resolveChildTools(
  configured: readonly string[] | undefined,
  toolPolicy: ChildToolPolicy | undefined,
  includeSupervisorBridge: boolean,
): string[] {
  const allowed = configured?.filter((tool) => !CHILD_FORBIDDEN_TOOLS.has(tool));
  const tools =
    toolPolicy === "none"
      ? []
      : toolPolicy === "readOnly"
        ? (allowed ?? []).filter((tool) => CHILD_READ_ONLY_TOOLS.has(tool))
        : (allowed ?? []);
  return includeSupervisorBridge ? [...tools, "contact_supervisor"] : tools;
}

function normalizeTitle(raw: string): string {
  const firstLine =
    raw
      .split("\n", 1)[0]
      ?.trim()
      .replace(/^["'"']|["'"']$/g, "") ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/** The text of the LAST user cell in a transcript — the message that started
 * the just-finished turn, used as a checkpoint's short label. Empty when none. */
const lastUserText = (transcript: TranscriptState): string => {
  for (let i = transcript.cells.length - 1; i >= 0; i -= 1) {
    const cell = transcript.cells[i];
    if (cell && cell.kind === "user") return cell.text;
  }
  return "";
};

const isPiEvent = (item: PiStreamItem): item is PiStreamItem & { _tag: "PiEvent" } =>
  item._tag === "PiEvent";

const eventType = (event: PiInboundEvent): string => (event as { type?: string }).type ?? "";

/**
 * The per-session push-bus ring capacity. Defaults to the service default
 * (5,000); `AGENT_DECK_PUSH_BUS_CAPACITY` overrides it so tests can force ring
 * eviction (→ snapshot fallback on resubscribe) without emitting 5,000 events.
 * A non-positive / unparseable value falls back to the default.
 */
const pushBusCapacity = (): number | undefined => {
  const raw = process.env.AGENT_DECK_PUSH_BUS_CAPACITY;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

// ---------------------------------------------------------------------------
// 2. The scoped per-session build
// ---------------------------------------------------------------------------

/**
 * Build one live session's runtime state as a resource of the caller's Scope:
 * acquire the pi subprocess (PiHost) + push bus (SessionPushBuses), wire the
 * ingestion loop, and expose every operation. Closing the caller's scope kills
 * pi and settles everything. Never fails — pi spawn errors surface as an exit.
 */
export const makeManagedSessionRuntime = (
  piHost: Context.Tag.Service<PiHost>,
  buses: Context.Tag.Service<SessionPushBuses>,
  params: SpawnSessionParams,
): Effect.Effect<ManagedSessionRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { meta, receipts, onMetaChange, helperContext, autoTitle } = params;
    // The per-session Scope (provided by the class facade in ../SessionManager.ts).
    // The pi subprocess is acquired into it, and the fire-and-forget title /
    // session-file fibers below are forked into it too, so session close ==
    // scope close settles ALL of them (no fiber or helper pi escapes).
    const sessionScope = yield* Effect.scope;
    const bus = yield* buses.make(pushBusCapacity());
    const handle = yield* piHost.spawn(params.spawn);

    // Closure-scoped mutable state, only ever mutated inside synchronous units
    // (the `emit` helper and single `Effect.sync` ops) — same atomicity
    // rationale as pushBus/piHost. Two fibers never run JS simultaneously, and
    // no `emit` call yields mid-body, so transcript + bus stay consistent.
    const ingest: IngestState = createIngestState();
    let transcript: TranscriptState = emptyTranscript();
    let sawFirstDelta = false;
    let titleStarted = false;
    const pendingUiRequests = new Map<string, string>();
    const exitListeners = new Set<(exit: PiProcessExit) => void>();
    let currentExit: PiProcessExit | null = null;
    let exitHandled = false;

    /**
     * The single seam through which both pi-derived and synthetic domain events
     * reach clients: reduce the authoritative transcript AND stamp the ordered
     * bus in ONE synchronous unit, so ordering stays in pi-stdout order. Uses
     * the bus's `unsafeAppend` sync bridge (not `runSync`) so this hot-path
     * callback never captures a fiber runtime — the pushBus caveat the piHost
     * template follows with `Queue.unsafeOffer`.
     */
    const emit = (event: DomainEvent): void => {
      transcript = reduceTranscript(transcript, event);
      bus.unsafeAppend(event);
    };

    const cleanupTempDirs = (): void => {
      for (const dir of params.tempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort: a leftover temp dir is harmless.
        }
      }
    };

    const runExitHandling = (exit: PiProcessExit): void => {
      if (exitHandled) return;
      try {
        params.expirePendingImages?.();
      } catch {
        // Image cleanup must not hide the process failure or session stop.
      }
      exitHandled = true;
      currentExit = exit;
      meta.endedAt = new Date().toISOString();
      onMetaChange(meta);
      for (const listener of exitListeners) listener(exit);
      cleanupTempDirs();
    };

    // Fire-and-forget: record pi's canonical session file (the resume handle).
    const captureSessionFile = Effect.gen(function* () {
      if (meta.piSessionFile) return;
      if (!(yield* handle.isRunning)) return;
      const state = yield* handle.getState.pipe(Effect.option);
      if (Option.isNone(state)) return;
      const sessionFile = (state.value as { sessionFile?: string }).sessionFile;
      if (sessionFile && !meta.piSessionFile) {
        meta.piSessionFile = sessionFile;
        onMetaChange(meta);
      }
    });

    /**
     * Isolated title-helper launch (pi-rpc-launch-flags.md §3): no session, no
     * tools, no resources; sends only the first user message. Fire-and-forget.
     */
    const generateTitle = Effect.gen(function* () {
      if (titleStarted || meta.title) return;
      const firstUser = transcript.cells.find((cell) => cell.kind === "user");
      if (!firstUser || firstUser.kind !== "user" || !firstUser.text.trim()) return;
      titleStarted = true;

      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const helper = yield* piHost.spawn({
            binPath: resolvePiBinary().path,
            args: buildLaunchArgs({
              kind: "helper",
              systemPrompt: TITLE_SYSTEM_PROMPT,
              provider: helperContext.provider,
              model: helperContext.model,
              extensions: helperContext.extensions,
            }),
            cwd: meta.cwd,
            env: helperContext.env,
            requestTimeoutMs: TITLE_TIMEOUT_MS,
          });
          yield* handleHelperPrompt(helper, firstUser.text.slice(0, 2000), TITLE_TIMEOUT_MS);
          const { text } = yield* helper.request({ type: "get_last_assistant_text" });
          return text ? normalizeTitle(text) : "";
        }),
      ).pipe(
        // Any failure (timeout, early exit, RPC error) → retry on a later idle.
        Effect.either,
      );

      if (outcome._tag === "Left") {
        titleStarted = false;
        return;
      }
      const title = outcome.right;
      if (title) {
        meta.title = title;
        onMetaChange(meta);
        receipts.emit("title", meta.id);
      }
    });

    const applyPiEvent = (piEvent: PiInboundEvent): void => {
      if (eventType(piEvent) === "extension_ui_request") {
        const e = piEvent as { id: string; method: string };
        pendingUiRequests.set(e.id, e.method);
      }
      for (const domainEvent of ingestPiEvent(ingest, piEvent)) {
        if (
          domainEvent.type === "cell_final" &&
          domainEvent.cell.kind === "user" &&
          params.decorateUserCell
        ) {
          domainEvent.cell = params.decorateUserCell(
            domainEvent.cell,
            (piEvent as { message?: unknown }).message,
          );
        }
        emit(domainEvent);
        if (domainEvent.type === "cell_delta" && !sawFirstDelta) {
          sawFirstDelta = true;
          receipts.emit("first_delta", meta.id);
        }
        if (domainEvent.type === "cell_final" && domainEvent.cell.kind === "assistant") {
          receipts.emit("assistant_final", meta.id);
        }
        if (domainEvent.type === "agent_status" && domainEvent.status === "idle") {
          receipts.emit("idle", meta.id);
          const reconcileImages = Effect.gen(function* () {
            if (!params.reconcileImages) {
              params.expirePendingImages?.();
              return;
            }
            const entryData = yield* handle.getEntries;
            const users = activeEntryChain(entryData).flatMap((entry) => {
              if (entry.type !== "message" || entry.message.role !== "user") return [];
              const textEvent = ingestPiEvent(createIngestState(), {
                type: "message_end",
                entryId: entry.id,
                message: entry.message,
              } as unknown as PiInboundEvent).find(
                (event) => event.type === "cell_final" && event.cell.kind === "user",
              );
              if (!textEvent || textEvent.type !== "cell_final" || textEvent.cell.kind !== "user")
                return [];
              return [
                {
                  entryId: entry.id,
                  cellId: textEvent.cell.id,
                  text: textEvent.cell.text,
                  rawMessage: entry.message,
                },
              ];
            });
            params.reconcileImages(users);
          }).pipe(Effect.catchAll(() => Effect.sync(() => params.expirePendingImages?.())));
          Effect.runFork(Effect.forkIn(reconcileImages, sessionScope));
          // Fire-and-forget, but forked INTO the session Scope (not the global
          // daemon scope): they outlive the triggering item, yet closing the
          // session — Scope.close, which also kills the main pi — interrupts any
          // still-running title/session-file work, so an in-flight title helper
          // pi can never be orphaned. `forkIn` auto-removes each fiber's scope
          // finalizer when it completes, so repeated idles don't accumulate.
          // Slice 18a: the checkpoint capture must see a RESOLVED session-file
          // handle, so it is chained AFTER captureSessionFile (which sets
          // meta.piSessionFile on the first idle) in the same fiber — not a
          // sibling fork that would race it. The label is read at run time (the
          // turn's last user cell) via Effect.suspend. When no capture hook is
          // wired, captureSessionFile forks alone exactly as before.
          const sessionFileFiber = params.captureCheckpoint
            ? captureSessionFile.pipe(
                Effect.andThen(
                  Effect.suspend(() => params.captureCheckpoint!(lastUserText(transcript))),
                ),
              )
            : captureSessionFile;
          Effect.runFork(Effect.forkIn(sessionFileFiber, sessionScope));
          if (autoTitle()) Effect.runFork(Effect.forkIn(generateTitle, sessionScope));
          // Slice 9: refresh the session's changed-file set at the turn
          // boundary — forked like the title fiber, so it never perturbs the
          // receipt timing above and dies with the session Scope.
          if (params.onIdle) Effect.runFork(Effect.forkIn(params.onIdle, sessionScope));
        }
      }
    };

    const processStreamItem = (item: PiStreamItem): void => {
      switch (item._tag) {
        case "PiEvent":
          applyPiEvent(item.event);
          return;
        case "MalformedLine":
          // Legacy ManagedSession listened to "event" only; malformed lines are
          // surfaced by pi-host but ignored here.
          return;
        case "ProcessExit":
          runExitHandling(item.exit);
      }
    };

    const ingestLoop = handle.events.pipe(
      Stream.runForEach((item) =>
        // `Effect.sync` turns any throw in processStreamItem (a throwing bus
        // subscriber, a reduceTranscript on malformed input) into a DEFECT, not
        // a typed failure — `catchAll` can't see those. Catch defects PER ITEM
        // and continue, so one bad event can't kill this detached fiber and
        // freeze the session; later events keep flowing to the bus/socket.
        Effect.sync(() => processStreamItem(item)).pipe(Effect.catchAllDefect(() => Effect.void)),
      ),
      // The single-consumer contract can't be violated (we're the only run) but
      // `PiEventsAlreadyConsumed` is in the stream's error type; swallow it so a
      // stray typed failure can't crash the fiber either.
      Effect.catchAll(() => Effect.void),
    );

    const seedFromHistory = Effect.gen(function* () {
      const entryData = yield* handle.getEntries.pipe(Effect.orDie);
      yield* Effect.sync(() => {
        const entries = activeEntryChain(entryData);
        const historyUsers: Array<{
          entryId: string;
          cellId: string;
          text: string;
          rawMessage: unknown;
        }> = [];
        for (const entry of entries) {
          if (entry.type !== "message") continue;
          for (const domainEvent of ingestPiEvent(ingest, {
            type: "message_end",
            entryId: entry.id,
            message: entry.message,
          } as unknown as PiInboundEvent)) {
            if (
              domainEvent.type === "cell_final" &&
              domainEvent.cell.kind === "user" &&
              params.decorateUserCell
            ) {
              domainEvent.cell = params.decorateUserCell(domainEvent.cell, entry.message);
              historyUsers.push({
                entryId: entry.id,
                cellId: domainEvent.cell.id,
                text: domainEvent.cell.text,
                rawMessage: entry.message,
              });
            }
            emit(domainEvent);
          }
        }
        params.reconcileImages?.(historyUsers);
      });
    });

    const runtime: ManagedSessionRuntime = {
      meta,
      bus,
      ingest: ingestLoop,
      seedFromHistory,
      seedSyntheticCells: (cells) =>
        Effect.sync(() => {
          const known = new Set(transcript.cells.map((cell) => cell.id));
          for (const cell of cells) {
            if (known.has(cell.id)) continue;
            transcript = reduceTranscript(transcript, { type: "cell_open", cell });
            known.add(cell.id);
          }
        }),
      snapshot: Effect.sync(() => ({ seq: bus.unsafeLastSeq(), state: transcript })),
      isRunning: handle.isRunning,
      plan: Effect.sync(() => transcript.plan),
      ensureExitHandled: Effect.gen(function* () {
        if (exitHandled) return;
        const exit = yield* handle.exit;
        if (Option.isSome(exit)) runExitHandling(exit.value);
      }),

      setPlan: (items) =>
        Effect.sync(() => {
          emit({ type: "plan_set", items });
          meta.plan = transcript.plan;
          onMetaChange(meta);
        }),
      updatePlan: (updates) =>
        Effect.sync(() => {
          emit({ type: "plan_update", updates });
          meta.plan = transcript.plan;
          onMetaChange(meta);
        }),
      restorePlan: (items) =>
        Effect.sync(() => {
          if (items.length === 0) return;
          emit({ type: "plan_set", items });
        }),
      appendSubagentProgress: (cellId, message) =>
        Effect.sync(() => emit({ type: "subagent_progress", cellId, message })),
      openSupervisorQuestion: (req) =>
        Effect.sync(() =>
          emit({
            type: "cell_open",
            cell: {
              kind: "supervisor_question",
              id: `supervisor-${req.requestId}`,
              requestId: req.requestId,
              subagentCellId: req.subagentCellId,
              method: req.method,
              title: req.title,
              message: req.message,
              options: req.options,
              answered: false,
            },
          }),
        ),
      answerSupervisorQuestion: (requestId, answer) =>
        Effect.sync(() =>
          emit({ type: "supervisor_answered", cellId: `supervisor-${requestId}`, answer }),
        ),
      closeSupervisorQuestion: (requestId, reason) =>
        Effect.sync(() =>
          emit({ type: "supervisor_closed", cellId: `supervisor-${requestId}`, reason }),
        ),
      openAskUser: (cell) => Effect.sync(() => emit({ type: "cell_open", cell })),
      answerAskUser: (requestId, answer) =>
        Effect.sync(() =>
          emit({ type: "ask_user_answered", cellId: `ask-user-${requestId}`, answer }),
        ),
      closeAskUser: (requestId, status, reason) =>
        Effect.sync(() =>
          emit({ type: "ask_user_closed", cellId: `ask-user-${requestId}`, status, reason }),
        ),
      respondToUiRequest: (raw) =>
        Effect.gen(function* () {
          const id = raw.id;
          if (typeof id !== "string" || !pendingUiRequests.has(id)) {
            return yield* Effect.fail(new Error("no open extension UI request with that id"));
          }
          let response: { type: "extension_ui_response"; id: string } & Record<string, unknown>;
          if (raw.cancelled === true) {
            response = { type: "extension_ui_response", id, cancelled: true };
          } else if (typeof raw.confirmed === "boolean") {
            response = { type: "extension_ui_response", id, confirmed: raw.confirmed };
          } else if (typeof raw.value === "string") {
            response = { type: "extension_ui_response", id, value: raw.value };
          } else {
            return yield* Effect.fail(
              new Error("ui response must carry cancelled, confirmed, or a string value"),
            );
          }
          pendingUiRequests.delete(id);
          // Fire-and-forget write (like the legacy PiSession path); a dead pi
          // just swallows it rather than surfacing an error to the caller.
          yield* handle
            .respondToUiRequest(response as Parameters<PiHostHandle["respondToUiRequest"]>[0])
            .pipe(Effect.ignore);
          emit({ type: "question_answered", cellId: `question-${id}` });
        }),

      prompt: (message, images, streamingBehavior) =>
        handle.prompt(message, images, streamingBehavior).pipe(
          // Prompting is activity — bump updatedAt via the meta-change callback.
          Effect.tap(() => Effect.sync(() => onMetaChange(meta))),
          Effect.orDie,
        ),
      steer: (message) => handle.steer(message).pipe(Effect.orDie),
      followUp: (message) => handle.followUp(message).pipe(Effect.orDie),
      compact: handle.compact.pipe(Effect.orDie),
      abort: handle.abort.pipe(Effect.orDie),
      getState: handle.getState.pipe(Effect.orDie),
      getSessionStats: handle.getSessionStats.pipe(Effect.orDie),
      getAvailableModels: handle.getAvailableModels.pipe(Effect.orDie),
      getCommands: handle.getCommands.pipe(Effect.orDie),
      setModel: (provider, modelId) =>
        handle.setModel(provider, modelId).pipe(Effect.asVoid, Effect.orDie),
      setThinkingLevel: (level) => handle.setThinkingLevel(level).pipe(Effect.orDie),
      rename: (title) =>
        Effect.gen(function* () {
          if (yield* handle.isRunning) {
            yield* handle.setSessionName(title).pipe(Effect.ignore);
          }
          meta.title = title;
          onMetaChange(meta);
        }),

      runChildAgent: (task, agentName, toolPolicy, overrides, runOptions) =>
        Effect.gen(function* () {
          // Child execution is owned by the parent session Scope. Parent stop,
          // deletion, and server shutdown therefore interrupt and finalize every
          // child before the parent's teardown completes.
          const fiber = yield* Effect.forkIn(
            runChildAgent({
              piHost,
              helperContext,
              meta,
              params,
              emit,
              task,
              agentName,
              toolPolicy,
              overrides,
              runOptions,
            }),
            sessionScope,
          );
          return yield* Fiber.join(fiber);
        }),

      onExit: (listener) => {
        if (currentExit) {
          listener(currentExit);
          return () => {};
        }
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
    };

    return runtime;
  });

/**
 * Drain a helper/subagent child's event stream to `agent_end` (idle), enforcing
 * the given timeout. An early `ProcessExit` ends the stream too; the caller's
 * follow-up RPC then fails, which the scoped launch treats as an error.
 */
const handleHelperPrompt = (
  handle: PiHostHandle,
  message: string,
  timeoutMs: number,
): Effect.Effect<void, Error | { readonly _tag: string }> =>
  Effect.gen(function* () {
    const idle = handle.events.pipe(
      Stream.takeUntil((item) => isPiEvent(item) && eventType(item.event) === "agent_end"),
      Stream.runDrain,
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () => new Error("helper timeout"),
      }),
    );
    const collector = yield* Effect.fork(idle);
    yield* handle.prompt(message);
    yield* Fiber.join(collector);
  });

/**
 * Run a one-shot pi helper (native commit-message / release-notes / title): an
 * isolated `--no-session --no-tools` launch that answers a single prompt and
 * exits. Fails (as an `Error`) on timeout / early exit, matching the legacy
 * `SessionManager.runHelper` contract. Requires PiHost from the runtime.
 */
export const runOneShotHelper = (opts: RunHelperOptions): Effect.Effect<string, Error, PiHost> =>
  Effect.gen(function* () {
    const piHost = yield* PiHost;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const helper = yield* piHost.spawn({
          binPath: resolvePiBinary().path,
          args: buildLaunchArgs({
            kind: "helper",
            systemPrompt: opts.systemPrompt,
            provider: opts.provider,
            model: opts.model,
            extensions: opts.extensions,
          }),
          cwd: opts.cwd,
          env: opts.env,
          requestTimeoutMs: timeoutMs,
        });
        yield* handleHelperPrompt(helper, opts.userPrompt, timeoutMs);
        const { text } = yield* helper.request({ type: "get_last_assistant_text" });
        return text ?? "";
      }),
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.fail(error instanceof Error ? error : new Error(String(error))),
    ),
  );

export interface ChildLaunchOverrides {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ChildRunOptions {
  /** Supplied only for an already validated same-parent continuation. */
  runId?: string;
  resumeSessionPath?: string;
  artifactRootId?: string;
  artifactRootToken?: string;
  source: SubagentRunSource;
}

export interface ChildRunResult {
  runId: string;
  text: string;
}

/** Failure after a durable generic child identity has been created/reclaimed. */
export class ChildRunError extends Error {
  constructor(
    readonly runId: string,
    cause: Error,
  ) {
    super(cause.message, { cause });
    this.name = "ChildRunError";
  }
}

const persistChildRun = <T>(operation: () => T): Effect.Effect<T, Error> =>
  Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof Error
        ? error
        : new Error(`Subagent run persistence failed: ${String(error)}`),
  });

interface RunChildArgs {
  readonly piHost: Context.Tag.Service<PiHost>;
  readonly helperContext: HelperContext;
  readonly meta: SessionMeta;
  readonly params: SpawnSessionParams;
  readonly emit: (event: DomainEvent) => void;
  readonly task: string;
  readonly agentName?: string;
  readonly toolPolicy?: ChildToolPolicy;
  readonly overrides?: ChildLaunchOverrides;
  readonly runOptions?: ChildRunOptions;
}

/**
 * Native subagent (native-subagent-bridge.md): launch a fresh child pi for one
 * task, stream its transcript into the parent as a "Subagent" card, and return
 * its final assistant text (the tool result the model sees — unchanged by the
 * card). Concurrency-safe under managed_parallel: each child owns a distinct
 * cell id and the bus stamps interleaved deltas in arrival order.
 */
const runChildAgent = (args: RunChildArgs): Effect.Effect<ChildRunResult, Error> => {
  const runId = args.runOptions?.runId ?? randomUUID();
  let durableIdentityCreated = false;
  const {
    piHost,
    helperContext,
    meta,
    params,
    emit,
    task,
    agentName,
    toolPolicy,
    overrides,
    runOptions,
  } = args;
  return Effect.gen(function* () {
    const resolved = agentName ? params.resolveAgent?.(agentName, meta.projectId) : undefined;
    if (agentName && !resolved) {
      return yield* Effect.fail(new Error(`unknown agent: ${agentName}`));
    }
    const persona = resolved ? `\n\n# Agent: ${agentName}\n${resolved.body}` : "";
    const isContinuation = runOptions?.resumeSessionPath !== undefined;
    const boundaryPrompt = isContinuation
      ? SUBAGENT_CONTINUATION_SYSTEM_PROMPT
      : SUBAGENT_SYSTEM_PROMPT;
    const authoredSystemPrompt = `${boundaryPrompt}${persona}\n\nTask:\n${task}`;
    let effectiveSystemPrompt = authoredSystemPrompt;
    const cellId = runId;
    const childSessionId = randomUUID();
    // Loop/constrained executions retain their dedicated snapshot ownership.
    // Generic managed_subagent/managed_parallel runs use this first-class store.
    const durable = toolPolicy === undefined ? params.childRuns : undefined;
    const createdAt = new Date().toISOString();
    let artifactSessionsDirectory: string | undefined;
    if (durable) {
      const baseRecord: SubagentRunRecord = {
        id: runId,
        parentSessionId: meta.id,
        task,
        ...(agentName ? { agent: agentName } : {}),
        status: "starting",
        createdAt,
        updatedAt: createdAt,
        source: runOptions?.source ?? "single",
      };
      const allocation = durable.prepareTurn
        ? yield* persistChildRun(() =>
            durable.prepareTurn!(
              baseRecord,
              authoredSystemPrompt,
              isContinuation
                ? {
                    artifactRootId: runOptions?.artifactRootId,
                    artifactRootToken: runOptions?.artifactRootToken,
                  }
                : undefined,
            ),
          )
        : undefined;
      artifactSessionsDirectory = allocation?.sessionsDirectory;
      effectiveSystemPrompt = allocation?.systemPrompt ?? authoredSystemPrompt;
      yield* persistChildRun(() => {
        const artifactPatch = allocation
          ? {
              artifactRootId: allocation.artifactRootId,
              artifactRootToken: allocation.identityToken,
              currentTurnId: allocation.turnId,
            }
          : {};
        if (isContinuation) {
          durable.update(runId, {
            task,
            ...(agentName ? { agent: agentName } : {}),
            status: "starting",
            updatedAt: createdAt,
            completedAt: undefined,
            summary: undefined,
            error: undefined,
            model: undefined,
            inputTokens: undefined,
            outputTokens: undefined,
            durationMs: undefined,
            ...artifactPatch,
          });
        } else {
          durable.create({ ...baseRecord, ...artifactPatch });
        }
      });
      durableIdentityCreated = true;
    }
    let terminalPersisted = false;
    // Declare volatile stream/metadata state before registering cleanup. Setup or
    // spawn failures can finalize safely, while graceful interruption captures
    // whatever the live child delivered without adding per-delta disk writes.
    const startedAt = Date.now();
    let streamed = "";
    let childModel: string | undefined;
    let childInputTokens = 0;
    let childOutputTokens = 0;
    let sawUsage = false;
    let sawAgentEnd = false;
    let childSessionFile: string | undefined;
    let childSessionOwned = false;
    let cardOpened = false;
    let startupCardFinalized = false;
    const claimOwnedSessionIfAvailable = (): boolean => {
      if (
        childSessionOwned ||
        !durable?.markOwnedSession ||
        !childSessionFile ||
        (isContinuation && !runOptions?.artifactRootId)
      ) {
        return false;
      }
      try {
        durable.markOwnedSession(runId, childSessionFile);
        childSessionOwned = true;
        return true;
      } catch (error) {
        if (
          error instanceof SubagentArtifactCapabilityError &&
          error.code === "SUBAGENT_ARTIFACT_NOT_FOUND"
        ) {
          return false;
        }
        throw error;
      }
    };
    const metadata = (): {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      durationMs: number;
    } => ({
      model: childModel,
      inputTokens: sawUsage ? childInputTokens : undefined,
      outputTokens: sawUsage ? childOutputTokens : undefined,
      durationMs: Date.now() - startedAt,
    });

    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Register durable cleanup before creating any bridge, prompt directory,
        // or child process. Interruption by parent stop becomes a clear terminal
        // record; a persistence failure is logged without blocking child cleanup.
        yield* Effect.addFinalizer((exit) => {
          if (!durable || terminalPersisted) return Effect.void;
          const now = new Date().toISOString();
          const interrupted = Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause);
          const status = interrupted ? "stopped" : "failed";
          const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          const detail =
            failure instanceof Error
              ? failure.message
              : failure !== undefined
                ? String(failure)
                : "Subagent execution ended without a terminal result.";
          const error = interrupted
            ? "Subagent run was stopped before completion."
            : `Subagent failed before completion: ${detail}`;
          // A continuation may fail after its durable record moved to starting
          // but before spawn/get_state allowed the normal cell_open. Replace the
          // existing stable card now so live UI and persistence agree; fresh
          // runs retain their established no-card-on-pre-open-failure behavior.
          if (isContinuation && !cardOpened && !startupCardFinalized) {
            startupCardFinalized = true;
            emit({
              type: "cell_final",
              cell: {
                kind: "subagent",
                id: cellId,
                task,
                status: interrupted ? "stopped" : "error",
                text: streamed,
                error,
                artifactRootId: runId,
                progress: [],
                ...(agentName ? { agentName } : {}),
                ...metadata(),
              },
            });
          }
          return persistChildRun(() => {
            claimOwnedSessionIfAvailable();
            durable.writeOutput?.(runId, streamed, error);
            durable.update(runId, {
              status,
              updatedAt: now,
              completedAt: now,
              ...(streamed ? { summary: streamed } : {}),
              ...metadata(),
              error,
            });
          }).pipe(
            Effect.tap(() => Effect.sync(() => (terminalPersisted = true))),
            Effect.tapError((persistError) =>
              Effect.sync(() =>
                console.warn(
                  `[subagent-runs] failed to persist ${status} run ${runId}`,
                  persistError,
                ),
              ),
            ),
            Effect.orDie,
          );
        });
        // Constrained report-only children never receive a bridge extension:
        // even contact_supervisor mutates parent state and is outside policy.
        const childBridge =
          toolPolicy === undefined
            ? params.childBridgeFactory?.(childSessionId, {
                parentSessionId: meta.id,
                cellId,
              })
            : undefined;
        yield* Effect.addFinalizer(() => Effect.sync(() => childBridge?.dispose()));
        const promptDir = mkdtempSync(join(tmpdir(), "agent-deck-subagent-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              rmSync(promptDir, { recursive: true, force: true });
            } catch {
              // Best-effort.
            }
          }),
        );
        const promptFile = join(promptDir, "system.md");
        writeFileSync(promptFile, effectiveSystemPrompt);

        const childTools = resolveChildTools(resolved?.tools, toolPolicy, Boolean(childBridge));

        const child = yield* piHost.spawn({
          binPath: resolvePiBinary().path,
          args: buildLaunchArgs({
            kind: "agent",
            systemPrompt: { mode: "replace", text: promptFile },
            tools: childTools,
            provider: overrides?.provider ?? helperContext.provider,
            model: overrides?.model ?? resolved?.model ?? helperContext.model,
            thinking: overrides?.thinking ?? resolved?.thinking,
            skills: resolved?.skillDirs,
            ...(runOptions?.resumeSessionPath
              ? { resumeSessionPath: runOptions.resumeSessionPath }
              : artifactSessionsDirectory
                ? { sessionDir: artifactSessionsDirectory }
                : {}),
            extensions: childBridge
              ? [...(helperContext.extensions ?? []), childBridge.extension]
              : helperContext.extensions,
          }),
          cwd: meta.cwd,
          env: helperContext.env,
          requestTimeoutMs: SUBAGENT_TIMEOUT_MS,
        });

        // Capture Pi's own opaque resume handle before the first prompt. A run
        // without this durable handle must fail rather than advertise a stable
        // continuation ID that cannot actually be resumed.
        if (durable) {
          const state = yield* child.getState;
          const sessionFile = (state as { sessionFile?: unknown }).sessionFile;
          if (typeof sessionFile !== "string" || !sessionFile.trim()) {
            return yield* Effect.fail(new Error("subagent get_state returned no session file"));
          }
          if (!isAbsolute(sessionFile)) {
            return yield* Effect.fail(
              new Error("subagent get_state returned a non-absolute session file"),
            );
          }
          childSessionFile = sessionFile;
          // Pi creates a fresh session file lazily when the first assistant
          // message is persisted. Store its canonical path now; continuation
          // re-validates existence/type after the run is terminal.
          // Persist the running transition and resume handle together before
          // the task can be prompted. If this write fails, scoped cleanup reaps
          // the unprompted child and terminally updates the already-created ID.
          yield* persistChildRun(() =>
            durable.update(runId, {
              status: "running",
              sessionFile,
              ...(isContinuation ? {} : { sessionOwnership: undefined }),
              updatedAt: new Date().toISOString(),
            }),
          );
          // Pi may create the file at spawn or lazily on its first persisted
          // event. Claim immediately when possible, then retry on every event
          // and terminal path without buffering deltas.
          yield* persistChildRun(() => claimOwnedSessionIfAvailable());
        }

        // Open (or replace, for continuation) the stable Subagent card in the PARENT transcript.
        emit({
          type: "cell_open",
          cell: {
            kind: "subagent",
            id: cellId,
            task,
            status: "running",
            ...(durable ? { artifactRootId: runId } : {}),
            text: "",
            progress: [],
            ...(agentName ? { agentName } : {}),
          },
        });
        cardOpened = true;

        const processChild = (item: PiStreamItem): void => {
          if (!isPiEvent(item)) return;
          claimOwnedSessionIfAvailable();
          const e = item.event as {
            type?: string;
            message?: {
              role?: string;
              model?: unknown;
              usage?: { input?: number; output?: number };
            };
            assistantMessageEvent?: { type?: string; delta?: string };
          };
          if (
            e.type === "message_update" &&
            e.assistantMessageEvent?.type === "text_delta" &&
            typeof e.assistantMessageEvent.delta === "string"
          ) {
            streamed += e.assistantMessageEvent.delta;
            emit({ type: "subagent_delta", cellId, delta: e.assistantMessageEvent.delta });
          }
          if (e.type === "message_end" && e.message?.role === "assistant") {
            if (typeof e.message.model === "string") childModel = e.message.model;
            if (e.message.usage) {
              if (typeof e.message.usage.input === "number") {
                childInputTokens += e.message.usage.input;
              }
              if (typeof e.message.usage.output === "number") {
                childOutputTokens += e.message.usage.output;
              }
              sawUsage = true;
            }
          }
          if (e.type === "agent_end") sawAgentEnd = true;
        };

        const childOutcome = yield* Effect.gen(function* () {
          const collector = yield* child.events.pipe(
            Stream.takeUntil((item) => isPiEvent(item) && eventType(item.event) === "agent_end"),
            Stream.runForEach((item) => Effect.sync(() => processChild(item))),
            Effect.timeoutFail({
              duration: Duration.millis(SUBAGENT_TIMEOUT_MS),
              onTimeout: () => new Error("subagent timeout"),
            }),
            Effect.fork,
          );
          yield* child.prompt(task);
          yield* Fiber.join(collector);
          if (!sawAgentEnd)
            return yield* Effect.fail(new Error("subagent exited before finishing"));
          const { text } = yield* child.request({ type: "get_last_assistant_text" });
          return text ?? streamed;
        }).pipe(Effect.either);

        const finalMetadata = metadata();
        const completedAt = new Date().toISOString();
        if (childOutcome._tag === "Left") {
          const failure =
            childOutcome.left instanceof Error
              ? childOutcome.left
              : new Error(String(childOutcome.left));
          const persisted = durable
            ? yield* persistChildRun(() => {
                claimOwnedSessionIfAvailable();
                durable.writeOutput?.(runId, streamed, failure.message);
                durable.update(runId, {
                  status: "failed",
                  updatedAt: completedAt,
                  completedAt,
                  summary: streamed,
                  error: failure.message,
                  ...finalMetadata,
                });
              }).pipe(Effect.either)
            : ({ _tag: "Right" } as const);
          if (persisted._tag === "Right") terminalPersisted = true;
          const reportedFailure =
            persisted._tag === "Left"
              ? new Error(
                  `${failure.message} (could not persist failed run: ${persisted.left.message})`,
                )
              : failure;
          emit({
            type: "cell_final",
            cell: {
              kind: "subagent",
              id: cellId,
              task,
              status: "error",
              text: streamed,
              error: reportedFailure.message,
              artifactRootId: runId,
              progress: [],
              ...(agentName ? { agentName } : {}),
              ...finalMetadata,
            },
          });
          return yield* Effect.fail(reportedFailure);
        }

        const result = childOutcome.right;
        const completionWrite = durable
          ? yield* persistChildRun(() => {
              claimOwnedSessionIfAvailable();
              durable.writeOutput?.(runId, result);
              durable.update(runId, {
                status: "completed",
                updatedAt: completedAt,
                completedAt,
                summary: result,
                ...finalMetadata,
              });
            }).pipe(Effect.either)
          : ({ _tag: "Right" } as const);
        if (completionWrite._tag === "Left") {
          const failure = new Error(
            `Subagent completed, but its result could not be persisted: ${completionWrite.left.message}`,
          );
          const failureWrite = durable
            ? yield* persistChildRun(() =>
                durable.update(runId, {
                  status: "failed",
                  updatedAt: completedAt,
                  completedAt,
                  summary: result,
                  error: failure.message,
                  ...finalMetadata,
                }),
              ).pipe(Effect.either)
            : ({ _tag: "Right" } as const);
          // Never let the scope finalizer overwrite a genuinely completed child
          // as "stopped". If both writes failed, startup will honestly correct
          // the last durable active record to interrupted.
          terminalPersisted = true;
          const reportedFailure =
            failureWrite._tag === "Left"
              ? new Error(
                  `${failure.message} Failed-run persistence also failed: ${failureWrite.left.message}`,
                )
              : failure;
          emit({
            type: "cell_final",
            cell: {
              kind: "subagent",
              id: cellId,
              task,
              status: "error",
              text: result,
              error: reportedFailure.message,
              artifactRootId: runId,
              progress: [],
              ...(agentName ? { agentName } : {}),
              ...finalMetadata,
            },
          });
          return yield* Effect.fail(reportedFailure);
        }

        terminalPersisted = true;
        emit({
          type: "cell_final",
          cell: {
            kind: "subagent",
            id: cellId,
            task,
            status: "done",
            text: result,
            artifactRootId: runId,
            progress: [],
            ...(agentName ? { agentName } : {}),
            ...finalMetadata,
          },
        });
        return { runId, text: result };
      }),
    );
  }).pipe(
    // Normalize any defect/typed failure into an Error for the facade's promise.
    // Once persistence accepted the run identity, preserve that stable ID on
    // every failure so the parent-facing tool result can report it as well.
    Effect.catchAll((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      return Effect.fail(
        durableIdentityCreated && !(normalized instanceof ChildRunError)
          ? new ChildRunError(runId, normalized)
          : normalized,
      );
    }),
  );
};

// ---------------------------------------------------------------------------
// 3. Service tag + 4. Live layer
// ---------------------------------------------------------------------------

export interface SessionManagerServiceShape {
  /**
   * Build one live session as a resource of the caller's Scope: pi from PiHost,
   * bus from SessionPushBuses, ingestion wired. Closing the scope kills pi.
   */
  readonly spawn: (
    params: SpawnSessionParams,
  ) => Effect.Effect<ManagedSessionRuntime, never, Scope.Scope>;
}

/**
 * The coordinator service (t3code's Services/ role): depends on the Slice 3+4
 * leaf services and hands out per-session runtimes.
 */
export class SessionManagerService extends Context.Tag(
  "agent-deck/server/services/SessionManagerService",
)<SessionManagerService, SessionManagerServiceShape>() {}

export const SessionManagerServiceLive = Layer.effect(
  SessionManagerService,
  Effect.gen(function* () {
    const piHost = yield* PiHost;
    const buses = yield* SessionPushBuses;
    return {
      spawn: (params) => makeManagedSessionRuntime(piHost, buses, params),
    };
  }),
);
