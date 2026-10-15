// SRV-12c1 session move: the envelope a device sends to a shared server, and the
// Pi transcript checks both sides share. The envelope crosses a trust boundary
// (the server imports what any member's device sends), so the server validates
// it strictly: closed shapes, bounded sizes, UUID ids, and no device path.
// SRV-12c3: the same envelope, export and import code carry a session back
// (direction "return"): the server exports, the device imports and validates
// just as strictly.
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import type { SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { redactSecrets } from "@agent-deck/domain";
import type { LaunchPlan } from "@agent-deck/pi-host";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { composerDraftSchema } from "./composerDrafts.ts";
import { envDefaults, type ServerContext } from "./context.ts";
import { resolveLaunchResources } from "./launchResources.ts";
import {
  createSessionWorktreeWithBranchRetries,
  gitCarriesLfs,
  gitCommitParents,
  gitDeleteOwnedWorktreeBranch,
  gitDeleteTransferRef,
  gitErrorText,
  gitFetchTransfer,
  gitPushTransfer,
  gitResetMixedTo,
  gitSharePlan,
  gitSnapshotCommit,
  gitWorktreePrune,
  gitWorktreeRegistrationMatches,
  SessionWorktreeAddError,
  SnapshotPlanChangedError,
  validTransferRef,
  withoutHooks,
  type GitWorktree,
} from "./git.ts";
import type { SessionMutationClaims } from "./sessionMutationClaims.ts";

/** The whole envelope, as JSON, never exceeds this (the transcript is most of it). */
export const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
/** ade-q0pz: transfers push without hooks, so git-lfs would not upload the objects. */
export const LFS_MOVE_REFUSAL = "LFS repositories cannot be moved yet.";
export const LFS_DETECTION_REFUSAL =
  "LFS detection failed, so the work cannot be moved with its files.";

/** What a move never carries: device-local state, named in the import summary. */
export const ALWAYS_DROPPED = [
  "checkpoints",
  "subagent runs",
  "Loop cells",
  "plan history",
  "event history",
] as const;

const uuid = z.string().uuid();
const deviceSchema = z.string().regex(/^[A-Za-z0-9._-]{1,200}$/);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const text = (max: number) => z.string().min(1).max(max);
const launchId = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.@/][A-Za-z0-9_.:@/-]*$/);

const planItem = z
  .object({
    id: text(200),
    title: z.string().max(2000),
    status: z.enum(["todo", "in_progress", "done", "blocked", "skipped"]),
    dependsOn: z.array(text(200)).max(200).optional(),
    assignee: text(200).optional(),
    verifiedBy: text(200).optional(),
    task: z.string().max(20_000).optional(),
    isolated: z.boolean().optional(),
  })
  .strict();

const authorTurn = z
  .object({
    signature: z.string().regex(/^[0-9a-f]{64}$/),
    author: z.object({ id: text(320), name: z.string().max(200).optional() }).strict(),
    entryId: text(500),
    claimed: z.boolean().optional(),
  })
  .strict();

// The unsent composer text travels; attached file and folder references are
// device paths, so they never do.
const draft = composerDraftSchema
  .extend({ files: z.array(z.never()).max(0), folders: z.array(z.never()).max(0) })
  .strict();

