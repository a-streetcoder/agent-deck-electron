// A8: the human node (VISION_ORCHESTRATION principle 4: "a human is a node kind too, with
// a timeout policy"). Three existing interactions map onto one node kind in the log:
//   loopApproval  a Human Approval loop run waiting at its checkpoint (POST /loops/runs/:id/resolve)
//   decision      a child's contact_supervisor need_decision / interview_request (POST /supervisor/:id/answer)
//   askUser       the parent's ask_user tool (POST /sessions/:id/asks/:rid/answer) and a Pi
//                 extension's blocking extension_ui_request (the ui_response RPC)
// Events: human.requested (opens), human.answered (who answered, what), human.expired (the
// request's timeout policy fired), human.cancelled (closed without an answer: the waiting
// side gave up, ended, or a person cancelled). The existing events and cards stay; these
// are written next to them. Pure: the server only appends the drafts built here.
//
// Timeout policy, per request, default none (nothing expires that did not before):
//   askUser (ask_user tool)  opt-in `timeoutPolicy` param, at most 4 minutes: Pi's bridge
//                            fetch fails at undici's 300 s headers timeout, so a longer wait
//                            could never fire. "default": the call returns the default as the answer
//                            and the turn continues; "blocked": the call returns timed_out and
//                            the node is marked blocked.
//   askUser (extension UI)   the request's own `timeout` (ms), when the extension sets one:
//                            Pi then resolves the dialog with no answer, so it expires
//                            "blocked". Without one, none.
//   decision                 none: the channel's fixed wait (110 s) closes the request as
//                            cancelled, which the child already receives as an error.
//   loopApproval             none: the checkpoint is durable across restarts, and a timer
//                            would need a stored policy on the loop definition.
// Secrets: free text is redacted (paths, token-like strings) and capped; an MCP sign-in
// paste box's answer is withheld entirely (it is an authorization code).
import { z } from "zod";
import {
  redactPaths,
  redactSecrets,
  type EventActor,
  type EventDraft,
  type EventEnvelope,
  type NodeRef,
  type PathPrefix,
} from "./events.ts";
import type { ExecutionNode, NodeTree } from "./nodeTree.ts";
import { capText, EVENT_LABEL_MAX_CHARS, EVENT_TEXT_MAX_CHARS } from "./turnRefs.ts";

export const HUMAN_KINDS = ["loopApproval", "decision", "askUser"] as const;
export type HumanKind = (typeof HUMAN_KINDS)[number];

export const HUMAN_MAX_OPTIONS = 20;
/**
 * Below Pi's bridge fetch limit: undici's default 300 s headersTimeout fails a longer
 * wait first (the bridge fetch sets none of its own). ask_user's plain `timeout` caps at 290 s.
 */
export const HUMAN_TIMEOUT_MAX_MINUTES = 4;

export type HumanTimeoutPolicy =
  | { type: "none" }
  | { type: "expire"; afterMinutes: number; then: "default"; default: string }
  | { type: "expire"; afterMinutes: number; then: "blocked" };

export const NO_HUMAN_TIMEOUT: HumanTimeoutPolicy = { type: "none" };

/** The agent-facing opt-in (a tool parameter): absent means none. */
export const humanTimeoutPolicyParamSchema = z
  .object({
    afterMinutes: z.number().positive().max(HUMAN_TIMEOUT_MAX_MINUTES),
    then: z.enum(["default", "blocked"]),
    default: z.string().trim().min(1).max(EVENT_TEXT_MAX_CHARS).optional(),
  })
  .strict()
  .refine((value) => value.then !== "default" || value.default !== undefined, {
    message: 'then: "default" requires a default answer',
    path: ["default"],
  });

export type HumanTimeoutPolicyParam = z.infer<typeof humanTimeoutPolicyParamSchema>;

export function humanTimeoutPolicy(param: HumanTimeoutPolicyParam | undefined): HumanTimeoutPolicy {
  if (!param) return NO_HUMAN_TIMEOUT;
  return param.then === "default"
    ? { type: "expire", afterMinutes: param.afterMinutes, then: "default", default: param.default! }
    : { type: "expire", afterMinutes: param.afterMinutes, then: "blocked" };
}

