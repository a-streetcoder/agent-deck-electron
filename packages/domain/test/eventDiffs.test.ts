import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diffLoopRuns,
  diffSubagentRuns,
  MAX_EVENT_ERROR_BYTES,
  MAX_EVENT_TEXT_CHARS,
  projectLoopRuns,
  projectPlans,
  projectSubagentRuns,
  projectSupervisor,
  textHead,
  toPublicLoopRun,
  toPublicSubagentRun,
  utf8Suffix,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "../src/eventDiffs.ts";
import {
  MAX_EVENT_BYTES,
  parseEventLine,
  redactPaths,
  serializeEvent,
  splitJsonl,
  validateEnvelope,
  type EventDraft,
  type EventEnvelope,
} from "../src/events.ts";
import type { LoopRun } from "../src/loops.ts";

// Recorded by apps/server/test/eventProducers.pi.test.ts with
// AGENT_DECK_RECORD_EVENT_FIXTURES=1: per real store commit the public view and how
// many events the log held by then, during one managed_subagent run (fresh, continued,
// removed with its parent) and one makerChecker loop; plus the events written.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/events");
const FIXTURE_NAMES = ["managed-subagent", "loop-makerChecker"] as const;

interface Commit<T> {
  events: number;
  runs: T[];
}
const states = <T>(name: string): Commit<T>[] =>
  JSON.parse(readFileSync(path.join(FIXTURES, `${name}.states.json`), "utf8")) as Commit<T>[];
const events = (name: string): EventEnvelope[] =>
  splitJsonl(readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")).lines.map(
    (line) => parseEventLine(line)!,
  );

/** Drafts through the writer's own validation and serializer (and its size cap). */
function throughWriter(drafts: EventDraft[]): EventEnvelope[] {
  return drafts.map((draft, index) => {
    const envelope = validateEnvelope({
      ...draft,
      v: 1,
      id: draft.id ?? `event-${index}`,
      seq: index + 1,
      ts: "2026-10-15T00:00:00.000Z",
      logId: "log",
      projectId: draft.projectId ?? null,
      payload: draft.payload ?? null,
    });
    expect(envelope, draft.kind).not.toBeNull();
    return parseEventLine(serializeEvent(envelope!))!;
  });
}