export const transferEnvelopeSchema = z
  .object({
    version: z.literal(1),
    localSessionId: uuid,
    /** The device's host name, shown and written into the conversation notice. */
    device: deviceSchema,
    /** SRV-12c3: "return" when the shared server sends a session back to its device;
     * `localSessionId` is then the server session's id (always the sender's). */
    direction: z.literal("return").optional(),
    /** SRV-12c3, return only: the device session the server copy came from. */
    sharedFrom: z.object({ device: deviceSchema, localSessionId: uuid }).strict().optional(),
    meta: z
      .object({
        title: z.string().max(200).optional(),
        titleUserEdited: z.boolean().optional(),
        // A Loop session never moves; a Loop-named agent would read as one here.
        agentName: text(200)
          .refine((name) => !name.startsWith("Loop ·"), "a Loop session cannot move")
          .optional(),
        // Become Pi launch arguments: a plain id, never something flag-like.
        provider: launchId.optional(),
        model: launchId.optional(),
        subagentsEnabled: z.boolean().optional(),
        plan: z.array(planItem).max(200).optional(),
        /** SRV-12c3, return only: the pull request the server's merge opened. */
        mergePr: z
          .object({
            url: z
              .string()
              .max(500)
              .regex(/^https:\/\/[^\s]+\/pull\/\d+$/),
            number: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    transcript: z.string().min(1).max(MAX_TRANSFER_BYTES),
    authors: z.array(authorTurn).max(10_000),
    /** Paste turns; each one is re-checked by the paste store on import. */
    pastes: z.array(z.unknown()).max(10_000),
    draft: draft.nullable(),
    transfer: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("snapshot"),
          ref: z.string().refine(validTransferRef, "invalid transfer ref"),
          commit: oid,
          baseHead: oid,
        })
        .strict(),
      z.object({ mode: z.literal("conversation") }).strict(),
    ]),
    dropped: z.array(text(100)).max(50),
  })
  .strict()
  .refine(
    (envelope) =>
      envelope.transfer.mode !== "snapshot" ||
      envelope.transfer.ref.endsWith(`/${envelope.localSessionId}`),
    "the transfer ref must name the moved session",
  )
  .refine(
    (envelope) =>
      envelope.direction === "return"
        ? envelope.sharedFrom !== undefined && envelope.transfer.mode === "snapshot"
        : envelope.sharedFrom === undefined,
    "a return carries its device session and a snapshot; a share carries neither",
  );

export type TransferEnvelope = z.infer<typeof transferEnvelopeSchema>;

/**
 * Check a Pi session file: JSON objects, one per line, the first one Pi's
 * `session` header (Pi resumes in the header's cwd, so it must be there).
 * Every entry has a unique id and a parent written before it (Pi appends, so
 * the ancestry walk can never loop or dangle); a message entry has its message.
 * Throws with a short reason.
 */
