import { describe, expect, it } from "vitest";
import { validateEnvelope, type EventDraft, type EventEnvelope } from "../src/events.ts";
import {
  askUserAnswerText,
  extensionUiAnswerText,
  humanAnsweredDraft,
  humanCancelledDraft,
  humanExpiredDraft,
  humanFromAskUser,
  humanFromExtensionUi,
  humanFromLoopApproval,
  humanFromSupervisor,
  humanRequestedDraft,
  humanTimeoutPolicy,
  humanTimeoutPolicyParamSchema,
  openHumanNodes,
  projectOpenHumanRequests,
  WITHHELD_ANSWER,
} from "../src/humanNode.ts";
import { projectNodeTree } from "../src/nodeTree.ts";

const AT = new Date("2026-10-15T10:00:00.000Z");
const ALE = { type: "user" as const, id: "ale@example.com", name: "Ale" };

let seq = 0;
const envelope = (draft: EventDraft, ts = AT.toISOString()): EventEnvelope => {
  seq += 1;
  const event = {
    v: 1 as const,
    id: draft.id ?? `e${seq}`,
    seq,
    ts,
    logId: "log",
    projectId: draft.projectId ?? null,
    ...draft,
  };
  // Every draft is a valid envelope for the writer (closed node-type enum included).
  expect(validateEnvelope(event)).not.toBeNull();
  return event as EventEnvelope;
};

describe("mapping the three request shapes", () => {
  it("loopApproval: the run's checkpoint under its loop run, asked by the system", () => {
    const draft = humanRequestedDraft(
      humanFromLoopApproval({ id: "run-1", checkpointPrompt: "Ship it?", projectId: "p1" }),
      AT,
    );
    expect(draft).toMatchObject({
      kind: "human.requested",
      projectId: "p1",
      subject: { type: "human", id: "run-1" },
      parent: { type: "loopRun", id: "run-1" },
      actor: { type: "system" },
      payload: {
        kind: "loopApproval",
        prompt: "Ship it?",
        options: ["approve", "reject"],
        timeoutPolicy: { type: "none" },
      },
    });
    expect(draft.payload).not.toHaveProperty("expiresAt");
  });

  it("decision: the child's request under its subagent run, asked by the child", () => {
    const draft = humanRequestedDraft(
      humanFromSupervisor(
        {
          id: "req-1",
          parentSessionId: "parent",
          cellId: "run-9",
          title: "Pick",
          message: "A or B",
        },
        "child",
        ["A", "B"],
      ),
      AT,
    );
    expect(draft).toMatchObject({
      sessionId: "parent",
      subject: { type: "human", id: "req-1" },
      parent: { type: "subagentRun", id: "run-9" },
      actor: { type: "agent", sessionId: "child" },
      causationId: "req-1",
      payload: { kind: "decision", prompt: "Pick\n\nA or B", options: ["A", "B"] },
    });
  });

  it("askUser (tool): question and context, option titles, the opt-in policy with its expiry", () => {
    const policy = humanTimeoutPolicy(
      humanTimeoutPolicyParamSchema.parse({ afterMinutes: 2, then: "default", default: "Wait" }),
    );
    const draft = humanRequestedDraft(
      humanFromAskUser(
        {
          requestId: "ask-1",
          sessionId: "s1",
          question: "Deploy?",
          context: "CI is green",
          options: [{ title: "Ship" }, { title: "Wait" }],
        },
        policy,
      ),
      AT,
    );
    expect(draft).toMatchObject({
      sessionId: "s1",
      subject: { type: "human", id: "ask-1" },
      actor: { type: "agent", sessionId: "s1" },
      payload: {
        kind: "askUser",
        prompt: "Deploy?\n\nCI is green",
        options: ["Ship", "Wait"],
        timeoutPolicy: { type: "expire", afterMinutes: 2, then: "default", default: "Wait" },
        expiresAt: "2026-10-15T10:02:00.000Z",
      },
    });
    // No explicit parent: the server places it under the session's running turn.
    expect(draft).not.toHaveProperty("parent");
  });

  it("askUser (extension UI): select options, confirm as yes/no, a sign-in code withheld", () => {
    const select = humanFromExtensionUi("s1", {
      id: "u1",
      method: "select",
      title: "Pick a model",
      options: ["a", "b"],
    });
    expect(select).toMatchObject({ id: "s1/ui/u1", kind: "askUser", options: ["a", "b"] });
    expect(
      humanFromExtensionUi("s1", { id: "u2", method: "confirm", title: "Sure?" }).options,
    ).toEqual(["yes", "no"]);
    const signIn = humanFromExtensionUi("s1", {
      id: "u3",
      method: "input",
      title: 'Waiting for sign-in to "github". Paste the code',
    });
    expect(humanRequestedDraft(signIn, AT).payload).toMatchObject({ withholdAnswer: true });
    expect(
      humanAnsweredDraft(signIn, ALE, "4/0AbCdEf-secret-code", { withhold: true }).payload,
    ).toEqual({ by: ALE, answer: WITHHELD_ANSWER });
    expect(extensionUiAnswerText({ confirmed: false })).toBe("no");
    expect(extensionUiAnswerText({ value: "b" })).toBe("b");
    expect(extensionUiAnswerText({ cancelled: true })).toBeUndefined();
  });

  it("answers record who answered; text is redacted and capped", () => {
    const draft = humanAnsweredDraft(
      { id: "ask-1", sessionId: "s1" },
      ALE,
      `use token=ghp_${"a".repeat(30)} from C:\\Users\\ale\\repo ${"x".repeat(5_000)}`,
    );
    expect(draft.actor).toEqual(ALE);
    const payload = draft.payload as { by: unknown; answer: string };
    expect(payload.by).toEqual(ALE);
    expect(payload.answer).not.toContain("ghp_");
    expect(payload.answer).not.toContain("Users");
    expect(payload.answer.length).toBeLessThanOrEqual(4_000);
    expect(askUserAnswerText({ selections: ["Ship"], comment: "now" })).toBe(
      "Ship\n\nComment: now",
    );
    expect(askUserAnswerText({ selections: [], freeform: "later" })).toBe("later");
  });

  it("rejects a policy over the cap or a default policy without a default", () => {
    expect(
      humanTimeoutPolicyParamSchema.safeParse({ afterMinutes: 5, then: "blocked" }).success,
    ).toBe(false);
    expect(
      humanTimeoutPolicyParamSchema.safeParse({ afterMinutes: 1, then: "default" }).success,
    ).toBe(false);
    expect(humanTimeoutPolicy(undefined)).toEqual({ type: "none" });
  });
});

