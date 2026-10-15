import { randomUUID } from "node:crypto";
import { mergePlanHistory, type ProjectedPlanChange } from "@agent-deck/domain";
import type {
  SessionPlanEvent,
  SessionPlanEventKind,
  SessionPlanItem,
} from "@agent-deck/contracts";
import { Effect } from "effect";
import { makeKeyedJsonStoreHandle } from "./persistence.ts";

/**
 * SUB-14 — a durable history of how each session's plan evolved, ported from
 * native's `PiAgentSessionStore.appendPlanEvent`.
 *
 * The session itself only ever holds the CURRENT plan (`meta.plan`), so once a
 * plan is replaced there is otherwise no record that the earlier one existed.
 *
 * This deliberately does NOT live on `SessionMeta`. Meta is republished to every
 * subscribed client on every metadata change, and a hundred full plan snapshots
 * would ride along with each one. A keyed store keeps the history off the
 * broadcast path, the way checkpoints already do.
 */

/** Native caps each session's history at `events.suffix(100)`. */
const MAX_EVENTS_PER_SESSION = 100;

export interface PlanEventServiceOptions {
  readonly dataDir: string;
  readonly maxPerSession?: number;
  /** A1 event log: called once per recorded event, after the store write. */
  readonly onRecorded?: (
    event: SessionPlanEvent,
    op: PlanChangeOperation,
    causationId?: string,
  ) => void;
  /** A1d: the log's plan projection for a session; undefined = read the store alone. */
  readonly readLog?: (sessionId: string) => readonly ProjectedPlanChange[] | undefined;
}

/**
 * Which plan operation ran — the same distinction native draws by method, plus
 * `system`, an update the server wrote (the A5 dispatcher), and
 * `restore`, which republishes a plan the session already had (reopening one)
 * or hands an inherited plan to a brand-new session (forking one).
 */
export type PlanChangeOperation = "set" | "update" | "restore" | "system";

export interface PlanEventServiceShape {
  /** This session's history, oldest first. */
  readonly list: (sessionId: string) => SessionPlanEvent[];
  /** Every session's stored history (the startup equivalence check). */
  readonly all: () => Record<string, SessionPlanEvent[]>;
  /**
   * Record a transition, classifying it the way native does. An update that
   * changed nothing records nothing, mirroring `updateSessionPlan`'s
   * `guard changed else { return }`.
   */
  readonly record: (
    sessionId: string,
    op: PlanChangeOperation,
    before: readonly SessionPlanItem[],
    after: readonly SessionPlanItem[],
    causationId?: string,
  ) => void;
  /** Forget a deleted session's history. */
  readonly deleteSession: (sessionId: string) => void;
}

const samePlanItem = (a: SessionPlanItem, b: SessionPlanItem | undefined): boolean =>
  b !== undefined &&
  a.id === b.id &&
  a.title === b.title &&
  a.status === b.status &&
  a.assignee === b.assignee &&
  a.verifiedBy === b.verifiedBy &&
  a.runId === b.runId &&
  a.task === b.task &&
  a.isolated === b.isolated &&
  a.note === b.note &&
  (a.dependsOn ?? []).join("\n") === (b.dependsOn ?? []).join("\n");

/**
 * Which kind of event a before→after transition is, or undefined when it is not
 * an event at all. Emptying a plan that was already empty is a no-op, not a
 * `cleared` — native only appends `cleared` when an existing plan was present.
 */
function classify(
  op: PlanChangeOperation,
  before: readonly SessionPlanItem[],
  after: readonly SessionPlanItem[],
): SessionPlanEventKind | undefined {
  if (op === "update" || op === "system") {
    // Native's updateSessionPlan patches items by id and returns early on
    // `guard changed else`, so an unknown id or a patch that rewrites a value
    // with itself appends nothing. It never empties a plan.
    return before.length === after.length && before.every((item, i) => samePlanItem(item, after[i]))
      ? undefined
      : "updated";
  }
  // A set declares a whole plan. Which kind it is depends on what it displaced,
  // NOT on whether the contents happen to differ — the agent restating the same
  // plan is still a plan event, and native records it as one. Deriving this from
  // the snapshots instead would file a same-shape replacement as `updated`
  // (Codex).
  if (after.length === 0) return before.length === 0 ? undefined : "cleared";
  return before.length === 0 ? "created" : "replaced";
}

export const makePlanEventService = (options: PlanEventServiceOptions): PlanEventServiceShape => {
  const cap = options.maxPerSession ?? MAX_EVENTS_PER_SESSION;
  // Context-free store handle — a total Effect.runSync build, as persistence.ts
  // documents for its synchronous facade.
  const store = Effect.runSync(
    makeKeyedJsonStoreHandle<SessionPlanEvent>(options.dataDir, ["plan-events", "index.json"]),
  );

  return {
    list: (sessionId) => {
      const stored = Effect.runSync(store.get(sessionId));
      const logged = options.readLog?.(sessionId);
      if (!logged) return stored;
      // The log decides membership and order (uncapped); the store, which keeps the
      // last `cap`, supplies exact items by id.
      return mergePlanHistory(logged, stored, (change) => ({
        id: change.id,
        sessionId,
        kind: change.kind as SessionPlanEventKind,
        items: change.items as SessionPlanItem[],
        at: change.at ?? "",
        source: "log",
      }));
    },

    all: () => Effect.runSync(store.all),

    record: (sessionId, op, before, after, causationId) => {
      const existing = Effect.runSync(store.get(sessionId));
      // A restore is only an event when it is the session's FIRST plan — which
      // is native's own load-time rule: any plan holding no events is seeded
      // with a synthetic `created`. Reopening a session leaves its history
      // alone, while a FORK, which inherits the source's plan under a new
      // session id and therefore an empty bucket, gets the `created` it would
      // otherwise never have (Codex).
      const kind =
        op === "restore"
          ? existing.length === 0 && after.length > 0
            ? "created"
            : undefined
          : classify(op, before, after);
      if (!kind) return;
      const event: SessionPlanEvent = {
        id: randomUUID(),
        sessionId,
        kind,
        // Copy: the caller's array is the live plan, which keeps mutating.
        items: after.map((item) => ({ ...item })),
        at: new Date().toISOString(),
      };
      Effect.runSync(store.set(sessionId, [...existing, event].slice(-cap)));
      options.onRecorded?.(event, op, causationId);
    },

    deleteSession: (sessionId) => {
      Effect.runSync(store.deleteKey(sessionId));
    },
  };
};