export function checkPiTranscript(transcript: string): void {
  const lines = transcript.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("the transcript is empty");
  const ids = new Set<string>();
  lines.forEach((line, index) => {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`transcript line ${index + 1} is not JSON`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`transcript line ${index + 1} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (index === 0) {
      if (
        record.type !== "session" ||
        typeof record.id !== "string" ||
        typeof record.cwd !== "string"
      ) {
        throw new Error("the transcript does not start with a Pi session header");
      }
    } else if (typeof record.type !== "string" || record.type === "session") {
      throw new Error(`transcript line ${index + 1} is not a Pi entry`);
    } else {
      const where = `transcript line ${index + 1}`;
      if (typeof record.id !== "string" || record.id === "") throw new Error(`${where} has no id`);
      if (ids.has(record.id)) throw new Error(`${where} repeats the id ${record.id}`);
      const parent = record.parentId;
      if (parent !== null && (typeof parent !== "string" || !ids.has(parent)))
        throw new Error(`${where} has a parent that is not before it`);
      if (
        record.targetId !== undefined &&
        (typeof record.targetId !== "string" || !ids.has(record.targetId))
      )
        throw new Error(`${where} points at an unknown entry`);
      const message = record.message as { role?: unknown } | null | undefined;
      if (
        record.type === "message" &&
        (!message || typeof message !== "object" || typeof message.role !== "string")
      )
        throw new Error(`${where} is a message without its message`);
      ids.add(record.id);
    }
  });
}

/** The thinking level of the transcript's active chain (its last
 * thinking_level_change from the leaf back), or undefined when it never set one. */
export function transcriptThinkingLevel(
  transcript: string,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const byId = new Map<string, Record<string, unknown>>();
  let leaf: string | undefined;
  for (const line of transcript.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry.id === "string") {
      byId.set(entry.id, entry);
      leaf = entry.id;
    }
  }
  // checkPiTranscript proved every parent is written before its child: no loop.
  for (let id = leaf; id; ) {
    const entry = byId.get(id);
    if (!entry) break;
    if (entry.type === "thinking_level_change") {
      const level = entry.thinkingLevel;
      return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level as string)
        ? (level as "off")
        : undefined;
    }
    id = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  return undefined;
}

/**
 * Point the transcript at `cwd`. Only the header line changes: its `cwd`, and
 * its `parentSession` (a path on the other machine) is dropped, or set to
 * `parentSession` (SRV-12c3: the device's own, kept through the round trip).
 * Every other byte is kept.
 */
export function rewriteTranscriptCwd(
  transcript: string,
  cwd: string,
  parentSession?: string,
): string {
  const end = transcript.indexOf("\n");
  const first = end === -1 ? transcript : transcript.slice(0, end);
  const header = JSON.parse(first) as Record<string, unknown>;
  delete header.parentSession;
  const next = { ...header, cwd, ...(parentSession ? { parentSession } : {}) };
  return `${JSON.stringify(next)}${end === -1 ? "\n" : transcript.slice(end)}`;
}

/** The `parentSession` of a Pi transcript header, when it is a string. */
export function transcriptParentSession(transcript: string): string | undefined {
  try {
    const end = transcript.indexOf("\n");
    const header = JSON.parse(end === -1 ? transcript : transcript.slice(0, end)) as {
      parentSession?: unknown;
    };
    return typeof header.parentSession === "string" ? header.parentSession : undefined;
  } catch {
    return undefined;
  }
}

/** A launch refused because the session's model is not offered here (409 model_unavailable). */
export class TransferModelError extends Error {
  readonly statusCode = 409;
}

/**
 * The launch configuration of a moved session on the receiving side: the
 * agent, provider and model it ran with, and the thinking level its transcript
 * last set (durable: no default or agent level replaces it on any resume). An
 * agent that is not here makes it a plain chat (`droppedAgent`). The model must
 * be one the receiving side offers (the fork's check: the requester's
 * providers on the server, `localCatalog` this device's own), else
 * TransferModelError. Writes nothing.
 */
export async function resolveTransferLaunch(
  ctx: ServerContext,
  envelope: TransferEnvelope,
  where: { id: string; cwd: string; projectId?: string; sessionFile?: string },
  owner: UserIdentity | undefined,
  options: { localCatalog?: boolean } = {},
) {
  const defaults = envDefaults();
  const thinking = transcriptThinkingLevel(envelope.transcript);
  const resolve = (choice: { provider?: string; model?: string }, agentName?: string) =>
    resolveLaunchResources(
      ctx,
      {
        cwd: where.cwd,
        ...(where.projectId ? { projectId: where.projectId } : {}),
        ...choice,
        ...(agentName ? { agentName } : {}),
      },
      defaults,
      {
        version: 1,
        ...(choice.provider ? { providerOverride: choice.provider } : {}),
        ...(choice.model ? { modelOverride: choice.model } : {}),
        ...(thinking ? { thinkingOverride: thinking } : {}),
      },
    );
  const choice = {
    ...(envelope.meta.provider ? { provider: envelope.meta.provider } : {}),
    ...(envelope.meta.model ? { model: envelope.meta.model } : {}),
  };
  let agentName = envelope.meta.agentName;
  let droppedAgent = false;
  let resolved;
  try {
    resolved = resolve(choice, agentName);
  } catch {
    // An agent this side does not have (or disabled): continue as a plain chat.
    if (!agentName) throw new Error("The session's launch settings are not available here.");
    agentName = undefined;
    droppedAgent = true;
    resolved = resolve(choice);
  }
  let launch = {
    launchPlan: resolved.plan as SessionMeta["launchPlan"],
    launchResourceConfig: resolved.config,
    launchResourceFingerprint: resolved.fingerprint,
  };
  const gate = ctx.sessionModelGate;
  if (gate) {
    const probe = {
      id: where.id,
      cwd: where.cwd,
      createdAt: new Date().toISOString(),
      ...(where.sessionFile ? { piSessionFile: where.sessionFile } : {}),
      ...launch,
    } as SessionMeta;
    let pinned: SessionMeta;
    try {
      pinned = await gate.pin(probe, owner);
    } catch (error) {
      throw new TransferModelError((error as Error).message);
    }
    const refusal = await gate.refusal(pinned, owner, options.localCatalog === true);
    if (refusal) throw new TransferModelError(refusal);
    const plan = pinned.launchPlan as LaunchPlan;
    const before = launch.launchPlan as LaunchPlan;
    if (plan.provider !== before.provider || plan.model !== before.model) {
      // A refused model moved to its twin: record it like a launch override.
      const repinned = resolve({ provider: plan.provider, model: plan.model }, agentName);
      launch = {
        launchPlan: repinned.plan as SessionMeta["launchPlan"],
        launchResourceConfig: repinned.config,
        launchResourceFingerprint: repinned.fingerprint,
      };
    }
  }
  return { ...launch, ...(agentName ? { agentName } : {}), droppedAgent };
}

/**
 * Conversation-only move: tell the model (and anyone reading the file) that the
 * device's edits did not come along. Appended as a Pi `custom_message` on the
 * current leaf, which Pi includes in the model context of the next turn.
 */
export function appendImportNotice(transcript: string, notice: string): string {
  const lines = transcript.split("\n").filter((line) => line.trim() !== "");
  let leaf: string | null = null;
  const ids = new Set<string>();
  for (const line of lines.slice(1)) {
    const id = (JSON.parse(line) as { id?: unknown }).id;
    if (typeof id === "string") {
      leaf = id;
      ids.add(id);
    }
  }
  let id = randomUUID().slice(0, 8);
  while (ids.has(id)) id = randomUUID().slice(0, 8);
  const entry = {
    type: "custom_message",
    customType: "agent-deck-import",
    content: notice,
    display: true,
    id,
    parentId: leaf,
    timestamp: new Date().toISOString(),
  };
  return `${lines.join("\n")}\n${JSON.stringify(entry)}\n`;
}

// ---------------------------------------------------------------------------
// SRV-12c3: the export and import steps both directions share. A share runs
// the export on the device and the import on the server; a return runs the
// export on the server (the owner's GitHub connection pushes) and the import on
// the device (its own git login fetches).
// ---------------------------------------------------------------------------

/** How long a prepared move holds the session frozen without being finished. */
export const HANDOFF_TTL_MS = 15 * 60_000;

/** A pushed transfer ref: where, and with which credentials it is deleted again. */
export interface PushedTransfer {
  ref: string;
  root: string;
  env?: Record<string, string>;
}

/** A refused export, with its HTTP answer. */
export interface TransferRefusal {
  status: number;
  body: Record<string, unknown>;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((name, i) => name === right[i]);
};

const refused = (error: string): TransferRefusal => ({
  status: 409,
  body: { code: "share_refused", error },
});

/**
 * Build the envelope of `meta` and, for a snapshot, commit the working tree
 * (tracked changes plus exactly the consented untracked files) and push it to
 * the transfer ref. Everything that can fail is read before anything is pushed;
 * nothing after the push can fail here, so a caller only deletes the ref when
 * its own later step fails.
 */
export async function prepareSessionExport(
  ctx: Pick<ServerContext, "composerDrafts" | "sessionAuthors" | "sessionPastes">,
  meta: SessionMeta,
  options: {
    mode: "snapshot" | "conversation";
    /** The untracked files the user saw and agreed to send (snapshot). */
    untracked?: readonly string[];
    /** The sender's name in the envelope (letters, digits, dot, dash, underscore). */
    device: string;
    /** Credentials for the push (none: the process's own git login). */
    pushEnv?: Record<string, string>;
    /** SRV-12c3: a return names the device session it goes back to. */
    returnTo?: { device: string; localSessionId: string };
    redact?: (text: string) => string;
  },
): Promise<{ envelope: TransferEnvelope; pushed?: PushedTransfer } | TransferRefusal> {
  const id = meta.id;
  const redact = options.redact ?? redactSecrets;
  let transcript: string;
  try {
    if (!meta.piSessionFile) throw new Error("there is no transcript yet");
    if (statSync(meta.piSessionFile).size > MAX_TRANSFER_BYTES) throw new Error("too large");
    transcript = readFileSync(meta.piSessionFile, "utf8");
    checkPiTranscript(transcript);
  } catch (error) {
    return refused(
      (error as Error).message === "too large"
        ? "This session's transcript is larger than 16 MB and cannot move."
        : `This session's transcript cannot move: ${(error as Error).message}.`,
    );
  }
  const plan = meta.launchPlan as LaunchPlan | undefined;
  const model = plan && plan.kind !== "helper" ? plan : undefined;
  let stored;
  try {
    stored = ctx.composerDrafts?.get(id) ?? null;
  } catch {
    return refused("This session's unsent message could not be read.");
  }
  const dropped: string[] = [...ALWAYS_DROPPED];
  if (stored && (stored.files.length > 0 || stored.folders.length > 0))
    dropped.push("draft attachments");
  type Transfer = TransferEnvelope["transfer"];
  const envelope: TransferEnvelope = {
    version: 1,
    localSessionId: id,
    device: options.device,
    ...(options.returnTo
      ? { direction: "return" as const, sharedFrom: { ...options.returnTo } }
      : {}),
    meta: {
      ...(meta.title ? { title: meta.title.slice(0, 200) } : {}),
      ...(meta.titleUserEdited ? { titleUserEdited: true } : {}),
      ...(meta.agentName ? { agentName: meta.agentName } : {}),
      ...(model?.provider ? { provider: model.provider } : {}),
      ...(model?.model ? { model: model.model } : {}),
      ...(meta.subagentsEnabled !== undefined ? { subagentsEnabled: meta.subagentsEnabled } : {}),
      ...(meta.plan?.length
        ? { plan: meta.plan.map(({ runId: _runId, note: _note, ...item }) => item) }
        : {}),
      // SRV-12c3: the device shows the server's open pull request after a return.
      ...(options.returnTo && meta.mergePr
        ? { mergePr: { url: meta.mergePr.url, number: meta.mergePr.number } }
        : {}),
    },
    transcript,
    // exportTurns keeps only turns bound to an entry.
    authors: (ctx.sessionAuthors?.exportTurns(id) ?? []) as TransferEnvelope["authors"],
    pastes: ctx.sessionPastes.exportTurns(id),
    draft: stored ? { ...stored, files: [], folders: [] } : null,
    transfer: { mode: "conversation" },
    dropped,
  };
  // Sized with the longest transfer it can carry, so a push never happens for nothing.
  const longest: Transfer = {
    mode: "snapshot",
    ref: `refs/heads/agent-deck/transfer/${id}`,
    commit: "0".repeat(64),
    baseHead: "0".repeat(64),
  };
  if (Buffer.byteLength(JSON.stringify({ ...envelope, transfer: longest })) > MAX_TRANSFER_BYTES)
    return refused("This session is larger than 16 MB with its attachments and cannot move.");
  if (options.mode === "conversation") return { envelope };

  let sharePlan;
  try {
    sharePlan = await gitSharePlan(meta.cwd);
  } catch (error) {
    return refused(`The session's repository could not be read: ${gitErrorText(error)}`);
  }
  const planChanged = (untracked: string[]): TransferRefusal => ({
    status: 409,
    body: {
      code: "share_plan_changed",
      error: "The untracked files changed since you looked. Check the list again.",
      untracked,
    },
  });
  // The user agreed to a list of untracked files: send that list or ask again.
  if (!options.untracked || !sameSet(options.untracked, sharePlan.untracked))
    return planChanged(sharePlan.untracked);
  if (sharePlan.dirtySubmodules.length > 0)
    return {
      status: 409,
      body: {
        code: "share_snapshot_unavailable",
        error: `Submodules with their own changes cannot travel in a snapshot (${sharePlan.dirtySubmodules.join(", ")}).`,
        fallback: "conversation",
      },
    };
  try {
    // Stages exactly the consented untracked files, or refuses before writing.
    const commit = await gitSnapshotCommit(
      sharePlan.root,
      `agent-deck transfer ${id}`,
      options.untracked,
    );
    // ade-q0pz: the push runs without hooks, so git-lfs would not upload; any doubt refuses.
    const lfs = await gitCarriesLfs(sharePlan.root, {
      tip: commit,
      untracked: options.untracked,
    }).then(
      (found) => (found ? LFS_MOVE_REFUSAL : undefined),
      () => LFS_DETECTION_REFUSAL,
    );
    if (lfs)
      return { status: 409, body: { code: "share_refused", error: lfs, fallback: "conversation" } };
    const ref = await gitPushTransfer(sharePlan.root, commit, id, options.pushEnv);
    envelope.transfer = { mode: "snapshot", ref, commit, baseHead: sharePlan.head };
    return {
      envelope,
      pushed: { ref, root: sharePlan.root, ...(options.pushEnv ? { env: options.pushEnv } : {}) },
    };
  } catch (error) {
    if (error instanceof SnapshotPlanChangedError) {
      const now = await gitSharePlan(meta.cwd).catch(() => sharePlan);
      return planChanged(now.untracked);
    }
    // The working tree was not touched; a share offers the conversation-only move.
    return {
      status: 409,
      body: {
        code: "share_push_failed",
        error: `The snapshot could not be pushed: ${redact(gitErrorText(error)).slice(-1_000)}`,
        fallback: "conversation",
      },
    };
  }
}

