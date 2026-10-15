// A1b2 startup reconcile: after the log opens and the stores load, bring the log up
// to the stores. diff(projection(log), store as loaded) is written with
// origin "reconcile" (first boot imports history; a crash between a store write and its
// log write is repaired; a clean boot writes nothing), then boot recovery (interrupted
// runs) as ordinary system events, then the stores' commit points take over.
// Uses its own comparison over the projections, never the writer's id dedupe.
import {
  diffLoopRuns,
  diffSubagentRuns,
  projectLoopRuns,
  projectSubagentRuns,
  type EventDraft,
  type EventEnvelope,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "@agent-deck/domain";
import { MAX_EVENT_READ_LIMIT, type EventLog } from "./eventLog.ts";

export interface DiffProducerStore<T> {
  /** Public view as loaded, before boot recovery. */
  bootPublicRuns(): T[];
  publicRuns(): T[];
  attachEventSink(sink: (drafts: EventDraft[]) => void): void;
}

export interface ReconcileCounts {
  subagentReconciled: number;
  subagentRecovered: number;
  loopReconciled: number;
  loopRecovered: number;
}

/** Every event in the log, oldest first. */
// ponytail: replays all history at every boot; projection snapshots when this
// exceeds ~1 s (~50 MB), see A1d.
export function readAllEvents(log: EventLog): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = log.read({ afterSeq, limit: MAX_EVENT_READ_LIMIT });
    events.push(...page.events);
    if (!page.more || page.nextAfterSeq === undefined || page.nextAfterSeq <= afterSeq) break;
    afterSeq = page.nextAfterSeq;
  }
  return events;
}

function reconcileOne<T>(
  log: EventLog,
  store: DiffProducerStore<T>,
  logged: T[],
  diff: (prev: readonly T[], next: readonly T[]) => EventDraft[],
): { reconciled: number; recovered: number } {
  const append = (drafts: EventDraft[]): number =>
    drafts.filter((draft) => log.append(draft).ok).length;
  const boot = store.bootPublicRuns();
  const reconciled = append(
    diff(logged, boot).map((draft) => ({ ...draft, origin: "reconcile" as const })),
  );
  const recovered = append(diff(boot, store.publicRuns()));
  store.attachEventSink((drafts) => void append(drafts));
  return { reconciled, recovered };
}

export function reconcileEventLog(
  log: EventLog,
  stores: {
    subagentRuns: DiffProducerStore<PublicSubagentRun>;
    loopRuns: DiffProducerStore<PublicLoopRun>;
  },
): ReconcileCounts | undefined {
  // A read-only process does not own the log; the writer process reconciles it.
  if (!log.writable) return undefined;
  const events = readAllEvents(log);
  const subagent = reconcileOne(
    log,
    stores.subagentRuns,
    [...projectSubagentRuns(events).values()],
    diffSubagentRuns,
  );
  const loop = reconcileOne(
    log,
    stores.loopRuns,
    [...projectLoopRuns(events).values()],
    diffLoopRuns,
  );
  return {
    subagentReconciled: subagent.reconciled,
    subagentRecovered: subagent.recovered,
    loopReconciled: loop.reconciled,
    loopRecovered: loop.recovered,
  };
}
