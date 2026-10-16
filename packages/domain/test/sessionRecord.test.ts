import type { LegacySessionMeta, SessionMeta } from "@agent-deck/contracts";
import { describe, expect, it } from "vitest";
import {
  allowedOperations,
  isLegacySessionRecord,
  lineage,
  reviewRunId,
  sessionOwner,
  LOOP_FORK_REFUSAL,
  LOOP_REVIEW_PROMPT_REFUSAL,
  migrateSessionMeta,
  MOVING_REFUSAL,
  POINTER_REFUSAL,
  SESSION_OPERATIONS,
  sessionLifecycle,
  type OperationRefusal,
  type SessionActor,
  type SessionOperation,
} from "../src/sessionRecord.ts";

const AT = "2026-10-01T10:00:00.000Z";
const ALICE = { id: "alice@example.com", name: "Alice" };
const BOB = { id: "bob@example.com" };
const base = { id: "s1", cwd: "/repo", createdAt: AT };
const legacy = (fields: Record<string, unknown>): LegacySessionMeta =>
  ({ ...base, ...fields }) as LegacySessionMeta;

describe("migrateSessionMeta (ADR 0006): one case per legacy field", () => {
  it("a bare record gets version 2, provenance created and its location", () => {
    expect(migrateSessionMeta(legacy({}), "local")).toEqual({
      ...base,
      schemaVersion: 2,
      provenance: { kind: "created", by: {}, at: AT },
      location: { kind: "local" },
    });
  });

  it("createdBy stays the creator and becomes the owner and the provenance actor", () => {
    const record = migrateSessionMeta(legacy({ createdBy: ALICE }), "server");
    expect(record.createdBy).toEqual(ALICE);
    expect(record.location).toEqual({ kind: "server", owner: ALICE });
    expect(record.provenance).toEqual({ kind: "created", by: { user: ALICE }, at: AT });
  });

  it("lifecycle: draft is kept, started is dropped", () => {
    expect(migrateSessionMeta(legacy({ lifecycle: "draft" }), "local").lifecycle).toBe("draft");
    expect("lifecycle" in migrateSessionMeta(legacy({ lifecycle: "started" }), "local")).toBe(
      false,
    );
  });

  it("launchPlan, launchResourceConfig, launchResourceFingerprint, resourceRefreshError → launch", () => {
    const resourceConfig = { version: 1, providerOverride: "openai", skillsOverride: ["a"] };
    const record = migrateSessionMeta(
      legacy({
        launchPlan: { kind: "parent", provider: "openai" },
        launchResourceConfig: resourceConfig,
        launchResourceFingerprint: "f".repeat(64),
        resourceRefreshError: "stale",
      }),
      "local",
    );
    expect(record.launch).toEqual({
      plan: { kind: "parent", provider: "openai" },
      resourceConfig,
      fingerprint: "f".repeat(64),
      refreshError: "stale",
    });
  });

  it.each([
    ["worktreePath", "path", "/wt"],
    ["worktreeIdentity", "identity", "token"],
    ["worktreeBranch", "branch", "agent-deck/session-s1"],
    ["worktreeSourceBranch", "sourceBranch", "main"],
    ["worktreeCleanupBranchHead", "cleanupBranchHead", "abc"],
    ["worktreeOwnerSessionId", "ownerSessionId", "s0"],
  ])("%s → workspace.%s", (old, field, value) => {
    const record = migrateSessionMeta(legacy({ [old]: value }), "local");
    expect(record.workspace).toEqual({ [field]: value });
    expect(old in record).toBe(false);
  });

  it("loopReviewRunId → provenance reviewed from the run", () => {
    const record = migrateSessionMeta(legacy({ loopReviewRunId: "run-1" }), "local");
    expect(record.provenance).toEqual({
      kind: "reviewed",
      from: { runId: "run-1" },
      by: {},
      at: AT,
    });
  });

  it("forkProvenance → provenance forked at a message, with its recap", () => {
    const record = migrateSessionMeta(
      legacy({
        createdBy: BOB,
        forkProvenance: {
          version: 1,
          sourceSessionId: "src",
          sourceEntryId: "e1",
          sourceTitle: "Source",
          recap: "user: hi",
          recapTruncated: true,
        },
      }),
      "local",
    );
    expect(record.provenance).toEqual({
      kind: "forked",
      from: { sessionId: "src", entryId: "e1", title: "Source" },
      by: { user: BOB },
      at: AT,
      recap: { text: "user: hi", truncated: true },
    });
  });

  it("forkedFrom → provenance forked, with the source's title and owner then", () => {
    const record = migrateSessionMeta(
      legacy({ forkedFrom: { sessionId: "src", title: "T", owner: ALICE } }),
      "server",
    );
    expect(record.provenance).toEqual({
      kind: "forked",
      from: { sessionId: "src", title: "T", owner: ALICE },
      by: {},
      at: AT,
    });
  });

  it("sharedFrom → provenance imported from the device; exportSha256 → transcriptSha256", () => {
    const record = migrateSessionMeta(
      legacy({
        createdBy: ALICE,
        sharedFrom: {
          device: "laptop",
          localSessionId: "local-1",
          sharedAt: "2026-10-02T00:00:00.000Z",
          mode: "conversation",
          exportSha256: "e".repeat(64),
        },
      }),
      "server",
    );
    expect(record.provenance).toEqual({
      kind: "imported",
      from: { device: "laptop", localSessionId: "local-1" },
      by: { user: ALICE },
      at: "2026-10-02T00:00:00.000Z",
      mode: "conversation",
    });
    expect(record.transcriptSha256).toBe("e".repeat(64));
  });

  it("sharedTo to the server → location.live on the device", () => {
    const record = migrateSessionMeta(
      legacy({
        sharedTo: {
          serverOrigin: "https://deck.example.com",
          serverSessionId: "srv-1",
          sharedAt: AT,
          mode: "snapshot",
        },
      }),
      "local",
    );
    expect(record.location).toEqual({
      kind: "local",
      live: {
        serverOrigin: "https://deck.example.com",
        sessionId: "srv-1",
        at: AT,
        mode: "snapshot",
      },
    });
  });

  it("sharedTo back to a device → location.live on the server", () => {
    const record = migrateSessionMeta(
      legacy({
        sharedTo: {
          serverOrigin: null,
          device: "laptop",
          deviceSessionId: "local-1",
          sharedAt: AT,
          mode: "snapshot",
        },
      }),
      "server",
    );
    expect(record.location?.live).toEqual({
      device: "laptop",
      sessionId: "local-1",
      at: AT,
      mode: "snapshot",
    });
  });

  it("returnedFrom → provenance returned; its mergePr → location.mergePr", () => {
    const record = migrateSessionMeta(
      legacy({
        returnedFrom: {
          serverOrigin: "https://deck.example.com",
          serverSessionId: "srv-1",
          returnedAt: "2026-10-03T00:00:00.000Z",
          mergePr: { url: "https://github.com/a/b/pull/9", number: 9 },
        },
      }),
      "local",
    );
    expect(record.provenance).toEqual({
      kind: "returned",
      from: { sessionId: "srv-1", serverOrigin: "https://deck.example.com" },
      by: {},
      at: "2026-10-03T00:00:00.000Z",
    });
    expect(record.location?.mergePr).toEqual({ url: "https://github.com/a/b/pull/9", number: 9 });
  });

  it("returnPending → location.transfer (direction return)", () => {
    const record = migrateSessionMeta(
      legacy({
        returnPending: {
          token: "tok",
          serverOrigin: "https://deck.example.com",
          serverSessionId: "srv-1",
          ref: "refs/agent-deck/transfer/s1",
          until: AT,
        },
      }),
      "local",
    );
    expect(record.location?.transfer).toEqual({
      direction: "return",
      token: "tok",
      serverOrigin: "https://deck.example.com",
      sessionId: "srv-1",
      ref: "refs/agent-deck/transfer/s1",
      until: AT,
    });
  });

  it("mergePr → location.mergePr", () => {
    const pr = { url: "https://github.com/a/b/pull/7", number: 7, openedAt: AT };
    expect(migrateSessionMeta(legacy({ mergePr: pr }), "server").location?.mergePr).toEqual(pr);
  });

  it("the Loop review marker wins over any other origin (it is a capability)", () => {
    const record = migrateSessionMeta(
      legacy({
        loopReviewRunId: "run-1",
        sharedFrom: { device: "laptop", localSessionId: "l", sharedAt: AT, mode: "snapshot" },
      }),
      "server",
    );
    expect(record.provenance).toMatchObject({ kind: "reviewed", from: { runId: "run-1" } });
  });

  it("a fork's provenance wins over a later return of the same record", () => {
    const record = migrateSessionMeta(
      legacy({
        forkedFrom: { sessionId: "src" },
        returnedFrom: { serverOrigin: "https://x", serverSessionId: "srv", returnedAt: AT },
      }),
      "local",
    );
    expect(record.provenance?.kind).toBe("forked");
  });

  it("keeps unknown and unrelated fields, and drops every legacy key", () => {
    const record = migrateSessionMeta(
      legacy({
        title: "T",
        plan: [{ id: "p", text: "x", status: "pending" }],
        futureField: { keep: true },
        sharedTo: {
          serverOrigin: "https://x",
          serverSessionId: "srv",
          sharedAt: AT,
          mode: "snapshot",
        },
        worktreePath: "/wt",
      }),
      "local",
    ) as SessionMeta & Record<string, unknown>;
    expect(record.title).toBe("T");
    expect(record.plan).toEqual([{ id: "p", text: "x", status: "pending" }]);
    expect(record.futureField).toEqual({ keep: true });
    expect(record.sharedTo).toBeUndefined();
    expect(record.worktreePath).toBeUndefined();
  });

  it("keeps the v2 objects an unversioned record already carries when no legacy key is beside them", () => {
    const provenance = { kind: "forked" as const, from: { sessionId: "src" }, by: {}, at: AT };
    const workspace = { ownerSessionId: "owner" };
    const record = migrateSessionMeta(legacy({ provenance, workspace }), "local");
    expect(record.provenance).toEqual(provenance);
    expect(record.workspace).toEqual(workspace);
    expect(record.location).toEqual({ kind: "local" });
  });

  it("is idempotent, and leaves a clean v2 record unchanged", () => {
    const once = migrateSessionMeta(legacy({ forkedFrom: { sessionId: "src" } }), "local");
    expect(migrateSessionMeta(once, "local")).toEqual(once);
    expect(isLegacySessionRecord(once)).toBe(false);
  });

  it("takes location.kind from the side reading the record, never from storage", () => {
    const stamped = { ...migrateSessionMeta(legacy({}), "server") };
    expect(stamped.location?.kind).toBe("server");
    expect(migrateSessionMeta(stamped, "local").location?.kind).toBe("local");
  });
});

