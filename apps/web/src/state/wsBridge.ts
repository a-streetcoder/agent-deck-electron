import type {
  ClientMessage,
  EditorId,
  HistoryActionResult,
  ProjectMeta,
  ProjectServerCommand,
  ScriptPush,
  ServerMessage,
  SessionMeta,
  TerminalPush,
  ThinkingLevel,
} from "@agent-deck/contracts";
import { reduceTranscript } from "@agent-deck/domain";
import type {
  FileListResult,
  FileReadResult,
  FileWriteResult,
  ScriptRunResult,
  TerminalOpenResult,
} from "@agent-deck/client-runtime";
import { responseErrorMessage } from "../lib/responseError.ts";
import { RpcClientTransport, type ClientTransport, type TransportHost } from "./clientTransport.ts";
import { useAppStore } from "./store.ts";

/**
 * The ONLY module that touches the WebSocket. Server messages mutate the
 * zustand store through the shared domain reducer; UI components send
 * commands exclusively through the exported functions below.
 *
 * One socket, one subscribed session at a time: switching project closes the
 * socket and reconnects subscribed to that project's session.
 *
 * The socket mechanism itself lives behind a {@link ClientTransport} (see
 * clientTransport.ts): the Effect-RPC `/rpc` transport (the legacy `/ws` envelope
 * was retired in Slice 7c). This module owns the shared reducer/host; the
 * transport owns framing + reconnect.
 */

let currentSessionId: string | null = null;
// A keep-off merge may intentionally stop Pi before deleting its cwd. Defer an
// exit arriving during that request until the typed response tells us whether
// cleanup actually reached runtime teardown; never clear unrelated errors.
const mergeRequests = new Set<string>();
const deferredMergeExits = new Map<string, string>();
const expectedCleanupExits = new Set<string>();
const historyActionClaims = new Map<string, number>();
const historyActionClaimListeners = new Set<() => void>();
const updateHistoryClaim = (sessionId: string, delta: 1 | -1): void => {
  const next = Math.max(0, (historyActionClaims.get(sessionId) ?? 0) + delta);
  if (next) historyActionClaims.set(sessionId, next);
  else historyActionClaims.delete(sessionId);
  for (const listener of historyActionClaimListeners) listener();
};
export const historyActionPending = (sessionId: string | null): boolean =>
  sessionId !== null && (historyActionClaims.get(sessionId) ?? 0) > 0;
export const subscribeHistoryActionPending = (listener: () => void): (() => void) => {
  historyActionClaimListeners.add(listener);
  return () => historyActionClaimListeners.delete(listener);
};

const transportHost: TransportHost = {
  onServerMessage: (message) => handleMessage(message),
  setConnection: (status) => {
    // Terminals AND script runs are owned by the server-side RPC connection: any
    // drop kills their child processes, so every remembered id dies with the
    // socket (a reopen respawns / re-lists).
    if (status !== "open") {
      sessionTerminals.clear();
      sessionRuns.clear();
    }
    useAppStore.getState().setConnection(status);
  },
  getLastSeq: () => useAppStore.getState().lastSeq,
  getStreamGeneration: () => useAppStore.getState().streamGeneration,
  onTerminalPush: (message) => {
    for (const listener of terminalPushListeners) listener(message);
  },
  onScriptPush: (message) => {
    for (const listener of scriptPushListeners) listener(message);
  },
  // Slice 10: a turn boundary refreshed the session's changed-file set. The
  // push is broadcast per connection and carries its sessionId — only the
  // subscribed session's set drives the store (same filter as event pushes).
  onDiffPush: (message) => {
    if (message.sessionId !== currentSessionId) return;
    useAppStore.getState().setDiffState(message);
  },
  // Fired after every (re)subscription settles: fetch the freshly-subscribed
  // session's set (a session switch dropped the old one; a reconnect may have
  // missed pushes while down).
  onSessionSubscribed: (sessionId) => {
    useAppStore.getState().setSessionSubscriptionSettled(true);
    void refreshDiffFiles(sessionId);
    void refreshCheckpoints(sessionId);
  },
};

const transport: ClientTransport = new RpcClientTransport(transportHost);

// ---------------------------------------------------------------------------
// Terminal drawer surface (Slice 8b) — ported from t3code's terminal state
// wiring (MIT), re-expressed over our RPC transport: the drawer opens a
// terminal for the CURRENT session, the server remembers it per connection,
// and reopening the drawer reattaches by id to replay the scrollback.
// ---------------------------------------------------------------------------

/** Terminal ids the server allocated for this connection, per session. */
const sessionTerminals = new Map<string, string>();
/** In-flight opens, per session: a drawer close+reopen before the first open
 * resolves must JOIN it, not race a second terminal_open (last-writer-wins
 * would leave the first PTY streaming to a filtered-out listener). */
const pendingOpens = new Map<string, Promise<TerminalOpenResult & { sessionId: string }>>();
const terminalPushListeners = new Set<(message: TerminalPush) => void>();

/** Subscribe to terminal pushes (output/exit). Returns the unsubscriber. */
export function subscribeTerminalPush(listener: (message: TerminalPush) => void): () => void {
  terminalPushListeners.add(listener);
  return () => terminalPushListeners.delete(listener);
}

/**
 * Open the current session's terminal — reattaching to the one this connection
 * already opened (scrollback replays), or spawning a fresh PTY in the session's
 * cwd. A stale remembered id (e.g. the session exited and took its terminals
 * down) falls back to a fresh open.
 */
