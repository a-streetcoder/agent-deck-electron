import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronDown, ExternalLink, MessageSquarePlus, Plus, Trash2 } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { THEME_CHANGE_EVENT } from "../design-system/theme.ts";
import { createXtermTheme, getTerminalFontFamily } from "../design-system/themes/xterm.ts";
import { useAppStore } from "../state/store.ts";
import { buildTerminalSelectionContext } from "../lib/elementContext.ts";
import {
  activateTab,
  addTab,
  closeTab,
  createTabsState,
  getSessionTabs,
  renameTab,
  setSessionTabs,
  type TerminalTabsState,
} from "../lib/terminalTabs.ts";
import {
  closeSessionTerminal,
  openSessionInExternalTerminal,
  openSessionTerminal,
  sendTerminalInput,
  sendTerminalResize,
  subscribeTerminalPush,
} from "../state/wsBridge.ts";

/**
 * The per-session terminal drawer (Slice 8b), ported from t3code's
 * `ThreadTerminalDrawer.tsx` (MIT): our zustand store instead of atoms, our
 * RPC transport instead of the donor's atom commands. What survives the port
 * is the drawer's shape and behavior: a resizable bottom drawer on the session
 * view, xterm + FitAddon rendering, focus-on-open, fit-on-resize, and the
 * "closing hides, the shell survives" contract — reopening reattaches by
 * terminal id and the server replays the scrollback.
 *
 * TER-02/04: a session has terminal TABS (lib/terminalTabs.ts), each mapping
 * to its own server PTY; renaming a tab (double-click) covers grouping's
 * core. Switching tabs reuses the reattach contract — dispose the renderer,
 * reattach by the tab's remembered terminal id, scrollback replays. Splits
 * (TER-03) are deliberately not built: one visible PTY at a time.
 *
 * Lifecycle: the xterm instance exists only while the drawer is OPEN on one
 * (session, tab). Opening lazily creates (or reattaches to) the server PTY;
 * closing the drawer disposes only the renderer. The PTY itself dies with its
 * session, its connection, or the explicit kill button — a session that never
 * opens the drawer never spawns a shell.
 */

const DEFAULT_DRAWER_HEIGHT = 260;
const MIN_DRAWER_HEIGHT = 160;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

function clampDrawerHeight(height: number): number {
  const max = Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
  const safe = Number.isFinite(height) ? Math.round(height) : DEFAULT_DRAWER_HEIGHT;
  return Math.min(Math.max(safe, MIN_DRAWER_HEIGHT), max);
}

function fitSafely(fitAddon: FitAddon): void {
  try {
    fitAddon.fit();
  } catch {
    // A zero-sized container mid-layout: the next resize observation refits.
  }
}