describe("migrateSessionMeta: legacy keys an older build wrote beside a migrated record", () => {
  const migrated = migrateSessionMeta(
    legacy({
      createdBy: ALICE,
      launchPlan: { kind: "parent", model: "a" },
      worktreePath: "/wt",
      worktreeBranch: "agent-deck/session-s1",
    }),
    "local",
  );

  it("a sharedTo written by an older build makes the record a pointer again", () => {
    const written = {
      ...migrated,
      sharedTo: {
        serverOrigin: "https://x",
        serverSessionId: "srv",
        sharedAt: AT,
        mode: "snapshot",
      },
    } as unknown as SessionMeta;
    expect(isLegacySessionRecord(written)).toBe(true);
    const record = migrateSessionMeta(written, "local") as SessionMeta & Record<string, unknown>;
    expect(sessionLifecycle(record)).toBe("pointer");
    expect(record.location).toEqual({
      kind: "local",
      owner: ALICE,
      live: { serverOrigin: "https://x", sessionId: "srv", at: AT, mode: "snapshot" },
    });
    expect(record.sharedTo).toBeUndefined();
    // Untouched groups keep their v2 objects.
    expect(record.workspace).toEqual(migrated.workspace);
    expect(migrateSessionMeta(record, "local")).toEqual(record);
  });

  it("a mergePr an older build wrote beside a v2 pointer keeps the pointer (per key)", () => {
    const pointer = migrateSessionMeta(
      {
        ...migrated,
        sharedTo: {
          serverOrigin: "https://x",
          serverSessionId: "srv",
          sharedAt: AT,
          mode: "snapshot",
        },
      } as unknown as SessionMeta,
      "server",
    );
    const merged = migrateSessionMeta(
      {
        ...pointer,
        mergePr: { url: "https://github.com/a/b/pull/3", number: 3, openedAt: AT },
      } as unknown as SessionMeta,
      "server",
    );
    expect(sessionLifecycle(merged)).toBe("pointer");
    expect(merged.location?.live).toEqual(pointer.location?.live);
    expect(merged.location?.mergePr).toEqual({
      url: "https://github.com/a/b/pull/3",
      number: 3,
      openedAt: AT,
    });
    expect(migrateSessionMeta(merged, "server")).toEqual(merged);
  });

  it("a returnPending maps the hand-off only; a sharedTo it did not rewrite stays (known limit)", () => {
    const pointer = migrateSessionMeta(
      {
        ...migrated,
        sharedTo: {
          serverOrigin: "https://x",
          serverSessionId: "srv",
          sharedAt: AT,
          mode: "snapshot",
        },
      } as unknown as SessionMeta,
      "local",
    );
    const back = migrateSessionMeta(
      {
        ...pointer,
        returnPending: { token: "t", serverOrigin: "https://x", serverSessionId: "srv", until: AT },
      } as unknown as SessionMeta,
      "local",
    );
    expect(back.location?.live).toEqual(pointer.location?.live);
    expect(back.location?.transfer).toMatchObject({ token: "t", sessionId: "srv" });
  });

  it("a launchPlan written by an older build becomes launch.plan", () => {
    const written = {
      ...migrated,
      launchPlan: { kind: "parent", model: "b" },
    } as unknown as SessionMeta;
    const record = migrateSessionMeta(written, "local") as SessionMeta & Record<string, unknown>;
    expect(record.launch).toEqual({ plan: { kind: "parent", model: "b" } });
    expect(record.launchPlan).toBeUndefined();
    expect(migrateSessionMeta(record, "local")).toEqual(record);
  });

  it("drops the old started lifecycle an older build wrote", () => {
    const written = { ...migrated, lifecycle: "started" } as unknown as SessionMeta;
    expect(isLegacySessionRecord(written)).toBe(true);
    expect(migrateSessionMeta(written, "local").lifecycle).toBeUndefined();
  });
});