export async function openSessionTerminal(
  cols?: number,
  rows?: number,
): Promise<TerminalOpenResult & { sessionId: string }> {
  const sessionId = currentSessionId;
  if (!sessionId) throw new Error("no active session");
  const inFlight = pendingOpens.get(sessionId);
  if (inFlight) return await inFlight;
  const task = doOpenSessionTerminal(sessionId, cols, rows);
  pendingOpens.set(sessionId, task);
  try {
    return await task;
  } finally {
    pendingOpens.delete(sessionId);
  }
}

async function doOpenSessionTerminal(
  sessionId: string,
  cols?: number,
  rows?: number,
): Promise<TerminalOpenResult & { sessionId: string }> {
  const size = {
    ...(cols !== undefined ? { cols } : {}),
    ...(rows !== undefined ? { rows } : {}),
  };
  const known = sessionTerminals.get(sessionId);
  try {
    const result = await transport.openTerminal({
      sessionId,
      ...(known !== undefined ? { terminalId: known } : {}),
      ...size,
    });
    sessionTerminals.set(sessionId, result.terminalId);
    return { ...result, sessionId };
  } catch (error) {
    if (known === undefined) throw error;
    sessionTerminals.delete(sessionId);
    const result = await transport.openTerminal({ sessionId, ...size });
    sessionTerminals.set(sessionId, result.terminalId);
    return { ...result, sessionId };
  }
}

export function sendTerminalInput(terminalId: string, data: string): void {
  transport.sendTerminal({ type: "terminal_input", terminalId, data });
}

export function sendTerminalResize(terminalId: string, cols: number, rows: number): void {
  transport.sendTerminal({ type: "terminal_resize", terminalId, cols, rows });
}

/** Continue this session's pi conversation in the user's own terminal app
 * (TER-01). Rejects with the server's message when nothing is resumable or no
 * supported terminal is installed — the caller surfaces it as a toast. */
export function openSessionInExternalTerminal(sessionId: string): Promise<void> {
  return transport.openExternalTerminal({ sessionId });
}

/** Kill the current session's terminal (the PTY dies; the next open is fresh). */
export function closeSessionTerminal(sessionId: string): void {
  const terminalId = sessionTerminals.get(sessionId);
  if (terminalId === undefined) return;
  sessionTerminals.delete(sessionId);
  transport.sendTerminal({ type: "terminal_close", terminalId });
}

// ---------------------------------------------------------------------------
// Preview / dev-script surface (Slice 15b) — ported from t3code's preview state
// wiring (openDiscoveredPort / usePreviewSession, MIT), re-expressed over our
// RPC transport: the preview panel lists the CURRENT session's package.json
// scripts, starts ONE as a managed child process (server-allocated run id,
// remembered per connection), streams its output, and surfaces the loopback
// dev-server URL the run starts listening on so the panel can embed it. Like
// terminals, a run is owned by the RPC connection: a drop tree-kills the child
// and clears the remembered id (the panel re-lists on reconnect).
// ---------------------------------------------------------------------------

/** Run ids the server allocated for this connection, per session (one active
 * run per session — the server enforces it). Cleared on disconnect. */
const sessionRuns = new Map<string, string>();
const scriptPushListeners = new Set<(message: ScriptPush) => void>();

/** Subscribe to script pushes (output/server/exit). Returns the unsubscriber. */
export function subscribeScriptPush(listener: (message: ScriptPush) => void): () => void {
  scriptPushListeners.add(listener);
  return () => scriptPushListeners.delete(listener);
}

/** List the CURRENT session's declared package.json scripts ([] if none/offline). */
export async function listSessionScripts(): Promise<readonly ProjectServerCommand[]> {
  const sessionId = currentSessionId;
  if (!sessionId) return [];
  const result = await transport.scriptsList(sessionId);
  return result.candidates;
}

/** The run this connection currently has active for the CURRENT session, if any
 * (drives the panel's reattach-on-reopen path). */
export function getSessionRunId(): string | null {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  return sessionRuns.get(sessionId) ?? null;
}

/** Start a declared dev/build script for the CURRENT session as a managed run.
 * Throws on a server failure reply (undeclared script, a run already active). */
export async function startSessionScript(commandId: string): Promise<ScriptRunResult> {
  const sessionId = currentSessionId;
  if (!sessionId) throw new Error("no active session");
  const result = await transport.startScript(sessionId, commandId);
  sessionRuns.set(sessionId, result.runId);
  return result;
}

/** Reattach to a run (the panel reopened while the dev server still runs):
 * replays scrollback + the current server, and replaces the push listener. */
export async function attachSessionRun(runId: string): Promise<ScriptRunResult> {
  return await transport.attachScript(runId);
}

/** Stop the CURRENT session's run (tree-kill the child; the next start is fresh). */
export function stopSessionScript(sessionId: string): void {
  const runId = sessionRuns.get(sessionId);
  if (runId === undefined) return;
  sessionRuns.delete(sessionId);
  void transport.stopScript(runId).catch(() => {
    // A stop of an already-exited/torn-down run is a no-op; the exit push (or
    // the connection drop) already conveyed the truth to the panel.
  });
}

// ---------------------------------------------------------------------------
// Changed-files surface (Slice 10) — the session's diff set lives in the store
// and is kept fresh two ways: diff_push at turn boundaries (onDiffPush above)
// and an explicit fetch on every (re)subscription (onSessionSubscribed).
// ---------------------------------------------------------------------------

/** Fetch `sessionId`'s changed-file set into the store (if still current). */
async function refreshDiffFiles(sessionId: string): Promise<void> {
  try {
    const result = await transport.diffFiles(sessionId);
    if (sessionId !== currentSessionId) return; // switched away mid-flight
    useAppStore.getState().setDiffState(result);
  } catch {
    // Offline or a torn-down session: leave the (reset) state alone — the
    // next subscription refetches. Never worth the error banner.
  }
}

