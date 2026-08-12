/**
 * Access to the Electron preload bridge (window.agentDeck). In a plain browser
 * the bridge is absent, so callers fall back to the type-a-path input.
 */

/** A renderer hint for a durable false→true attention transition. Main
 * re-reads backend truth before showing OS UI or deriving a badge count. */
export interface AttentionPayload {
  sessionId: string;
  title: string;
  body: string;
}

export type AppMenuName = "file" | "edit" | "view" | "resources" | "git" | "help";
export type NativeResourceKind = "agent" | "prompt";
export interface NativeResourceFileRequest {
  kind: NativeResourceKind;
  projectId: string | null;
  filePath: string;
}
export type NativeMenuAction =
  | "new-chat"
  | "add-project"
  | "open-keybindings"
  | "question.previous"
  | "question.next"
  | "git.commit"
  | "git.push"
  | "git.mergeWorktree"
  | "git.release"
  | "agent.new"
  | "agent.openFile"
  | "agent.reveal"
  | "agent.toggleDisabled"
  | "skills.import"
  | "prompt.new"
  | "prompt.copyInvocation"
  | "prompt.openFile"
  | "prompt.reveal";

export interface AgentDeckBridge {
  isElectron?: boolean;
  platform?: string;
  chooseDirectory?(options?: {
    title?: string;
    message?: string;
    buttonLabel?: string;
    multiple?: boolean;
  }): Promise<string[]>;
  chooseFiles?(options?: {
    title?: string;
    message?: string;
    buttonLabel?: string;
  }): Promise<string[]>;
  revealSubagentArtifacts?(runId: string): Promise<boolean>;
  revealLoopArtifacts?(runId: string): Promise<boolean>;
  revealLoopWorktree?(runId: string): Promise<boolean>;
  trashSkillRecovery?(token: string): Promise<{ moved: boolean; acknowledgementPending: boolean }>;
  openResourceFile?(request: NativeResourceFileRequest): Promise<boolean>;
  revealResourceFile?(request: NativeResourceFileRequest): Promise<boolean>;
  openExternal?(url: string): Promise<boolean>;
  openAppMenu?(name: AppMenuName, anchor: { x: number; y: number }): Promise<boolean>;
  /** Subscribe to native-menu commands; returns an unsubscribe function. */
  onMenu?(handler: (action: NativeMenuAction) => void): () => void;
  /** Ask main to re-read the authoritative durable attention set. */
  syncAttention?(): void;
  /** Hint that one durable marker transitioned false→true. */
  notifyAttention?(payload: AttentionPayload): void;
  /** Subscribe to a notification click targeting an app-owned session id. */
  onFocusSession?(handler: (sessionId: string) => void): () => void;
  /**
   * Subscribe to browser popup requests (Slice L2): a target=_blank / window.open
   * inside a `<webview>` guest, denied its native child window and forwarded by
   * the main process for the browser panel to open as an internal page-tab.
   * Returns an unsubscribe function.
   */
  onBrowserOpenPage?(handler: (url: string) => void): () => void;
}

declare global {
  interface Window {
    agentDeck?: AgentDeckBridge;
  }
}

export function nativeBridge(): AgentDeckBridge | undefined {
  return typeof window === "undefined" ? undefined : window.agentDeck;
}

/** True when running inside the Electron shell (native folder picker available). */
export function isElectron(): boolean {
  return nativeBridge()?.isElectron === true;
}

/** Whether this renderer has the purpose-built desktop reveal capability. */
export function canRevealSubagentArtifacts(): boolean {
  return typeof nativeBridge()?.revealSubagentArtifacts === "function";
}

/** Reveal a backend/native-validated subagent artifact root through Electron. */
export async function revealSubagentArtifacts(runId: string): Promise<boolean> {
  const bridge = nativeBridge();
  if (!bridge?.revealSubagentArtifacts) return false;
  return (await bridge.revealSubagentArtifacts(runId)) === true;
}

/** Reveal a backend-validated Loop artifact directory through Electron. */
export async function revealLoopArtifacts(runId: string): Promise<boolean> {
  const bridge = nativeBridge();
  if (!bridge?.revealLoopArtifacts) return false;
  return (await bridge.revealLoopArtifacts(runId)) === true;
}

/** Reveal a backend-validated retained Loop worktree through Electron. */
export async function revealLoopWorktree(runId: string): Promise<boolean> {
  const bridge = nativeBridge();
  if (!bridge?.revealLoopWorktree) return false;
  return (await bridge.revealLoopWorktree(runId)) === true;
}

