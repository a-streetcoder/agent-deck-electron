// A1b1 simple producers (VISION_ORCHESTRATION principle 1): each store or route
// calls one of these at its own commit point; nothing here subscribes to the push
// bus. Payloads are whitelisted public projections with capped strings: never a
// path, a capability token or raw tool output (eventProducers.test.ts scans them).
import { randomUUID } from "node:crypto";
import type { SessionMeta, SessionPlanEvent } from "@agent-deck/contracts";
import {
  capText,
  EVENT_LABEL_MAX_CHARS,
  EVENT_TEXT_MAX_CHARS,
  eventLabel,
  type EventActor,
  type EventDraft,
  type NodeRef,
  type TurnRefs,
} from "@agent-deck/domain";
import type { EventLog } from "./eventLog.ts";
import type { CheckpointRecord } from "./services/checkpoints.ts";
import type { PlanChangeOperation } from "./services/planEvents.ts";
import type { SupervisorRequest } from "./supervisor.ts";

const MAX_PLAN_ITEMS = 200;
const ACTOR_FIELD_MAX = 320;

export type PromptMode = "prompt" | "steer" | "follow_up";
export type LoopUserAction = "start" | "stop" | "apply" | "discard";

/** A delegated child's turn: no session index row, so its project comes from the parent. */
export interface ChildTurn {
  parentSessionId: string;
  projectId?: string;
  subagentRunId: string;
  childSessionId: string;
  agentName?: string;
}

export interface EventProducers {
  sessionCreated(meta: SessionMeta, actor: EventActor, forkedFrom?: string): void;
  sessionRemoved(meta: Pick<SessionMeta, "id" | "projectId">, actor: EventActor): void;
  turnPrompted(sessionId: string, actor: EventActor, mode: PromptMode, text: string): void;
  turnCompleted(meta: SessionMeta, turn: TurnRefs, child?: ChildTurn): void;
  planChanged(sessionId: string, op: PlanChangeOperation, event: SessionPlanEvent): void;
  checkpointCreated(sessionId: string, record: CheckpointRecord, actor?: EventActor): void;
  checkpointRolledBack(
    sessionId: string,
    target: CheckpointRecord,
    safety: CheckpointRecord | null,
    actor: EventActor,
  ): void;
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

/** CheckpointInfo plus gitRef: never sessionSnapshotPath, cwd or source-file identity. */
const checkpointPayload = (record: CheckpointRecord) => ({
  turnIndex: record.turnIndex,
  createdAt: record.createdAt,
  label: capText(record.label, EVENT_LABEL_MAX_CHARS),
  hasFiles: record.hasFiles,
  gitRef: record.gitRef,
});

const supervisorPayload = (request: SupervisorRequest) => ({
  id: request.id,
  parentSessionId: request.parentSessionId,
  cellId: request.cellId,
  method: request.method,
  ...(request.title ? { title: capText(request.title, EVENT_LABEL_MAX_CHARS) } : {}),
  message: capText(request.message, EVENT_TEXT_MAX_CHARS),
  status: request.status,
  createdAt: request.createdAt,
});

interface TurnState {
  turnId: string;
  promptEventId: string;
  completed: boolean;
}

export function createEventProducers(
  log: EventLog,
  randomId: () => string = randomUUID,
): EventProducers {
  // The prompting user event of each session's current turn: later agent and system
  // events of that turn carry it as causationId. Memory only; a restart loses it.
  // ponytail: one entry per session ever prompted, dropped on removal.
  const turns = new Map<string, TurnState>();
  const causeOf = (sessionId: string): { causationId?: string } => {
    const turn = turns.get(sessionId);
    return turn ? { causationId: turn.promptEventId } : {};
  };
  const append = (draft: EventDraft): void => {
    log.append(draft);
  };

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
          ...(meta.title ? { title: capText(meta.title, EVENT_LABEL_MAX_CHARS) } : {}),
          ...(meta.agentName ? { agentName: capText(meta.agentName, EVENT_LABEL_MAX_CHARS) } : {}),
          ...(meta.createdBy ? { createdBy: userActor(meta.createdBy) } : {}),
        },
      });
    },

    sessionRemoved(meta, actor) {
      turns.delete(meta.id);
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
      // A steer or follow-up joins a turn still running; a prompt opens a new one.
      const running = turns.get(sessionId);
      const turnId = mode !== "prompt" && running && !running.completed ? running.turnId : id;
      turns.set(sessionId, { turnId, promptEventId: id, completed: false });
      append({
        id,
        kind: "turn.prompted",
        sessionId,
        subject: { type: "turn", id: turnId },
        parent: { type: "session", id: sessionId },
        actor,
        payload: { mode, label: eventLabel(text) },
      });
    },

    turnCompleted(meta, turn, child) {
      const payload = { entryIds: turn.entryIds, toolCalls: turn.toolCalls, label: turn.label };
      if (child) {
        append({
          kind: "session.turn.completed",
          projectId: child.projectId ?? null,
          subject: { type: "turn", id: randomId() },
          parent: { type: "subagentRun", id: child.subagentRunId },
          actor: agentActor(child.childSessionId, child.agentName),
          ...causeOf(child.parentSessionId),
          payload,
        });
        return;
      }
      // A turn nobody prompted through the RPC handler (a loop, a resume) is its own node.
      const current = turns.get(meta.id);
      const opensTurn = !current || current.completed;
      const turnId = opensTurn ? randomId() : current.turnId;
      if (current && !opensTurn) current.completed = true;
      append({
        kind: "session.turn.completed",
        sessionId: meta.id,
        projectId: meta.projectId ?? null,
        subject: { type: "turn", id: turnId },
        ...(opensTurn ? { parent: { type: "session", id: meta.id } } : {}),
        actor: agentActor(meta.id, meta.agentName),
        ...(opensTurn ? {} : causeOf(meta.id)),
        payload,
      });
    },

    planChanged(sessionId, op, event) {
      append({
        kind: "plan.changed",
        sessionId,
        subject: { type: "plan", id: sessionId },
        // A restore republishes a plan the session already had (reopen or fork).
        actor: op === "restore" ? SYSTEM : agentActor(sessionId),
        ...(op === "restore" ? {} : causeOf(sessionId)),
        payload: {
          kind: event.kind,
          items: event.items.slice(0, MAX_PLAN_ITEMS).map((item) => ({
            id: capText(item.id, EVENT_LABEL_MAX_CHARS),
            title: capText(item.title, EVENT_TEXT_MAX_CHARS),
            status: item.status,
          })),
        },
      });
    },

    checkpointCreated(sessionId, record, actor = SYSTEM) {
      const turn = turns.get(sessionId);
      append({
        kind: "checkpoint.created",
        sessionId,
        subject: checkpointRef(sessionId, record.turnIndex),
        parent: turn ? { type: "turn", id: turn.turnId } : { type: "session", id: sessionId },
        actor,
        ...(actor.type === "system" ? causeOf(sessionId) : {}),
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
      append({
        id: request.id,
        kind: "supervisor.request.opened",
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
        payload: {
          id: request.id,
          response: capText(request.response ?? "", EVENT_TEXT_MAX_CHARS),
        },
      });
    },

    supervisorCancelled(request) {
      append({
        kind: "supervisor.request.cancelled",
        sessionId: request.parentSessionId,
        subject: { type: "supervisorRequest", id: request.id },
        actor: SYSTEM,
        causationId: request.id,
        payload: { id: request.id, reason: capText(request.response ?? "", EVENT_LABEL_MAX_CHARS) },
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