// ---------------------------------------------------------------------------
// Checkpoints surface (Slice 18b) — the session's captured checkpoints live in
// the store, refreshed on (re)subscribe (onSessionSubscribed) + on each return
// to idle (App wires that) + after a rollback. A rollback restores both halves
// server-side and re-pushes a fresh transcript snapshot on the same connection,
// so the transcript reloads without a client-driven reconnect.
// ---------------------------------------------------------------------------

/** Fetch `sessionId`'s checkpoint list into the store (if still current). */
export async function refreshCheckpoints(sessionId: string): Promise<void> {
  try {
    const checkpoints = await transport.checkpointsList(sessionId);
    if (sessionId !== currentSessionId) return; // switched away mid-flight
    useAppStore.getState().setCheckpoints(checkpoints);
  } catch {
    // Offline or a torn-down session: the next subscription/idle refetches.
  }
}

/**
 * Roll the CURRENT session back to the checkpoint at `turnIndex` (DESTRUCTIVE —
 * the caller confirmed). The server restores both halves, relaunches pi, and
 * pushes a fresh transcript snapshot on this connection (so the transcript
 * reloads to the restored state); we then refresh the sideband (changed-file
 * set + the checkpoint timeline itself, now truncated + carrying the safety
 * checkpoint). Returns whether the workspace files were restored. */