/** One prepared move per session: the claim that freezes it, its token and the pushed ref. */
export interface Handoff {
  token: string;
  release: () => void;
  timer: NodeJS.Timeout;
  pushed?: PushedTransfer;
  /** The receiving side's answer is being recorded: nothing may end or replace it now. */
  finalizing?: boolean;
}

/**
 * The hand-offs of one side. A started hand-off holds the session's "share"
 * mutation claim (prompts, delegation and history changes answer
 * session_moving) until it is ended, or until HANDOFF_TTL_MS, which also
 * deletes the pushed ref. Expiry gives way to a finalizing hand-off.
 */
export function createHandoffs(
  fastify: Pick<FastifyInstance, "addHook">,
  claims: SessionMutationClaims,
) {
  const map = new Map<string, Handoff>();
  // SRV-12c3: a ref whose deletion failed is kept here and retried by the next
  // call on the session, until a deletion succeeds.
  const leftovers = new Map<string, PushedTransfer>();
  const dropRef = async (id: string, pushed: PushedTransfer): Promise<boolean> => {
    try {
      await gitDeleteTransferRef(pushed.root, pushed.ref, pushed.env);
      if (leftovers.get(id) === pushed) leftovers.delete(id);
      return true;
    } catch {
      leftovers.set(id, pushed);
      return false;
    }
  };
  const end = (id: string, token?: string, dropPushed = false): boolean => {
    const handoff = map.get(id);
    if (!handoff || (token !== undefined && handoff.token !== token)) return false;
    clearTimeout(handoff.timer);
    map.delete(id);
    handoff.release();
    if (dropPushed && handoff.pushed) void dropRef(id, handoff.pushed);
    return true;
  };
  fastify.addHook("onClose", async () => {
    for (const id of [...map.keys()]) end(id);
  });
  return {
    get: (id: string): Handoff | undefined => map.get(id),
    end,
    /** Delete a pushed ref now; on failure it is kept for the next retry. */
    dropRef,
    /** Retry the deletion of a ref an earlier call could not delete (true: none left). */
    async retryLeftover(id: string): Promise<boolean> {
      const left = leftovers.get(id);
      return left ? dropRef(id, left) : true;
    },
    /** The ref still waiting for its deletion, if any. */
    leftover: (id: string): PushedTransfer | undefined => leftovers.get(id),

    /** Claim the session for a new hand-off; null while another mutation holds it. */
    claim: (id: string) => claims.tryClaim(id, "share"),
    start(id: string, release: () => void, pushed?: PushedTransfer): string {
      const token = randomUUID();
      map.set(id, {
        token,
        release,
        timer: setTimeout(() => {
          if (!map.get(id)?.finalizing) end(id, token, true);
        }, HANDOFF_TTL_MS).unref(),
        ...(pushed ? { pushed } : {}),
      });
      return token;
    },
    /**
     * A retry replaces an unfinished hand-off of the same session, never one
     * being finalized, and never forgets the ref the earlier one pushed.
     * Answers why it cannot, or undefined when the way is clear.
     */
    async replace(id: string): Promise<"finalizing" | "ref_left" | undefined> {
      const previous = map.get(id);
      if (previous?.finalizing) return "finalizing";
      if (previous?.pushed) {
        try {
          await gitDeleteTransferRef(
            previous.pushed.root,
            previous.pushed.ref,
            previous.pushed.env,
          );
        } catch {
          return "ref_left";
        }
      }
      if (previous) {
        if (map.get(id) !== previous || previous.finalizing) return "finalizing";
        end(id, previous.token);
      }
      return undefined;
    },
  };
}