describe("malformed or future provenance and location never throw", () => {
  const odd = (fields: Record<string, unknown>) =>
    ({ ...base, schemaVersion: 2, piSessionFile: "/p", ...fields }) as unknown as SessionMeta;
  const records = [
    odd({ provenance: { kind: "forked", from: "future-origin", by: {}, at: AT } }),
    odd({ provenance: { kind: "scheduled", from: { cron: "* * *" }, by: "system", at: AT } }),
    odd({ provenance: { kind: "reviewed", from: 7, by: {}, at: AT } }),
    odd({ provenance: { kind: "imported", from: null, by: {}, at: AT } }),
    odd({ location: { kind: "server", live: "elsewhere", owner: "x" } }),
    odd({ provenance: "created", location: 3 }),
  ];

  it("allowedOperations, lifecycle, owner and lineage read them as absent", () => {
    for (const subject of records) {
      expect(() => allowedOperations(subject, { user: ALICE })).not.toThrow();
      expect(sessionLifecycle(subject)).toBe("running");
      expect(reviewRunId(subject)).toBeUndefined();
      expect(() => sessionOwner(subject)).not.toThrow();
    }
    const others = records.map((subject, index) => ({ ...subject, id: `odd-${index}` }));
    expect(lineage([...others, record({ id: "fine" })], "fine")).toEqual({
      ancestors: [],
      descendants: [],
    });
  });
});