export async function rollbackToCheckpoint(turnIndex: number): Promise<{
  filesRestored: boolean;
  nextPrompt: string | null;
  nextPromptHadAttachments: boolean;
}> {
  const sessionId = currentSessionId;
  if (!sessionId) throw new Error("no active session");
  const result = await transport.checkpointRollback(sessionId, turnIndex);
  if (sessionId === currentSessionId) {
    await refreshDiffFiles(sessionId);
    await refreshCheckpoints(sessionId);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Worktree merge action (Slice 20) — an isolated worktree session's work stays
// UNCOMMITTED on its branch until merge; the server's merge route auto-commits
// it, merges --no-ff into the source branch, and reports the merged branch
// names + commit count. Both the Git screen banner and the diff-panel branch
// toolbar drive THIS one path (no duplicated fetch).
// ---------------------------------------------------------------------------

/** The parsed success reply of POST /sessions/:id/merge. */
export type MergeCleanup =
  | { status: "retained"; runtimeStopped: false }
  | { status: "removed"; runtimeStopped: boolean }
  | {
      status: "failed";
      runtimeStopped: boolean;
      code:
        | "runtime_busy"
        | "runtime_shutdown_failed"
        | "worktree_remove_failed"
        | "branch_remove_failed";
      error: string;
    };

export interface MergeResult {
  ok: true;
  code: "merge_succeeded";
  outcome: "merged";
  branch: string;
  sourceBranch: string;
  commits: number;
  worktreeCommitted: boolean;
  cleanup: MergeCleanup;
}

export type MergeFailureOutcome =
  | "dirty"
  | "busy"
  | "stale_ownership"
  | "conflict"
  | "nothing_to_merge"
  | "read_only"
  | "failed";

const mergeFailureDiscriminants: Readonly<Record<string, MergeFailureOutcome>> = {
  merge_session_missing: "failed",
  loop_review_read_only: "read_only",
  merge_stale_ownership: "stale_ownership",
  merge_path_validation_failed: "stale_ownership",
  merge_busy: "busy",
  merge_source_missing: "stale_ownership",
  merge_parent_busy: "busy",
  merge_parent_dirty: "dirty",
  merge_source_occupied: "stale_ownership",
  merge_worktree_busy: "busy",
  merge_runtime_busy: "busy",
  merge_runtime_state_unavailable: "busy",
  merge_preflight_failed: "failed",
  merge_source_checkout_failed: "failed",
  merge_parent_changed: "stale_ownership",
  merge_worktree_commit_failed: "failed",
  merge_ahead_failed: "failed",
  merge_nothing_to_merge: "nothing_to_merge",
  merge_conflict: "conflict",
  merge_active_failure: "failed",
  merge_failed: "failed",
};

interface MergeFailureBody {
  code: string;
  outcome: MergeFailureOutcome;
  error: string;
  worktreeCommitted: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseMergeFailure(value: unknown): MergeFailureBody | null {
  const body = record(value);
  if (
    !body ||
    typeof body.code !== "string" ||
    body.code.length === 0 ||
    typeof body.outcome !== "string" ||
    mergeFailureDiscriminants[body.code] !== body.outcome ||
    typeof body.error !== "string" ||
    typeof body.worktreeCommitted !== "boolean"
  ) {
    return null;
  }
  return body as unknown as MergeFailureBody;
}

function parseMergeSuccess(value: unknown): MergeResult | null {
  const body = record(value);
  const cleanup = record(body?.cleanup);
  const cleanupValid =
    (cleanup?.status === "retained" && cleanup.runtimeStopped === false) ||
    (cleanup?.status === "removed" && typeof cleanup.runtimeStopped === "boolean") ||
    (cleanup?.status === "failed" &&
      typeof cleanup.runtimeStopped === "boolean" &&
      [
        "runtime_busy",
        "runtime_shutdown_failed",
        "worktree_remove_failed",
        "branch_remove_failed",
      ].includes(String(cleanup.code)) &&
      typeof cleanup.error === "string" &&
      cleanup.error.length > 0);
  if (
    !body ||
    body.ok !== true ||
    body.code !== "merge_succeeded" ||
    body.outcome !== "merged" ||
    typeof body.branch !== "string" ||
    body.branch.length === 0 ||
    typeof body.sourceBranch !== "string" ||
    body.sourceBranch.length === 0 ||
    typeof body.commits !== "number" ||
    !Number.isSafeInteger(body.commits) ||
    body.commits < 1 ||
    typeof body.worktreeCommitted !== "boolean" ||
    !cleanupValid
  ) {
    return null;
  }
  return body as unknown as MergeResult;
}

function clearMergedSessionDiff(sessionId: string): void {
  if (sessionId === currentSessionId) {
    useAppStore.getState().setDiffState({ repo: true, files: [], truncated: false });
  }
}

export class MergeWorktreeError extends Error {
  constructor(
    public readonly code: string,
    public readonly outcome: MergeFailureOutcome,
    public readonly worktreeCommitted: boolean,
    serverMessage: string,
  ) {
    const prefix = worktreeCommitted
      ? "Your session changes were committed in its worktree, but the merge did not finish. "
      : "";
    const guidance =
      code === "merge_active_failure" ||
      code === "merge_runtime_busy" ||
      code === "merge_runtime_state_unavailable"
        ? serverMessage
        : outcome === "dirty"
          ? "Commit, stash, or discard the project checkout changes, then try again."
          : outcome === "busy"
            ? "Finish or abort the Git operation, then try again."
            : outcome === "stale_ownership"
              ? "The session checkout or branch ownership changed. Review the worktrees and start a new isolated session if ownership cannot be restored."
              : outcome === "conflict"
                ? "Resolve the conflicts and commit the merge, or abort it in the project checkout."
                : outcome === "failed"
                  ? `${serverMessage} Review the project and session Git state, then try again.`
                  : serverMessage;
    super(`${prefix}${guidance}`);
    this.name = "MergeWorktreeError";
  }
}

/**
 * Merge `sessionId`'s isolated worktree back into its source branch (native
 * Merge, POST /sessions/:id/merge). Returns the merged branch names + commit
 * count on success; THROWS an Error carrying the server's `{ error }` message on
 * a refusal — 400 "Nothing to merge", 409 "Merge failed: <conflict>", or 404 —
 * so callers can surface it verbatim.
 *
 * On success the merge route auto-commits ALL uncommitted worktree work (git add
 * -A) before merging, so the session's working-tree-vs-HEAD diff (the review
 * surface) is now provably EMPTY. We reflect that immediately by clearing the
 * store's changed-file set (repo stays true so the panel shows its "no changes"
 * state, not hidden) — reusing the same `setDiffState` the diff_push / subscribe
 * refresh drive, rather than inventing a new push. The merge route also drops the
 * server-side per-session diff cache (ctx.dropDiffCache), so a resubscribe before
 * the next turn boundary recomputes the now-empty set instead of replaying the
 * stale pre-merge one — the optimistic clear and the server invalidation agree.
 */
export async function mergeWorktreeSession(sessionId: string): Promise<MergeResult> {
  mergeRequests.add(sessionId);
  let response: Response;
  try {
    response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/merge`, {
      method: "POST",
    });
  } catch (error) {
    mergeRequests.delete(sessionId);
    const deferredExit = deferredMergeExits.get(sessionId);
    deferredMergeExits.delete(sessionId);
    if (deferredExit) useAppStore.getState().setError(deferredExit);
    throw error;
  }
  if (!response.ok) {
    const body = parseMergeFailure(await response.json().catch(() => null));
    mergeRequests.delete(sessionId);
    const deferredExit = deferredMergeExits.get(sessionId);
    deferredMergeExits.delete(sessionId);
    if (deferredExit) useAppStore.getState().setError(deferredExit);
    if (!body) {
      throw new MergeWorktreeError(
        "merge_failed",
        "failed",
        false,
        `Merge failed (${response.status}).`,
      );
    }
    if (body.worktreeCommitted) clearMergedSessionDiff(sessionId);
    throw new MergeWorktreeError(body.code, body.outcome, body.worktreeCommitted, body.error);
  }
  const result = parseMergeSuccess(await response.json().catch(() => null));
  if (!result) {
    mergeRequests.delete(sessionId);
    const deferredExit = deferredMergeExits.get(sessionId);
    deferredMergeExits.delete(sessionId);
    if (deferredExit) useAppStore.getState().setError(deferredExit);
    throw new MergeWorktreeError(
      "merge_failed",
      "failed",
      false,
      "The merge server returned an invalid success response.",
    );
  }
  clearMergedSessionDiff(sessionId);
  mergeRequests.delete(sessionId);
  const deferredExit = deferredMergeExits.get(sessionId);
  deferredMergeExits.delete(sessionId);
  if (result.cleanup.runtimeStopped) {
    // Usually the awaited stop has already delivered the deferred exit. Keep a
    // one-shot marker for the narrow response-before-push race.
    if (!deferredExit && sessionId === currentSessionId) expectedCleanupExits.add(sessionId);
  } else if (deferredExit) {
    useAppStore.getState().setError(deferredExit);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Open-in-editor surface (Slice 11) — the diff panel / changed-files tree open
// a file in one of the editors the SERVER detected on its machine.
// ---------------------------------------------------------------------------

/** The server's detected-editor list, cached per page load (the server caches
 * its own probe too — the set doesn't change within a run). */
let availableEditorsPromise: Promise<readonly EditorId[]> | null = null;

/** The editors detected on the server's machine ([] while offline). */
export function fetchAvailableEditors(): Promise<readonly EditorId[]> {
  availableEditorsPromise ??= transport.listEditors().catch(() => {
    availableEditorsPromise = null; // offline — retry on the next surface mount
    return [] as readonly EditorId[];
  });
  return availableEditorsPromise;
}

/** Open one changed file of the CURRENT session in `editor` (optionally at a
 * 1-based line). Throws on a server failure reply. */
export async function openFileInEditor(
  path: string,
  line: number | undefined,
  editor: EditorId,
): Promise<void> {
  const sessionId = currentSessionId;
  if (!sessionId) return;
  await transport.openInEditor({
    sessionId,
    path,
    ...(line !== undefined ? { line } : {}),
    editor,
  });
}

/** Fetch one changed file's unified diff for the CURRENT session. */
export async function fetchFileDiff(
  path: string,
  scope?: "all" | "staged" | "unstaged",
): Promise<{ diff: string; truncated: boolean; binary: boolean } | null> {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  const result = await transport.diffFile(sessionId, path, scope);
  return { diff: result.diff, truncated: result.truncated, binary: result.binary };
}

// ---------------------------------------------------------------------------
// File-navigation surface (Slice 13b) — the Files panel lazily browses the
// CURRENT session's project tree one directory at a time and reads one file's
// bounded content for the read-only preview. On-demand (no store cache); the
// panel owns its own directory/expansion state (components/files/useFileTree).
// The current-session capture mirrors the diff surface: a request that resolves
// after a session switch is dropped by the panel's own stale guard.
// ---------------------------------------------------------------------------

/** List one directory of the CURRENT session's project (omit `path` = root). */
export async function fetchFileList(path?: string): Promise<FileListResult | null> {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  return await transport.fileList(sessionId, path);
}

/** Read one file of the CURRENT session's project, bounded (text/image/binary). */
export async function fetchFileRead(path: string): Promise<FileReadResult | null> {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  return await transport.fileRead(sessionId, path);
}

/**
 * Overwrite one existing file of the CURRENT session's project (Slice L4b —
 * debounced autosave). `baseVersion` is the token from the read this buffer
 * descends from; the result's `outcome` is `written` (new token to adopt) or
 * `conflict` (the on-disk version drifted — the write was refused). Null when no
 * session is subscribed (dropped by the caller's stale guard).
 */
export async function fetchFileWrite(
  path: string,
  content: string,
  baseVersion: string,
): Promise<FileWriteResult | null> {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  return await transport.fileWrite(sessionId, path, content, baseVersion);
}

/** (Re)connect subscribed to `sessionId` — the single entry point that keeps
 * `currentSessionId` (which gates handleMessage's per-session filtering) in sync
 * with the transport's subscription. */
function disconnect(): void {
  currentSessionId = null;
  transport.disconnect();
}

function connect(sessionId: string): void {
  currentSessionId = sessionId;
  expectedCleanupExits.delete(sessionId);
  deferredMergeExits.delete(sessionId);
  // The old session's changed-file set + checkpoint list must not bleed into the
  // new one; the fresh sets arrive via onSessionSubscribed once it settles.
  useAppStore.getState().resetDiffState();
  useAppStore.getState().setCheckpoints([]);
  useAppStore.getState().setSessionSubscriptionSettled(false);
  transport.connect(sessionId);
}

function send(message: ClientMessage): Promise<void> {
  return transport.send(message);
}

function sendCompatibleCommand(message: ClientMessage): void {
  void send(message).catch((error: unknown) => {
    useAppStore.getState().setError(String(error));
  });
}

function handleMessage(message: ServerMessage): void {
  const store = useAppStore.getState();
  switch (message.type) {
    case "snapshot":
      if (message.sessionId !== currentSessionId) return;
      store.setSnapshot(message.state, message.seq, message.streamGeneration);
      break;
    case "event": {
      if (message.sessionId !== currentSessionId) return;
      const { transcript, lastSeq } = useAppStore.getState();
      if (message.seq <= lastSeq) return; // replay overlap — already applied
      store.setTranscript(reduceTranscript(transcript, message.event), message.seq);
      break;
    }
    case "error":
      store.setError(message.message);
      break;
    case "session_exit":
      if (message.sessionId !== currentSessionId) return;
      if (expectedCleanupExits.delete(message.sessionId)) return;
      if (historyActionPending(message.sessionId)) return;
      if (mergeRequests.has(message.sessionId)) {
        deferredMergeExits.set(message.sessionId, `pi exited (code ${message.code ?? "?"})`);
        return;
      }
      store.setError(`pi exited (code ${message.code ?? "?"})`);
      break;
    case "resources_changed":
      store.bumpResourcesVersion();
      break;
    case "session_meta":
      attentionMetaGeneration.set(
        message.session.id,
        (attentionMetaGeneration.get(message.session.id) ?? 0) + 1,
      );
      store.upsertSessionMeta(message.session);
      break;
    case "session_rebind":
      if (message.sessionId !== currentSessionId) return;
      // A same-id history re-run replaced the process and ordered bus. This is
      // server-driven so every renderer subscribed to the id drops stale seq
      // ancestry and requests the replacement runtime's full snapshot.
      store.resetTranscript();
      store.setError(null);
      connect(message.sessionId);
      break;
    case "session_removed":
      store.removeSession(message.sessionId);
      // Its terminals AND script runs died server-side with the session
      // (rpcHandler teardown funnels both into the session-exit hook).
      sessionTerminals.delete(message.sessionId);
      sessionRuns.delete(message.sessionId);
      // If ANOTHER client deleted the session we're viewing, drop it and open
      // a fresh chat so we're not pointing at (or subscribed to) a dead id.
      if (useAppStore.getState().session?.id === message.sessionId) {
        void newChat();
      }
      break;
    case "hello_ok":
      break;
  }
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(await responseErrorMessage(response));
  return (await response.json()) as T;
}

async function findOrCreateSession(
  projectId: string | null,
  agentName: string | null,
): Promise<SessionMeta> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const { sessions } = await fetchJson<{ sessions: SessionMeta[] }>(`/sessions${query}`);
  const scoped = (projectId ? sessions : sessions.filter((s) => !s.projectId)).filter(
    (s) => (s.agentName ?? null) === agentName,
  );
  const existing = scoped.at(-1);
  // A persisted parked row after server restart has no in-memory Pi owner.
  // Wake it through the same canonical resume transaction before subscribing.
  if (existing?.endedAt || existing?.parkedAt) {
    const { session } = await fetchJson<{ session: SessionMeta }>(
      `/sessions/${encodeURIComponent(existing.id)}/resume`,
      { method: "POST" },
    );
    return session;
  }
  if (existing) return existing;
  const { session } = await fetchJson<{ session: SessionMeta }>("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(projectId ? { projectId } : {}),
      ...(agentName ? { agentName } : {}),
    }),
  });
  return session;
}

export async function refreshProjects(): Promise<void> {
  const { projects } = await fetchJson<{ projects: ProjectMeta[] }>("/projects");
  useAppStore.getState().setProjects(projects);
}

export async function refreshSessions(): Promise<void> {
  const { sessions } = await fetchJson<{ sessions: SessionMeta[] }>("/sessions");
  useAppStore.getState().setSessions(sessions);
}

let activationToken = 0;
let notificationFocusToken = 0;
const attentionMetaGeneration = new Map<string, number>();

/** Preserve attention transitions published after a catalog request began.
 * Other catalog fields still come from the response; only backend-owned
 * attention truth is protected from an older HTTP snapshot. */
function mergeCatalogAttention(
  sessions: SessionMeta[],
  generationsAtRequest: ReadonlyMap<string, number>,
): SessionMeta[] {
  const currentSessions = useAppStore.getState().sessions;
  return sessions.map((session) => {
    if (
      (attentionMetaGeneration.get(session.id) ?? 0) === (generationsAtRequest.get(session.id) ?? 0)
    ) {
      return session;
    }
    const current = currentSessions.find((candidate) => candidate.id === session.id);
    if (!current) return session;
    return current.needsAttention === true
      ? { ...session, needsAttention: true as const }
      : { ...session, needsAttention: false as const };
  });
}

async function refreshSessionsForActivation(token: number): Promise<boolean> {
  const generationsAtRequest = new Map(attentionMetaGeneration);
  const { sessions } = await fetchJson<{ sessions: SessionMeta[] }>("/sessions");
  if (token !== activationToken) return false;
  useAppStore.getState().setSessions(mergeCatalogAttention(sessions, generationsAtRequest));
  return true;
}

async function activateSession(projectId: string | null, agentName: string | null): Promise<void> {
  // Guards rapid switching: if another activation starts while this one's REST
  // call is in flight, the stale result must never win.
  const token = ++activationToken;
  const store = useAppStore.getState();
  disconnect();
  try {
    store.setError(null);
    store.setCurrentProject(projectId);
    store.setCurrentAgent(agentName);
    store.resetTranscript();
    store.setSession(null);
    const session = await findOrCreateSession(projectId, agentName);
    if (token !== activationToken) return;
    useAppStore.getState().setSession(session);
    connect(session.id);
    await refreshSessionsForActivation(token);
  } catch (error) {
    if (token !== activationToken) return;
    useAppStore.getState().setError(String(error));
  }
}

async function switchToSessionAtActivation(target: SessionMeta, token: number): Promise<void> {
  if (token !== activationToken) return;
  const store = useAppStore.getState();
  disconnect();
  try {
    store.setError(null);
    store.setCurrentProject(target.projectId ?? null);
    store.setCurrentAgent(target.agentName ?? null);
    store.resetTranscript();
    store.setSession(null);
    const { session } = await fetchJson<{ session: SessionMeta }>(
      `/sessions/${encodeURIComponent(target.id)}/resume`,
      { method: "POST" },
    );
    if (token !== activationToken) return;
    useAppStore.getState().setSession(session);
    connect(session.id);
    await refreshSessionsForActivation(token);
  } catch (error) {
    if (token !== activationToken) return;
    useAppStore.getState().setError(String(error));
  }
}

/** Open a specific chat, resuming its pi session if it has ended. */
export async function switchToSession(target: SessionMeta): Promise<void> {
  await switchToSessionAtActivation(target, ++activationToken);
}

/** Navigate an OS-notification click to an existing session without trusting
 * the renderer-facing opaque id as proof that the session still exists. A
 * separate request generation orders catalog lookups; the shared activation is
 * reserved only after a valid target is found, so an unknown/deleted id cannot
 * cancel a real session switch already in flight. */
export async function focusSessionFromNotification(sessionId: string): Promise<void> {
  const activationAtClick = activationToken;
  const requestToken = ++notificationFocusToken;
  try {
    const generationsAtRequest = new Map(attentionMetaGeneration);
    const { sessions } = await fetchJson<{ sessions: SessionMeta[] }>("/sessions");
    if (requestToken !== notificationFocusToken || activationToken !== activationAtClick) return;
    const mergedSessions = mergeCatalogAttention(sessions, generationsAtRequest);
    const target = mergedSessions.find((session) => session.id === sessionId);
    if (!target) return;

    const token = ++activationToken;
    const store = useAppStore.getState();
    store.setSessions(mergedSessions);
    store.setView("chat");
    if (store.session?.id !== target.id) await switchToSessionAtActivation(target, token);
  } catch (error) {
    if (requestToken !== notificationFocusToken || activationToken !== activationAtClick) return;
    useAppStore.getState().setError(String(error));
  }
}

/** Start a brand-new chat for the current project + agent. */
export async function newChat(): Promise<SessionMeta | null> {
  const token = ++activationToken;
  const store = useAppStore.getState();
  const { currentProjectId, currentAgentName } = store;
  disconnect();
  try {
    store.setError(null);
    store.resetTranscript();
    store.setSession(null);
    const { session } = await fetchJson<{ session: SessionMeta }>("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(currentProjectId ? { projectId: currentProjectId } : {}),
        ...(currentAgentName ? { agentName: currentAgentName } : {}),
      }),
    });
    if (token !== activationToken) return null;
    useAppStore.getState().setSession(session);
    connect(session.id);
    try {
      if (!(await refreshSessionsForActivation(token))) return null;
    } catch (error) {
      if (token !== activationToken) return null;
      // The chat is already active. Keep its identity available to callers
      // (notably issue seeding) even if the sidebar list could not refresh.
      useAppStore.getState().setError(String(error));
    }
    return session;
  } catch (error) {
    if (token !== activationToken) return null;
    useAppStore.getState().setError(String(error));
    return null;
  }
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  try {
    const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error(await response.text());
    await refreshSessions();
  } catch (error) {
    useAppStore.getState().setError(String(error));
  }
}

export async function acknowledgeSessionAttention(sessionId: string): Promise<void> {
  const generationAtRequest = attentionMetaGeneration.get(sessionId) ?? 0;
  const attentionAtRequest =
    useAppStore.getState().sessions.find((session) => session.id === sessionId)?.needsAttention ===
    true;
  const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/attention`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ needsAttention: false }),
  });
  if (!response.ok) throw new Error(await responseErrorMessage(response));
  const body = (await response.json()) as { session?: SessionMeta };
  // The websocket publication is authoritative. If activation temporarily put
  // the renderer between subscriptions, apply only this session's PATCH result,
  // and only when no session_meta publication arrived since the request began.
  // This closes the lost-push gap without a stale full-catalog overwrite.
  if (
    body.session?.id === sessionId &&
    body.session.needsAttention !== true &&
    (attentionMetaGeneration.get(sessionId) ?? 0) === generationAtRequest &&
    (useAppStore.getState().sessions.find((session) => session.id === sessionId)?.needsAttention ===
      true) ===
      attentionAtRequest
  ) {
    attentionMetaGeneration.set(sessionId, generationAtRequest + 1);
    useAppStore.getState().upsertSessionMeta(body.session);
  }
}

