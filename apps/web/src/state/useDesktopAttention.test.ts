// @vitest-environment jsdom

import type { SessionMeta } from "@agent-deck/contracts";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { acknowledge, native } = vi.hoisted(() => ({
  acknowledge: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  native: {
    electron: true,
    notify: vi.fn(),
    sync: vi.fn(),
  },
}));
vi.mock("@/lib/native", () => ({
  isElectron: () => native.electron,
  notifyAttention: native.notify,
  syncAttention: native.sync,
}));
vi.mock("./wsBridge.ts", () => ({ acknowledgeSessionAttention: acknowledge }));

import {
  attentionEpisode,
  newlyAttentiveSessionIds,
  useDesktopAttention,
} from "./useDesktopAttention.ts";
import { useAppStore } from "./store.ts";

const session = (id: string, needsAttention?: boolean, needsAttentionAt?: string): SessionMeta => ({
  id,
  cwd: "/tmp",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(needsAttention === undefined ? {} : { needsAttention }),
  ...(needsAttentionAt === undefined ? {} : { needsAttentionAt }),
});

function Harness(): null {
  useDesktopAttention();
  return null;
}

beforeEach(() => {
  acknowledge.mockReset().mockResolvedValue(undefined);
  native.electron = true;
  native.notify.mockReset();
  native.sync.mockReset();
  useAppStore.setState({
    session: session("selected", true),
    sessions: [session("selected", true), session("hidden", true)],
    sessionsLoaded: true,
    attentionAnnouncement: null,
    attentionRoutingToken: null,
    view: "chat",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("newlyAttentiveSessionIds", () => {
  it("treats hydration as a baseline and legacy absence as false", () => {
    expect(newlyAttentiveSessionIds(null, [session("legacy"), session("pending", true)])).toEqual(
      [],
    );
  });

  it("observes false→true transitions across every session", () => {
    // Not-attentive is recorded as no episode at all.
    const previous = new Map<string, string | null>([
      ["selected", null],
      ["hidden", null],
    ]);
    expect(
      newlyAttentiveSessionIds(previous, [session("selected", true), session("hidden", true)]),
    ).toEqual(["selected", "hidden"]);
  });

  it("does not duplicate a notification for repeated metadata publication", () => {
    // Built from the same helper the hook stores, so this can never encode a
    // stale snapshot shape: republishing one episode announces nothing.
    const chat = session("chat", true);
    expect(newlyAttentiveSessionIds(new Map([["chat", attentionEpisode(chat)]]), [chat])).toEqual(
      [],
    );
  });
});

describe("catalog bootstrap and announcement", () => {
  it("does not baseline the initial pre-bootstrap empty array or notify restart hydration", async () => {
    useAppStore.setState({ sessions: [], sessionsLoaded: false });
    render(createElement(Harness));
    await act(async () => {});
    expect(native.notify).not.toHaveBeenCalled();

    act(() => {
      useAppStore.getState().setSessions([session("durable-pending", true)]);
    });
    await act(async () => {});
    expect(native.notify).not.toHaveBeenCalled();
    expect(useAppStore.getState().attentionAnnouncement).toBeNull();
  });

  it("politely announces only a new post-baseline attention edge", async () => {
    useAppStore.setState({ sessions: [session("selected")], sessionsLoaded: true });
    render(createElement(Harness));
    await act(async () => {});
    act(() => useAppStore.getState().setSessions([session("selected", true)]));
    await act(async () => {});
    expect(useAppStore.getState().attentionAnnouncement?.text).toContain("needs attention");
    expect(native.notify).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh token for a same-title re-raise and summarizes simultaneous edges", async () => {
    useAppStore.setState({ sessions: [session("selected")], sessionsLoaded: true });
    render(createElement(Harness));
    await act(async () => {});

    act(() => useAppStore.getState().setSessions([session("selected", true)]));
    await act(async () => {});
    const first = useAppStore.getState().attentionAnnouncement;
    act(() => useAppStore.getState().setSessions([session("selected", false)]));
    act(() => useAppStore.getState().setSessions([session("selected", true)]));
    await act(async () => {});
    const second = useAppStore.getState().attentionAnnouncement;
    expect(second?.text).toBe(first?.text);
    expect(second?.id).toBeGreaterThan(first?.id ?? 0);

    act(() =>
      useAppStore
        .getState()
        .setSessions([session("selected", true), session("two", true), session("three", true)]),
    );
    await act(async () => {});
    expect(useAppStore.getState().attentionAnnouncement?.text).toBe("2 sessions need attention.");
  });
});

describe("visible review acknowledgement", () => {
  it("does not acknowledge selection while the document is hidden", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    render(createElement(Harness));
    await act(async () => {});
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges only the selected chat after it is visible and focused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    render(createElement(Harness));
    await act(async () => {});
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith("selected");
    expect(acknowledge).not.toHaveBeenCalledWith("hidden");
  });

  it("suppresses old-session acknowledgement during notification routing, then acknowledges only the target", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    useAppStore.setState({ attentionRoutingToken: 7 });
    const rendered = render(createElement(Harness));
    await act(async () => {});
    expect(acknowledge).not.toHaveBeenCalled();

    act(() => {
      useAppStore.setState({
        session: session("hidden", true),
        attentionRoutingToken: null,
      });
    });
    rendered.rerender(createElement(Harness));
    await act(async () => {});
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith("hidden");
    expect(acknowledge).not.toHaveBeenCalledWith("selected");
  });

  it("acknowledges visible review in a plain browser while skipping native IPC", async () => {
    native.electron = false;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    render(createElement(Harness));
    await act(async () => {});
    expect(acknowledge).toHaveBeenCalledWith("selected");
    expect(native.sync).not.toHaveBeenCalled();
    expect(native.notify).not.toHaveBeenCalled();
  });
});

describe("attention episodes (SES-14)", () => {
  it("treats a re-raised session as newly attentive even when the flag never looked false", () => {
    // Acknowledging and re-flagging can land inside ONE snapshot: the store goes
    // true -> true and the boolean diff sees nothing, so the second episode was
    // never announced (Codex). The backend stamps each raise, so the episode —
    // not the flag — is what "newly attentive" means.
    const previous = new Map([["s1", "2026-08-17T10:00:00.000Z"]]);
    expect(
      newlyAttentiveSessionIds(previous, [session("s1", true, "2026-08-17T11:00:00.000Z")]),
    ).toEqual(["s1"]);
    expect(
      newlyAttentiveSessionIds(previous, [session("s1", true, "2026-08-17T10:00:00.000Z")]),
    ).toEqual([]);
  });

  it("still announces a first raise and stays quiet with no previous snapshot", () => {
    expect(
      newlyAttentiveSessionIds(new Map([["s1", null]]), [
        session("s1", true, "2026-08-17T10:00:00.000Z"),
      ]),
    ).toEqual(["s1"]);
    expect(
      newlyAttentiveSessionIds(null, [session("s1", true, "2026-08-17T10:00:00.000Z")]),
    ).toEqual([]);
  });
});
