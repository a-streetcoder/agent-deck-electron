// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handler: undefined as ((sessionId: string) => void) | undefined,
  focus: vi.fn<(sessionId: string) => Promise<void>>(),
  acknowledge: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock("@/lib/native", () => ({
  isElectron: () => true,
  notifyAttention: vi.fn(),
  syncAttention: vi.fn(),
  onFocusSession: (handler: (sessionId: string) => void) => {
    mocks.handler = handler;
    return () => {
      mocks.handler = undefined;
    };
  },
}));
vi.mock("./wsBridge.ts", () => ({
  focusSessionFromNotification: mocks.focus,
  acknowledgeSessionAttention: mocks.acknowledge,
}));

import type { SessionMeta } from "@agent-deck/contracts";
import { useAppStore } from "./store.ts";
import { useDesktopAttention } from "./useDesktopAttention.ts";
import { useNotificationRouting } from "./useNotificationRouting.ts";

const session = (id: string): SessionMeta => ({
  id,
  cwd: "/tmp",
  createdAt: "2026-01-01T00:00:00.000Z",
  needsAttention: true,
});

function Harness(): null {
  useNotificationRouting();
  useDesktopAttention();
  return null;
}

beforeEach(() => {
  mocks.focus.mockReset();
  mocks.acknowledge.mockReset().mockResolvedValue(undefined);
  useAppStore.setState({
    session: null,
    sessions: [],
    sessionsLoaded: false,
    view: "chat",
    attentionRoutingToken: null,
    attentionAnnouncement: null,
  });
});
afterEach(cleanup);

it.each(["success", "failure"] as const)("clears its routing guard once on %s", async (outcome) => {
  let settle!: () => void;
  mocks.focus.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        settle = outcome === "success" ? resolve : () => reject(new Error("activation failed"));
      }),
  );
  render(createElement(Harness));
  act(() => mocks.handler?.("target"));
  const token = useAppStore.getState().attentionRoutingToken;
  expect(token).not.toBeNull();

  await act(async () => settle());
  expect(useAppStore.getState().attentionRoutingToken).toBeNull();
  expect(mocks.focus).toHaveBeenCalledWith("target");
});

it("clicking pending B while pending A is selected acknowledges only B after activation", async () => {
  let focused = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const a = session("A");
  const b = session("B");
  useAppStore.setState({
    session: a,
    sessions: [a, b],
    sessionsLoaded: true,
    view: "chat",
  });
  let activate!: () => void;
  mocks.focus.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        activate = () => {
          useAppStore.setState({ session: b });
          resolve();
        };
      }),
  );

  render(createElement(Harness));
  act(() => mocks.handler?.("B"));
  focused = true;
  window.dispatchEvent(new FocusEvent("focus"));
  await act(async () => {});
  expect(mocks.acknowledge).not.toHaveBeenCalledWith("A");

  await act(async () => activate());
  expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
  expect(mocks.acknowledge).toHaveBeenCalledWith("B");
  expect(useAppStore.getState().sessions.find((item) => item.id === "A")?.needsAttention).toBe(
    true,
  );
});
