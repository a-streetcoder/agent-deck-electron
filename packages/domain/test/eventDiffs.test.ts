import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diffLoopRuns,
  diffSubagentRuns,
  projectLoopRuns,
  projectPlans,
  projectSubagentRuns,
  projectSupervisor,
  toPublicLoopRun,
  toPublicSubagentRun,
  utf8Suffix,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "../src/eventDiffs.ts";
import { parseEventLine, splitJsonl, type EventDraft, type EventEnvelope } from "../src/events.ts";
import type { LoopRun } from "../src/loops.ts";

// Recorded by apps/server/test/eventProducers.pi.test.ts with
// AGENT_DECK_RECORD_EVENT_FIXTURES=1: the public view after every real store commit
// during one managed_subagent run and one makerChecker loop, and the emitted events.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/events");
const FIXTURE_NAMES = ["managed-subagent", "loop-makerChecker"] as const;

const states = <T>(name: string): T[][] =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.states.json`), "utf8")) as T[][];
const events = (name: string): EventEnvelope[] =>
  splitJsonl(readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")).lines.map(
    (line) => parseEventLine(line)!,
  );

/** Drafts as the writer would store them (a JSON round trip). */
const written = (drafts: EventDraft[]): EventDraft[] =>
  JSON.parse(JSON.stringify(drafts)) as EventDraft[];

const byId = <T extends { id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

describe("diff producers: reduce(project(prev), diff(prev, next)) == project(next)", () => {
  it("holds over every recorded managed_subagent commit", () => {
    const sequence = states<PublicSubagentRun>("managed-subagent");
    expect(sequence.length).toBeGreaterThan(2);
    for (let i = 1; i < sequence.length; i += 1) {
      const [prev, next] = [sequence[i - 1]!, sequence[i]!];
      const projected = projectSubagentRuns(written(diffSubagentRuns(prev, next)), prev);
      expect(projected).toEqual(byId(next));
    }
  });

  it("holds over every recorded makerChecker loop persist", () => {
    const sequence = states<PublicLoopRun>("loop-makerChecker");
    expect(sequence.length).toBeGreaterThan(5);
    for (let i = 1; i < sequence.length; i += 1) {
      const [prev, next] = [sequence[i - 1]!, sequence[i]!];
      const projected = projectLoopRuns(written(diffLoopRuns(prev, next)), prev);
      expect(projected).toEqual(byId(next));
    }
  });

  it("the recorded logs project to the final recorded states", () => {
    expect(projectSubagentRuns(events("managed-subagent"))).toEqual(
      byId(states<PublicSubagentRun>("managed-subagent").at(-1)!),
    );
    expect(projectLoopRuns(events("loop-makerChecker"))).toEqual(
      byId(states<PublicLoopRun>("loop-makerChecker").at(-1)!),
    );
  });

  it("an unchanged state diffs to nothing (a clean boot reconciles zero events)", () => {
    const loop = states<PublicLoopRun>("loop-makerChecker").at(-1)!;
    const subagent = states<PublicSubagentRun>("managed-subagent").at(-1)!;
    expect(diffLoopRuns([...projectLoopRuns(events("loop-makerChecker")).values()], loop)).toEqual(
      [],
    );
    expect(
      diffSubagentRuns([...projectSubagentRuns(events("managed-subagent")).values()], subagent),
    ).toEqual([]);
  });
});

describe("finished and removed", () => {
  const run: PublicSubagentRun = {
    id: "run-1",
    parentSessionId: "session-1",
    task: "t",
    status: "running",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };

  it("active -> terminal emits one finished with the structured result", () => {
    const done: PublicSubagentRun = {
      ...run,
      status: "completed",
      completedAt: "2026-10-15T00:00:05.000Z",
      summary: "S",
      model: "m",
      inputTokens: 3,
      outputTokens: 4,
      durationMs: 5000,
      artifactRootId: "run-1",
    };
    const drafts = diffSubagentRuns([run], [done]);
    expect(drafts.map((draft) => draft.kind)).toEqual(["subagent.run.finished"]);
    expect(drafts[0]!.payload).toMatchObject({
      result: {
        status: "completed",
        summary: "S",
        tokens: { input: 3, output: 4 },
        durationMs: 5000,
        model: "m",
        artifactRootId: "run-1",
      },
    });
    // The summary travels once.
    expect((drafts[0]!.payload as { run: object }).run).not.toHaveProperty("summary");
    // Terminal -> terminal (a later edit) is an update, not a second finished.
    expect(diffSubagentRuns([done], [{ ...done, updatedAt: "later" }])[0]!.kind).toBe(
      "subagent.run.updated",
    );
    expect(diffSubagentRuns([done], []).map((draft) => draft.kind)).toEqual([
      "subagent.run.removed",
    ]);
  });

  it("a created run without a tool call hangs under its session", () => {
    expect(diffSubagentRuns([], [run])[0]!.parent).toEqual({ type: "session", id: "session-1" });
  });

  it("a pruned loop run is removed from the projection", () => {
    const loop = states<PublicLoopRun>("loop-makerChecker").at(-1)!;
    expect(projectLoopRuns(diffLoopRuns(loop, []), loop).size).toBe(0);
  });
});

describe("public projections", () => {
  it("drop capability fields, paths, lock keys and outputs", () => {
    const record = {
      id: "r",
      parentSessionId: "s",
      task: "t",
      status: "completed",
      createdAt: "a",
      updatedAt: "b",
      completedAt: "c",
      sessionFile: "/home/user/.pi/sessions/x.jsonl",
      artifactRootToken: "secret-token",
      currentTurnId: "turn",
      worktreePath: "/repo/wt",
      declaredReads: ["src/a.ts"],
    } as unknown as PublicSubagentRun;
    expect(Object.keys(toPublicSubagentRun(record)).sort()).toEqual(
      ["completedAt", "createdAt", "id", "parentSessionId", "status", "task", "updatedAt"].sort(),
    );
    const loop = toPublicLoopRun({
      id: "l",
      loopName: "L",
      artifactDirectory: "/data/loop-artifacts/x",
      manifestPath: "/data/m.json",
      definitionSnapshot: { goal: "secret goal" },
      launch: { sessionId: "s", writeTarget: "currentCheckout", checkoutLockKey: "c:/repo" },
      status: "completed",
      currentIteration: 1,
      maxIterations: 1,
      startedAt: "a",
      updatedAt: "b",
      iterations: [
        {
          id: "i",
          index: 1,
          startedAt: "a",
          output: "RAW OUTPUT",
          validationPassed: true,
          validationResult: {
            command: "npm test",
            workingDirectory: "/repo",
            exitCode: 0,
            durationMs: 1,
            stdout: "RAW STDOUT",
            stderr: "",
            classification: "completed",
            passed: true,
          },
          timeline: [],
          children: [{ id: "c", phase: "maker", output: "RAW CHILD" }],
          artifacts: [
            {
              id: "a",
              phase: "maker",
              filename: "f.md",
              filePath: "/data/f.md",
              bytes: 1,
              createdAt: "a",
            },
          ],
          changedFiles: [{ path: "src/x.ts", status: "staged" }],
          manifestPath: "/data/i.json",
        },
      ],
    } as unknown as LoopRun);
    const text = JSON.stringify(loop);
    for (const leaked of ["RAW", "/data", "/repo", "secret goal", "c:/repo", "npm test"]) {
      expect(text).not.toContain(leaked);
    }
    expect(loop.writeTarget).toBe("currentCheckout");
    expect(loop.iterations[0]!.validation).toEqual({
      classification: "completed",
      exitCode: 0,
      durationMs: 1,
      passed: true,
    });
  });

  it("utf8Suffix keeps the newest bytes without splitting a code point", () => {
    expect(utf8Suffix("abc", 10)).toBe("abc");
    expect(utf8Suffix("aé€", 3)).toBe("€");
    expect(utf8Suffix("a€", 2)).toBe("");
  });
});

describe("secrets scan of the recorded fixtures", () => {
  // subagentRunStore.ts CAPABILITY_FIELDS. artifactRootId is exempt: it is the opaque
  // id the transcript cell already exposes and A4's result needs; its token is the
  // capability and never leaves the store.
  const CAPABILITY_FIELDS = [
    "artifactRootToken",
    "identityToken",
    "sessionFile",
    "sessionOwnership",
    "currentTurnId",
    "turnDirectory",
    "sessionsDirectory",
    "worktreePath",
    "worktreeIdentity",
    "worktreeParentRepository",
    "worktreeRepositoryIdentity",
    "worktreeBaseCommit",
    "worktreeState",
    "worktreeCleanup",
  ];
  const LOOP_PRIVATE = [
    "artifactDirectory",
    "manifestPath",
    "progressPath",
    "definitionSnapshot",
    "checkoutLockKey",
    "launch",
    "filePath",
    "stdout",
    "stderr",
    "workingDirectory",
    "changedFiles",
    "archivedPath",
    "checkerOutput",
    "evaluatorOutput",
    "classificationOutput",
  ];

  const keysOf = (value: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) for (const item of value) keysOf(item, out);
    else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        out.add(key);
        keysOf(nested, out);
      }
    }
    return out;
  };

  for (const name of FIXTURE_NAMES) {
    for (const file of [`${name}.jsonl`, `${name}.states.json`]) {
      it(`${file} holds no capability field, path, lock key or raw output`, () => {
        const text = readFileSync(path.join(FIXTURES, file), "utf8");
        const values = file.endsWith(".jsonl")
          ? splitJsonl(text).lines.map((line) => JSON.parse(line) as unknown)
          : (JSON.parse(text) as unknown);
        const keys = keysOf(values);
        // Loop child outputs use the key "output" (A4's result has tokens.output).
        const loopOnly = name.startsWith("loop") ? ["output"] : [];
        for (const key of [...CAPABILITY_FIELDS, ...LOOP_PRIVATE, ...loopOnly]) {
          expect(keys.has(key), key).toBe(false);
        }
        // Absolute paths: drive letters, UNC and common POSIX roots, escaped or not.
        expect(text).not.toMatch(
          /[A-Za-z]:(\\\\|\\|\/)|\\\\\\\\|"\/(?:Users|home|tmp|var|private)\//,
        );
        // Raw agent output the real-Pi run produced for the loop roles.
        expect(text).not.toContain("MAKER_RAW_OUTPUT");
        expect(text).not.toContain("Checker streamed");
      });
    }
  }
});

describe("supervisor and plan projections", () => {
  const event = (
    kind: string,
    subject: EventEnvelope["subject"],
    payload: unknown,
    extra: Partial<EventEnvelope> = {},
  ) => ({ kind, subject, payload, ...extra });

  it("a pending request at a later server.started is interrupted", () => {
    const request = { type: "supervisorRequest", id: "q1" };
    const projected = projectSupervisor([
      event("supervisor.request.opened", request, { message: "?", status: "pending" }),
      event("supervisor.request.opened", { ...request, id: "q2" }, { status: "pending" }),
      event("supervisor.request.answered", { ...request, id: "q2" }, { response: "yes" }),
      event("server.started", { type: "server", id: "boot" }, {}),
    ]);
    expect(projected.get("q1")?.status).toBe("interrupted");
    expect(projected.get("q2")).toMatchObject({ status: "answered", response: "yes" });
  });

  it("plan changes group by session in log order", () => {
    const plan = { type: "plan", id: "p" };
    const projected = projectPlans([
      event("plan.changed", plan, { kind: "created", items: [] }, { sessionId: "s", id: "e1" }),
      event("plan.changed", plan, { kind: "cleared", items: [] }, { sessionId: "s", id: "e2" }),
    ]);
    expect(projected.get("s")?.map((change) => [change.id, change.kind])).toEqual([
      ["e1", "created"],
      ["e2", "cleared"],
    ]);
  });
});
