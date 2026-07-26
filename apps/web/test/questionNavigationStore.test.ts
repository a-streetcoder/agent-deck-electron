import { afterEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import { runCommand } from "../src/state/commands.ts";
import { useAppStore } from "../src/state/store.ts";

const session = (id: string): SessionMeta => ({
  id,
  cwd: "/tmp/project",
  createdAt: "2026-01-01T00:00:00.000Z",
});

afterEach(() => {
  useAppStore.setState({
    session: null,
    questionNavigationRequest: null,
    questionNavigationAnchorId: null,
    toasts: [],
  });
});

describe("question navigation requests", () => {
  it("explains why navigation cannot run without an active session", () => {
    runCommand("question.previous");
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({
      kind: "info",
      message: "Open a session to navigate questions.",
    });
    expect(useAppStore.getState().questionNavigationRequest).toBeNull();
  });

  it("are tokenized and cannot be cleared by an older consumer", () => {
    const store = useAppStore.getState();
    store.setSession(session("one"));
    store.requestQuestionNavigation("previous", "one");
    const first = useAppStore.getState().questionNavigationRequest;
    store.requestQuestionNavigation("next", "one");
    const second = useAppStore.getState().questionNavigationRequest;

    expect(second?.token).toBeGreaterThan(first?.token ?? 0);
    store.completeQuestionNavigation(first?.token ?? -1, "stale-target");
    expect(useAppStore.getState().questionNavigationRequest?.token).toBe(second?.token);
    store.completeQuestionNavigation(second?.token ?? -1, "question-2");
    expect(useAppStore.getState()).toMatchObject({
      questionNavigationRequest: null,
      questionNavigationAnchorId: "question-2",
    });
  });

  it("clears the request and anchor when session identity changes", () => {
    const store = useAppStore.getState();
    store.setSession(session("one"));
    store.requestQuestionNavigation("previous", "one");
    const token = useAppStore.getState().questionNavigationRequest?.token ?? -1;
    store.completeQuestionNavigation(token, "question-1");
    store.requestQuestionNavigation("next", "one");

    store.setSession(session("two"));
    expect(useAppStore.getState()).toMatchObject({
      session: { id: "two" },
      questionNavigationRequest: null,
      questionNavigationAnchorId: null,
    });
  });
});