describe("human nodes in the tree", () => {
  const session = (id: string): EventDraft => ({
    kind: "session.created",
    sessionId: id,
    subject: { type: "session", id },
    actor: { type: "system" },
    payload: {},
  });

  it("projects each kind under its parent and records answer, expiry and cancellation", () => {
    const ask = humanFromAskUser({
      requestId: "ask-1",
      sessionId: "s1",
      question: "Deploy?",
      options: [],
    });
    const events = [
      envelope(session("s1")),
      envelope({
        id: "turn-ev",
        kind: "turn.prompted",
        sessionId: "s1",
        subject: { type: "turn", id: "t1" },
        parent: { type: "session", id: "s1" },
        actor: ALE,
        payload: { mode: "prompt", label: "go" },
      }),
      envelope(humanRequestedDraft({ ...ask, parent: { type: "turn", id: "t1" } }, AT)),
      envelope(
        humanRequestedDraft(
          humanFromSupervisor(
            { id: "req-1", parentSessionId: "s1", cellId: "run-9", message: "A or B" },
            "child",
          ),
          AT,
        ),
      ),
      envelope(
        humanRequestedDraft(
          {
            ...humanFromAskUser({
              requestId: "ask-2",
              sessionId: "s1",
              question: "Later?",
              options: [],
            }),
            timeoutPolicy: { type: "expire", afterMinutes: 1, then: "blocked" },
            parent: { type: "turn", id: "t1" },
          },
          AT,
        ),
      ),
      envelope(humanAnsweredDraft(ask, ALE, "yes")),
      // A late second answer never rewrites the first.
      envelope(humanAnsweredDraft(ask, { type: "user", id: "bob@example.com" }, "no")),
      envelope(
        humanExpiredDraft(
          { id: "ask-2", sessionId: "s1" },
          { type: "expire", afterMinutes: 1, then: "blocked" },
        ),
      ),
    ];
    const tree = projectNodeTree(events, { sessionId: "s1" });
    const turn = tree.nodes.get("turn:t1")!;
    const answered = tree.nodes.get("human:ask-1")!;
    expect(answered.parent).toBe("turn:t1");
    expect(answered).toMatchObject({ status: "done", label: "Deploy?" });
    expect(answered.human).toMatchObject({ kind: "askUser", by: ALE, answer: "yes" });
    expect(turn.children.map((child) => child.key)).toEqual(["human:ask-1", "human:ask-2"]);
    expect(tree.nodes.get("human:ask-2")).toMatchObject({
      status: "stopped",
      human: { expired: "blocked" },
    });
    // The decision sits under its subagent run (a placeholder here) and is still open.
    const decision = tree.nodes.get("human:req-1")!;
    expect(decision.parent).toBe("subagentRun:run-9");
    expect(openHumanNodes(tree).map((node) => node.key)).toEqual(["human:req-1"]);

    const cancelled = projectNodeTree(
      [
        ...events,
        envelope(humanCancelledDraft({ id: "req-1", sessionId: "s1" }, "The subagent ended.")),
      ],
      { sessionId: "s1" },
    );
    expect(cancelled.nodes.get("human:req-1")).toMatchObject({
      status: "stopped",
      human: { cancelledReason: "The subagent ended." },
    });
    expect(openHumanNodes(cancelled)).toEqual([]);
  });

  it("a restart interrupts memory-only waits but keeps a loop approval open", () => {
    const tree = projectNodeTree([
      envelope(
        humanRequestedDraft(humanFromLoopApproval({ id: "run-1", checkpointPrompt: "Ok?" }), AT),
      ),
      envelope(
        humanRequestedDraft(
          humanFromAskUser({ requestId: "ask-9", sessionId: "s9", question: "Q", options: [] }),
          AT,
        ),
      ),
      envelope({
        kind: "server.started",
        subject: { type: "server", id: "srv" },
        actor: { type: "system" },
        payload: {},
      }),
    ]);
    expect(tree.nodes.get("human:run-1")?.status).toBe("pending");
    expect(tree.nodes.get("human:ask-9")?.status).toBe("interrupted");
    expect(openHumanNodes(tree).map((node) => node.key)).toEqual(["human:run-1"]);
  });

  it("a removed loop run (eviction) closes its waiting approval", () => {
    const tree = projectNodeTree([
      envelope(
        humanRequestedDraft(humanFromLoopApproval({ id: "run-2", checkpointPrompt: "Ok?" }), AT),
      ),
      envelope({
        kind: "loop.run.removed",
        subject: { type: "loopRun", id: "run-2" },
        actor: { type: "system" },
        payload: { runId: "run-2" },
      }),
    ]);
    expect(tree.nodes.get("human:run-2")).toMatchObject({
      status: "stopped",
      human: { cancelledReason: "The loop run was removed." },
    });
    expect(openHumanNodes(tree)).toEqual([]);
  });

  it("an extension UI request's own timeout becomes its policy", () => {
    expect(
      humanFromExtensionUi("s1", { id: "u", method: "input", title: "Name", timeout: 90_000 })
        .timeoutPolicy,
    ).toEqual({ type: "expire", afterMinutes: 1.5, then: "blocked" });
    expect(
      humanFromExtensionUi("s1", { id: "u", method: "input", title: "Name" }).timeoutPolicy,
    ).toBeUndefined();
  });
});

