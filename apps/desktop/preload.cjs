// Preload bridge (CommonJS so it loads cleanly under the sandbox).
//
// Exposes a tiny, allow-listed surface on window.agentDeck. The web UI checks
// `window.agentDeck?.isElectron` to prefer the native folder picker over the
// type-a-path fallback it uses in a plain browser.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const remote = process.argv.includes("--agent-deck-remote-server");
// SRV-12b, SRV-16b: the configured shared server's origin (never a token),
// asked from main at every load so a reload after Save picks up a new one.
const askedOrigin = remote ? null : ipcRenderer.sendSync("shared-server:window-origin");
const sharedServerOrigin = typeof askedOrigin === "string" ? askedOrigin : undefined;

contextBridge.exposeInMainWorld("agentDeck", {
  isElectron: true,
  platform: process.platform,
  /**
   * True when the shell is attached to a remote server (AGENT_DECK_REMOTE_SERVER_URL):
   * native file/folder pickers would choose paths on THIS machine, not the one
   * running the agents, so the renderer must use server-side path flows.
   */
  remote,
  /**
   * Open the native folder chooser. Resolves to the selected absolute path(s),
   * or [] if the user cancels.
   * @param {{ title?: string, message?: string, buttonLabel?: string, multiple?: boolean }} [options]
   * @returns {Promise<string[]>}
   */
  chooseDirectory: (options) => ipcRenderer.invoke("dialog:openDirectory", options),
  /**
   * Open the native file chooser. Only paths explicitly selected by the user
   * cross the bridge; reading/opening those paths is not exposed.
   * @param {{ title?: string, message?: string, buttonLabel?: string }} [options]
   * @returns {Promise<string[]>}
   */
  chooseFiles: (options) => ipcRenderer.invoke("dialog:openFiles", options),
  /**
   * Resolve only File objects received from an OS drag. Electron owns path
   * extraction; main validates and classifies each resulting path.
   * @param {File[]} files
   * @returns {Promise<Array<{ index: number, path: string, kind: "file" | "folder" }>>}
   */
  resolveDroppedItems: (files) => {
    if (!Array.isArray(files)) return Promise.resolve([]);
    const paths = files.slice(0, 16).flatMap((file, index) => {
      try {
        const resolved = webUtils.getPathForFile(file);
        return resolved ? [{ index, path: resolved }] : [];
      } catch {
        return [];
      }
    });
    return ipcRenderer.invoke("drop:classifyPaths", paths);
  },
  /** Open a native menu at a renderer-provided titlebar anchor. */
  openAppMenu: (name, anchor) => ipcRenderer.invoke("app-menu:open", name, anchor),
  /** Reveal a backend/native-validated subagent artifact root by opaque run id. */
  revealSubagentArtifacts: (runId) => ipcRenderer.invoke("subagents:revealArtifacts", runId),
  /** Reveal a backend-validated Loop artifact directory by opaque run id. */
  revealLoopArtifacts: (runId) => ipcRenderer.invoke("loops:revealArtifacts", runId),
  /** Reveal a backend-validated retained Loop worktree by opaque run id. */
  revealLoopWorktree: (runId) => ipcRenderer.invoke("loops:revealWorktree", runId),
  /** Move a backend-revalidated skill recovery to OS Trash by opaque token. */
  trashSkillRecovery: (token) => ipcRenderer.invoke("skills:trashRecovery", token),
  /** Open/reveal a backend-catalog-validated agent or prompt file. */
  openResourceFile: (request) => ipcRenderer.invoke("resources:openFile", request),
  revealResourceFile: (request) => ipcRenderer.invoke("resources:revealFile", request),
  /**
   * Local sign-in page only (ade-zvv5): "start" runs the cloudflared browser
   * login, "cancel" aborts it. Resolves { ok, error? }, never the token.
   * @param {"start" | "cancel"} action
   */
  remoteSignIn: (action) => ipcRenderer.invoke("remote-sign-in", action),
  /**
   * SRV-12b, local mode with a shared server configured: allow-listed calls to
   * it made by main with the Access token. Resolves { status, body } or
   * { status: 401, signInRequired: true }; signIn() opens the system browser.
   */
  sharedServer: sharedServerOrigin
    ? {
        origin: sharedServerOrigin,
        request: (method, path, body) =>
          ipcRenderer.invoke("shared-server:request", method, path, body),
        signIn: () => ipcRenderer.invoke("shared-server:sign-in"),
        cancelSignIn: () => ipcRenderer.invoke("shared-server:sign-in-cancel"),
      }
    : undefined,
  /**
   * SRV-16a: the team server setting. get() resolves
   * { serverUrl, overridden, origin, restartRequired }; set({ serverUrl })
   * resolves { ok: false, error } or { ok: true, ...the new state }. Absent in
   * remote mode: that page comes from the server and must not set it.
   * SRV-16b: status() and onStatus(handler) give the sign-in status
   * { state, user?, team?, error?, warning? } (never a token); signIn(),
   * signOut(), acceptTeam(), cancelSignIn(), forgetToken() (Remove cached
   * token) and check() (re-check the status) resolve { ok, error? }.
   */
  teamServer: remote
    ? undefined
    : {
        get: () => ipcRenderer.invoke("team-server:get"),
        set: (input) => ipcRenderer.invoke("team-server:set", input),
        status: () => ipcRenderer.invoke("team-server:status"),
        signIn: () => ipcRenderer.invoke("team-server:sign-in"),
        signOut: () => ipcRenderer.invoke("team-server:sign-out"),
        acceptTeam: () => ipcRenderer.invoke("team-server:accept-team"),
        cancelSignIn: () => ipcRenderer.invoke("team-server:sign-in-cancel"),
        forgetToken: () => ipcRenderer.invoke("team-server:forget-token"),
        check: () => ipcRenderer.invoke("team-server:check"),
        onStatus: (handler) => {
          const listener = (_event, status) => handler(status);
          ipcRenderer.on("team-server:status", listener);
          return () => ipcRenderer.removeListener("team-server:status", listener);
        },
        // --- SRV-16c: cloudflared ---
        /** { path, source, version, warning } or null when no cloudflared is found. */
        cloudflared: () => ipcRenderer.invoke("team-server:cloudflared"),
        /** { downloadVersion, warning }: the pinned version a download fetches (or null). */
        cloudflaredInfo: () => ipcRenderer.invoke("team-server:cloudflared-info"),
        /** Verified download; resolves { ok, path, version } or { ok: false, error }. */
        downloadCloudflared: () => ipcRenderer.invoke("team-server:cloudflared-download"),
        /** Byte progress { received, total } of a running download; returns unsubscribe. */
        onCloudflaredProgress: (handler) => {
          const listener = (_event, progress) => handler(progress);
          ipcRenderer.on("team-server:cloudflared-progress", listener);
          return () => ipcRenderer.removeListener("team-server:cloudflared-progress", listener);
        },
        // --- end SRV-16c ---
      },
  /** Open an allow-listed http(s) URL in the user's default browser. */
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  /** Flush device-local drafts before main closes the renderer/backend. */
  onFlushDrafts: (handler) => {
    ipcRenderer.removeAllListeners("drafts:flush");
    const listener = async (_event, payload) => {
      if (!payload || typeof payload.token !== "string" || payload.token.length > 256) return;
      try {
        await handler();
        ipcRenderer.send("drafts:flushed", { token: payload.token, ok: true });
      } catch {
        ipcRenderer.send("drafts:flushed", { token: payload.token, ok: false });
      }
    };
    ipcRenderer.on("drafts:flush", listener);
    return () => ipcRenderer.removeListener("drafts:flush", listener);
  },
  /** Ask main to re-read the durable backend attention set. */
  syncAttention: () => ipcRenderer.send("attention:sync"),
  /** Hint one durable false→true transition; main revalidates backend truth. */
  notifyAttention: (payload) => ipcRenderer.send("attention:notify", payload),
  /**
   * Subscribe to notification-click session routing. The renderer receives only
   * the opaque session id selected by main; raw IPC events stay inside preload.
   * @param {(sessionId: string) => void} handler
   * @returns {() => void}
   */
  onFocusSession: (handler) => {
    ipcRenderer.removeAllListeners("focus-session");
    const listener = (_event, sessionId) => {
      if (typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256) {
        handler(sessionId);
      }
    };
    ipcRenderer.on("focus-session", listener);
    return () => ipcRenderer.removeListener("focus-session", listener);
  },
  /**
   * Subscribe to allow-listed semantic native-menu commands. Returns an
   * unsubscribe function; raw IPC events are never exposed to the renderer.
   * @param {(action: string) => void} handler
   * @returns {() => void}
   */
  onMenu: (handler) => {
    // The preload context can survive a renderer reload. Clear any listener
    // owned by the previous React tree so one native menu click stays one
    // action after reloads (including development hot reloads).
    ipcRenderer.removeAllListeners("menu");
    const allowed = new Set([
      "new-chat",
      "add-project",
      "open-keybindings",
      "question.previous",
      "question.next",
      "git.commit",
      "git.push",
      "git.mergeWorktree",
      "git.release",
      "agent.new",
      "agent.openFile",
      "agent.reveal",
      "agent.toggleDisabled",
      "skills.import",
      "prompt.new",
      "prompt.copyInvocation",
      "prompt.openFile",
      "prompt.reveal",
    ]);
    const listener = (_event, action) => {
      if (typeof action === "string" && allowed.has(action)) handler(action);
    };
    ipcRenderer.on("menu", listener);
    return () => ipcRenderer.removeListener("menu", listener);
  },
  /**
   * Subscribe to browser popup requests (Slice L2). A target=_blank / window.open
   * inside a <webview> guest is denied its native child window by the main
   * process, which forwards the http(s) target here; the browser panel opens it
   * as a new internal page-tab. Returns an unsubscribe function.
   * @param {(url: string) => void} handler
   * @returns {() => void}
   */
  onBrowserOpenPage: (handler) => {
    const listener = (_event, url) => handler(url);
    ipcRenderer.on("browser:open-page", listener);
    return () => ipcRenderer.removeListener("browser:open-page", listener);
  },
});