/** Milliseconds until the policy expires the request, or undefined for none. */
export function humanTimeoutMs(policy: HumanTimeoutPolicy): number | undefined {
  return policy.type === "expire" ? Math.round(policy.afterMinutes * 60_000) : undefined;
}

/** Where the node sits and which filters find it. */
export interface HumanNodeRef {
  id: string;
  sessionId?: string;
  projectId?: string;
}

export interface HumanRequest extends HumanNodeRef {
  kind: HumanKind;
  /** Uncapped, unredacted: the draft builder cleans it. */
  prompt: string;
  options?: string[];
  timeoutPolicy?: HumanTimeoutPolicy;
  /** The tree parent (loop run, subagent run, turn); the server fills a session turn. */
  parent?: NodeRef;
  /** Who asks: an agent session, or the system (a loop checkpoint). */
  actor: EventActor;
  causationId?: string;
  /** Hide the answer from the log (an MCP sign-in code). */
  withholdAnswer?: true;
}

export interface HumanRequestedPayload {
  kind: HumanKind;
  prompt: string;
  options?: string[];
  timeoutPolicy: HumanTimeoutPolicy;
  /** ISO time the policy expires the request (requestedAt + afterMinutes). */
  expiresAt?: string;
  withholdAnswer?: true;
}

export interface HumanAnsweredPayload {
  by: EventActor;
  answer: string;
}

export interface HumanExpiredPayload {
  then: "default" | "blocked";
  /** The default that answered the request ("default" only). */
  answer?: string;
}

export interface HumanCancelledPayload {
  reason: string;
}

export interface HumanDraftOptions {
  pathPrefixes?: readonly PathPrefix[];
}

export const WITHHELD_ANSWER = "<withheld>";

const clean = (text: string, max: number, options: HumanDraftOptions): string =>
  capText(redactSecrets(redactPaths(text, options.pathPrefixes)), max);

const SYSTEM: EventActor = { type: "system" };

const base = (ref: HumanNodeRef) => ({
  ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
  ...(ref.projectId ? { projectId: ref.projectId } : {}),
  subject: { type: "human", id: ref.id } as NodeRef,
});

export function humanRequestedDraft(
  request: HumanRequest,
  requestedAt: Date,
  options: HumanDraftOptions = {},
): EventDraft {
  const policy = request.timeoutPolicy ?? NO_HUMAN_TIMEOUT;
  const ms = humanTimeoutMs(policy);
  const payload: HumanRequestedPayload = {
    kind: request.kind,
    prompt: clean(request.prompt, EVENT_TEXT_MAX_CHARS, options),
    ...(request.options?.length
      ? {
          options: request.options
            .slice(0, HUMAN_MAX_OPTIONS)
            .map((option) => clean(option, EVENT_LABEL_MAX_CHARS, options)),
        }
      : {}),
    timeoutPolicy:
      policy.type === "expire" && policy.then === "default"
        ? { ...policy, default: clean(policy.default, EVENT_TEXT_MAX_CHARS, options) }
        : policy,
    ...(ms !== undefined ? { expiresAt: new Date(requestedAt.getTime() + ms).toISOString() } : {}),
    ...(request.withholdAnswer ? { withholdAnswer: true as const } : {}),
  };
  return {
    ...base(request),
    kind: "human.requested",
    ...(request.parent ? { parent: request.parent } : {}),
    actor: request.actor,
    ...(request.causationId ? { causationId: request.causationId } : {}),
    payload,
  };
}

/** `by` is the person (or agent) who answered; on the shared server, any member. */
export function humanAnsweredDraft(
  ref: HumanNodeRef,
  by: EventActor,
  answer: string,
  options: HumanDraftOptions & { withhold?: boolean } = {},
): EventDraft {
  const payload: HumanAnsweredPayload = {
    by,
    answer: options.withhold ? WITHHELD_ANSWER : clean(answer, EVENT_TEXT_MAX_CHARS, options),
  };
  return { ...base(ref), kind: "human.answered", actor: by, payload };
}

