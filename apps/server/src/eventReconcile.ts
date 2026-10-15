// A1b2 startup reconcile and the diff producers' sinks. After the log opens and the
// stores load: (1) attach every store's sink, always; (2) reconcile BOTH stores,
// writing diff(projection(log), store as loaded) with origin "reconcile" (first boot
// imports history, a crash between a store write and its log write is repaired, a
// clean boot writes nothing); (3) only then write boot recovery (interrupted runs) as
// ordinary system events. A sink that finds the log unsynced (read-only at boot and
// promoted since, a failed reconcile, a failed append) reconciles again before it
// continues incrementally. Uses its own comparison over projections, never the
// writer's id dedupe (ids are checked over two segments only).
import { homedir } from "node:os";
import type { SessionPlanEvent } from "@agent-deck/contracts";
import {
  diffLoopRuns,
  diffSubagentRuns,
  projectLoopRuns,
  projectSubagentRuns,
  type EventDraft,
  type PathPrefix,
  type PublicLoopRun,
  type PublicSubagentRun,
  type PublicViewOptions,
} from "@agent-deck/domain";
import { MAX_EVENT_READ_LIMIT, type AppendResult, type EventLog } from "./eventLog.ts";
import type { LogReaders } from "./eventReaders.ts";

export interface DiffProducerStore<T> {
  /** Public view as loaded, before boot recovery. */
  bootPublicRuns(): T[];
  publicRuns(): T[];
  /** The store file was corrupt at boot: its history is unknown, so never infer removals. */
  quarantined(): boolean;
  attachEventSink(sink: (drafts: EventDraft[]) => void, view: () => PublicViewOptions): void;
}

export interface ReconcileCounts {
  subagentReconciled: number;
  subagentRecovered: number;
  loopReconciled: number;
  loopRecovered: number;
}

/** Placeholders for the local roots in event text (longest prefix wins in redactPaths). */
export function localPathPrefixes(dataDir: string, projectRoots: readonly string[]): PathPrefix[] {
  return [
    { prefix: dataDir, placeholder: "<data>" },
    { prefix: homedir(), placeholder: "~" },
    ...projectRoots.map((prefix) => ({ prefix, placeholder: "<project>" })),
  ];
}

interface Projections {
  subagent: PublicSubagentRun[];
  loop: PublicLoopRun[];
}

/** Fold the whole log into both projections one page at a time. */
// ponytail: replays all history at every boot and every resync; projection snapshots
// when startup exceeds ~1 s (about 10 MB of log, measured in A1d).
export function projectLog(log: EventLog): Projections {
  let subagent = projectSubagentRuns([]);
  let loop = projectLoopRuns([]);
  let afterSeq = 0;
  for (;;) {
    const page = log.read({ afterSeq, limit: MAX_EVENT_READ_LIMIT });
    subagent = projectSubagentRuns(page.events, subagent.values());
    loop = projectLoopRuns(page.events, loop.values());
    if (!page.more || page.nextAfterSeq === undefined || page.nextAfterSeq <= afterSeq) break;
    afterSeq = page.nextAfterSeq;
  }
  return { subagent: [...subagent.values()], loop: [...loop.values()] };
}

/** A failure that means the log missed events, so the next commit must reconcile. */
const lost = (result: AppendResult): boolean =>
  !result.ok &&
  (result.reason === "io" || result.reason === "readonly" || result.reason === "closed");

interface Producer {
  /** Reconcile drafts: diff(logged, boot) with origin reconcile. */
  reconcileBoot(logged: Projections): number;
  /** Boot recovery: diff(boot, current) as ordinary events. Marks the producer synced. */
  recoverBoot(): number;
}

