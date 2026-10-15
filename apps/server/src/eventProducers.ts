// A1b1 simple producers (VISION_ORCHESTRATION principle 1): each store or route
// calls one of these at its own commit point; nothing here subscribes to the push
// bus. Payloads are whitelisted public projections: facts and references. Free
// text is redacted (paths, token-like strings) and capped; prompts only ever
// appear as a short label (eventProducers.test.ts scans the result).
import { randomUUID } from "node:crypto";
import type { SessionMeta, SessionPlanEvent } from "@agent-deck/contracts";
import {
  capText,
  EVENT_LABEL_MAX_CHARS,
  EVENT_TEXT_MAX_CHARS,
  eventLabel,
  MAX_PLAN_EVENT_ITEMS,
  PROMPT_LABEL_MAX_CHARS,
  redactPaths,
  redactSecrets,
  type EventActor,
  type EventDraft,
  type NodeRef,
  type PathPrefix,
} from "@agent-deck/domain";
import type { EventLog } from "./eventLog.ts";
import type { CheckpointRecord } from "./services/checkpoints.ts";
import type { PlanChangeOperation } from "./services/planEvents.ts";
import type { SessionTurnEvents, TurnContext } from "./services/sessionManager.ts";
import type { SupervisorRequest } from "./supervisor.ts";

const ACTOR_FIELD_MAX = 320;

export type PromptMode = "prompt" | "steer" | "follow_up";
export type LoopUserAction = "start" | "stop" | "apply" | "discard";

/** What the RPC handler holds after turn.prompted: Pi refused the message. */
export interface PromptAttempt {
  rejected(): void;
}

export interface EventProducers {
  sessionCreated(meta: SessionMeta, actor: EventActor, forkedFrom?: string): void;
  sessionRemoved(meta: Pick<SessionMeta, "id" | "projectId">, actor: EventActor): void;
  /** Before Pi sees the message; a steer or follow-up joins the turn still running. */
  turnPrompted(sessionId: string, actor: EventActor, mode: PromptMode, text: string): PromptAttempt;
  /** The live session's turn boundaries and completions (SessionManager calls them). */
  turnHooks(meta: SessionMeta): SessionTurnEvents;
  /**
   * reconcile: a store event the log missed (A1d import), with the id of the store entry
   * it follows; keeps the store's `at`.
   */
  planChanged(
    sessionId: string,
    op: PlanChangeOperation,
    event: SessionPlanEvent,
    reconcile?: { afterId?: string },
  ): void;
  /** A5: the server dispatched a ready plan item to a subagent run; false when not logged. */
  planItemDispatched(
    sessionId: string,
    dispatch: { itemId: string; runId: string; agentName: string },
    causationId?: string,
  ): boolean;
  checkpointCreated(
    sessionId: string,
    record: CheckpointRecord,
    options?: { actor?: EventActor; turn?: TurnContext },
  ): void;
  checkpointRolledBack(
    sessionId: string,
    target: CheckpointRecord,
    safety: CheckpointRecord | null,
    actor: EventActor,
  ): void;
  /** A blocking request opens; a progress_update is recorded (it is not a request). */
  supervisorOpened(request: SupervisorRequest, childSessionId: string): void;
  supervisorAnswered(request: SupervisorRequest, actor: EventActor): void;
  supervisorCancelled(request: SupervisorRequest): void;
  loopUserAction(
    runId: string,
    projectId: string | undefined,
    action: LoopUserAction,
    actor: EventActor,
  ): void;
}

export interface EventProducerOptions {
  randomId?: () => string;
  /** Known absolute roots to replace in free text (data dir, home, project roots). */
  pathPrefixes?: () => readonly PathPrefix[];
}

/** The person behind a request; anonymous on the desktop (loopback, no identity). */
export function userActor(user?: { id: string; name?: string }): EventActor {
  if (!user) return { type: "user" };
  return {
    type: "user",
    id: capText(user.id, ACTOR_FIELD_MAX),
    ...(user.name ? { name: capText(user.name, ACTOR_FIELD_MAX) } : {}),
  };
}