describe("sessionOwner", () => {
  it("is location.owner, else the creator", () => {
    expect(sessionOwner(record({ location: { kind: "server", owner: BOB } }))).toEqual(BOB);
    expect(sessionOwner({ createdBy: ALICE, location: { kind: "server" } })).toEqual(ALICE);
    expect(sessionOwner({})).toBeUndefined();
  });

  it("refuses the operator a pull request for a record without any owner", () => {
    const ownerless = server({ location: { kind: "server" } });
    expect(allowedOperations(ownerless, OPERATOR).refused.mergePullRequest?.code).toBe(
      "merge_forbidden",
    );
    expect(allowedOperations(server(), OPERATOR).refused.mergePullRequest).toBeUndefined();
  });

  it("authorises the creator of a record that has no location.owner", () => {
    const creatorOnly = server({ createdBy: ALICE, location: { kind: "server" } });
    expect(allowedOperations(creatorOnly, OWNER).refused.return).toBeUndefined();
    expect(allowedOperations(creatorOnly, OWNER).refused.mergePullRequest).toBeUndefined();
    expect(allowedOperations(creatorOnly, OTHER).refused.mergePullRequest?.code).toBe(
      "merge_forbidden",
    );
  });
});

const record = (fields: Partial<SessionMeta> = {}): SessionMeta => ({
  ...base,
  schemaVersion: 2,
  piSessionFile: "/pi/s1.jsonl",
  provenance: { kind: "created", by: { user: ALICE }, at: AT },
  location: { kind: "local", owner: ALICE },
  ...fields,
});
const server = (fields: Partial<SessionMeta> = {}): SessionMeta =>
  record({
    provenance: {
      kind: "imported",
      from: { device: "laptop", localSessionId: "local-1" },
      by: { user: ALICE },
      at: AT,
    },
    location: { kind: "server", owner: ALICE },
    ...fields,
  });
