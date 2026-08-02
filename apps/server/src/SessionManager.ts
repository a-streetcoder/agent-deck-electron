import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import type {
  AskUserAnswer,
  AskUserCell,
  UserCell,
  SessionPlanItem,
  SessionPlanUpdate,
  SubagentCell,
  TranscriptState,
  ChildTranscriptSnapshot,
} from "@agent-deck/domain";
import {
  buildLaunchArgs,
  resolvePiBinary,
  type AgentSessionPlan,
  type LaunchPlan,
  type ModelSelection,
  type PiProcessExit,
} from "@agent-deck/pi-host";
import { Effect, Exit, Scope } from "effect";
import { runPromiseUnwrapped, runSyncUnwrapped } from "./effectRun.ts";
import type { LoopSessionSnapshotStore } from "./loopSessionSnapshots.ts";
import type { ReceiptBus } from "./receipts.ts";
import type { SubagentRunStore } from "./subagentRunStore.ts";
import type { ServerRuntime } from "./runtime.ts";
import type { PiSpawnOptions } from "./services/piHost.ts";
import type { StampedEvent } from "./services/pushBus.ts";
import {
  readCanonicalChildTranscript,
  runOneShotHelper,
  SessionManagerService,
  type ChildBridgeFactory,
  type ChildToolPolicy,
  type ChildLaunchOverrides,
  type ChildRunOptions,
  type ChildRunResult,
  type ManagedSessionRuntime,
  type RunHelperOptions,
  type SpawnSessionParams,
} from "./services/sessionManager.ts";

export type { AgentSessionPlan, LaunchPlan };
export type {
  ChildBridgeFactory,
  ChildToolPolicy,
  AgentResolver,
} from "./services/sessionManager.ts";

/**
 * SessionManager — the synchronous class facade over the Slice 5 Effect service
 * (services/sessionManager.ts). It keeps the exact external API the routes,
 * wsHandler and bridge tools depend on, while every session's real lifecycle
 * (pi subprocess, push bus, ingestion fiber) now runs through the server's
 * ManagedRuntime and its PiHost + SessionPushBuses services — this is the slice
 * where the runtime stops being transitional debt and carries production
 * traffic. Callsites become Effect-native at Slice 7 (the transport swap); this
 * facade is the seam that lets them not churn before then. Same pattern
 * `pushBus.ts` used for the bus in Slice 3.
 */

export class SubagentTranscriptEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentTranscriptEvidenceError";
  }
}

export class SessionCreationError extends Error {
  constructor(
    readonly sessionId: string,
    cause: unknown,
    /** Settles only after any spawned Pi scope has closed and exit handling ran. */
    readonly cleanup: Promise<void> = Promise.resolve(),
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SessionCreationError";
  }
}

export interface CreateSessionOptions {
  cwd: string;
  plan: LaunchPlan;
  projectId?: string;
  agentName?: string;
  /** Extra env for the pi subprocess (merged over process.env). */
  env?: Record<string, string | undefined>;
  /** Set when this session runs in an isolated git worktree (cwd IS the worktree)
   *  so the fields persist WITH the initial meta — no orphan window. */
  worktree?: { path: string; branch: string; sourceBranch: string; identityToken?: string };
  /** Server-owned marker for retained Loop review semantics. */
  loopReviewRunId?: string;
  /** Route transaction seam: delay persistence/broadcast/receipt until the
   * caller has completed immediate setup and explicitly commits creation. */
  deferAnnouncement?: boolean;
}

/** A synchronous view of one session's push bus, for the (still class-based)
 * wsHandler: subscribe/replay dispatch synchronously, exactly like the legacy
 * SessionPushBus (see services/pushBus.ts's sync-dispatch note). */
export interface SessionBusView {
  subscribe(subscriber: (stamped: StampedEvent) => void): () => void;
  replayFrom(lastSeq: number): StampedEvent[] | null;
  readonly lastSeq: number;
}

/**
 * One live chat session — the class facade over a {@link ManagedSessionRuntime}.
 * Synchronous operations (bus subscribe, plan edits, snapshot) run the runtime's
 * effects via `runSync`; async pi operations run them on the ManagedRuntime.
 */
export class ManagedSession {
  private ingestionStarted = false;
  private readonly busView: SessionBusView;

  constructor(
    private readonly rt: ManagedSessionRuntime,
    private readonly runtime: ServerRuntime,
    /** The session's own Scope: closing it kills pi and settles everything. */
    private readonly scope: Scope.CloseableScope,
    private readonly enableMetaPublication: () => void = () => {},
  ) {
    const handle = rt.bus;
    this.busView = {
      subscribe: (subscriber) => {
        const unsubscribe = Effect.runSync(handle.subscribe(subscriber));
        return () => Effect.runSync(unsubscribe);
      },
      replayFrom: (lastSeq) => Effect.runSync(handle.replayFrom(lastSeq)),
      get lastSeq() {
        return Effect.runSync(handle.lastSeq);
      },
    };
  }

  get meta(): SessionMeta {
    return this.rt.meta;
  }

  get bus(): SessionBusView {
    return this.busView;
  }

  /** Fork the ingestion fiber (idempotent). Create forks immediately; resume/fork
   * fork it only AFTER seeding history, so buffered live events apply after. */
  startIngestion(): void {
    if (this.ingestionStarted) return;
    this.ingestionStarted = true;
    this.runtime.runFork(this.rt.ingest);
  }