export async function setSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
  try {
    const { session } = await fetchJson<{ session: SessionMeta }>(
      `/sessions/${encodeURIComponent(sessionId)}/pin`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned }),
      },
    );
    useAppStore.getState().upsertSessionMeta(session);
  } catch (error) {
    useAppStore.getState().setError(String(error));
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(await response.text());
    // If the deleted session was open, fall back to a new chat.
    if (useAppStore.getState().session?.id === sessionId) {
      await newChat();
    }
    await refreshSessions();
  } catch (error) {
    useAppStore.getState().setError(String(error));
  }
}

/** Run a stable-entry history action. The server result is durable even when a
 * newer user navigation wins; only activation/draft focus is generation-gated. */
export async function runHistoryAction(
  sessionId: string,
  entryId: string,
  action: "fork" | "rerun",
): Promise<HistoryActionResult> {
  const activationAtStart = activationToken;
  updateHistoryClaim(sessionId, 1);
  try {
    const result = await fetchJson<HistoryActionResult>(
      `/sessions/${encodeURIComponent(sessionId)}/history/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId }),
      },
    );
    await refreshSessions().catch(() => {});
    if (activationToken !== activationAtStart || currentSessionId !== sessionId) return result;
    if (result.outcome === "forked") {
      // Replace, never merge with a pre-existing target/source draft.
      const store = useAppStore.getState();
      store.updateComposerDraft(result.session.id, () => result.draft);
      store.setPendingComposerText({ sessionId: result.session.id, text: result.draft.text });
      await switchToSession(result.session);
    }
    return result;
  } finally {
    updateHistoryClaim(sessionId, -1);
  }
}

export async function forkSession(sessionId: string): Promise<void> {
  try {
    const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/fork`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(await response.text());
    const { session } = (await response.json()) as { session: SessionMeta };
    await refreshSessions();
    await switchToSession(session);
  } catch (error) {
    useAppStore.getState().setError(String(error));
  }
}

async function resourceAction(input: string, init: RequestInit): Promise<void> {
  try {
    const response = await fetch(input, init);
    if (!response.ok) throw new Error(await responseErrorMessage(response));
  } catch (error) {
    useAppStore.getState().setError(String(error));
  }
}

export async function setAgentDisabled(
  scope: string,
  name: string,
  disabled: boolean,
): Promise<void> {
  const projectId = useAppStore.getState().currentProjectId ?? undefined;
  await resourceAction("/resources/agents/disabled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, scope, name, disabled }),
  });
  await refreshProjects();
}