const devicePointer = record({
  location: {
    kind: "local",
    owner: ALICE,
    live: { serverOrigin: "https://deck.example.com", sessionId: "srv", at: AT, mode: "snapshot" },
  },
});
const serverPointer = server({
  location: {
    kind: "server",
    owner: ALICE,
    live: { device: "laptop", sessionId: "local-1", at: AT, mode: "snapshot" },
  },
});
const review = record({
  provenance: { kind: "reviewed", from: { runId: "run-1" }, by: {}, at: AT },
});

const shared = (error = POINTER_REFUSAL): OperationRefusal => ({
  status: 409,
  code: "session_shared",
  error,
});
const moving = (error = MOVING_REFUSAL): OperationRefusal => ({
  status: 409,
  code: "session_moving",
  error,
});
const conflict = (code: string, error: string): OperationRefusal => ({ status: 409, code, error });
const OWNER: SessionActor = { user: ALICE };
const OTHER: SessionActor = { user: BOB };
const OPERATOR: SessionActor = { user: BOB, operator: true };

describe("sessionLifecycle", () => {
  it.each<[string, Partial<SessionMeta>, { moving?: boolean }, string]>([
    ["draft", { lifecycle: "draft" }, {}, "draft"],
    ["running", {}, {}, "running"],
    ["parked", { parkedAt: AT }, {}, "parked"],
    ["ended", { endedAt: AT, parkedAt: AT }, {}, "ended"],
    ["moving claim", {}, { moving: true }, "moving"],
    [
      "pointer, even with a claim",
      { location: devicePointer.location },
      { moving: true },
      "pointer",
    ],
  ])("%s", (_name, fields, runtime, expected) => {
    expect(sessionLifecycle(record(fields), runtime)).toBe(expected);
  });
});

