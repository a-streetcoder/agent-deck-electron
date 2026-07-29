/**
 * Access to the Electron preload bridge (window.agentDeck). In a plain browser
 * the bridge is absent, so callers fall back to the type-a-path input.
 */

/** A semantic attention event forwarded to the Electron shell (Slice 22a). */
export interface AttentionPayload {
  kind: "turn-complete" | "approval-needed";
  title: string;
  body: string;
  sessionId?: string;
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
  revealLoopArtifacts?(runId: string): Promise<boolean>;
  revealLoopWorktree?(runId: string): Promise<boolean>;
  trashSkillRecovery?(token: string): Promise<{ moved: boolean; acknowledgementPending: boolean }>;
  openResourceFile?(request: NativeResourceFileRequest): Promise<boolean>;
  revealResourceFile?(request: NativeResourceFileRequest): Promise<boolean>;
  openExternal?(url: string): Promise<boolean>;
  openAppMenu?(name: AppMenuName, anchor: { x: number; y: number }): Promise<boolean>;
  /** Subscribe to native-menu commands; returns an unsubscribe function. */
  onMenu?(handler: (action: NativeMenuAction) => void): () => void;
  /** Forward a semantic attention event; the main process owns the focus gate. */
  signalAttention?(payload: AttentionPayload): void;
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
    return (await bridge.chooseDirectory(options)) ?? [];
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

/**
 * Forward a semantic attention event (turn complete / approval needed) to the
 * Electron shell (Slice 22a). No-op in a plain browser, or against an older
 * bridge that predates the method. Fire-and-forget: the MAIN process decides
 * whether to actually notify/badge based on window focus, so this never throws
 * at the call site.
 */
export function signalAttention(payload: AttentionPayload): void {
  const bridge = nativeBridge();
  if (!bridge?.signalAttention) return;
  try {
    bridge.signalAttention(payload);
  } catch {
    // A failed IPC must not surface where a domain transition is detected.
  }
}
