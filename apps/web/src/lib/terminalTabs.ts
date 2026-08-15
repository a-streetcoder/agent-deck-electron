/**
 * TER-02/04 — the pure per-session terminal tab model. Tabs organize multiple
 * PTYs per session (the server already spawns N per session; the old
 * 1-per-session limit was purely client bookkeeping) and rename covers the
 * "grouped/renamed" core. Donor-derived: the native macOS app has no embedded
 * terminal (TER-01 — it opens external Terminal.app).
 *
 * Tab ids are client-local (`tab-N`) and map to server terminal ids in
 * wsBridge's per-(session, tab) registry. Numbering derives from the highest
 * live suffix, so a fresh tab never reuses a live id — and closing the last
 * tab yields a NEW id, never the just-killed one (its remembered PTY is dead).
 */

export interface TerminalTab {
  readonly id: string;
  readonly title: string;
}

export interface TerminalTabsState {
  readonly tabs: readonly TerminalTab[];
  readonly activeId: string;
}

const MAX_TITLE_LENGTH = 40;

function tabNumber(id: string): number {
  const suffix = Number(id.slice("tab-".length));
  return Number.isInteger(suffix) && suffix > 0 ? suffix : 0;
}

function nextTab(tabs: readonly TerminalTab[]): TerminalTab {
  const next = Math.max(0, ...tabs.map((tab) => tabNumber(tab.id))) + 1;
  return { id: `tab-${next}`, title: `Terminal ${next}` };
}

/** A title character that can alter or conceal how OTHER characters display:
 * C0/DEL/C1 controls, plus the Unicode format controls (zero-width chars,
 * bidi embeddings/overrides/isolates, word joiner, BOM) that enable visual
 * spoofing of a label (Codex). */
function isDisallowedTitleChar(code: number): boolean {
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2060 && code <= 0x2064) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0xfeff || code === 0x061c;
}

/** Tab titles come from user input near terminal text — treat as untrusted:
 * strip every control/format character, then trim and clamp. */
function sanitizeTitle(raw: string): string {
  let cleaned = "";
  for (const ch of raw) {
    if (isDisallowedTitleChar(ch.codePointAt(0) ?? 0)) continue;
    cleaned += ch;
  }
  return cleaned.trim().slice(0, MAX_TITLE_LENGTH);
}

export function createTabsState(): TerminalTabsState {
  const tab = nextTab([]);
  return { tabs: [tab], activeId: tab.id };
}

export function addTab(state: TerminalTabsState): TerminalTabsState {
  const tab = nextTab(state.tabs);
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function closeTab(state: TerminalTabsState, id: string): TerminalTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return state;
  if (state.tabs.length === 1) {
    const tab = nextTab(state.tabs);
    return { tabs: [tab], activeId: tab.id };
  }
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId =
    state.activeId === id ? (state.tabs[index + 1] ?? state.tabs[index - 1]!).id : state.activeId;
  return { tabs, activeId };
}

export function renameTab(
  state: TerminalTabsState,
  id: string,
  rawTitle: string,
): TerminalTabsState {
  const title = sanitizeTitle(rawTitle);
  if (title.length === 0 || !state.tabs.some((tab) => tab.id === id)) return state;
  return {
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
    activeId: state.activeId,
  };
}

export function activateTab(state: TerminalTabsState, id: string): TerminalTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return { tabs: state.tabs, activeId: id };
}

// ---------------------------------------------------------------------------
// Per-session registry: the drawer component unmounts its renderer freely (it
// returns null while hidden), so tab state lives here — same lifetime as
// wsBridge's terminal-id bookkeeping. Bounded by sessions visited in one run.
// ---------------------------------------------------------------------------

const sessionTabs = new Map<string, TerminalTabsState>();

export function getSessionTabs(sessionId: string): TerminalTabsState {
  const existing = sessionTabs.get(sessionId);
  if (existing) return existing;
  const fresh = createTabsState();
  sessionTabs.set(sessionId, fresh);
  return fresh;
}

export function setSessionTabs(sessionId: string, state: TerminalTabsState): void {
  sessionTabs.set(sessionId, state);
}