/**
 * Every refusal the routes made before ADR 0006, keyed on (lifecycle, location,
 * actor): the ade-q0pz dispositions are the regression net. Each row names the
 * record, the actor, the hand-off claim and the exact refusal per operation;
 * every operation the row does not name is allowed.
 */
const TABLE: Array<{
  name: string;
  record: SessionMeta;
  actor?: SessionActor;
  moving?: boolean;
  refused: Partial<Record<SessionOperation, OperationRefusal>>;
}> = [
  {
    name: "device, running, owner",
    record: record(),
    actor: OWNER,
    refused: {
      mergePullRequest: undefined,
      return: { status: 409, error: "A session goes back to a device from a shared server." },
      returnFinish: { status: 409, error: "A session goes back to a device from a shared server." },
      returnCancel: { status: 409, error: "A session goes back to a device from a shared server." },
    },
  },
  {
    name: "device, no sign-in (merge as PR needs an owner)",
    record: record({ location: { kind: "local" } }),
    refused: {
      mergePullRequest: {
        status: 403,
        code: "merge_forbidden",
        error: "Only the person who owns this session, or the operator, can open its pull request.",
      },
      return: { status: 409, error: "A session goes back to a device from a shared server." },
      returnFinish: { status: 409, error: "A session goes back to a device from a shared server." },
      returnCancel: { status: 409, error: "A session goes back to a device from a shared server." },
    },
  },
  {
    name: "device, draft",
    record: record({ lifecycle: "draft", piSessionFile: undefined }),
    actor: OWNER,
    refused: {
      move: conflict(
        "share_refused",
        "This session has nothing to move yet: send a first message.",
      ),
      return: { status: 409, error: "A session goes back to a device from a shared server." },
      returnFinish: { status: 409, error: "A session goes back to a device from a shared server." },
      returnCancel: { status: 409, error: "A session goes back to a device from a shared server." },
    },
  },
  {
    name: "device, moving (share claim)",
    record: record(),
    actor: OWNER,
    moving: true,
    refused: {
      prompt: moving(),
      steer: moving(),
      rollback: moving(),
      compact: moving(),
      configure: moving(),
      delegate: moving(),
      rename: moving(),
      planRetry: moving(),
      composerDraft: moving("This session is moving between a device and the shared server."),
      return: { status: 409, error: "A session goes back to a device from a shared server." },
      returnFinish: { status: 409, error: "A session goes back to a device from a shared server." },
      returnCancel: { status: 409, error: "A session goes back to a device from a shared server." },
    },
  },
  {
    name: "device pointer to the server",
    record: devicePointer,
    actor: OWNER,
    refused: {
      prompt: shared(),
      steer: shared(),
      rollback: shared(),
      compact: shared(),
      configure: shared(),
      runtime: shared(),
      resume: shared(),
      rename: shared(),
      planRetry: shared(),
      delegate: shared(),
      historyFork: shared(),
      merge: shared(),
      mergePullRequest: shared(),
      composerDraft: shared("This session continues on another copy."),
      move: conflict("share_refused", "This session already continues on deck.example.com."),
      return: { status: 409, error: "A session goes back to a device from a shared server." },
      returnFinish: { status: 409, error: "A session goes back to a device from a shared server." },
      returnCancel: { status: 409, error: "A session goes back to a device from a shared server." },
    },
  },
  {
    name: "device, Loop review session",
    record: review,
    actor: OWNER,
    refused: {
      prompt: { status: 409, error: LOOP_REVIEW_PROMPT_REFUSAL },
      steer: { status: 409, error: LOOP_REVIEW_PROMPT_REFUSAL },
      fork: { status: 409, error: LOOP_FORK_REFUSAL },
      historyFork: conflict("history_fork_refused", LOOP_FORK_REFUSAL),
      merge: conflict(
        "loop_review_read_only",
        "Loop review sessions are read-only. Merge and apply are unavailable.",
      ),
      mergePullRequest: conflict(
        "loop_review_read_only",
        "Loop review sessions are read-only. Merge and apply are unavailable.",
      ),
      move: conflict("share_refused", "A Loop session cannot move to a server."),
      return: { status: 409, error: "A session goes back to a device from a shared server." },
      returnFinish: { status: 409, error: "A session goes back to a device from a shared server." },
      returnCancel: { status: 409, error: "A session goes back to a device from a shared server." },
    },
  },
  {
    name: "device, a Loop run's parent session (by agent name)",
    record: record({ agentName: "Loop · tests" }),
    actor: OWNER,
    refused: {
      fork: { status: 409, error: LOOP_FORK_REFUSAL },
      historyFork: conflict("history_fork_refused", LOOP_FORK_REFUSAL),
      move: conflict("share_refused", "A Loop session cannot move to a server."),
      return: { status: 409, error: "A session goes back to a device from a shared server." },
      returnFinish: { status: 409, error: "A session goes back to a device from a shared server." },
      returnCancel: { status: 409, error: "A session goes back to a device from a shared server." },
    },
  },
  {
    name: "server, imported, owner",
    record: server(),
    actor: OWNER,
    refused: {
      move: conflict("share_refused", "This session is already on a shared server."),
    },
  },
  {
    name: "server, imported, another member",
    record: server(),
    actor: OTHER,
    refused: {
      move: conflict("share_refused", "This session is already on a shared server."),
      mergePullRequest: {
        status: 403,
        code: "merge_forbidden",
        error: "Only the person who owns this session, or the operator, can open its pull request.",
      },
      return: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session can bring it back.",
      },
      returnFinish: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session can bring it back.",
      },
      returnCancel: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session, or the operator, can cancel its return.",
      },
    },
  },
  {
    name: "server, imported, the operator",
    record: server(),
    actor: OPERATOR,
    refused: {
      move: conflict("share_refused", "This session is already on a shared server."),
      return: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session can bring it back.",
      },
      returnFinish: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session can bring it back.",
      },
    },
  },
  {
    name: "server, imported, signed out",
    record: server(),
    refused: {
      move: conflict("share_refused", "This session is already on a shared server."),
      mergePullRequest: {
        status: 403,
        code: "merge_forbidden",
        error: "Only the person who owns this session, or the operator, can open its pull request.",
      },
      return: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session can bring it back.",
      },
      returnFinish: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session can bring it back.",
      },
      returnCancel: {
        status: 403,
        code: "return_forbidden",
        error: "Only the person who owns this session, or the operator, can cancel its return.",
      },
    },
  },
  {
    name: "server, return prepared (moving), owner",
    record: server(),
    actor: OWNER,
    moving: true,
    refused: {
      prompt: moving(),
      steer: moving(),
      rollback: moving(),
      compact: moving(),
      configure: moving(),
      delegate: moving(),
      rename: moving(),
      planRetry: moving(),
      composerDraft: moving("This session is moving between a device and the shared server."),
      move: conflict("share_refused", "This session is already on a shared server."),
      return: conflict(
        "return_in_progress",
        "A return of this session is already prepared. Finish it, or cancel it first.",
      ),
    },
  },
  {
    name: "server, created there (not from a device), owner",
    record: server({ provenance: { kind: "created", by: { user: ALICE }, at: AT } }),
    actor: OWNER,
    refused: {
      move: conflict("share_refused", "This session is already on a shared server."),
      return: conflict(
        "return_refused",
        "This session did not come from a device: there is nothing to bring back.",
      ),
    },
  },
  {
    name: "server, imported draft, owner",
    record: server({ piSessionFile: undefined }),
    actor: OWNER,
    refused: {
      move: conflict("share_refused", "This session is already on a shared server."),
      return: conflict("return_refused", "This session has nothing to bring back yet."),
    },
  },
  {
    name: "server, imported Loop session, owner",
    record: server({ agentName: "Loop · x" }),
    actor: OWNER,
    refused: {
      fork: { status: 409, error: LOOP_FORK_REFUSAL },
      historyFork: conflict("history_fork_refused", LOOP_FORK_REFUSAL),
      move: conflict("share_refused", "This session is already on a shared server."),
      return: conflict("return_refused", "A Loop session cannot move to a device."),
    },
  },
  {
    name: "server pointer back to the device, owner",
    record: serverPointer,
    actor: OWNER,
    refused: {
      prompt: shared(),
      steer: shared(),
      rollback: shared(),
      compact: shared(),
      configure: shared(),
      runtime: shared(),
      resume: shared(),
      rename: shared(),
      planRetry: shared(),
      delegate: shared(),
      historyFork: shared(),
      merge: shared(),
      mergePullRequest: shared(),
      composerDraft: shared("This session continues on another copy."),
      move: conflict("share_refused", "This session is already on a shared server."),
      return: conflict("return_refused", "This session already continues on laptop."),
    },
  },
];