export async function trashSkillRecovery(
  token: string,
): Promise<{ moved: boolean; acknowledgementPending: boolean } | undefined> {
  const bridge = nativeBridge();
  if (!bridge?.trashSkillRecovery) return undefined;
  const result = await bridge.trashSkillRecovery(token);
  return result?.moved ? result : undefined;
}

/** Open a catalog-validated agent or prompt file in its default editor. */
export async function openResourceFile(request: NativeResourceFileRequest): Promise<boolean> {
  try {
    return (await nativeBridge()?.openResourceFile?.(request)) === true;
  } catch {
    return false;
  }
}

/** Reveal a catalog-validated agent or prompt file in the OS file manager. */
export async function revealResourceFile(request: NativeResourceFileRequest): Promise<boolean> {
  try {
    return (await nativeBridge()?.revealResourceFile?.(request)) === true;
  } catch {
    return false;
  }
}

/** Open an http(s) URL in the user's default browser through Electron. */
export async function openExternal(url: string): Promise<boolean> {
  const bridge = nativeBridge();
  if (bridge?.openExternal) {
    try {
      return (await bridge.openExternal(url)) === true;
    } catch {
      return false;
    }
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  return opened !== null;
}

/**
 * Subscribe to browser popup requests (Slice L2). No-op (returns a no-op
 * unsubscribe) in a plain browser or against an older bridge without the method.
 */
export function onBrowserOpenPage(handler: (url: string) => void): () => void {
  const bridge = nativeBridge();
  if (!bridge?.onBrowserOpenPage) return () => {};
  try {
    return bridge.onBrowserOpenPage(handler);
  } catch {
    return () => {};
  }
}

/**
 * True on the macOS desktop build, where the frameless window (hiddenInset)
 * puts the traffic-light buttons over the top-left — content there must clear
 * them.
 */
export function isMacDesktop(): boolean {
  return isElectron() && nativeBridge()?.platform === "darwin";
}

/** True for Electron's custom Windows/Linux title bar. */
export function hasIntegratedDesktopChrome(): boolean {
  return isElectron() && !isMacDesktop();
}

/** Open one of the native menus from the integrated desktop title bar. */
export async function openAppMenu(
  name: AppMenuName,
  anchor: { x: number; y: number },
): Promise<boolean> {
  try {
    return (await nativeBridge()?.openAppMenu?.(name, anchor)) === true;
  } catch {
    return false;
  }
}

/**
 * Open the native OS folder chooser (the NSOpenPanel equivalent). Resolves to
 * the chosen absolute path(s), or [] if unavailable or the user cancels.
 */
export async function chooseDirectory(
  options?: Parameters<NonNullable<AgentDeckBridge["chooseDirectory"]>>[0],
): Promise<string[]> {
  const bridge = nativeBridge();
  if (!bridge?.chooseDirectory) return [];
  try {
    const result: unknown = await bridge.chooseDirectory(options);
    if (!Array.isArray(result)) return [];
    return result.filter((value): value is string => typeof value === "string").slice(0, 16);
  } catch {
    // A failed IPC/dialog shouldn't become an unhandled rejection at call sites.
    return [];
  }
}

/** Open the trusted desktop multi-file chooser; no file read capability is exposed. */
export async function chooseFiles(
  options?: Parameters<NonNullable<AgentDeckBridge["chooseFiles"]>>[0],
): Promise<string[]> {
  const bridge = nativeBridge();
  if (!bridge?.chooseFiles) return [];
  try {
    const result: unknown = await bridge.chooseFiles(options);
    if (!Array.isArray(result)) return [];
    return result.filter((value): value is string => typeof value === "string").slice(0, 16);
  } catch {
    return [];
  }
}

/** Ask Electron main to derive the distinct badge count from backend truth. */
export function syncAttention(): void {
  try {
    nativeBridge()?.syncAttention?.();
  } catch {
    // A failed fire-and-forget hint is reconciled by the next metadata update.
  }
}

/** Hint a durable attention edge. Main validates the source and backend state. */
export function notifyAttention(payload: AttentionPayload): void {
  try {
    nativeBridge()?.notifyAttention?.(payload);
  } catch {
    // Native attention must never break renderer state handling.
  }
}

/** Subscribe to notification-click session routing in the Electron shell. */
export function onFocusSession(handler: (sessionId: string) => void): () => void {
  const bridge = nativeBridge();
  if (!bridge?.onFocusSession) return () => {};
  try {
    return bridge.onFocusSession(handler);
  } catch {
    return () => {};
  }
}