export async function deleteAgent(scope: string, name: string): Promise<void> {
  const projectId = useAppStore.getState().currentProjectId ?? undefined;
  await resourceAction("/resources/agents", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, scope, name }),
  });
  await refreshProjects();
}

/** Rename a global/project agent; returns true on success (the caller closes
 *  the inline editor), false after surfacing the server error (409/404/…). */
export async function renameAgent(scope: string, name: string, newName: string): Promise<boolean> {
  const projectId = useAppStore.getState().currentProjectId ?? undefined;
  try {
    const response = await fetch("/resources/agents/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, scope, name, newName }),
    });
    if (!response.ok) {
      const { error } = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(error ?? "Couldn't rename the agent.");
    }
    await refreshProjects();
    return true;
  } catch (error) {
    useAppStore.getState().setError(String(error));
    return false;
  }
}

export async function setSkillDisabled(name: string, disabled: boolean): Promise<void> {
  await resourceAction("/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setDisabledSkill: { name, disabled } }),
  });
}

export async function deleteSkill(scope: string, name: string): Promise<void> {
  const projectId = useAppStore.getState().currentProjectId ?? undefined;
  await resourceAction("/resources/skills", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, scope, name }),
  });
}

/** Rename a global/project skill; returns true on success (the caller closes
 *  the inline editor), false after surfacing the server error (409/404/…). */