  appendSubagentProgress(cellId: string, message: string): void {
    runSyncUnwrapped(this.rt.appendSubagentProgress(cellId, message));
  }

  openSupervisorQuestion(req: {
    requestId: string;
    subagentCellId: string;
    method: "need_decision" | "interview_request";
    title: string;
    message?: string;
    options?: string[];
  }): void {
    runSyncUnwrapped(this.rt.openSupervisorQuestion(req));
  }

  answerSupervisorQuestion(requestId: string, answer: string): void {
    runSyncUnwrapped(this.rt.answerSupervisorQuestion(requestId, answer));
  }

  closeSupervisorQuestion(requestId: string, reason: string): void {
    runSyncUnwrapped(this.rt.closeSupervisorQuestion(requestId, reason));
  }

  openAskUser(cell: AskUserCell): void {
    runSyncUnwrapped(this.rt.openAskUser(cell));
  }

  answerAskUser(requestId: string, answer: AskUserAnswer): void {
    runSyncUnwrapped(this.rt.answerAskUser(requestId, answer));
  }

  closeAskUser(requestId: string, status: "cancelled" | "timed_out", reason: string): void {
    runSyncUnwrapped(this.rt.closeAskUser(requestId, status, reason));
  }

  setPlan(items: SessionPlanItem[]): void {
    runSyncUnwrapped(this.rt.setPlan(items));
  }

  updatePlan(updates: SessionPlanUpdate[]): void {
    runSyncUnwrapped(this.rt.updatePlan(updates));
  }

  restorePlan(items: SessionPlanItem[]): void {
    runSyncUnwrapped(this.rt.restorePlan(items));
  }

  get plan(): SessionPlanItem[] {
    return Effect.runSync(this.rt.plan);
  }

  async runChildAgent(
    task: string,
    agentName?: string,
    toolPolicy?: ChildToolPolicy,
    overrides?: ChildLaunchOverrides,
    runOptions?: ChildRunOptions,
  ): Promise<ChildRunResult> {
    return await runPromiseUnwrapped(
      this.runtime,
      this.rt.runChildAgent(task, agentName, toolPolicy, overrides, runOptions),
    );
  }

