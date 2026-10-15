import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateCapabilityProfiles,
  capabilityProfilesFromEvents,
  UNNAMED_EVALUATOR_AGENT,
} from "../src/capabilityProfiles.ts";
import type { PublicLoopChild, PublicLoopRun, PublicSubagentRun } from "../src/eventDiffs.ts";
import { parseEventLine, splitJsonl, type EventEnvelope } from "../src/events.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/events");
const events = (name: string): EventEnvelope[] =>
  splitJsonl(readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")).lines.map(
    (line) => parseEventLine(line)!,
  );

const NOW = Date.parse("2026-10-15T00:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();
const options = { now: NOW, windowDays: 30 };

function subagent(
  agent: string | undefined,
  status: PublicSubagentRun["status"],
  daysAgo: number,
  extra: Partial<PublicSubagentRun> = {},
): PublicSubagentRun {
  return {
    id: `${agent}-${status}-${daysAgo}-${Math.random()}`,
    parentSessionId: "parent",
    task: "task",
    ...(agent ? { agent } : {}),
    status,
    createdAt: at(daysAgo),
    updatedAt: at(daysAgo),
    completedAt: at(daysAgo),
    ...extra,
  };
}

function loop(children: PublicLoopChild[]): PublicLoopRun {
  return {
    id: "loop",
    loopName: "loop",
    status: "completed",
    currentIteration: 1,
    maxIterations: 1,
    startedAt: at(1),
    updatedAt: at(1),
    iterations: [
      {
        id: "iteration",
        index: 1,
        startedAt: at(1),
        validationPassed: true,
        timeline: [],
        children,
        artifacts: [],
      },
    ],
  };
}

describe("aggregateCapabilityProfiles", () => {
  it("is empty without settled named runs", () => {
    expect(aggregateCapabilityProfiles([], [], options)).toEqual([]);
    expect(
      aggregateCapabilityProfiles(
        [subagent(undefined, "completed", 1), subagent("Writer", "running", 1)],
        [loop([{ id: "c", phase: "maker", agentName: "Maker", status: "running" }])],
        options,
      ),
    ).toEqual([]);
  });

  it("counts outcomes, pass rate without stops, and splits the window from all time", () => {
    const [profile] = aggregateCapabilityProfiles(
      [
        subagent("Writer", "completed", 1, { inputTokens: 100, outputTokens: 20, durationMs: 10 }),
        subagent("Writer", "failed", 2, { inputTokens: 10, outputTokens: 0, durationMs: 30 }),
        subagent("Writer", "stopped", 3),
        subagent("Writer", "interrupted", 4),
        subagent("Writer", "completed", 40, { inputTokens: 1000, durationMs: 5000 }),
      ],
      [],
      options,
    );
    expect(profile).toEqual({
      agent: "Writer",
      role: "subagent",
      window: {
        runs: 4,
        completed: 1,
        failed: 1,
        stopped: 2,
        passRate: 0.5,
        medianTokens: 10,
        p90Tokens: 120,
        medianDurationMs: 10,
        p90DurationMs: 30,
        lastRunAt: at(1),
      },
      allTime: {
        runs: 5,
        completed: 2,
        failed: 1,
        stopped: 2,
        passRate: 2 / 3,
        medianTokens: 120,
        p90Tokens: 1000,
        medianDurationMs: 30,
        p90DurationMs: 5000,
        lastRunAt: at(1),
      },
    });
  });

  it("windows [now - windowDays, now] inclusive on both ends", () => {
    const runs = [
      subagent("Edge", "completed", 30), // exactly since: in
      subagent("Edge", "completed", 0), // exactly now: in
      subagent("Edge", "completed", 30 + 1 / 86_400_000), // 1 ms before since: out
      subagent("Edge", "completed", -1 / 86_400_000), // 1 ms after now: out
    ];
    const [profile] = aggregateCapabilityProfiles(runs, [], options);
    expect(profile!.window.runs).toBe(2);
    expect(profile!.allTime.runs).toBe(4);
  });

  it("has a null pass rate and no medians in an empty window", () => {
    const [profile] = aggregateCapabilityProfiles(
      [subagent("Old", "completed", 90, { durationMs: 1 })],
      [],
      options,
    );
    expect(profile!.window).toEqual({
      runs: 0,
      completed: 0,
      failed: 0,
      stopped: 0,
      passRate: null,
    });
    expect(profile!.allTime.p90DurationMs).toBe(1);
  });

  it("keeps roles apart and names an unnamed loop evaluator", () => {
    const child = (
      id: string,
      phase: PublicLoopChild["phase"],
      agentName?: string,
    ): PublicLoopChild => ({
      id,
      phase,
      ...(agentName ? { agentName } : {}),
      status: "completed",
      startedAt: at(1),
      endedAt: new Date(NOW - DAY + 2_000).toISOString(),
      tokens: { input: 5, output: 7 },
      model: "m",
    });
    const profiles = aggregateCapabilityProfiles(
      [subagent("Helper", "completed", 1)],
      [
        loop([
          child("a", "maker", "Helper"),
          child("b", "checker", "Helper"),
          child("c", "evaluator"),
        ]),
      ],
      options,
    );
    expect(profiles.map((p) => [p.agent, p.role])).toEqual([
      [UNNAMED_EVALUATOR_AGENT, "evaluator"],
      ["Helper", "checker"],
      ["Helper", "maker"],
      ["Helper", "subagent"],
    ]);
    expect(profiles[1]!.allTime).toMatchObject({ medianTokens: 12, medianDurationMs: 2_000 });
    // No usage reported: no token medians, the run still counts.
    expect(profiles[3]!.allTime).toMatchObject({ runs: 1, passRate: 1 });
    expect(profiles[3]!.allTime.medianTokens).toBeUndefined();
  });

  it("p90 with few samples is the largest of them (nearest rank)", () => {
    const runs = [3, 1, 2].map((ms) => subagent("Few", "completed", 1, { durationMs: ms }));
    const [profile] = aggregateCapabilityProfiles(runs, [], options);
    expect(profile!.allTime).toMatchObject({ medianDurationMs: 2, p90DurationMs: 3 });
    const [one] = aggregateCapabilityProfiles([runs[0]!], [], options);
    expect(one!.allTime).toMatchObject({ medianDurationMs: 3, p90DurationMs: 3 });
  });
});

describe("capabilityProfilesFromEvents over the recorded fixtures", () => {
  it("profiles the makerChecker loop's maker, checker and evaluator with real Pi usage", () => {
    const profiles = capabilityProfilesFromEvents(events("loop-makerChecker"), {
      now: Date.parse("2026-01-02T00:00:00.000Z"),
      windowDays: 30,
    });
    expect(profiles.map((p) => [p.agent, p.role])).toEqual([
      ["Checker", "checker"],
      [UNNAMED_EVALUATOR_AGENT, "evaluator"],
      ["Maker", "maker"],
    ]);
    for (const profile of profiles) {
      expect(profile.window).toEqual(profile.allTime);
      expect(profile.allTime).toMatchObject({ runs: 1, completed: 1, passRate: 1 });
      expect(profile.allTime.medianTokens).toBeGreaterThan(0);
    }
  });

  it("skips an anonymous subagent run (and one removed with its session)", () => {
    expect(capabilityProfilesFromEvents(events("managed-subagent"), options)).toEqual([]);
  });
});