describe("allowedOperations: the refusal table lifted from the routes", () => {
  it.each(TABLE)("$name", ({ record: subject, actor, moving: claim, refused }) => {
    const result = allowedOperations(subject, actor, { moving: claim });
    for (const operation of SESSION_OPERATIONS) {
      const expected = refused[operation];
      expect([operation, result.refused[operation]]).toEqual([operation, expected]);
      expect([operation, result.allowed.has(operation)]).toEqual([operation, !expected]);
    }
  });

  it("a pointer always allows a plain fork, delete and pin", () => {
    for (const pointer of [devicePointer, serverPointer]) {
      const { allowed } = allowedOperations(pointer, OWNER);
      expect([...allowed].filter((op) => ["fork", "delete", "pin"].includes(op))).toEqual([
        "fork",
        "delete",
        "pin",
      ]);
    }
  });
});

describe("lineage", () => {
  const forkOf = (id: string, source: string): SessionMeta =>
    record({
      id,
      provenance: { kind: "forked", from: { sessionId: source }, by: {}, at: AT },
    });

  it("walks provenance.from both ways, nearest ancestor first", () => {
    const records = [record({ id: "a" }), forkOf("b", "a"), forkOf("c", "b"), forkOf("d", "a")];
    const { ancestors, descendants } = lineage(records, "b");
    expect(ancestors.map((item) => item.id)).toEqual(["a"]);
    expect(descendants.map((item) => item.id)).toEqual(["c"]);
    expect(lineage(records, "a").descendants.map((item) => item.id)).toEqual(["b", "d", "c"]);
    expect(lineage(records, "c").ancestors.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("stops at a source this side does not hold, and survives a cycle", () => {
    expect(lineage([forkOf("b", "gone")], "b")).toEqual({ ancestors: [], descendants: [] });
    const cycle = [forkOf("x", "y"), forkOf("y", "x")];
    expect(lineage(cycle, "x").ancestors.map((item) => item.id)).toEqual(["y"]);
    expect(lineage(cycle, "x").descendants.map((item) => item.id)).toEqual(["y"]);
  });

  it("ignores device and run origins (no local record to link)", () => {
    expect(lineage([server(), review], "s1")).toEqual({ ancestors: [], descendants: [] });
  });
});
