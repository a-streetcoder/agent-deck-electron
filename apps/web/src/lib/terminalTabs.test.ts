import { describe, expect, it } from "vitest";
import {
  activateTab,
  addTab,
  closeTab,
  createTabsState,
  getSessionTabs,
  renameTab,
  setSessionTabs,
} from "./terminalTabs.ts";

/**
 * TER-02/04 — the pure per-session terminal tab model. The native macOS app
 * has no embedded terminal at all (TER-01: it opens external Terminal.app),
 * so this is donor-derived: tabs organize multiple PTYs per session, rename
 * covers the "grouped/renamed" core. The server already supports N PTYs per
 * session (terminal_open without terminalId always spawns fresh); this model
 * is the client-side bookkeeping that was the only 1-per-session limit.
 */
describe("terminalTabs model (TER-02/04)", () => {
  it("starts with a single active 'Terminal 1' tab", () => {
    const state = createTabsState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.title).toBe("Terminal 1");
    expect(state.activeId).toBe(state.tabs[0]!.id);
  });

  it("addTab appends the next-numbered tab and activates it", () => {
    const state = addTab(createTabsState());
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]!.title).toBe("Terminal 2");
    expect(state.activeId).toBe(state.tabs[1]!.id);
    expect(state.tabs[1]!.id).not.toBe(state.tabs[0]!.id);
  });

  it("tab numbering never reuses a live id after a middle close", () => {
    // [1,2,3] -> close 2 -> add: the new tab derives past the highest (4).
    let state = addTab(addTab(createTabsState()));
    const middle = state.tabs[1]!.id;
    state = closeTab(state, middle);
    state = addTab(state);
    expect(state.tabs.map((tab) => tab.title)).toEqual(["Terminal 1", "Terminal 3", "Terminal 4"]);
  });

  it("closing a non-active tab keeps the active one", () => {
    const two = addTab(createTabsState());
    const state = closeTab(two, two.tabs[0]!.id);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe(two.tabs[1]!.id);
  });

  it("closing the active tab activates its right neighbor, else the left", () => {
    const three = addTab(addTab(createTabsState()));
    const middleActive = activateTab(three, three.tabs[1]!.id);
    const closedMiddle = closeTab(middleActive, three.tabs[1]!.id);
    expect(closedMiddle.activeId).toBe(three.tabs[2]!.id);
    const lastActive = activateTab(closedMiddle, closedMiddle.tabs[1]!.id);
    const closedLast = closeTab(lastActive, lastActive.activeId);
    expect(closedLast.activeId).toBe(three.tabs[0]!.id);
  });

  it("closing the last remaining tab yields a fresh tab with a NEW id", () => {
    const only = createTabsState();
    const state = closeTab(only, only.tabs[0]!.id);
    expect(state.tabs).toHaveLength(1);
    // Never reuse the just-killed tab's id — its remembered PTY is dead.
    expect(state.tabs[0]!.id).not.toBe(only.tabs[0]!.id);
    expect(state.activeId).toBe(state.tabs[0]!.id);
  });

  it("closing an unknown id is a no-op", () => {
    const state = createTabsState();
    expect(closeTab(state, "tab-999")).toBe(state);
  });

  it("renameTab sets a sanitized title", () => {
    const state = createTabsState();
    const renamed = renameTab(state, state.tabs[0]!.id, "  server logs  ");
    expect(renamed.tabs[0]!.title).toBe("server logs");
  });

  it("rename strips control characters and clamps length (terminal-adjacent text is untrusted)", () => {
    const state = createTabsState();
    const hostile = "ab\u001b[31mc\nd" + "x".repeat(100);
    const renamed = renameTab(state, state.tabs[0]!.id, hostile);
    expect(renamed.tabs[0]!.title).toBe("ab[31mcd" + "x".repeat(32));
    expect(renamed.tabs[0]!.title.length).toBeLessThanOrEqual(40);
  });

  it("rename strips Unicode format controls that can visually spoof a title (bidi, zero-width)", () => {
    const state = createTabsState();
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const isolate = String.fromCodePoint(0x2066);
    const bom = String.fromCodePoint(0xfeff);
    const alm = String.fromCodePoint(0x061c);
    const renamed = renameTab(
      state,
      state.tabs[0]!.id,
      `safe${rlo}txt.exe${zwsp}${isolate}${bom}${alm}`,
    );
    expect(renamed.tabs[0]!.title).toBe("safetxt.exe");
  });

  it("rename to empty (after sanitization) keeps the old title; unknown id is a no-op", () => {
    const state = createTabsState();
    expect(renameTab(state, state.tabs[0]!.id, " \u0007 ").tabs[0]!.title).toBe("Terminal 1");
    expect(renameTab(state, "tab-999", "x")).toBe(state);
  });

  it("activateTab switches; unknown id is a no-op", () => {
    const two = addTab(createTabsState());
    expect(activateTab(two, two.tabs[0]!.id).activeId).toBe(two.tabs[0]!.id);
    expect(activateTab(two, "tab-999")).toBe(two);
  });

  it("the per-session registry isolates sessions and persists explicit sets", () => {
    const a = getSessionTabs("ter-test-session-a");
    const b = getSessionTabs("ter-test-session-b");
    expect(getSessionTabs("ter-test-session-a")).toBe(a);
    const grown = addTab(a);
    setSessionTabs("ter-test-session-a", grown);
    expect(getSessionTabs("ter-test-session-a")).toBe(grown);
    expect(getSessionTabs("ter-test-session-b")).toBe(b);
  });
});
