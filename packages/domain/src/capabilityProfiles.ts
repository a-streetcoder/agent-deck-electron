// A6: capability profiles. Per agent name and role, how its settled runs went: counts,
// pass rate, tokens and duration, over a recent window and all time. Pure: built from
// the public run views (subagent runs and loop children), or from the event log.
import {
  projectLoopRuns,
  projectSubagentRuns,
  type PublicLoopChild,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "./eventDiffs.ts";

/** A loop child's phase, or "subagent" for managed_subagent / managed_parallel runs. */
export type CapabilityRole = PublicLoopChild["phase"] | "subagent";

export interface CapabilityStats {
  /** Settled runs: completed + failed + stopped. Queued and running are not counted. */
  runs: number;
  completed: number;
  failed: number;
  /** Stopped by a person or a parent, or interrupted by a restart. */
  stopped: number;
  /** completed / (completed + failed); stops are not the agent's failure. Null with neither. */
  passRate: number | null;
  /** Input + output tokens, over the runs that reported usage. */
  medianTokens?: number;
  p90Tokens?: number;
  medianDurationMs?: number;
  p90DurationMs?: number;
  lastRunAt?: string;
}

export interface CapabilityProfile {
  agent: string;
  role: CapabilityRole;
  window: CapabilityStats;
  allTime: CapabilityStats;
}

export interface CapabilityProfileOptions {
  /** ms since epoch; the window ends here. */
  now: number;
  windowDays: number;
}

/** The engine's label for a loop child without an agent (the goal evaluator). */
export const UNNAMED_EVALUATOR_AGENT = "Goal evaluator";

interface Sample {
  agent: string;
  role: CapabilityRole;
  outcome: "completed" | "failed" | "stopped";
  at: string;
  tokens?: number;
  durationMs?: number;
}

/** Nearest-rank percentile of ascending values: always a real observation. */
function percentile(sorted: readonly number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function tokenTotal(input?: number, output?: number): number | undefined {
  return input === undefined && output === undefined ? undefined : (input ?? 0) + (output ?? 0);
}

function stats(samples: readonly Sample[]): CapabilityStats {
  const count = (outcome: Sample["outcome"]): number =>
    samples.filter((sample) => sample.outcome === outcome).length;
  const completed = count("completed");
  const failed = count("failed");
  const ascending = (values: (number | undefined)[]): number[] =>
    values.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  const tokens = ascending(samples.map((sample) => sample.tokens));
  const durations = ascending(samples.map((sample) => sample.durationMs));
  const lastRunAt = samples.reduce<string | undefined>(
    (latest, sample) =>
      !latest || Date.parse(sample.at) > Date.parse(latest) ? sample.at : latest,
    undefined,
  );
  const out: CapabilityStats = {
    runs: samples.length,
    completed,
    failed,
    stopped: count("stopped"),
    passRate: completed + failed ? completed / (completed + failed) : null,
  };
  const optional = {
    medianTokens: percentile(tokens, 0.5),
    p90Tokens: percentile(tokens, 0.9),
    medianDurationMs: percentile(durations, 0.5),
    p90DurationMs: percentile(durations, 0.9),
    lastRunAt,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) Object.assign(out, { [key]: value });
  }
  return out;
}

function subagentSample(run: PublicSubagentRun): Sample | undefined {
  const outcome =
    run.status === "completed" || run.status === "failed"
      ? run.status
      : run.status === "stopped" || run.status === "interrupted"
        ? "stopped"
        : undefined;
  if (!outcome || !run.agent) return undefined;
  const tokens = tokenTotal(run.inputTokens, run.outputTokens);
  return {
    agent: run.agent,
    role: "subagent",
    outcome,
    at: run.completedAt ?? run.updatedAt,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
  };
}

function loopChildSample(child: PublicLoopChild): Sample | undefined {
  const status = child.status;
  if (status !== "completed" && status !== "failed" && status !== "stopped") return undefined;
  if (!child.endedAt) return undefined;
  const agent = child.agentName ?? (child.phase === "evaluator" ? UNNAMED_EVALUATOR_AGENT : "");
  if (!agent) return undefined;
  const tokens = tokenTotal(child.tokens?.input, child.tokens?.output);
  const durationMs = child.startedAt
    ? Date.parse(child.endedAt) - Date.parse(child.startedAt)
    : Number.NaN;
  return {
    agent,
    role: child.phase,
    outcome: status,
    at: child.endedAt,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
  };
}

/**
 * Profiles per (agent, role), sorted by agent then role. Anonymous subagent runs have
 * no agent to profile and are skipped; an unnamed loop evaluator counts as
 * UNNAMED_EVALUATOR_AGENT.
 */
export function aggregateCapabilityProfiles(
  subagentRuns: Iterable<PublicSubagentRun>,
  loopRuns: Iterable<PublicLoopRun>,
  options: CapabilityProfileOptions,
): CapabilityProfile[] {
  const samples: Sample[] = [];
  for (const run of subagentRuns) {
    const sample = subagentSample(run);
    if (sample) samples.push(sample);
  }
  for (const run of loopRuns) {
    for (const iteration of run.iterations) {
      for (const child of iteration.children) {
        const sample = loopChildSample(child);
        if (sample) samples.push(sample);
      }
    }
  }
  const since = options.now - options.windowDays * 86_400_000;
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.agent, sample.role]);
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  return [...groups.values()]
    .map((group) => ({
      agent: group[0]!.agent,
      role: group[0]!.role,
      window: stats(group.filter((sample) => Date.parse(sample.at) >= since)),
      allTime: stats(group),
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.role.localeCompare(b.role));
}

/** The same profiles from the event log (subagent.run.* and loop.* facts). */
export function capabilityProfilesFromEvents(
  events: Parameters<typeof projectLoopRuns>[0],
  options: CapabilityProfileOptions,
): CapabilityProfile[] {
  const list = [...events];
  return aggregateCapabilityProfiles(
    projectSubagentRuns(list).values(),
    projectLoopRuns(list).values(),
    options,
  );
}