/** A fetch that did not bring the snapshot the envelope names. */
export class TransferFetchError extends Error {
  constructor(
    readonly code: "transfer_fetch_failed" | "transfer_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TransferFetchError";
  }
}

/** Fetch first: the snapshot commit, proven to be the one sent (one parent, the base). */
export async function fetchTransferSnapshot(
  repoDir: string,
  transfer: { ref: string; commit: string; baseHead: string },
  env: Record<string, string>,
): Promise<string> {
  let fetched: string;
  try {
    fetched = await gitFetchTransfer(repoDir, transfer.ref, env);
  } catch (error) {
    throw new TransferFetchError("transfer_fetch_failed", gitErrorText(error));
  }
  const parents = await gitCommitParents(repoDir, fetched).catch(() => []);
  if (fetched !== transfer.commit || parents.length !== 1 || parents[0] !== transfer.baseHead)
    throw new TransferFetchError(
      "transfer_mismatch",
      "The fetched snapshot is not the one this session sent.",
    );
  return fetched;
}

/**
 * A fresh session worktree of `projectPath` (the same allocation as an isolated
 * session), branched from the snapshot with its commit undone (--mixed: edits
 * unstaged, untracked files untracked, as before the snapshot), or from the
 * project HEAD without one. `discard` removes every piece it made; a failure
 * here discards before throwing.
 */