const byId = <T extends { id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

describe("diff producers: reduce(project(prev), diff(prev, next)) == project(next)", () => {
  it("holds over every recorded managed_subagent commit", () => {
    const sequence = states<PublicSubagentRun>("managed-subagent");
    expect(sequence.length).toBeGreaterThan(5);
    for (let i = 1; i < sequence.length; i += 1) {
      const [prev, next] = [sequence[i - 1]!.runs, sequence[i]!.runs];
      const projected = projectSubagentRuns(throughWriter(diffSubagentRuns(prev, next)), prev);
      expect(projected).toEqual(byId(next));
    }
  });

  it("holds over every recorded makerChecker loop persist", () => {
    const sequence = states<PublicLoopRun>("loop-makerChecker");
    expect(sequence.length).toBeGreaterThan(5);
    for (let i = 1; i < sequence.length; i += 1) {
      const [prev, next] = [sequence[i - 1]!.runs, sequence[i]!.runs];
      const projected = projectLoopRuns(throughWriter(diffLoopRuns(prev, next)), prev);
      expect(projected).toEqual(byId(next));
    }
  });

  it("the recorded log up to each commit projects to the state recorded at that commit", () => {
    const subagentLog = events("managed-subagent");
    for (const commit of states<PublicSubagentRun>("managed-subagent")) {
      expect(projectSubagentRuns(subagentLog.slice(0, commit.events))).toEqual(byId(commit.runs));
    }
    const loopLog = events("loop-makerChecker");
    for (const commit of states<PublicLoopRun>("loop-makerChecker")) {
      expect(projectLoopRuns(loopLog.slice(0, commit.events))).toEqual(byId(commit.runs));
    }
  });

  it("the recorded subagent run finishes once per turn and is removed with its parent", () => {
    expect(events("managed-subagent").map((event) => event.kind)).toEqual([
      "subagent.run.created",
      "subagent.run.updated",
      "subagent.run.finished",
      "subagent.run.updated",
      "subagent.run.updated",
      "subagent.run.finished",
      "subagent.run.removed",
    ]);
  });

  it("an unchanged state diffs to nothing (a clean boot reconciles zero events)", () => {
    const loop = states<PublicLoopRun>("loop-makerChecker").at(-1)!.runs;
    const subagent = states<PublicSubagentRun>("managed-subagent").at(-2)!.runs;
    const subagentLog = events("managed-subagent").slice(0, -1);
    expect(diffLoopRuns([...projectLoopRuns(events("loop-makerChecker")).values()], loop)).toEqual(
      [],
    );
    expect(diffSubagentRuns([...projectSubagentRuns(subagentLog).values()], subagent)).toEqual([]);
  });
});

describe("finished, removed and gaps", () => {
  const run: PublicSubagentRun = {
    id: "run-1",
    parentSessionId: "session-1",
    task: "t",
    status: "running",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
  const done: PublicSubagentRun = {
    ...run,
    status: "completed",
    completedAt: "2026-10-15T00:00:05.000Z",
    summary: "S",
    summaryBytes: 1,
    model: "m",
    inputTokens: 3,
    outputTokens: 4,
    durationMs: 5000,
  };

  it("active -> terminal emits one finished with the structured result", () => {
    const drafts = diffSubagentRuns([run], [done]);
    expect(drafts.map((draft) => draft.kind)).toEqual(["subagent.run.finished"]);
    expect(drafts[0]!.payload).toEqual({
      run: expect.not.objectContaining({ summary: expect.anything() }),
      result: {
        status: "completed",
        summary: "S",
        summaryBytes: 1,
        tokens: { input: 3, output: 4 },
        durationMs: 5000,
        model: "m",
      },
    });
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

  it("updates for a run whose created event is missing are skipped (reconcile re-creates it)", () => {
    const [, finished] = diffSubagentRuns([], [done]);
    expect(projectSubagentRuns([finished!]).size).toBe(0);
    expect(diffSubagentRuns([], [done]).map((draft) => draft.kind)).toEqual([
      "subagent.run.created",
      "subagent.run.finished",
    ]);
  });

  it("a pruned loop run is removed from the projection", () => {
    const loop = states<PublicLoopRun>("loop-makerChecker").at(-1)!.runs;
    expect(projectLoopRuns(diffLoopRuns(loop, []), loop).size).toBe(0);
  });

  it("a Human Approval decision after the pause finishes the run again", () => {
    const paused: PublicLoopRun = {
      id: "l",
      loopName: "L",
      status: "stopped",
      stopReason: "humanInputRequired",
      currentIteration: 1,
      maxIterations: 1,
      startedAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:01.000Z",
      endedAt: "2026-10-15T00:00:01.000Z",
      iterations: [],
    };
    const approved = { ...paused, stopReason: "humanApproved" as const, updatedAt: "later" };
    const finished = (drafts: EventDraft[]) =>
      drafts.filter((draft) => draft.kind === "loop.run.finished");
    expect(finished(diffLoopRuns([], [paused]))).toHaveLength(1);
    expect(finished(diffLoopRuns([paused], [approved]))[0]!.payload).toMatchObject({
      result: { status: "stopped", stopReason: "humanApproved" },
    });
    expect(finished(diffLoopRuns([approved], [{ ...approved, updatedAt: "x" }]))).toHaveLength(0);
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
      artifactRootId: "r",
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
      artifactDirectoryId: "dir-id",
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
    for (const leaked of [
      "RAW",
      "/data",
      "/repo",
      "secret goal",
      "c:/repo",
      "npm test",
      "dir-id",
    ]) {
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

  it("caps summaries and task to their head with summaryBytes, errors to their tail", () => {
    const summary = "s".repeat(10_000);
    const run = toPublicSubagentRun({
      id: "r",
      parentSessionId: "p",
      task: "t".repeat(5_000),
      status: "failed",
      createdAt: "a",
      updatedAt: "b",
      summary,
      error: `${"x".repeat(20_000)}END`,
    });
    expect(run.summary).toBe(`${"s".repeat(MAX_EVENT_TEXT_CHARS)}\u2026`);
    expect(run.summaryBytes).toBe(10_000);
    expect(run.task).toHaveLength(MAX_EVENT_TEXT_CHARS + 1);
    expect(run.error!.endsWith("END")).toBe(true);
    expect(new TextEncoder().encode(run.error).byteLength).toBeLessThanOrEqual(
      MAX_EVENT_ERROR_BYTES,
    );
    // A surrogate pair at the cut is not split.
    expect(textHead(`${"a".repeat(3_999)}\u{1F600}b`)).toBe(`${"a".repeat(3_999)}\u2026`);
  });

  it("keeps the worst-case event far below MAX_EVENT_BYTES through the real serializer", () => {
    // Control characters JSON-escape to six bytes each: the worst case per character.
    const nasty = "\u0001".repeat(60_000);
    const run = toPublicSubagentRun({
      id: "r",
      parentSessionId: "p",
      task: nasty,
      agent: "a".repeat(500),
      status: "failed",
      createdAt: "a",
      updatedAt: "b",
      completedAt: "c",
      summary: nasty,
      error: nasty,
      model: "m".repeat(500),
    });
    const drafts = diffSubagentRuns([], [run]);
    for (const event of throughWriter(drafts)) {
      expect(event.payload).not.toHaveProperty("truncated");
      expect(new TextEncoder().encode(serializeEvent(event)).byteLength).toBeLessThan(
        MAX_EVENT_BYTES / 2,
      );
    }
  });

  it("utf8Suffix keeps the newest bytes without splitting a code point", () => {
    expect(utf8Suffix("abc", 10)).toBe("abc");
    expect(utf8Suffix("a\u00e9\u20ac", 3)).toBe("\u20ac");
    expect(utf8Suffix("a\u20ac", 2)).toBe("");
  });
});

describe("redactPaths", () => {
  const windows = [
    { prefix: "C:\\Users\\me\\AppData\\Roaming\\agent-deck", placeholder: "<data>" },
    { prefix: "C:\\Users\\me", placeholder: "~" },
    { prefix: "D:\\code\\repo", placeholder: "<project>" },
  ];
  const posix = [
    { prefix: "/home/me/.local/share/agent-deck", placeholder: "<data>" },
    { prefix: "/home/me", placeholder: "~" },
    { prefix: "/srv/repo", placeholder: "<project>" },
  ];

  it("replaces Windows prefixes in either slash style and case, then any drive or UNC path", () => {
    expect(
      redactPaths(
        "cannot read c:/users/ME/AppData/Roaming/agent-deck/loop-artifacts/x.md: EPERM",
        windows,
      ),
    ).toBe("cannot read <data>/loop-artifacts/x.md: EPERM");
    expect(redactPaths("git failed in D:\\code\\repo\\.git (worktree E:\\wt\\a)", windows)).toBe(
      "git failed in <project>\\.git (worktree <path>)",
    );
    expect(redactPaths("archive at \\\\nas\\share\\loops\\x.zip", windows)).toBe(
      "archive at <path>",
    );
    // A prefix matches whole segments only.
    expect(redactPaths("C:\\Users\\me2\\x", windows)).toBe("<path>");
  });

  it("replaces POSIX prefixes, then paths under the usual roots, and leaves the rest", () => {
    expect(redactPaths("ENOENT: /home/me/.local/share/agent-deck/events/x", posix)).toBe(
      "ENOENT: <data>/events/x",
    );
    expect(redactPaths("patch failed: /srv/repo/src/a.ts and /tmp/pi-123/out", posix)).toBe(
      "patch failed: <project>/src/a.ts and <path>",
    );
    expect(redactPaths("see https://example.com/home/page and a/b/c", posix)).toBe(
      "see https://example.com/home/page and a/b/c",
    );
  });

  it("is applied to every error and note in the public views (before capping)", () => {
    const options = { pathPrefixes: windows };
    const run = toPublicSubagentRun(
      {
        id: "r",
        parentSessionId: "p",
        task: "edit D:\\code\\repo\\src\\a.ts",
        status: "failed",
        createdAt: "a",
        updatedAt: "b",
        error: "spawn failed: C:\\Users\\me\\.pi\\agent\\bin\\pi.exe",
      },
      options,
    );
    expect(run.error).toBe("spawn failed: ~\\.pi\\agent\\bin\\pi.exe");
    expect(run.task).toBe("edit <project>\\src\\a.ts");
    const loop = toPublicLoopRun(
      {
        id: "l",
        loopName: "L",
        status: "failed",
        currentIteration: 1,
        maxIterations: 1,
        startedAt: "a",
        updatedAt: "b",
        review: {
          status: "applyUncertain",
          updatedAt: "a",
          availableAt: "a",
          error: "apply failed under /home/other/archive/loop-1",
        },
        iterations: [
          {
            id: "i",
            index: 1,
            startedAt: "a",
            output: "",
            validationPassed: null,
            timeline: [
              { id: "t", phase: "maker", roleName: "M", note: "wrote E:\\x\\y", timestamp: "a" },
            ],
            children: [{ id: "c", phase: "maker", error: "crashed in D:\\code\\repo\\tool" }],
            artifacts: [],
          },
        ],
      } as LoopRun,
      options,
    );
    expect(loop.review?.error).toBe("apply failed under <path>");
    expect(loop.iterations[0]!.children[0]!.error).toBe("crashed in <project>\\tool");
    expect(loop.iterations[0]!.timeline[0]!.note).toBe("wrote <path>");
  });
});

describe("secrets scan of the recorded fixtures", () => {
  // Hand copy of subagentRunStore.ts CAPABILITY_FIELDS (the server tests scan with the
  // exported set itself).
  const CAPABILITY_FIELDS = [
    "artifactRootId",
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
    "artifactDirectoryId",
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

  // Keys inside a tokens object are recorded as tokens.<key>: A6's loop child
  // tokens.output is a count, not the child's raw output.
  const keysOf = (value: unknown, out = new Set<string>(), prefix = ""): Set<string> => {
    if (Array.isArray(value)) for (const item of value) keysOf(item, out, prefix);
    else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        out.add(prefix + key);
        keysOf(nested, out, key === "tokens" ? "tokens." : "");
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