export async function renameSkill(scope: string, name: string, newName: string): Promise<boolean> {
  const projectId = useAppStore.getState().currentProjectId ?? undefined;
  try {
    const response = await fetch("/resources/skills/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, scope, name, newName }),
    });
    if (!response.ok) {
      const { error } = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(error ?? "Couldn't rename the skill.");
    }
    return true;
  } catch (error) {
    useAppStore.getState().setError(String(error));
    return false;
  }
}

async function askUserAction(
  sessionId: string,
  requestId: string,
  action: "answer" | "cancel",
  body?: object,
): Promise<void> {
  const response = await fetch(
    `/sessions/${encodeURIComponent(sessionId)}/asks/${encodeURIComponent(requestId)}/${action}`,
    {
      method: "POST",
      ...(body
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? "Could not update the decision request.");
  }
}

export function sendAskUserAnswer(
  sessionId: string,
  requestId: string,
  answer: { selections: string[]; freeform?: string; comment?: string },
): Promise<void> {
  return askUserAction(sessionId, requestId, "answer", answer);
}

export function sendAskUserCancel(sessionId: string, requestId: string): Promise<void> {
  return askUserAction(sessionId, requestId, "cancel");
}

/** Answer a blocking supervisor-request card raised by a child subagent. */
export async function sendSupervisorAnswer(requestId: string, response: string): Promise<void> {
  await fetch(`/supervisor/${encodeURIComponent(requestId)}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response }),
  });
}

/** Answer a question card. */
export function sendUiResponse(requestId: string, response: Record<string, unknown>): void {
  if (currentSessionId) {
    sendCompatibleCommand({
      type: "ui_response",
      sessionId: currentSessionId,
      response: { type: "extension_ui_response", id: requestId, ...response },
    });
  }
}

export async function switchToProject(projectId: string | null): Promise<void> {
  // Changing project activates its default agent (or the plain Pi Agent).
  const project = projectId
    ? useAppStore.getState().projects.find((p) => p.id === projectId)
    : undefined;
  await activateSession(projectId, project?.defaultAgentName ?? null);
}

export async function updateProject(
  projectId: string,
  patch: {
    assignedAgentNames?: string[];
    assignedSkills?: string[];
    assignedPrompts?: string[];
    assignedMcpServers?: string[];
    defaultAgentName?: string | null;
    enabled?: boolean;
  },
): Promise<boolean> {
  const store = useAppStore.getState();
  // Optimistic: controlled inputs (assignment checkboxes) must flip
  // immediately; refreshProjects reconciles (or rolls back on error).
  store.setProjects(
    store.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            ...(patch.assignedAgentNames !== undefined
              ? { assignedAgentNames: patch.assignedAgentNames }
              : {}),
            ...(patch.assignedSkills !== undefined ? { assignedSkills: patch.assignedSkills } : {}),
            ...(patch.assignedPrompts !== undefined
              ? { assignedPrompts: patch.assignedPrompts }
              : {}),
            ...(patch.assignedMcpServers !== undefined
              ? { assignedMcpServers: patch.assignedMcpServers }
              : {}),
            ...(patch.defaultAgentName !== undefined
              ? { defaultAgentName: patch.defaultAgentName ?? undefined }
              : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          }
        : project,
    ),
  );
  try {
    const response = await fetch(`/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error(await response.text());
    return true;
  } catch (error) {
    useAppStore.getState().setError(String(error));
    return false;
  } finally {
    await refreshProjects();
  }
}

export async function switchToAgent(agentName: string | null): Promise<void> {
  await activateSession(useAppStore.getState().currentProjectId, agentName);
}

export async function addProject(path: string): Promise<void> {
  const store = useAppStore.getState();
  try {
    const { project } = await fetchJson<{ project: ProjectMeta }>("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    await refreshProjects();
    await switchToProject(project.id);
  } catch (error) {
    store.setError(String(error));
  }
}

export async function connectAndBootstrap(): Promise<void> {
  try {
    await refreshProjects();
    await switchToProject(null);
  } catch (error) {
    useAppStore.getState().setError(String(error));
  }
}

export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export function sendPrompt(
  sessionId: string,
  message: string,
  images?: ImageAttachment[],
  streamingBehavior?: "steer" | "followUp",
  pasteProjection?: {
    transcriptText: string;
    pastes: Array<{ id: number; marker: string; text: string }>;
  },
  titleSource?: string,
): Promise<void> {
  // The caller captures the originating session. Never retarget an in-flight
  // composer submission merely because the user switched sessions.
  if (sessionId !== currentSessionId) return Promise.reject(new Error("active session changed"));
  return send({
    type: "prompt",
    sessionId,
    message,
    ...(images && images.length > 0 ? { images } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
    ...(pasteProjection
      ? { transcriptText: pasteProjection.transcriptText, pastes: pasteProjection.pastes }
      : {}),
    ...(titleSource !== undefined ? { titleSource } : {}),
  });
}

export function sendAbort(): void {
  if (currentSessionId) sendCompatibleCommand({ type: "abort", sessionId: currentSessionId });
}

/** Manually compact the current session's context (native "Compact context"). */
export function sendCompact(): void {
  if (currentSessionId) sendCompatibleCommand({ type: "compact", sessionId: currentSessionId });
}

export function sendSetModel(provider: string, modelId: string): void {
  if (currentSessionId) {
    sendCompatibleCommand({ type: "set_model", sessionId: currentSessionId, provider, modelId });
  }
}

export function sendSetThinking(level: ThinkingLevel): void {
  if (currentSessionId) {
    sendCompatibleCommand({ type: "set_thinking", sessionId: currentSessionId, level });
  }
}