function producer<T>(
  log: EventLog,
  name: string,
  store: DiffProducerStore<T>,
  logged: (projections: Projections) => T[],
  diff: (prev: readonly T[], next: readonly T[]) => EventDraft[],
  view: () => PublicViewOptions,
  warn: (message: string, error?: unknown) => void,
): Producer {
  let synced = false;
  let warnedReadonly = false;
  const append = (drafts: EventDraft[]): number => {
    let written = 0;
    for (const draft of drafts) {
      const result = log.append(draft);
      if (result.ok) written += 1;
      else if (lost(result)) synced = false;
    }
    return written;
  };
  const asReconcile = (drafts: EventDraft[]): EventDraft[] =>
    drafts
      // A quarantined store starts empty: its absent runs were not removed.
      .filter((draft) => !(store.quarantined() && draft.kind.endsWith(".removed")))
      .map((draft) => ({ ...draft, origin: "reconcile" as const }));
  const resync = (): void => {
    synced = true;
    const count = append(asReconcile(diff(logged(projectLog(log)), store.publicRuns())));
    if (count > 0) console.info(`[events] ${name} reconciled ${count} events after a gap`);
  };

  store.attachEventSink((drafts) => {
    if (!log.writable) {
      synced = false;
      if (!warnedReadonly) {
        warnedReadonly = true;
        warn(`[events] log is read-only; ${name} events wait for a reconcile`);
      }
      return;
    }
    warnedReadonly = false;
    if (!synced) {
      try {
        resync();
      } catch (error) {
        synced = false;
        warn(`[events] ${name} reconcile failed`, error);
      }
      return;
    }
    append(drafts);
  }, view);

  return {
    reconcileBoot: (projections) =>
      append(asReconcile(diff(logged(projections), store.bootPublicRuns()))),
    recoverBoot: () => {
      synced = true; // before the appends, so a lost one marks the gap
      return append(diff(store.bootPublicRuns(), store.publicRuns()));
    },
  };
}

export function startEventProducers(
  log: EventLog,
  stores: {
    subagentRuns: DiffProducerStore<PublicSubagentRun>;
    loopRuns: DiffProducerStore<PublicLoopRun> & { releaseBootRuns?(): void };
  },
  options: {
    view: () => PublicViewOptions;
    warn: (message: string, error?: unknown) => void;
    /** Rethrow a failed boot reconcile (tests). */
    strict?: boolean;
  },
): ReconcileCounts | undefined {
  const { view, warn } = options;
  // Sinks first, always: a read-only or failed boot reconciles at the next commit.
  const subagent = producer(
    log,
    "subagent runs",
    stores.subagentRuns,
    (projections) => projections.subagent,
    diffSubagentRuns,
    view,
    warn,
  );
  const loop = producer(
    log,
    "loop runs",
    stores.loopRuns,
    (projections) => projections.loop,
    diffLoopRuns,
    view,
    warn,
  );
  try {
    if (!log.writable) {
      warn("[events] log is read-only at boot; the writer process reconciles it");
      return undefined;
    }
    const projections = projectLog(log);
    // Two phases across the stores: every reconcile event precedes every recovery event.
    const subagentReconciled = subagent.reconcileBoot(projections);
    const loopReconciled = loop.reconcileBoot(projections);
    return {
      subagentReconciled,
      loopReconciled,
      subagentRecovered: subagent.recoverBoot(),
      loopRecovered: loop.recoverBoot(),
    };
  } catch (error) {
    if (options.strict) throw error;
    warn("[events] startup reconcile failed; the next commit retries", error);
    return undefined;
  } finally {
    stores.loopRuns.releaseBootRuns?.();
  }
}

/**
 * A1d plan history: store events whose id the log lacks (history from before A1, or a
 * crash between the store write and its append), written back with origin reconcile.
 * Compares only the ids the store still holds (it keeps the last 100 per session).
 * Undefined when the log cannot take writes.
 */
export function reconcilePlanHistory(
  stored: Record<string, SessionPlanEvent[]>,
  readers: LogReaders,
  write: (event: SessionPlanEvent) => void,
): number | undefined {
  let written = 0;
  for (const [sessionId, history] of Object.entries(stored)) {
    const logged = readers.plans(sessionId);
    if (!logged) return undefined;
    const ids = new Set(logged.map((change) => change.id));
    for (const event of history) {
      if (ids.has(event.id)) continue;
      write(event);
      written += 1;
    }
  }
  return written;
}

/**
 * The startup equivalence report, logged once: per store, the entries the log lacked
 * against the store as loaded (zero on a clean boot). Recovered counts are boot
 * recovery (runs a restart interrupted), not mismatches. The supervisor store is
 * memory-only, so it has nothing to compare: its restart rule lives in the projection.
 */
export interface EquivalenceReport extends ReconcileCounts {
  planReconciled: number;
  mismatches: number;
}

export function equivalenceReport(
  counts: ReconcileCounts,
  planReconciled: number,
): EquivalenceReport {
  return {
    ...counts,
    planReconciled,
    mismatches: counts.subagentReconciled + counts.loopReconciled + planReconciled,
  };
}