describe("open human requests over the whole log", () => {
  const boundary = (kind: string): EventDraft => ({
    kind,
    subject: { type: "server", id: kind },
    actor: { type: "system" },
    payload: {},
  });
  const ask = (id: string) =>
    humanFromAskUser({ requestId: id, sessionId: "s1", question: id, options: [] });

  it("keeps an old loop approval through restarts and takeovers; drops what settled or died", () => {
    const log = [
      envelope(
        humanRequestedDraft(
          humanFromLoopApproval({ id: "run-old", checkpointPrompt: "Ok?", projectId: "p1" }),
          AT,
        ),
        "2026-09-01T00:00:00.000Z",
      ),
      envelope(humanRequestedDraft(ask("ask-a"), AT)),
      envelope(boundary("writer.acquired")),
      envelope(humanRequestedDraft(ask("ask-b"), AT)),
      envelope(humanRequestedDraft(ask("ask-c"), AT)),
      envelope(humanAnsweredDraft(ask("ask-c"), ALE, "yes")),
      envelope(
        humanRequestedDraft(humanFromLoopApproval({ id: "run-gone", checkpointPrompt: "?" }), AT),
      ),
      envelope({
        kind: "loop.run.removed",
        subject: { type: "loopRun", id: "run-gone" },
        actor: { type: "system" },
        payload: { runId: "run-gone" },
      }),
    ];
    const open = projectOpenHumanRequests(log);
    expect([...open.keys()]).toEqual(["run-old", "ask-b"]);
    expect(open.get("run-old")).toMatchObject({
      kind: "loopApproval",
      projectId: "p1",
      requestedAt: "2026-09-01T00:00:00.000Z",
      actor: { type: "system" },
    });
    expect(open.get("ask-b")).toMatchObject({ kind: "askUser", sessionId: "s1", prompt: "ask-b" });
    // Folding on: a restart drops the memory-only one, the approval stays.
    const later = projectOpenHumanRequests([envelope(boundary("server.started"))], open);
    expect([...later.keys()]).toEqual(["run-old"]);
    expect(open.has("ask-b")).toBe(true);
  });

  it("the tree interrupts open waits at a writer takeover, but not a loop approval", () => {
    const tree = projectNodeTree([
      envelope(
        humanRequestedDraft(humanFromLoopApproval({ id: "run-1", checkpointPrompt: "Ok?" }), AT),
      ),
      envelope(humanRequestedDraft(ask("ask-1"), AT)),
      envelope(boundary("writer.acquired")),
    ]);
    expect(tree.nodes.get("human:run-1")?.status).toBe("pending");
    expect(tree.nodes.get("human:ask-1")?.status).toBe("interrupted");
  });
});