export function TerminalDrawer() {
  const open = useAppStore((state) => state.terminalOpen);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const sessionId = useAppStore((state) => state.session?.id ?? null);
  const connection = useAppStore((state) => state.connection);
  const pushToast = useAppStore((state) => state.pushToast);
  const addElementContext = useAppStore((state) => state.addElementContext);
  // COM-01: the live xterm instance + whether it has a selection, for the
  // attach-to-composer affordance (the instance itself lives in the effect).
  const xtermRef = useRef<Terminal | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // TER-02/04: per-session tab state, mirrored from the module registry so it
  // survives drawer close/reopen and session switches.
  const [tabs, setTabs] = useState<TerminalTabsState>(() =>
    sessionId ? getSessionTabs(sessionId) : createTabsState(),
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameCancelRef = useRef(false);
  const updateTabs = (next: TerminalTabsState): void => {
    if (sessionId) setSessionTabs(sessionId, next);
    setTabs(next);
  };
  const commitRename = (tabId: string, raw: string): void => {
    setRenamingId(null);
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      return;
    }
    updateTabs(renameTab(tabs, tabId, raw));
  };

  // Session switches reset DURING RENDER, not in an effect (Codex): an
  // effect-based reset leaves one committed render where the new session is
  // paired with the OLD session's tab state (the xterm effect would open the
  // new session under the old active tab id) and the old terminal's selection
  // still looks attachable. Render-phase state adjustment re-renders before
  // any effect or paint, so no such window exists.
  const [tabsSession, setTabsSession] = useState(sessionId);
  if (sessionId !== tabsSession) {
    setTabsSession(sessionId);
    setTabs(sessionId ? getSessionTabs(sessionId) : createTabsState());
    setRenamingId(null);
    setHasSelection(false);
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(DEFAULT_DRAWER_HEIGHT);
  const heightRef = useRef(height);
  heightRef.current = height;
  const resizeStateRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(
    null,
  );

  // ---------------------------------------------------------------------
  // xterm lifecycle: one renderer per (open, session, connection) episode.
  // Reconnects re-run it (a drop killed the server PTY; reattach or respawn).
  // ---------------------------------------------------------------------
  const connected = connection === "open";
  const activeTabId = tabs.activeId;
  useEffect(() => {
    const mount = containerRef.current;
    if (!open || !sessionId || !connected || !mount) return;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: false,
      fontSize: 12,
      scrollback: 5_000,
      // xterm measures the resolved stack, so the adapter reads the token value.
      fontFamily: getTerminalFontFamily(),
      theme: createXtermTheme(),
    });
    const syncTheme = (): void => {
      terminal.options.theme = createXtermTheme();
    };
    window.addEventListener(THEME_CHANGE_EVENT, syncTheme);
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitSafely(fitAddon);

    let disposed = false;
    let terminalId: string | null = null;

    // Push ordering note: frames arrive in socket order, and the open promise
    // resolves in a microtask BEFORE the next frame's task runs — so every
    // chunk of the new attachment is processed with `terminalId` already set.
    // Pushes seen while `terminalId` is null belong to a PREVIOUS attachment
    // (reopen while output streams); those chunks are already inside the
    // scrollback the reply replays, so they are dropped, not buffered —
    // buffering would double-write them.
    const unsubscribePush = subscribeTerminalPush((message) => {
      if (message.terminalId !== terminalId) return;
      if (message.type === "terminal_output") {
        terminal.write(message.data);
        return;
      }
      terminal.write(`\r\n[terminal] exited (code ${message.exitCode ?? "?"})\r\n`);
    });

    const inputDisposable = terminal.onData((data) => {
      if (terminalId !== null) sendTerminalInput(terminalId, data);
    });

    // COM-01: expose the instance + selection presence for attach-to-composer.
    xtermRef.current = terminal;
    const selectionDisposable = terminal.onSelectionChange(() => {
      setHasSelection(terminal.hasSelection());
    });

    // The toggle shortcut (⌘`/Ctrl+`) must bubble to the app while the
    // terminal owns focus; everything else stays with the shell (donor's
    // attachCustomKeyEventHandler contract).
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "`") return false;
      return true;
    });

    // Fit on every container size change (drawer drag, window resize) and
    // propagate the new grid to the PTY.
    const refit = (): void => {
      if (disposed) return;
      const before = { cols: terminal.cols, rows: terminal.rows };
      fitSafely(fitAddon);
      if (terminalId !== null && (terminal.cols !== before.cols || terminal.rows !== before.rows)) {
        sendTerminalResize(terminalId, terminal.cols, terminal.rows);
      }
    };
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        refit();
      });
    });
    observer.observe(mount);

    void openSessionTerminal(activeTabId, terminal.cols, terminal.rows)
      .then((result) => {
        if (disposed) return;
        terminalId = result.terminalId;
        if (result.scrollback.length > 0) terminal.write(result.scrollback);
        if (!result.running) terminal.write("\r\n[terminal] exited\r\n");
        // The PTY grid may predate this drawer size (reattach): re-sync it.
        sendTerminalResize(result.terminalId, terminal.cols, terminal.rows);
        terminal.focus();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        terminal.write(`\r\n[terminal] failed to open: ${String(error)}\r\n`);
      });

    return () => {
      disposed = true;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      window.removeEventListener(THEME_CHANGE_EVENT, syncTheme);
      unsubscribePush();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      xtermRef.current = null;
      setHasSelection(false);
      terminal.dispose();
    };
  }, [open, sessionId, connected, activeTabId]);

  // ---------------------------------------------------------------------
  // Drag-to-resize (donor's pointer-capture handle, condensed).
  // ---------------------------------------------------------------------
  const onHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: heightRef.current,
    };
  }, []);
  const onHandlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    setHeight(clampDrawerHeight(state.startHeight + (state.startY - event.clientY)));
  }, []);
  const onHandlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    resizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (!open || !sessionId) return null;

  return (
    <aside
      data-terminal-owner="drawer"
      data-testid="terminal-drawer"
      className="relative flex shrink-0 flex-col overflow-hidden border-t border-border-subtle bg-surface"
      style={{ height: `${height}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize"
        data-testid="terminal-resize-handle"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerEnd}
        onPointerCancel={onHandlePointerEnd}
      />
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface-elevated px-3 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Terminal
          </span>
          <div
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
            data-testid="terminal-tabs"
          >
            {tabs.tabs.map((tab) =>
              renamingId === tab.id ? (
                <ControlInput
                  key={tab.id}
                  autoFocus
                  defaultValue={tab.title}
                  data-testid="terminal-tab-rename-input"
                  className="w-28 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-xs text-text-primary outline-none"
                  onFocus={(event) => event.currentTarget.select()}
                  onBlur={(event) => commitRename(tab.id, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      renameCancelRef.current = true;
                      event.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                <ControlButton
                  key={tab.id}
                  type="button"
                  data-testid={`terminal-tab-${tab.id}`}
                  title="Double-click to rename"
                  className={`max-w-40 truncate rounded px-1.5 py-0.5 text-xs transition-colors ${
                    tab.id === tabs.activeId
                      ? "bg-hover text-text-primary"
                      : "text-text-muted hover:bg-hover hover:text-text-primary"
                  }`}
                  onClick={() => updateTabs(activateTab(tabs, tab.id))}
                  onDoubleClick={() => setRenamingId(tab.id)}
                >
                  {tab.title}
                </ControlButton>
              ),
            )}
          </div>
          <ControlButton
            type="button"
            className="rounded p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
            title="New terminal tab"
            aria-label="New terminal tab"
            data-testid="terminal-tab-add"
            onClick={() => updateTabs(addTab(tabs))}
          >
            <Plus className="h-3.5 w-3.5" />
          </ControlButton>
        </div>
        <div className="flex items-center gap-1">
          <ControlButton
            type="button"
            className="rounded p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            title="Attach the selected terminal output to the composer"
            aria-label="Attach selection to composer"
            data-testid="terminal-attach-selection"
            disabled={!hasSelection}
            onClick={() => {
              const selection = xtermRef.current?.getSelection() ?? "";
              const context = buildTerminalSelectionContext(selection);
              if (context === null) {
                pushToast({ kind: "info", message: "Select some terminal output first." });
                return;
              }
              // Attach to the session that is current AT CLICK TIME — a
              // render/cleanup race must not land A's output on B (Codex).
              const liveSessionId = useAppStore.getState().session?.id;
              if (!liveSessionId || liveSessionId !== sessionId) {
                pushToast({ kind: "info", message: "Session changed — selection not attached." });
                return;
              }
              addElementContext(liveSessionId, context);
              pushToast({
                kind: "success",
                message: "Attached terminal selection to the composer.",
              });
            }}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
          </ControlButton>
          <ControlButton
            type="button"
            className="rounded p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
            title="Continue in external terminal"
            aria-label="Continue in external terminal"
            data-testid="terminal-open-external"
            onClick={() => {
              openSessionInExternalTerminal(sessionId).catch((error: unknown) => {
                pushToast({
                  kind: "error",
                  message: error instanceof Error ? error.message : String(error),
                });
              });
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </ControlButton>
          <ControlButton
            type="button"
            className="rounded p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
            title="Kill this terminal tab"
            aria-label="Kill this terminal tab"
            data-testid="terminal-kill"
            onClick={() => {
              closeSessionTerminal(sessionId, tabs.activeId);
              updateTabs(closeTab(tabs, tabs.activeId));
              // Killing the only tab keeps the old single-terminal contract:
              // the drawer closes; reopening spawns a fresh shell (new tab id).
              if (tabs.tabs.length === 1) setTerminalOpen(false);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ControlButton>
          <ControlButton
            type="button"
            className="rounded p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
            title="Hide terminal (⌘`)"
            aria-label="Hide terminal"
            data-testid="terminal-hide"
            onClick={() => setTerminalOpen(false)}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </ControlButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-2 py-1">
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
      </div>
    </aside>
  );
}