  async seedFromHistory(): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.seedFromHistory);
  }

  seedSyntheticCells(cells: readonly SubagentCell[]): void {
    runSyncUnwrapped(this.rt.seedSyntheticCells(cells));
  }

  snapshot(): { seq: number; state: TranscriptState } {
    return Effect.runSync(this.rt.snapshot);
  }

  get isRunning(): boolean {
    return Effect.runSync(this.rt.isRunning);
  }

  async prompt(
    message: string,
    images?: Parameters<ManagedSessionRuntime["prompt"]>[1],
    streamingBehavior?: Parameters<ManagedSessionRuntime["prompt"]>[2],
  ): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.prompt(message, images, streamingBehavior));
  }

  async steer(message: string): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.steer(message));
  }

  async followUp(message: string): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.followUp(message));
  }

  async compact(): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.compact);
  }

  async abort(): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.abort);
  }

  respondToUiRequest(raw: Record<string, unknown>): void {
    runSyncUnwrapped(this.rt.respondToUiRequest(raw));
  }

  async getCommands(): Promise<Effect.Effect.Success<ManagedSessionRuntime["getCommands"]>> {
    return await runPromiseUnwrapped(this.runtime, this.rt.getCommands);
  }

  async getState(): Promise<Effect.Effect.Success<ManagedSessionRuntime["getState"]>> {
    return await runPromiseUnwrapped(this.runtime, this.rt.getState);
  }

  async getForkMessages(): Promise<
    Effect.Effect.Success<ManagedSessionRuntime["getForkMessages"]>
  > {
    return await runPromiseUnwrapped(this.runtime, this.rt.getForkMessages);
  }

  async getEntries(): Promise<Effect.Effect.Success<ManagedSessionRuntime["getEntries"]>> {
    return await runPromiseUnwrapped(this.runtime, this.rt.getEntries);
  }

  async forkAtEntry(
    entryId: string,
  ): Promise<Effect.Effect.Success<ReturnType<ManagedSessionRuntime["fork"]>>> {
    return await runPromiseUnwrapped(this.runtime, this.rt.fork(entryId));
  }

  async getSessionStats(): Promise<
    Effect.Effect.Success<ManagedSessionRuntime["getSessionStats"]>
  > {
    return await runPromiseUnwrapped(this.runtime, this.rt.getSessionStats);
  }

  async getAvailableModels(): Promise<
    Effect.Effect.Success<ManagedSessionRuntime["getAvailableModels"]>
  > {
    return await runPromiseUnwrapped(this.runtime, this.rt.getAvailableModels);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.setModel(provider, modelId));
  }

  async setThinkingLevel(
    level: Parameters<ManagedSessionRuntime["setThinkingLevel"]>[0],
  ): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.setThinkingLevel(level));
  }

  onExit(listener: (exit: PiProcessExit) => void): () => void {
    return this.rt.onExit(listener);
  }

  async rename(title: string): Promise<void> {
    await runPromiseUnwrapped(this.runtime, this.rt.rename(title));
  }

  get piSessionFile(): string | undefined {
    return this.rt.meta.piSessionFile;
  }

  /** Stop the session: close its Scope (kills pi, runs finalizers), then run the
   * exit handling now so endedAt/exit listeners fire before the caller proceeds
   * (matching the legacy synchronous pi-exit handler ordering). */
  publishMetaChanges(): void {
    this.enableMetaPublication();
  }

  async stop(): Promise<void> {
    await this.runtime.runPromise(Scope.close(this.scope, Exit.void));
    Effect.runSync(this.rt.ensureExitHandled);
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  /** In-flight resumes by session id — double-resume returns the same promise. */
  private readonly resuming = new Map<string, Promise<ManagedSession>>();
  /** Same-run continuation claims. JS's synchronous Set mutation is the lock. */
  private readonly claimedSubagentContinuations = new Set<string>();

  constructor(
    /** The server's ManagedRuntime (runtime.ts): every session resolves its pi
     * subprocess + push bus through this. */
    private readonly runtime: ServerRuntime,
    private readonly receipts: ReceiptBus,
    private readonly onMetaChange: (meta: SessionMeta) => void = () => {},
    /** Provider-registration extensions — the ONLY ones helper launches load. */
    private readonly helperExtensions: () => string[] | undefined = () => undefined,
    /**
     * Generates a per-session bridge extension exposing app-managed tools (see
     * apps/server/src/bridge.ts), or undefined when none are registered. Applied
     * to real chat launches (create/resume/fork) but never to isolated helper
     * launches, which stay resource-free per the launch-flag contract.
     */
    private readonly bridgeExtensionFactory: (meta: SessionMeta) => string | undefined = () =>
      undefined,
    /**
     * Extra --append-system-prompt values for a parent session, in order — the
     * preserved APPEND_SYSTEM.md path followed by the memory block. Applied to
     * parent launches only (create/resume/fork); returning empty leaves pi to
     * auto-discover APPEND_SYSTEM.md itself. `home` is the HOME the pi child will
     * actually see (env override, else the process home), so the GLOBAL
     * APPEND_SYSTEM.md resolves against the right directory. `cleanupDir` is a
     * temp dir the factory created (the memory block is passed as a file, not a
     * multi-line literal — that is truncated by cmd.exe on Windows) to remove on
     * exit. See agent-deck-system-prompt-logic.md.
     */
    private readonly parentAppendFactory: (
      cwd: string,
      home: string,
    ) => { appends: string[]; cleanupDir?: string } = () => ({ appends: [] }),
    /**
     * Builds a child subagent's contact_supervisor bridge (server-provided).
     * Threaded to each session so runChildAgent can give its children a
     * supervisor channel routed back to the right transcript cell.
     */
    private readonly childBridgeFactory?: ChildBridgeFactory,
    /** Resolves a named agent for `managed_subagent{agent}` delegation. */
    private readonly resolveAgent?: SpawnSessionParams["resolveAgent"],
    /** Live-read autoTitle preference (native autoTitle). */
    private readonly autoTitle: () => boolean = () => true,
    /**
     * Turn-boundary hook (Slice 9): called after each turn reaches idle, with
     * the session's live meta. server.ts wires the diff engine's changed-file
     * refresh (+ push/receipt) here. Best-effort — failures are swallowed.
     */
    private readonly onTurnIdle?: (meta: SessionMeta) => Promise<void>,
    /**
     * Checkpoint-capture hook (Slice 18a): called at each turn boundary AFTER
     * the session-file handle is flushed, with the session's live meta and the
     * turn's first user message (the checkpoint label). server.ts wires the
     * checkpoint service's per-turn capture here. Best-effort — failures are
     * swallowed and never surface (capture is inert until S18b restores).
     */
    private readonly onCheckpointCapture?: (meta: SessionMeta, label: string) => Promise<void>,
    private readonly loopSnapshots?: LoopSessionSnapshotStore,
    private readonly subagentRuns?: SubagentRunStore,
    private readonly decorateUserCell?: (
      sessionId: string,
      cell: UserCell,
      rawMessage: unknown,
    ) => UserCell,
    private readonly forkSessionImages?: (
      sourceSessionId: string,
      targetSessionId: string,
    ) => () => void,
    private readonly reconcileSessionImages?: (
      sessionId: string,
      users: readonly { entryId: string; cellId: string; text: string; rawMessage: unknown }[],
    ) => void,
    private readonly expirePendingSessionImages?: (sessionId: string) => void,
  ) {}

  create(options: CreateSessionOptions): ManagedSession {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: randomUUID(),
      cwd: options.cwd,
      createdAt: now,
      updatedAt: now,
      projectId: options.projectId,
      agentName: options.agentName,
      launchPlan: options.plan,
      ...(options.worktree
        ? {
            worktreePath: options.worktree.path,
            ...(options.worktree.identityToken
              ? { worktreeIdentity: options.worktree.identityToken }
              : {}),
            worktreeBranch: options.worktree.branch,
            worktreeSourceBranch: options.worktree.sourceBranch,
          }
        : {}),
      ...(options.loopReviewRunId ? { loopReviewRunId: options.loopReviewRunId } : {}),
    };
    try {
      const session = this.launch(meta, options.plan, options.env, options.deferAnnouncement);
      try {
        session.startIngestion();
        return session;
      } catch (error) {
        // startIngestion is normally non-throwing, but an injected/runtime defect
        // after registration must still expose an awaitable, exactly-once close.
        throw new SessionCreationError(
          meta.id,
          error,
          this.destroy(meta.id).catch(() => {}),
        );
      }
    } catch (error) {
      // launch() supplies its own cleanup when a Scope already exists. Failures
      // before then still carry the identity needed to remove the bridge token.
      if (error instanceof SessionCreationError) throw error;
      throw new SessionCreationError(meta.id, error);
    }
  }

  /**
   * Relaunch a persisted session against its pi session file, with the SAME
   * launch shape it was created with, rebuilding the transcript from pi's
   * canonical history before any live events. Concurrent resumes of the same
   * id share one relaunch.
   */
  async resume(
    meta: SessionMeta,
    fallbackPlan: LaunchPlan,
    env?: Record<string, string | undefined>,
  ): Promise<ManagedSession> {
    const inFlight = this.resuming.get(meta.id);
    if (inFlight) return await inFlight;
    // Already live and running → hand it back. launch() would otherwise
    // overwrite the map entry and orphan the old session's still-running pi
    // (the routes guard this too, but the manager must not rely on callers).
    const live = this.sessions.get(meta.id);
    if (live?.isRunning) return live;

    const original = (meta.launchPlan as LaunchPlan | undefined) ?? fallbackPlan;
    let plan: LaunchPlan;
    if (original.kind === "agent") {
      plan = { ...original, sessionDir: undefined, resumeSessionPath: meta.piSessionFile };
    } else if (original.kind === "parent") {
      plan = { ...original, resumeSessionPath: meta.piSessionFile };
    } else {
      plan = original;
    }

    const task = (async () => {
      // Naturally-ended sessions remain addressable in the map for snapshot/
      // exit semantics. Close and remove that settled owner before relaunch;
      // destroy keeps it registered if scope close itself fails.
      if (live) await this.destroy(meta.id);
      const revived: SessionMeta = {
        ...meta,
        endedAt: undefined,
        ...(meta.streamGeneration ? { streamGeneration: randomUUID() } : {}),
      };
      const session = this.launch(revived, plan, env);
      try {
        await session.seedFromHistory();
        session.seedSyntheticCells([
          ...(this.loopSnapshots?.get(revived.id) ?? []),
          ...(this.subagentRuns?.cells(revived.id) ?? []),
        ]);
        // The activity plan is app state (not in pi's session file), so restore
        // it from the persisted meta after the pi history is rebuilt.
        //
        // Ordering note: plan_set is emitted here BEFORE startIngestion drains
        // the pi events buffered since spawn — the reverse of the pre-Effect
        // order (buffered-live then plan). This is safe because the plan is
        // mutated ONLY via the set_session_plan/update_session_plan BRIDGE tools
        // (a separate HTTP round-trip, see services/sessionManager setPlan/
        // updatePlan), never from pi's stdout stream — so no buffered pi event
        // can carry a plan mutation that would race the restore. (And on resume
        // pi stays idle until the first prompt, so the buffer is near-empty.)
        // Final plan state is identical to legacy; only intermediate seq
        // numbering differs, which a snapshotting client never observes.
        if (revived.plan && revived.plan.length > 0) session.restorePlan(revived.plan);
        // Now that history is seeded, start draining live events (buffered since
        // spawn) so they apply strictly after the seed.
        session.startIngestion();
      } catch (error) {
        // launch() already spawned pi and registered the session, but seeding
        // failed (pi died / getMessages timed out) BEFORE ingestion was forked,
        // so its exit handling would never run. Tear the half-built session down
        // — destroy() closes its Scope (killing pi) and runs exit handling
        // (endedAt, temp-dir cleanup) — instead of leaking a dead session with
        // an orphaned pi and an unconsumed stdout queue.
        await this.destroy(revived.id).catch(() => {});
        throw error;
      }
      this.onMetaChange(revived);
      return session;
    })();
    this.resuming.set(meta.id, task);
    try {
      return await task;
    } finally {
      this.resuming.delete(meta.id);
    }
  }

  /**
   * Build one session synchronously through the ManagedRuntime: create its
   * Scope, spawn pi + bus + wire ingestion via the SessionManagerService (all
   * non-suspending, so `runSync` returns immediately). Ingestion forking is the
   * caller's (create forks now; resume/fork fork after seeding).
   */
  private launch(
    meta: SessionMeta,
    plan: LaunchPlan,
    env?: Record<string, string | undefined>,
    deferAnnouncement = false,
  ): ManagedSession {
    if (this.sessions.has(meta.id)) {
      throw new Error(`session already has an authoritative runtime owner: ${meta.id}`);
    }
    const tempDirs: string[] = [];
    // A throw before the session owns tempDirs would leak them; clean up on any
    // pre-ownership failure.
    let owned = false;
    try {
      let publicationEnabled = !deferAnnouncement;
      const publishMeta = (changed: SessionMeta): void => {
        if (publicationEnabled) this.onMetaChange(changed);
      };
      const params = this.buildSpawnParams(meta, plan, env, tempDirs, publishMeta);
      const scope = this.runtime.runSync(Scope.make());
      let rt: ManagedSessionRuntime;
      try {
        rt = this.runtime.runSync(
          SessionManagerService.pipe(
            Effect.flatMap((service) => service.spawn(params)),
            Effect.provideService(Scope.Scope, scope),
          ),
        );
      } catch (error) {
        // Spawn failed after the Scope existed. Start closing immediately, but
        // return its completion to the route so Windows cwd handles are released
        // before worktree removal begins.
        const cleanup = this.runtime.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
        throw new SessionCreationError(meta.id, error, cleanup);
      }
      // The session now owns tempDirs cleanup (via its exit handling).
      owned = true;
      try {
        const session = new ManagedSession(rt, this.runtime, scope, () => {
          publicationEnabled = true;
        });
        this.sessions.set(meta.id, session);
        if (!deferAnnouncement) {
          // Preserve the established non-deferred ordering used by Loop/direct
          // callers. The deferred HTTP transaction commits in announceCreated().
          this.receipts.emit("session_created", meta.id);
          this.onMetaChange(meta);
        }
        return session;
      } catch (error) {
        // A throw AFTER a successful spawn (ManagedSession ctor, receipts, the
        // injected onMetaChange) must not orphan the live pi: drop any
        // half-registered entry and fork scope-close (kills pi, awaits exit)
        // followed by the one-shot exit handling (endedAt, temp dirs,
        // listeners) — ingestion was never forked on this path, so nothing
        // else would ever run it.
        this.sessions.delete(meta.id);
        const cleanup = this.runtime
          .runPromise(Scope.close(scope, Exit.void).pipe(Effect.andThen(rt.ensureExitHandled)))
          .catch(() => {});
        throw new SessionCreationError(meta.id, error, cleanup);
      }
    } catch (error) {
      if (!owned) {
        for (const dir of tempDirs) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Best-effort.
          }
        }
      }
      throw error;
    }
  }

  /** Assemble the pi spawn options + session-build params, applying the bridge
   * extension, parent system-prompt appends, and the agent-prompt temp file —
   * the launch-plan shaping that used to live in `launchWithTemp`. */
  private buildSpawnParams(
    meta: SessionMeta,
    plan: LaunchPlan,
    env: Record<string, string | undefined> | undefined,
    tempDirs: string[],
    onMetaChange: (meta: SessionMeta) => void = this.onMetaChange,
  ): SpawnSessionParams {
    const bridgeExtension = this.bridgeExtensionFactory(meta);
    let launchPlan: LaunchPlan = bridgeExtension
      ? { ...plan, extensions: [...(plan.extensions ?? []), bridgeExtension] }
      : plan;
    if (bridgeExtension) tempDirs.push(dirname(bridgeExtension));
    // Parent sessions get Agent Deck's system-prompt appends (preserved
    // APPEND_SYSTEM.md path, then the memory block). Any explicit append
    // suppresses pi's auto-discovery, so the factory re-adds APPEND_SYSTEM.md
    // ahead of our own; empty leaves pi to discover it.
    if (launchPlan.kind === "parent") {
      const launchHome = env?.HOME ?? env?.USERPROFILE ?? homedir();
      const { appends, cleanupDir } = this.parentAppendFactory(meta.cwd, launchHome);
      if (appends.length > 0) {
        launchPlan = {
          ...launchPlan,
          appendSystemPrompts: [...appends, ...(launchPlan.appendSystemPrompts ?? [])],
        };
      }
      if (cleanupDir) tempDirs.push(cleanupDir);
    }
    // A MULTI-LINE agent body literal is truncated on Windows (pi runs via a
    // pi.cmd shim through cmd.exe, cutting an argument at the first newline) — pi
    // reads a value that is an existing file path as a file, so route a
    // multi-line agent body through a temp file (single-line bodies stay
    // literal). The temp dir is cleaned up with the others on exit.
    if (launchPlan.kind === "agent" && launchPlan.systemPrompt.text.includes("\n")) {
      const dir = mkdtempSync(join(tmpdir(), "agent-deck-agent-prompt-"));
      tempDirs.push(dir);
      const file = join(dir, "system.md");
      writeFileSync(file, launchPlan.systemPrompt.text);
      launchPlan = {
        ...launchPlan,
        systemPrompt: { ...launchPlan.systemPrompt, text: file },
      };
    }
    const spawn: PiSpawnOptions = {
      binPath: resolvePiBinary().path,
      args: buildLaunchArgs(launchPlan),
      cwd: meta.cwd,
      env,
    };
    return {
      meta,
      spawn,
      receipts: this.receipts,
      onMetaChange,
      helperContext: {
        provider: plan.provider,
        model: plan.model,
        // Helpers stay resource-free (launch contract §3) except for
        // provider-registration extensions, which custom providers require.
        extensions: this.helperExtensions(),
        env,
      } satisfies ModelSelection & {
        extensions?: string[];
        env?: Record<string, string | undefined>;
      },
      tempDirs,
      childBridgeFactory: this.childBridgeFactory,
      resolveAgent: this.resolveAgent,
      ...(this.subagentRuns
        ? {
            childRuns: {
              create: (record) => this.subagentRuns!.create(record),
              update: (id, patch) => this.subagentRuns!.update(id, patch),
              prepareWorktree: (id, parentCwd) => this.subagentRuns!.prepareWorktree(id, parentCwd),
              validateWorktreeForSpawn: (id) => this.subagentRuns!.validateWorktreeForSpawn(id),
              prepareTurn: (record, systemPrompt, continuation) =>
                this.subagentRuns!.prepareTurn(record, systemPrompt, continuation),
              writeOutput: (id, output, error) => this.subagentRuns!.writeOutput(id, output, error),
              markOwnedSession: (id, sessionFile) =>
                this.subagentRuns!.markOwnedSession(id, sessionFile),
              registerTranscript: (id) => this.subagentRuns!.registerLiveTranscript(id),
              updateTranscript: (id, transcript) =>
                this.subagentRuns!.updateLiveTranscript(id, transcript),
              unregisterTranscript: (id) => this.subagentRuns!.unregisterLiveTranscript(id),
            },
          }
        : {}),
      autoTitle: this.autoTitle,
      ...(this.decorateUserCell
        ? {
            decorateUserCell: (cell: UserCell, rawMessage: unknown) =>
              this.decorateUserCell!(meta.id, cell, rawMessage),
          }
        : {}),
      ...(this.reconcileSessionImages
        ? {
            reconcileImages: (
              users: readonly {
                entryId: string;
                cellId: string;
                text: string;
                rawMessage: unknown;
              }[],
            ) => this.reconcileSessionImages!(meta.id, users),
          }
        : {}),
      ...(this.expirePendingSessionImages
        ? { expirePendingImages: () => this.expirePendingSessionImages!(meta.id) }
        : {}),
      // The turn-boundary hook as a never-failing Effect (it is forked
      // fire-and-forget into the session Scope at each idle).
      ...(this.onTurnIdle !== undefined
        ? {
            onIdle: Effect.promise(async () => {
              try {
                await this.onTurnIdle?.(meta);
              } catch {
                // Best-effort: a diff-refresh failure must never surface.
              }
            }),
          }
        : {}),
      // Slice 18a checkpoint capture as a never-failing per-label Effect (forked
      // fire-and-forget after the session-file flush at each idle).
      ...(this.onCheckpointCapture !== undefined
        ? {
            captureCheckpoint: (label: string) =>
              Effect.promise(async () => {
                try {
                  await this.onCheckpointCapture?.(meta, label);
                } catch {
                  // Best-effort: a capture failure must never surface.
                }
              }),
          }
        : {}),
    };
  }

  /** Persist bounded synthetic Loop cards after every ordered transcript event. */
  trackLoopSession(sessionId: string): () => void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.loopSnapshots) return () => {};
    let timer: NodeJS.Timeout | undefined;
    const persist = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      const cells = session
        .snapshot()
        .state.cells.filter((cell): cell is SubagentCell => cell.kind === "subagent");
      this.loopSnapshots!.save(sessionId, cells);
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 250);
      timer.unref();
    };
    persist();
    const unsubscribe = session.bus.subscribe(schedule);
    return () => {
      unsubscribe();
      persist();
    };
  }

  saveLoopSessionSnapshot(sessionId: string, cells: readonly SubagentCell[]): void {
    this.loopSnapshots?.save(sessionId, cells);
  }

  removeLoopSessionSnapshot(sessionId: string): void {
    this.loopSnapshots?.remove(sessionId);
  }

  /** Remove only runs owned by a deleted parent, after destroy() settled children. */
  async removeSubagentRuns(sessionId: string): Promise<void> {
    await this.subagentRuns?.removeParent(sessionId);
  }

  async subagentTranscript(
    parentSessionId: string,
    runId: string,
    parentCwd: string,
  ): Promise<ChildTranscriptSnapshot | undefined> {
    const store = this.subagentRuns;
    const run = store?.get(runId);
    if (!store || !run || run.parentSessionId !== parentSessionId) return undefined;
    const live = store.liveTranscript(parentSessionId, runId);
    if (live) return live;
    const legacyOrExternal = !run.artifactRootId || run.sessionOwnership === "external";
    if (legacyOrExternal) return store.summaryTranscript(run);
    if (!run.sessionFile || run.sessionOwnership !== "owned") {
      throw new SubagentTranscriptEvidenceError("Subagent owned session proof is unavailable");
    }

    // Fail closed at the last possible moment before handing the opaque handle
    // to Pi. Validation failures are not converted to summary evidence.
    const sessionFile = store.validateOwnedSession(run.id, run.sessionFile);
    const transcript = await this.runtime.runPromise(
      readCanonicalChildTranscript(sessionFile, parentCwd),
    );

    // Reconstruction is asynchronous. Parent deletion or continuation may win
    // while Pi is reading, so prove the same parent and capability again before
    // any reconstructed cells cross the HTTP boundary.
    const current = store.get(runId);
    if (!current || current.parentSessionId !== parentSessionId) return undefined;
    if (
      current.sessionFile !== run.sessionFile ||
      current.sessionOwnership !== "owned" ||
      current.artifactRootId !== run.artifactRootId ||
      current.artifactRootToken !== run.artifactRootToken
    ) {
      throw new SubagentTranscriptEvidenceError("Subagent session evidence changed while reading");
    }
    store.validateOwnedSession(current.id, current.sessionFile);
    return store.snapshot(current, "canonical", transcript);
  }

  /** Revalidate an app-owned root immediately before Electron reveals it. */
  subagentArtifactDirectoryForReveal(runId: string): string | undefined {
    return this.subagentRuns?.artifactDirectoryForReveal(runId);
  }

  /** Commit a successfully prepared session to persistence/broadcast, then
   * expose the test milestone. The route uses this after worktree + spawn setup;
   * other creation paths retain their immediate announcement behavior. */
  announceCreated(session: ManagedSession): void {
    session.publishMetaChanges();
    this.onMetaChange(session.meta);
    this.receipts.emit("session_created", session.meta.id);
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Run a native subagent for a parent session: launch a child pi with the task
   * (inheriting the parent's provider/model/env) and return its final text.
   * Throws if the parent session is unknown.
   */
  async runSubagent(
    parentSessionId: string,
    task: string,
    agentName?: string,
    toolPolicy?: ChildToolPolicy,
    overrides?: ChildLaunchOverrides,
    source: "single" | "parallel" = "single",
    worktree = false,
  ): Promise<string> {
    const parent = this.sessions.get(parentSessionId);
    if (!parent) throw new Error(`unknown parent session: ${parentSessionId}`);
    return (
      await parent.runChildAgent(task, agentName, toolPolicy, overrides, {
        source,
        ...(worktree ? { worktree: true } : {}),
      })
    ).text;
  }

  /** Generic managed_subagent entrypoint. Continuations are validated and
   * claimed entirely before runChildAgent can spawn or prompt a second Pi. */
  async runManagedSubagent(
    parentSessionId: string,
    task: string,
    agentName?: string,
    continueSubagentId?: string,
  ): Promise<ChildRunResult> {
    const parent = this.sessions.get(parentSessionId);
    if (!parent) throw new Error(`unknown parent session: ${parentSessionId}`);
    if (!this.subagentRuns) throw new Error("subagent run persistence is unavailable");

    if (!continueSubagentId) {
      return await parent.runChildAgent(task, agentName, undefined, undefined, {
        source: "single",
      });
    }

    const run = this.subagentRuns.get(continueSubagentId);
    if (!run) throw new Error(`unknown Deck subagent ID: ${continueSubagentId}`);
    if (run.parentSessionId !== parentSessionId) {
      throw new Error("Deck subagent continuation belongs to a different parent session");
    }
    if (run.source !== "single") {
      throw new Error("only single managed_subagent runs can be continued");
    }
    if (this.claimedSubagentContinuations.has(continueSubagentId)) {
      throw new Error(`Deck subagent ${continueSubagentId} is already being continued`);
    }
    if (run.status === "starting" || run.status === "running") {
      throw new Error(`Deck subagent ${continueSubagentId} is still active`);
    }
    if (!run.sessionFile) {
      throw new Error("Deck subagent has no durable Pi session file and cannot be continued");
    }
    if (!isAbsolute(run.sessionFile)) {
      throw new Error("Deck subagent Pi session path is not absolute");
    }
    if (run.sessionOwnership === "owned") {
      try {
        this.subagentRuns.validateOwnedSession(run.id, run.sessionFile);
      } catch {
        throw new Error("Deck subagent owned Pi session could not be revalidated");
      }
    } else {
      // Legacy Pi handles remain explicitly external: continuable, but never
      // adopted into Agent Deck's deletion boundary.
      let stat;
      try {
        stat = lstatSync(run.sessionFile);
      } catch {
        throw new Error("Deck subagent Pi session file is missing or inaccessible");
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("Deck subagent Pi session path is not a regular file");
      }
    }
    this.claimedSubagentContinuations.add(continueSubagentId);
    try {
      // Native continuation permits an explicit agent change. When omitted,
      // preserve the durable run's original named persona/capabilities rather
      // than accidentally resuming its history as an anonymous child.
      const effectiveAgentName = agentName ?? run.agent;
      return await parent.runChildAgent(task, effectiveAgentName, undefined, undefined, {
        source: "single",
        runId: continueSubagentId,
        resumeSessionPath: run.sessionFile,
        artifactRootId: run.artifactRootId,
        artifactRootToken: run.artifactRootToken,
      });
    } finally {
      this.claimedSubagentContinuations.delete(continueSubagentId);
    }
  }

  /**
   * Run a one-shot pi helper (native commit-message / title generation): an
   * isolated `--no-session --no-tools` launch that answers a single prompt and
   * exits. Returns the final assistant text; throws on timeout / early exit.
   */
  async runHelper(opts: RunHelperOptions): Promise<string> {
    return await runPromiseUnwrapped(this.runtime, runOneShotHelper(opts));
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((session) => session.meta);
  }

  /** Stop and drop a live session from the manager (index removal is caller's).
   * Map ownership remains authoritative until stop settles. A failed stop keeps
   * the owner registered so no second process can launch under the same id. */
  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.stop();
    if (this.sessions.get(id) === session) this.sessions.delete(id);
  }

  /**
   * Fork/duplicate: copy the source session's canonical pi file and launch a
   * fresh, independent session resumed from the copy. The original is never
   * touched. Requires the source to have a captured pi session file (i.e. at
   * least one turn has happened).
   */
  async fork(
    source: SessionMeta,
    sessionFilePath: string,
    copyTo: string,
    env?: Record<string, string | undefined>,
  ): Promise<ManagedSession> {
    copyFileSync(sessionFilePath, copyTo);
    const meta: SessionMeta = {
      id: randomUUID(),
      cwd: source.cwd,
      createdAt: new Date().toISOString(),
      projectId: source.projectId,
      agentName: source.agentName,
      launchPlan: source.launchPlan,
      piSessionFile: copyTo,
      title: source.title ? `${source.title} (fork)` : undefined,
      plan: source.plan,
      ...(source.worktreeOwnerSessionId
        ? { worktreeOwnerSessionId: source.worktreeOwnerSessionId }
        : source.worktreePath
          ? { worktreeOwnerSessionId: source.id }
          : {}),
    };
    const original = (source.launchPlan as LaunchPlan | undefined) ?? { kind: "parent" };
    let plan: LaunchPlan;
    if (original.kind === "agent") {
      plan = { ...original, sessionDir: undefined, resumeSessionPath: copyTo };
    } else if (original.kind === "parent") {
      plan = { ...original, resumeSessionPath: copyTo };
    } else {
      plan = original;
    }
    let session: ManagedSession | undefined;
    let rollbackImages: (() => void) | undefined;
    try {
      // Establish image ownership before history seeding, so reconstructed cells
      // resolve to the source's stable opaque refs instead of importing new ids.
      rollbackImages = this.forkSessionImages?.(source.id, meta.id);
      session = this.launch(meta, plan, env);
      await session.seedFromHistory();
      // plan_set before startIngestion — safe for the same reason as resume()
      // (plans arrive only via bridge tools, never pi stdout).
      if (meta.plan && meta.plan.length > 0) session.restorePlan(meta.plan);
      session.startIngestion();
      this.onMetaChange(meta);
      return session;
    } catch (error) {
      // Launch/seeding failure removes both the half-built Pi owner and the
      // target manifest. Shared content-addressed blobs remain GC-safe.
      if (session) await this.destroy(meta.id).catch(() => {});
      try {
        rollbackImages?.();
      } catch {
        // Best-effort rollback must not mask the launch failure.
      }
      throw error;
    }
  }

  /** Materialize a Pi-created branch file as a new Deck session. The caller has
   * already stopped the source runtime because Pi's fork RPC rebound it. */
  async materializeHistoryFork(
    source: SessionMeta,
    branchFile: string,
    env?: Record<string, string | undefined>,
  ): Promise<ManagedSession> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      ...source,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      endedAt: undefined,
      piSessionFile: branchFile,
      title: source.title ? `${source.title} (fork)` : undefined,
    };
    // The target shares the checkout as a portable cwd reference, never the
    // source's app-owned worktree deletion authority. Persist the dependency so
    // source deletion/merge cannot remove the checkout while this target exists.
    if (source.worktreeOwnerSessionId) {
      meta.worktreeOwnerSessionId = source.worktreeOwnerSessionId;
    } else if (source.worktreePath) {
      meta.worktreeOwnerSessionId = source.id;
    } else {
      delete meta.worktreeOwnerSessionId;
    }
    delete meta.worktreePath;
    delete meta.worktreeIdentity;
    delete meta.worktreeBranch;
    delete meta.worktreeSourceBranch;
    delete meta.worktreeCleanupBranchHead;
    const original = (source.launchPlan as LaunchPlan | undefined) ?? { kind: "parent" };
    const plan: LaunchPlan =
      original.kind === "agent"
        ? { ...original, sessionDir: undefined, resumeSessionPath: branchFile }
        : original.kind === "parent"
          ? { ...original, resumeSessionPath: branchFile }
          : original;
    let session: ManagedSession | undefined;
    let rollbackAttachments: (() => void) | undefined;
    try {
      rollbackAttachments = this.forkSessionImages?.(source.id, meta.id);
      session = this.launch(meta, plan, env, true);
      await session.seedFromHistory();
      if (meta.plan?.length) session.restorePlan(meta.plan);
      session.startIngestion();
      this.announceCreated(session);
      return session;
    } catch (error) {
      if (session) await this.destroy(meta.id).catch(() => {});
      try {
        rollbackAttachments?.();
      } catch {
        // Preserve the primary branch materialization failure.
      }
      throw error;
    }
  }

  /** Relaunch the same Deck identity without publishing the branch handle until
   * launch and canonical history seeding both succeed. */
  async rebindHistoryDeferred(
    source: SessionMeta,
    branchFile: string,
    env?: Record<string, string | undefined>,
  ): Promise<ManagedSession> {
    const meta = {
      ...source,
      piSessionFile: branchFile,
      endedAt: undefined,
      streamGeneration: randomUUID(),
    };
    const original = (source.launchPlan as LaunchPlan | undefined) ?? { kind: "parent" };
    const plan: LaunchPlan =
      original.kind === "agent"
        ? { ...original, sessionDir: undefined, resumeSessionPath: branchFile }
        : original.kind === "parent"
          ? { ...original, resumeSessionPath: branchFile }
          : original;
    let session: ManagedSession | undefined;
    try {
      session = this.launch(meta, plan, env, true);
      await session.seedFromHistory();
      if (meta.plan?.length) session.restorePlan(meta.plan);
      session.startIngestion();
      session.publishMetaChanges();
      this.onMetaChange(meta);
      return session;
    } catch (error) {
      if (session) await this.destroy(meta.id).catch(() => {});
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
    // Symmetric with destroy(): a stopped session must not linger in the map
    // (stopAll is shutdown-only today, but the asymmetry invited misuse).
    this.sessions.clear();
  }
}