export function humanExpiredDraft(
  ref: HumanNodeRef,
  policy: Extract<HumanTimeoutPolicy, { type: "expire" }>,
  options: HumanDraftOptions = {},
): EventDraft {
  const payload: HumanExpiredPayload =
    policy.then === "default"
      ? { then: "default", answer: clean(policy.default, EVENT_TEXT_MAX_CHARS, options) }
      : { then: "blocked" };
  return { ...base(ref), kind: "human.expired", actor: SYSTEM, payload };
}

export function humanCancelledDraft(
  ref: HumanNodeRef,
  reason: string,
  actor: EventActor = SYSTEM,
  options: HumanDraftOptions = {},
): EventDraft {
  const payload: HumanCancelledPayload = { reason: clean(reason, EVENT_LABEL_MAX_CHARS, options) };
  return { ...base(ref), kind: "human.cancelled", actor, payload };
}

// ---------------------------------------------------------------------------
// The three request shapes

/** A Human Approval loop run at its checkpoint (LoopRun, structurally). */
export function humanFromLoopApproval(run: {
  id: string;
  checkpointPrompt?: string;
  loopName?: string;
  projectId?: string;
  sessionId?: string;
}): HumanRequest {
  return {
    id: run.id,
    kind: "loopApproval",
    prompt: run.checkpointPrompt ?? run.loopName ?? "Approval checkpoint",
    options: ["approve", "reject"],
    ...(run.projectId ? { projectId: run.projectId } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    parent: { type: "loopRun", id: run.id },
    actor: SYSTEM,
  };
}

/** A blocking supervisor request (need_decision / interview_request) from a child run. */
export function humanFromSupervisor(
  request: {
    id: string;
    parentSessionId: string;
    cellId: string;
    title?: string;
    message: string;
  },
  childSessionId: string,
  options?: readonly string[],
): HumanRequest {
  return {
    id: request.id,
    kind: "decision",
    prompt: request.title ? `${request.title}\n\n${request.message}` : request.message,
    ...(options?.length ? { options: [...options] } : {}),
    sessionId: request.parentSessionId,
    parent: { type: "subagentRun", id: request.cellId },
    actor: { type: "agent", sessionId: childSessionId },
    causationId: request.id,
  };
}

/** The parent's ask_user tool (AskUserCell, structurally). */
export function humanFromAskUser(
  cell: {
    requestId: string;
    sessionId: string;
    question: string;
    context?: string;
    options: readonly { title: string }[];
  },
  timeoutPolicy?: HumanTimeoutPolicy,
): HumanRequest {
  return {
    id: cell.requestId,
    kind: "askUser",
    prompt: cell.context ? `${cell.question}\n\n${cell.context}` : cell.question,
    ...(cell.options.length ? { options: cell.options.map((option) => option.title) } : {}),
    ...(timeoutPolicy ? { timeoutPolicy } : {}),
    sessionId: cell.sessionId,
    actor: { type: "agent", sessionId: cell.sessionId },
  };
}

const MCP_SIGN_IN = /^Waiting for sign-in to "/;

/** The node id of a Pi extension UI request: Pi's ids are only unique per process. */
export const extensionUiHumanId = (sessionId: string, requestId: string): string =>
  `${sessionId}/ui/${requestId}`;

/** A Pi extension's blocking extension_ui_request (select / confirm / input / editor). */
export function humanFromExtensionUi(
  sessionId: string,
  request: {
    id: string;
    method: string;
    title?: string;
    message?: string;
    options?: string[];
    timeout?: number;
  },
): HumanRequest {
  const title = request.title ?? request.method;
  const timeout = request.timeout;
  return {
    id: extensionUiHumanId(sessionId, request.id),
    kind: "askUser",
    prompt: request.message ? `${title}\n\n${request.message}` : title,
    ...(request.method === "select" && request.options?.length
      ? { options: request.options }
      : request.method === "confirm"
        ? { options: ["yes", "no"] }
        : {}),
    ...(typeof timeout === "number" && timeout > 0
      ? {
          timeoutPolicy: {
            type: "expire" as const,
            afterMinutes: timeout / 60_000,
            then: "blocked" as const,
          },
        }
      : {}),
    sessionId,
    actor: { type: "agent", sessionId },
    ...(request.method === "input" && MCP_SIGN_IN.test(title)
      ? { withholdAnswer: true as const }
      : {}),
  };
}

/** The answer text of an ask_user answer (AskUserAnswer, structurally). */
export function askUserAnswerText(answer: {
  selections: readonly string[];
  freeform?: string;
  comment?: string;
}): string {
  const main = answer.selections.length ? answer.selections.join(", ") : (answer.freeform ?? "");
  return answer.comment ? `${main}\n\nComment: ${answer.comment}` : main;
}

/** The answer text of an extension_ui_response, or undefined for a cancellation. */
export function extensionUiAnswerText(response: {
  cancelled?: unknown;
  confirmed?: unknown;
  value?: unknown;
}): string | undefined {
  if (response.cancelled === true) return undefined;
  if (typeof response.confirmed === "boolean") return response.confirmed ? "yes" : "no";
  return typeof response.value === "string" ? response.value : undefined;
}

// ---------------------------------------------------------------------------
// Readers

/** Open (pending) human nodes of a tree, oldest request first: what waits on a person. */
export function openHumanNodes(tree: NodeTree): ExecutionNode[] {
  return [...tree.nodes.values()]
    .filter((node) => node.ref.type === "human" && node.status === "pending")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

const KIND_LABEL: Record<string, string> = {
  loopApproval: "Loop approval",
  decision: "Decision",
  askUser: "Question",
};

export const humanKindLabel = (kind: string | undefined): string =>
  (kind && KIND_LABEL[kind]) ?? "Human";

/** An open human request as the server lists it (GET /events/open-human). */
export interface OpenHumanRequest extends HumanRequestedPayload {
  id: string;
  projectId: string | null;
  sessionId?: string;
  /** Who asked. */
  actor: EventActor;
  requestedAt: string;
}

/** Envelope fields the open-request fold reads (EventEnvelope is a superset). */
type HumanFoldEvent = Pick<EventEnvelope, "kind" | "ts" | "subject" | "actor" | "payload"> &
  Partial<Pick<EventEnvelope, "projectId" | "sessionId">>;

/**
 * Open human requests over the whole log, independent of any tail (a durable loop
 * approval may be weeks old). Settled ones drop out; a restart or writer takeover
 * drops every memory-only one (all kinds but loopApproval); a removed loop run drops
 * its approval. Extends a copy of initial.
 */
export function projectOpenHumanRequests(
  events: Iterable<HumanFoldEvent>,
  initial: Iterable<[string, OpenHumanRequest]> = [],
): Map<string, OpenHumanRequest> {
  const open = new Map(initial);
  for (const event of events) {
    if (event.kind === "server.started" || event.kind === "writer.acquired") {
      for (const [id, request] of open) if (request.kind !== "loopApproval") open.delete(id);
    } else if (event.kind === "loop.run.removed") {
      open.delete(event.subject.id);
    } else if (event.subject.type !== "human") {
      continue;
    } else if (event.kind === "human.requested") {
      const payload = event.payload as HumanRequestedPayload;
      if (!payload || !(HUMAN_KINDS as readonly string[]).includes(payload.kind)) continue;
      open.set(event.subject.id, {
        ...payload,
        id: event.subject.id,
        projectId: event.projectId ?? null,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        actor: event.actor,
        requestedAt: event.ts,
      });
    } else if (
      event.kind === "human.answered" ||
      event.kind === "human.expired" ||
      event.kind === "human.cancelled"
    ) {
      open.delete(event.subject.id);
    }
  }
  return open;
}