export async function createTransferWorktree(
  ctx: Pick<ServerContext, "sessionWorktreeStore" | "worktreesRoot">,
  projectPath: string,
  snapshot?: { commit: string; baseHead: string },
): Promise<{ worktree: GitWorktree; discard: () => Promise<void> }> {
  const suffix = randomUUID().slice(0, 8);
  const target = nodePath.join(ctx.worktreesRoot, suffix);
  let reservation: string | undefined;
  let worktree: GitWorktree | undefined;
  let attempt: GitWorktree | undefined;
  const discard = async (): Promise<void> => {
    if (!reservation) return;
    const removed = await ctx.sessionWorktreeStore
      .deleteWorktree(target, reservation)
      .then(() => true)
      .catch(() => false);
    const made = worktree ?? attempt;
    if (removed && made) {
      // Prune only a registration proven to be this attempt's.
      const registered = await gitWorktreeRegistrationMatches(
        projectPath,
        target,
        made.branch,
      ).catch(() => false);
      // ade-q0pz: no hook (reference-transaction) runs while cleaning up either.
      await withoutHooks(async (hooks) => {
        if (registered) await gitWorktreePrune(projectPath, hooks).catch(() => {});
        // A failed `git worktree add` still owns the branch it created.
        await gitDeleteOwnedWorktreeBranch(projectPath, made, hooks).catch(() => {});
      }).catch(() => {});
    }
  };
  try {
    const held = ctx.sessionWorktreeStore.reserveWorktree(target);
    reservation = held;
    // ade-q0pz: the snapshot is someone else's code; no hook of it (or of a
    // repository-relative core.hooksPath) runs on checkout or reset.
    const made = await withoutHooks(async (hooks) => {
      worktree = await createSessionWorktreeWithBranchRetries(
        projectPath,
        target,
        `agent-deck/session-${suffix}`,
        held,
        50,
        snapshot?.commit,
        hooks,
      );
      if (snapshot) await gitResetMixedTo(target, snapshot.baseHead, hooks);
      return worktree;
    });
    return { worktree: made, discard };
  } catch (error) {
    if (error instanceof SessionWorktreeAddError) attempt = error.worktree;
    await discard();
    throw error;
  }
}
