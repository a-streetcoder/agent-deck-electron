import { describe, expect, it, vi } from "vitest";
import { AskUserCoordinator, askUserParamsSchema } from "../src/askUserCoordinator.ts";
import type { SessionManager } from "../src/SessionManager.ts";

function harness(options: { closeFailure?: boolean } = {}) {
  const opened: unknown[] = [];
  const answered: unknown[] = [];
  const closed: unknown[] = [];
  const exitListeners = new Set<() => void>();
  const session = {
    openAskUser: (cell: unknown) => opened.push(cell),
    answerAskUser: (...args: unknown[]) => answered.push(args),
    closeAskUser: (...args: unknown[]) => {
      closed.push(args);
      if (options.closeFailure) throw new Error("projection failed");
    },
    onExit: (listener: () => void) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
  const sessions = { get: (id: string) => (id === "session-a" ? session : undefined) };
  const coordinator = new AskUserCoordinator(sessions as unknown as SessionManager, (id) =>
    id === "session-a" ? "token-a" : undefined,
  );
  return { coordinator, opened, answered, closed, exitListeners };
}

const params = () =>
  askUserParamsSchema.parse({
    question: "Choose",
    options: ["A", { title: "B", description: "Second" }],
  });

describe("AskUserCoordinator", () => {
  it("rejects blank/duplicate options and impossible answer combinations", () => {
    expect(askUserParamsSchema.safeParse({ question: "?", options: [" "] }).success).toBe(false);
    expect(
      askUserParamsSchema.safeParse({ question: "?", options: ["A", { title: "a" }] }).success,
    ).toBe(false);
    expect(askUserParamsSchema.safeParse({ question: "?", allowFreeform: false }).success).toBe(
      false,
    );
    expect(
      askUserParamsSchema.safeParse({ question: "?", allowMultiple: true, options: ["A"] }).success,
    ).toBe(false);
    expect(askUserParamsSchema.safeParse({ question: "?", timeout: 601 }).success).toBe(false);
  });

  it("owns concurrent requests and validates session/card response policy", async () => {
    const h = harness();
    const first = h.coordinator.ask("session-a", "token-a", params());
    const second = h.coordinator.ask("session-a", "token-a", params());
    const a = h.opened[0] as { requestId: string };
    const b = h.opened[1] as { requestId: string };
    expect(a.requestId).not.toBe(b.requestId);
    expect(h.coordinator.answer("wrong", a.requestId, { selections: ["A"] })).toBe("forbidden");
    expect(h.coordinator.answer("session-a", a.requestId, { selections: ["not offered"] })).toBe(
      "invalid",
    );
    expect(h.coordinator.answer("session-a", a.requestId, { selections: ["A", "B"] })).toBe(
      "invalid",
    );
    expect(
      h.coordinator.answer("session-a", a.requestId, {
        selections: ["A"],
        freeform: "other",
      }),
    ).toBe("invalid");
    expect(h.coordinator.answer("session-a", a.requestId, { selections: ["A"] })).toBe("ok");
    expect((await first).details).toEqual({ status: "answered", selections: ["A"] });
    expect(h.coordinator.cancel("session-a", b.requestId)).toBe("ok");
    expect((await second).details).toMatchObject({ status: "cancelled" });
    expect(h.coordinator.cancel("session-a", b.requestId)).toBe("missing");
  });

  it("settles an aborted bridge request exactly once and leaves audit state", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.coordinator.ask("session-a", "token-a", params(), controller.signal);
    const id = (h.opened[0] as { requestId: string }).requestId;
    controller.abort();
    expect((await result).details).toMatchObject({ status: "cancelled" });
    expect(h.closed).toEqual([[id, "cancelled", "The tool request was cancelled."]]);
    expect(h.coordinator.answer("session-a", id, { selections: ["A"] })).toBe("missing");
  });

  it("settles every concurrent wait during session teardown", async () => {
    const h = harness();
    const first = h.coordinator.ask("session-a", "token-a", params());
    const second = h.coordinator.ask("session-a", "token-a", params());
    h.coordinator.cancelSession("session-a");
    expect((await first).details).toMatchObject({ status: "cancelled" });
    expect((await second).details).toMatchObject({ status: "cancelled" });
    expect(h.exitListeners.size).toBe(0);
  });

  it("settles shutdown waits even when cancellation projection fails", async () => {
    const h = harness({ closeFailure: true });
    const first = h.coordinator.ask("session-a", "token-a", params());
    const second = h.coordinator.ask("session-a", "token-a", params());

    expect(() => h.coordinator.close()).toThrow(AggregateError);
    await expect(first).resolves.toMatchObject({ details: { status: "cancelled" } });
    await expect(second).resolves.toMatchObject({ details: { status: "cancelled" } });
    expect(h.exitListeners.size).toBe(0);
  });

  it("times out as a structured non-error result", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const result = h.coordinator.ask(
        "session-a",
        "token-a",
        askUserParamsSchema.parse({ question: "?", timeout: 1 }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await result).details).toMatchObject({ status: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });
});
