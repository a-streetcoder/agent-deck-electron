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
  comparePlanHistory,
  type EventDraft,
  type PathPrefix,
  type PublicLoopRun,
  type PublicSubagentRun,
  type PublicViewOptions,
} from "@agent-deck/domain";
import type { AppendResult, EventLog } from "./eventLog.ts";
import { createLogReaders, type LogReaders } from "./eventReaders.ts";

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

/** Both run projections from the shared fold (incremental after the first call). */
function projectLog(readers: LogReaders): Projections {
  const { subagent, loop } = readers.projections();
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
  readers: LogReaders,
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
    const count = append(asReconcile(diff(logged(projectLog(readers)), store.publicRuns())));
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
    /** The server's shared fold (plan history and supervisor read it too). */
    readers?: LogReaders;
  },
): ReconcileCounts | undefined {
  const { view, warn } = options;
  const readers = options.readers ?? createLogReaders(log);
  // Sinks first, always: a read-only or failed boot reconciles at the next commit.
  const subagent = producer(
    log,
    readers,
    "subagent runs",
    stores.subagentRuns,
    (projections) => projections.subagent,
    diffSubagentRuns,
    view,
    warn,
  );
  const loop = producer(
    log,
    readers,
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
    const projections = projectLog(readers);
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
 * A1d plan history: compare each session's stored history with the log (ids still in
 * the store only: it keeps the last 100). Store entries the log lacks are written back
 * with origin reconcile and their store predecessor (imports from before the log, or
 * lost appends); content differences are counted, not rewritten (the store stays the
 * source of exact items).
 */
export function reconcilePlanHistory(
  stored: Record<string, SessionPlanEvent[]>,
  readers: LogReaders,
  write: (event: SessionPlanEvent, afterId?: string) => void,
): { imported: number; reconciled: number; contentMismatches: number } {
  const counts = { imported: 0, reconciled: 0, contentMismatches: 0 };
  const startedAt = readers.projections().startedAt;
  for (const [sessionId, history] of Object.entries(stored)) {
    const result = comparePlanHistory(history, readers.plans(sessionId) ?? [], startedAt);
    counts.contentMismatches += result.contentMismatches;
    for (const { event, afterId, imported } of result.missing) {
      write(event, afterId);
      if (imported) counts.imported += 1;
      else counts.reconciled += 1;
    }
  }
  return counts;
}