const SYSTEM: EventActor = { type: "system" };

const agentActor = (sessionId: string, agentName?: string): EventActor => ({
  type: "agent",
  sessionId,
  ...(agentName ? { agentName: capText(agentName, ACTOR_FIELD_MAX) } : {}),
});

const checkpointRef = (sessionId: string, turnIndex: number): NodeRef => ({
  type: "checkpoint",
  id: `${sessionId}/${turnIndex}`,
});

interface SessionTurns {
  /** Prompted over RPC, not yet taken by Pi (oldest first). */
  queued: TurnContext[];
  /** The turn Pi is working on; cleared when it ends. */
  active?: TurnContext;
}

export function createEventProducers(
  log: EventLog,
  options: EventProducerOptions = {},
): EventProducers {
  const randomId = options.randomId ?? randomUUID;
  const pathPrefixes = options.pathPrefixes ?? (() => []);
  const clean = (text: string, max: number): string =>
    capText(redactSecrets(redactPaths(text, pathPrefixes())), max);
  const label = (text: string): string =>
    capText(redactSecrets(redactPaths(eventLabel(text), pathPrefixes())), PROMPT_LABEL_MAX_CHARS);

  // Memory only: a restart loses the running turn, so its later events carry no cause.
  // ponytail: one entry per session ever prompted, dropped on removal.
  const sessions = new Map<string, SessionTurns>();
  const turnsOf = (sessionId: string): SessionTurns => {
    let turns = sessions.get(sessionId);
    if (!turns) {
      turns = { queued: [] };
      sessions.set(sessionId, turns);
    }
    return turns;
  };
  /** Synchronous agent work (plan, supervisor) follows the turn Pi is acting on, never a queued one. */
  const causeOf = (sessionId: string): { causationId?: string } => {
    const id = sessions.get(sessionId)?.active?.promptEventId;
    return id ? { causationId: id } : {};
  };
  const causedBy = (turn: TurnContext | undefined): { causationId?: string } =>
    turn?.promptEventId ? { causationId: turn.promptEventId } : {};
  const append = (draft: EventDraft): void => {
    log.append(draft);
  };

  const supervisorPayload = (request: SupervisorRequest) => ({
    id: request.id,
    parentSessionId: request.parentSessionId,
    cellId: request.cellId,
    method: request.method,
    ...(request.title ? { title: clean(request.title, EVENT_LABEL_MAX_CHARS) } : {}),
    message: clean(request.message, EVENT_TEXT_MAX_CHARS),
    status: request.status,
    createdAt: request.createdAt,
  });
  /** CheckpointInfo plus gitRef: never sessionSnapshotPath, cwd or source-file identity. */
  const checkpointPayload = (record: CheckpointRecord) => ({
    turnIndex: record.turnIndex,
    createdAt: record.createdAt,
    label: label(record.label),
    hasFiles: record.hasFiles,
    gitRef: record.gitRef,
  });

  return {
    sessionCreated(meta, actor, forkedFrom) {
      append({
        kind: "session.created",
        sessionId: meta.id,
        projectId: meta.projectId ?? null,
        subject: { type: "session", id: meta.id },
        ...(forkedFrom ? { parent: { type: "session", id: forkedFrom } } : {}),
        actor,
        payload: {
          ...(meta.title ? { title: label(meta.title) } : {}),
          ...(meta.agentName ? { agentName: clean(meta.agentName, EVENT_LABEL_MAX_CHARS) } : {}),
          ...(meta.createdBy ? { createdBy: userActor(meta.createdBy) } : {}),
        },
      });
    },

    sessionRemoved(meta, actor) {
      sessions.delete(meta.id);
      append({
        kind: "session.removed",
        sessionId: meta.id,
        projectId: meta.projectId ?? null,
        subject: { type: "session", id: meta.id },
        actor,
        payload: {},
      });
    },

    turnPrompted(sessionId, actor, mode, text) {
      const id = randomId();
      const turns = turnsOf(sessionId);
      // The turn a steer or follow-up joins: the newest one prompted or running.
      const running = turns.queued.at(-1) ?? turns.active;
      const joins = mode !== "prompt" && running !== undefined;
      const context: TurnContext = {
        turnId: joins ? running.turnId : id,
        promptEventId: id,
        label: joins && running.label !== undefined ? running.label : label(text),
      };
      turns.queued.push(context);
      append({
        id,
        kind: "turn.prompted",
        sessionId,
        subject: { type: "turn", id: context.turnId },
        ...(joins ? {} : { parent: { type: "session", id: sessionId } }),
        actor,
        payload: { mode, label: label(text) },
      });
      return {
        rejected() {
          // Pi never took it: the active and queued turns stay as they were.
          const index = turns.queued.indexOf(context);
          if (index !== -1) turns.queued.splice(index, 1);
          append({
            kind: "turn.rejected",
            sessionId,
            subject: { type: "turn", id: context.turnId },
            actor: SYSTEM,
            causationId: id,
            payload: { mode },
          });
        },
      };
    },

    turnHooks(meta) {
      return {
        consumed() {
          const turns = turnsOf(meta.id);
          const next = turns.queued.shift();
          // A user message nobody prompted over RPC (a loop, a REST prompt) opens its
          // own turn when none is running, and otherwise belongs to the running one.
          if (next) turns.active = next;
          else turns.active ??= { turnId: randomId() };
        },
        current() {
          return sessions.get(meta.id)?.active;
        },
        end() {
          const turns = sessions.get(meta.id);
          const ended = turns?.active;
          if (turns) turns.active = undefined;
          return ended;
        },
        completed(turn, context, child) {
          const partial = {
            ...(turn.partial ? { partial: true } : {}),
            ...(turn.outcome ? { outcome: turn.outcome } : {}),
          };
          const refs = { entryIds: turn.entryIds, toolCalls: turn.toolCalls };
          if (child) {
            append({
              kind: "session.turn.completed",
              projectId: meta.projectId ?? null,
              subject: { type: "turn", id: randomId() },
              parent: { type: "subagentRun", id: child.subagentRunId },
              actor: agentActor(child.childSessionId, child.agentName),
              ...causedBy(context),
              payload: { ...refs, label: label(child.task), ...partial },
            });
            return;
          }
          // An unprompted turn's node starts here; a prompted one at its turn.prompted.
          const opens = !context?.promptEventId;
          append({
            kind: "session.turn.completed",
            sessionId: meta.id,
            projectId: meta.projectId ?? null,
            subject: { type: "turn", id: context?.turnId ?? randomId() },
            ...(opens ? { parent: { type: "session", id: meta.id } } : {}),
            actor: agentActor(meta.id, meta.agentName),
            ...causedBy(context),
            payload: { ...refs, label: context?.label ?? label(turn.label), ...partial },
          });
        },
      };
    },

    planChanged(sessionId, op, event, reconcile) {
      const system = op === "restore" || reconcile !== undefined;
      append({
        // The store's own id: A1d compares the projection with the store exactly.
        id: event.id,
        kind: "plan.changed",
        sessionId,
        subject: { type: "plan", id: sessionId },
        // A restore republishes a plan the session already had (reopen or fork).
        actor: system ? SYSTEM : agentActor(sessionId),
        ...(system ? {} : causeOf(sessionId)),
        ...(reconcile ? { origin: "reconcile" as const } : {}),
        payload: {
          kind: event.kind,
          ...(reconcile ? { at: event.at } : {}),
          ...(reconcile?.afterId ? { afterId: reconcile.afterId } : {}),
          items: event.items.slice(0, MAX_PLAN_EVENT_ITEMS).map((item) => ({
            id: capText(item.id, EVENT_LABEL_MAX_CHARS),
            title: clean(item.title, EVENT_LABEL_MAX_CHARS),
            status: item.status,
            // A5: graph fields are ids and agent names, capped like ids.
            ...(item.dependsOn
              ? {
                  dependsOn: item.dependsOn
                    .slice(0, MAX_PLAN_EVENT_ITEMS)
                    .map((id) => capText(id, EVENT_LABEL_MAX_CHARS)),
                }
              : {}),
            ...(item.assignee ? { assignee: capText(item.assignee, ACTOR_FIELD_MAX) } : {}),
            ...(item.verifiedBy ? { verifiedBy: capText(item.verifiedBy, ACTOR_FIELD_MAX) } : {}),
            ...(item.runId ? { runId: capText(item.runId, EVENT_LABEL_MAX_CHARS) } : {}),
          })),
        },
      });
    },

    planItemDispatched(sessionId, dispatch, causationId) {
      return log.append({
        kind: "plan.item.dispatched",
        sessionId,
        subject: { type: "plan", id: sessionId },
        // On behalf of the agent that set the plan (the dispatcher only runs its plans).
        actor: agentActor(sessionId),
        ...(causationId ? { causationId } : {}),
        payload: {
          itemId: capText(dispatch.itemId, EVENT_LABEL_MAX_CHARS),
          runId: dispatch.runId,
          agentName: capText(dispatch.agentName, ACTOR_FIELD_MAX),
        },
      }).ok;
    },

    checkpointCreated(sessionId, record, { actor = SYSTEM, turn } = {}) {
      append({
        kind: "checkpoint.created",
        sessionId,
        subject: checkpointRef(sessionId, record.turnIndex),
        parent: turn ? { type: "turn", id: turn.turnId } : { type: "session", id: sessionId },
        actor,
        ...causedBy(turn),
        payload: checkpointPayload(record),
      });
    },

    checkpointRolledBack(sessionId, target, safety, actor) {
      append({
        kind: "checkpoint.rolledBack",
        sessionId,
        subject: checkpointRef(sessionId, target.turnIndex),
        actor,
        payload: {
          ...checkpointPayload(target),
          safetyTurnIndex: safety ? safety.turnIndex : null,
        },
      });
    },

    supervisorOpened(request, childSessionId) {
      const progress = request.method === "progress_update";
      append({
        id: request.id,
        kind: progress ? "supervisor.progress.recorded" : "supervisor.request.opened",
        sessionId: request.parentSessionId,
        subject: { type: "supervisorRequest", id: request.id },
        parent: { type: "subagentRun", id: request.cellId },
        actor: agentActor(childSessionId),
        ...causeOf(request.parentSessionId),
        payload: supervisorPayload(request),
      });
    },

    supervisorAnswered(request, actor) {
      append({
        kind: "supervisor.request.answered",
        sessionId: request.parentSessionId,
        subject: { type: "supervisorRequest", id: request.id },
        actor,
        causationId: request.id,
        payload: { id: request.id, response: clean(request.response ?? "", EVENT_TEXT_MAX_CHARS) },
      });
    },

    supervisorCancelled(request) {
      append({
        kind: "supervisor.request.cancelled",
        sessionId: request.parentSessionId,
        subject: { type: "supervisorRequest", id: request.id },
        actor: SYSTEM,
        causationId: request.id,
        // `response`, as in SupervisorRequest: the cancellation reason.
        payload: { id: request.id, response: clean(request.response ?? "", EVENT_TEXT_MAX_CHARS) },
      });
    },

    loopUserAction(runId, projectId, action, actor) {
      append({
        kind: "loop.run.userAction",
        projectId: projectId ?? null,
        subject: { type: "loopRun", id: runId },
        actor,
        payload: { action },
      });
    },
  };
}
