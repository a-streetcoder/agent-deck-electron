// Electron main process for agent-deck.
//
// The main process owns the server lifecycle. Development spawns the workspace
// server through pnpm; a packaged app runs the compiled backend bundle through
// Electron's embedded Node runtime. Both bind an ephemeral loopback port and
// serve the renderer same-origin.

import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import nodeFs from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { attentionEpisodeKey } from "./attention-episodes.js";
import { createWindowsAttentionOverlay, windowsAttentionDescription } from "./attention-overlay.js";
import {
  allowPreviewNavigation,
  configurePreviewSession,
  PREVIEW_PARTITION,
} from "./preview-guard.js";
import { cloudflaredLogout, forgetCachedTokens } from "./cloudflared-access.js";
import {
  cloudflaredVersion,
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  downloadAndStoreCloudflared,
  lazyCloudflaredRunner,
  resolveCloudflared,
} from "./cloudflared-resolver.js";
import { createSharedServerClient, relaySharedRequest } from "./shared-server.js";
import {
  createTeamPins,
  createTeamServerHandlers,
  nextSharedServerClient,
  readTeamServerSettings,
  restartGate,
  windowOriginFor,
} from "./team-server-settings.js";
import { createTeamServerStatus } from "./team-server-status.js";
import { resolveResourceFile } from "./resource-file-request.js";
import { loopbackHttpUrl, mainWindowNavigation } from "./main-window-policy.js";
import { checkForUpdates } from "./update-check.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
} from "electron";
import electronUpdater from "electron-updater";

const startupTrace = (phase) => {
  if (process.env.AGENT_DECK_E2E_STARTUP_TRACE === "1") {
    console.error(`[agent-deck startup] ${phase}`);
  }
};

startupTrace("module loaded");

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/desktop -> repository root.
const repoRoot = path.resolve(__dirname, "..", "..");
// An external server (AGENT_DECK_SERVER_URL) cannot receive a token this shell
// generated, so the two sides may share one through the environment instead.
const desktopRecoveryToken = process.env.AGENT_DECK_DESKTOP_RECOVERY_TOKEN || randomUUID();
const legacySkillRecoveryTokenPattern =
  /^\.agent-deck-resource-recovery-v1-[1-9][0-9]{0,2}-[A-Za-z0-9][A-Za-z0-9._-]*-[0-9a-f]{32}$/;
// The shared skill engine names retained trees `.<slug>.displaced.<pid>.<sequence>`.
// Keep this check deliberately narrower than the backend's opaque-token lookup; the
// backend still resolves the supplied token against its authoritative recovery list
// before Electron receives a filesystem path.
const engineSkillRecoveryTokenPattern = /^\.[A-Za-z0-9][A-Za-z0-9._-]*\.displaced\.[0-9]+\.[0-9]+$/;

// Present as "Agent Deck" everywhere the OS shows the app name (menu bar,
// About panel) instead of the package/Electron default.
app.setName("Agent Deck");
startupTrace("application name configured");

/** Match the window chrome to the operating system before the renderer paints. */
const windowColors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: "#1e1e20", titlebar: "#28282b", symbol: "#f5f5f7" }
    : { background: "#f7f7f8", titlebar: "#ffffff", symbol: "#18181b" };

let serverProcess = null;
let serverPort = null;
// The privileged control-plane origin: this app's own loopback server, derived
// from `serverPort` once it is known.
let controlPlaneOrigin = null;
// AGENT_DECK_RENDERER_URL (the Vite dev server), validated as loopback at startup.
let rendererUrlOverride = null;
// SRV-12b: local mode with a team server configured (SRV-16a: the Settings
// value, or AGENT_DECK_SHARED_SERVER_URL as a dev override); Make shared calls
// that server through this client (the Access token stays in main).
let sharedServer = null;
// The origin the main window's preload was given on its current load (SRV-16b:
// it asks over shared-server:window-origin). Save reloads the window when the
// setting changes it; until that reload, renderer calls are refused (restartGate).
let windowSharedOrigin = null;
let mainWindow = null;
let draftsFlushedForQuit = false;
let draftFlushRequest = null;

// Keep the backend alive until unsent composer writes have reached durable
// storage. Closing the window and Cmd/Ctrl-Q use the same handshake.
function flushDraftsBeforeQuit() {
  requestDraftFlush(true);
}

/**
 * SRV-16b: the same handshake before a reload for a changed team server. A
 * failed or late flush skips the reload (the restart gate then keeps the page
 * off the new server); a quit asked meanwhile takes over the pending flush.
 */
function requestDraftFlush(quit) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (draftFlushRequest) {
    draftFlushRequest.quit ||= quit;
    return;
  }
  const token = randomUUID();
  const fail = () => {
    if (draftFlushRequest?.token !== token) return;
    clearTimeout(draftFlushRequest.timer);
    const quitting = draftFlushRequest.quit;
    draftFlushRequest = null;
    if (!quitting) return;
    dialog.showErrorBox(
      "Your draft could not be saved",
      "Agent Deck is still open so your message is safe. Check the connection and try quitting again.",
    );
  };
  draftFlushRequest = { token, quit, timer: setTimeout(fail, 15_000), fail };
  mainWindow.webContents.send("drafts:flush", { token });
}

ipcMain.on("drafts:flushed", (event, payload) => {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !draftFlushRequest ||
    payload?.token !== draftFlushRequest.token
  )
    return;
  if (payload.ok !== true) {
    draftFlushRequest.fail();
    return;
  }
  clearTimeout(draftFlushRequest.timer);
  const { quit } = draftFlushRequest;
  draftFlushRequest = null;
  if (!quit) {
    // The preload asks for the origin again on this load (shared-server:window-origin).
    mainWindow.webContents.reload();
    return;
  }
  draftsFlushedForQuit = true;
  app.quit();
});
// This app's own control-plane origin (the agent-deck server): its REST routes
// have no CSRF/Origin guard, so no guest webContents may ever reach it. Reads
// `serverPort` at CALL time — the server may start after handlers are wired.
const isControlPlaneUrl = (parsed) =>
  (controlPlaneOrigin !== null && parsed.origin === controlPlaneOrigin) ||
  (serverPort !== null &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === String(serverPort));
/** The renderer's origin: the Vite dev server when set, else the control plane. */
const expectedRendererOriginNow = () =>
  controlPlaneOrigin ? new URL(rendererUrlOverride || `${controlPlaneOrigin}/`).origin : null;
/** Fetch from this app's own server. */
const controlPlaneFetch = (pathname, init) => fetch(`${controlPlaneOrigin}${pathname}`, init);
// Generation-orders backend refreshes so a slower old response cannot restore
// a stale badge. The count itself is always derived from distinct durable rows.
let attentionRefreshGeneration = 0;
// Keyed by attention EPISODE, not session id: a session acknowledged and then
// flagged again is a new episode, and keying by id alone silently suppressed its
// notification (SES-14).
const notifiedAttentionEpisodes = new Set();

const registerNativeThemeUpdates = () => {
  nativeTheme.on("updated", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const colors = windowColors();
    mainWindow.setBackgroundColor(colors.background);
    if (process.platform !== "darwin") {
      mainWindow.setTitleBarOverlay({
        color: colors.titlebar,
        symbolColor: colors.symbol,
        height: 40,
      });
    }
  });
};

/** Resolve pnpm's executable name per platform (dev PATH is inherited). */
function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

/**
 * Bundled Pi CLI for packaged builds. Spawn with Electron's execPath and
 * ELECTRON_RUN_AS_NODE=1 — the same pattern as the owned server — rather than a
 * shell wrapper that re-execs the GUI binary (which often never runs as Node
 * while the app is open, and bounces a Dock icon labeled "exec").
 */
function bundledPiCli() {
  return path.join(
    process.resourcesPath,
    "pi-runtime",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
}

/** The command and environment used by the backend owned by this Electron process. */
function ownedServerLaunch() {
  if (!app.isPackaged) {
    return {
      command: pnpmCommand(),
      args: ["--filter", "@agent-deck/server", "dev"],
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: "0",
        AGENT_DECK_DESKTOP_RECOVERY_TOKEN: desktopRecoveryToken,
        AGENT_DECK_APP_VERSION: app.getVersion(),
      },
      shell: process.platform === "win32",
    };
  }

  return {
    command: process.execPath,
    args: [path.join(app.getAppPath(), "dist", "server", "index.mjs")],
    cwd: app.getPath("userData"),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: "0",
      AGENT_DECK_DATA_DIR: app.getPath("userData"),
      AGENT_DECK_DESKTOP_RECOVERY_TOKEN: desktopRecoveryToken,
      AGENT_DECK_APP_VERSION: app.getVersion(),
      AGENT_DECK_PI_PATH: process.execPath,
      AGENT_DECK_PI_CLI: bundledPiCli(),
      AGENT_DECK_WEB_DIST: path.join(app.getAppPath(), "apps", "web", "dist"),
      AGENT_DECK_BUILTIN_AGENTS_DIR: path.join(process.resourcesPath, "builtin-agents"),
      AGENT_DECK_BUILTIN_PROMPTS_DIR: path.join(process.resourcesPath, "builtin-prompts"),
      AGENT_DECK_LOOP_CATALOG_NATIVE_PATH: path.join(
        process.resourcesPath,
        "loop-catalog-native",
        `loop-catalog-native.${process.platform}-${process.arch}.node`,
      ),
      AGENT_DECK_SKILL_ENGINE_NATIVE_PATH: path.join(
        process.resourcesPath,
        "skill-engine-native",
        `skill-engine-native.${process.platform}-${process.arch}.node`,
      ),
    },
    shell: false,
  };
}

/**
 * In hot-reload development the backend is already owned by the workspace
 * watcher. Reuse it instead of spawning a second server. Only a loopback HTTP
 * endpoint is accepted because the renderer treats this as its privileged
 * control-plane origin.
 */
function externalServerPort() {
  const raw = process.env.AGENT_DECK_SERVER_URL;
  if (!raw) return null;
  return Number(loopbackHttpUrl(raw, "AGENT_DECK_SERVER_URL").port);
}

/**
 * Spawn the agent-deck server and resolve with the port it actually bound.
 * We pass PORT=0 so Fastify picks a free ephemeral port itself and reports it
 * in its startup log — no pre-pick, so there's no window for another process
 * to steal the port between choosing and binding it.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const launch = ownedServerLaunch();
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      // Pipe (not inherit) so the child holds pipes to us, not our raw stdout fds
      // — otherwise a detached child keeps our stdout open and blocks a clean exit.
      stdio: ["ignore", "pipe", "pipe"],
      // pnpm.cmd on Windows needs a shell to resolve. On POSIX, run the server in
      // its own process group so we can kill the whole tree (pnpm → tsx → node).
      shell: launch.shell,
      detached: process.platform !== "win32",
    });
    serverProcess = child;

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("server did not report a port within 25s"));
    }, 25_000);

    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (settled) return;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
      if (match) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before it started listening`));
        return;
      }
      // Died after starting, while the app is up → tear the app down rather than
      // leave a dead window pointed at nothing.
      if (!app.isQuiting && code !== 0 && code !== null) {
        dialog.showErrorBox(
          "agent-deck server stopped",
          `The backend exited with code ${code}. Check the terminal for details.`,
        );
        app.quit();
      }
    });
  });
}

/** Kill the whole server process tree (pnpm → tsx → node), cross-platform. */
function stopServer() {
  const child = serverProcess;
  if (!child || child.killed || child.pid == null) return;
  if (process.platform === "win32") {
    // SYNCHRONOUS so the whole tree (pnpm → tsx → node) is actually reaped before
    // this returns and `will-quit` lets Electron exit. A fire-and-forget spawn
    // let Electron quit while taskkill was still running, orphaning the server —
    // its lingering handles then blocked the Playwright worker teardown on Windows
    // ("Worker teardown timeout of 90000ms exceeded"). Capped so a stuck taskkill
    // can't hang quit.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5_000,
    });
  } else {
    try {
      // Negative pid → the detached process group, so the tsx/node grandchild dies too.
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/** Poll GET /health until the server answers or we time out. */
function waitForHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("server did not become healthy in time"));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

function createWindow() {
  const { width: workAreaWidth } = screen.getPrimaryDisplay().workAreaSize;
  const initialWidth = Math.max(940, Math.round(workAreaWidth * 0.6));
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: windowColors().background,
    title: "Agent Deck",
    icon: path.join(repoRoot, "build", "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      process.platform === "darwin"
        ? undefined
        : {
            color: windowColors().titlebar,
            symbolColor: windowColors().symbol,
            height: 40,
          },
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Enable the <webview> tag so the Slice L2 general-purpose browser can
      // mount a REAL Chromium guest (not an iframe). The guest's own security
      // posture is force-hardened in the web-contents-created handler below —
      // enabling the tag here does NOT weaken this window.
      webviewTag: true,
    },
  });

  // AGENT_DECK_RENDERER_URL points at the Vite dev server (HMR) when set;
  // otherwise load the server-served production build same-origin.
  void mainWindow.loadURL(rendererUrlOverride || `${controlPlaneOrigin}/`);

  // SRV-16d: the main window stays on the renderer origin (the IPC sender checks
  // trust it); any other http(s) target opens in the system browser. Redirects
  // too, since a server-side redirect never fires will-navigate.
  const guardMainNavigation = (event, url) => {
    const verdict = mainWindowNavigation(url, expectedRendererOriginNow());
    if (verdict === "allow") return;
    event.preventDefault();
    if (verdict === "external") void shell.openExternal(url);
  };
  mainWindow.webContents.on("will-navigate", guardMainNavigation);
  mainWindow.webContents.on("will-redirect", guardMainNavigation);

  // Open external links (docs, GitHub) in the user's browser, not the app.
  // Parse the URL and compare the exact host so a look-alike like
  // http://127.0.0.1.evil.test can't pass, and only ever hand http(s) to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { action: "deny" };
    }
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return { action: "allow" };
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Focus alone is not review: the selected renderer chat acknowledges only
  // after it is both visible and focused. Main never globally clears attention.
  // SRV-16b: focus re-checks the team server status (at most once a minute).
  mainWindow.on("focus", () => {
    void teamStatus.focused();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("close", (event) => {
    if (draftsFlushedForQuit || mainWindow.webContents.isCrashed()) return;
    event.preventDefault();
    flushDraftsBeforeQuit();
  });
}

/** Route a menu command to the renderer, which owns the actual action. */
function sendMenu(action) {
  mainWindow?.webContents.send("menu", action);
}

/** Native application menu — File actions bridge to the renderer via IPC. */
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const questionNavigationItems = [
    { label: "Previous Question", click: () => sendMenu("question.previous") },
    { label: "Next Question", click: () => sendMenu("question.next") },
    { type: "separator" },
  ];
  const viewSubmenu = app.isPackaged
    ? [
        ...questionNavigationItems,
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ]
    : [
        ...questionNavigationItems,
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ];
  const template = [
    ...(isMac
      ? [
          {
            label: "Agent Deck",
            submenu: [
              { role: "about", label: "About Agent Deck" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide", label: "Hide Agent Deck" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit", label: "Quit Agent Deck" },
            ],
          },
        ]
      : []),
    {
      id: "menu-file",
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => sendMenu("new-chat") },
        {
          label: "Add Project…",
          accelerator: "CmdOrCtrl+Alt+O",
          click: () => sendMenu("add-project"),
        },
        { type: "separator" },
        // Stable, non-rebindable way into the keybindings editor. The command
        // palette is the only OTHER entry point and its open-chord is itself
        // user-rebindable, so without this a lost palette binding would leave no
        // in-app path to reopen the editor and reset it. Deliberately given no
        // accelerator so it can't shadow any user-bound app chord.
        { label: "Edit Keybindings…", click: () => sendMenu("open-keybindings") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { id: "menu-edit", role: "editMenu" },
    // Keep Electron's normal development and shipped View controls while adding
    // semantic question navigation (no fixed accelerators; bindings stay user-owned).
    { id: "menu-view", label: "View", submenu: viewSubmenu },
    {
      id: "menu-resources",
      label: "Resources",
      submenu: [
        {
          label: "Agents",
          submenu: [
            { label: "New Agent", click: () => sendMenu("agent.new") },
            { label: "Open Selected Agent File", click: () => sendMenu("agent.openFile") },
            { label: "Reveal Selected Agent", click: () => sendMenu("agent.reveal") },
            {
              label: "Enable/Disable Selected Agent",
              click: () => sendMenu("agent.toggleDisabled"),
            },
          ],
        },
        {
          label: "Skills",
          submenu: [{ label: "Import Skills", click: () => sendMenu("skills.import") }],
        },
        {
          label: "Prompts",
          submenu: [
            { label: "New Prompt", click: () => sendMenu("prompt.new") },
            {
              label: "Copy Selected Prompt Invocation",
              click: () => sendMenu("prompt.copyInvocation"),
            },
            { label: "Open Selected Prompt File", click: () => sendMenu("prompt.openFile") },
            { label: "Reveal Selected Prompt", click: () => sendMenu("prompt.reveal") },
          ],
        },
      ],
    },
    {
      id: "menu-git",
      label: "Git",
      submenu: [
        { label: "Commit all", click: () => sendMenu("git.commit") },
        { label: "Push branch", click: () => sendMenu("git.push") },
        { label: "Merge worktree", click: () => sendMenu("git.mergeWorktree") },
        { type: "separator" },
        { label: "Release…", click: () => sendMenu("git.release") },
      ],
    },
    { role: "windowMenu" },
    {
      id: "menu-help",
      label: "Help",
      submenu: [
        {
          label: "Agent Deck on GitHub",
          click: () => void shell.openExternal("https://github.com/a-streetcoder/agent-deck"),
        },
        {
          label: "Documentation",
          click: () =>
            void shell.openExternal(
              "https://github.com/a-streetcoder/agent-deck/tree/main/agent-deck-documentation",
            ),
        },
        // DST-04: only an NSIS install carries the update feed (app-update.yml).
        ...(app.isPackaged && process.platform === "win32"
          ? [
              {
                label: "Check for Updates…",
                click: () =>
                  void checkForUpdates({
                    updater: electronUpdater.autoUpdater,
                    dialog,
                    window: mainWindow,
                    currentVersion: app.getVersion(),
                  }),
              },
            ]
          : []),
        { type: "separator" },
        { role: "about", label: "About Agent Deck" },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/**
 * Resolve a renderer resource identity against the backend's current catalog.
 * No path supplied by the renderer reaches shell APIs unless the exact path is
 * present in the requested project-scoped agent/prompt/MCP catalog
 * (resolveResourceFile in resource-file-request.js).
 */
async function validatedResourceFile(event, request) {
  const expectedRendererOrigin = expectedRendererOriginNow();
  let senderOrigin = null;
  try {
    senderOrigin = new URL(event.senderFrame?.url ?? "").origin;
  } catch {
    // Rejected by the shared guard below.
  }
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    senderOrigin !== expectedRendererOrigin ||
    !controlPlaneOrigin
  ) {
    throw new Error("Resource file is unavailable");
  }
  return resolveResourceFile(request, {
    controlPlaneFetch,
    lstat,
    realpath,
    stat,
  });
}

ipcMain.handle("resources:openFile", async (event, request) => {
  const file = await validatedResourceFile(event, request);
  const error = await shell.openPath(file);
  if (error) throw new Error("Resource file could not be opened");
  return true;
});

ipcMain.handle("resources:revealFile", async (event, request) => {
  const file = await validatedResourceFile(event, request);
  shell.showItemInFolder(file);
  return true;
});

// SRV-12b: the app's own renderer asks main to call the shared server. The
// client allow-lists the request and answers { status, body } or
// { status: 401, signInRequired: true }; the token never crosses IPC.
// SRV-16a: a changed setting answers a soft restart error (checked first, so
// clearing a configured server says restart too).
ipcMain.handle("shared-server:request", async (event, method, pathname, body) => {
  assertTrustedPickerSender(event, "The shared server is unavailable");
  const restart = restartGate(sharedServer, windowSharedOrigin);
  if (restart) return { status: 0, error: restart };
  if (!sharedServer) return { status: 0, error: "The shared server is unavailable." };
  // SRV-16b: a refused request is an answer, not a rejected invoke; the answer
  // is tagged with its client so a late one from a replaced client is ignored.
  return relaySharedRequest(sharedServer, [method, pathname, body], (answer, client) =>
    teamStatus.observe(answer, client),
  );
});

// SRV-16b: through teamStatus, so the Settings status follows every sign-in.
ipcMain.handle("shared-server:sign-in", (event) => {
  assertTrustedPickerSender(event, "The shared server is unavailable");
  const restart = restartGate(sharedServer, windowSharedOrigin);
  if (restart) return { ok: false, error: restart };
  if (!sharedServer) return { ok: false, error: "No shared server is configured." };
  return teamStatus.signIn();
});

// SRV-16b: the preload asks for the origin at every load of the main window's
// main frame (instead of a command-line switch fixed per window), so a reload
// after Save picks up a changed team server. Other senders get null.
ipcMain.on("shared-server:window-origin", (event) => {
  const origin = windowOriginFor(
    event,
    mainWindow,
    sharedServer?.origin ?? null,
    expectedRendererOriginNow(),
  );
  if (origin !== undefined) windowSharedOrigin = origin;
  event.returnValue = origin ?? null;
});

ipcMain.handle("shared-server:sign-in-cancel", (event) => {
  assertTrustedPickerSender(event, "The shared server is unavailable");
  sharedServer?.cancelSignIn();
  return true;
});

// SRV-16a: the team server setting (userData/team-server.json).
const teamServerHandlers = createTeamServerHandlers({
  context: () => ({
    dir: app.getPath("userData"),
    env: process.env.AGENT_DECK_SHARED_SERVER_URL,
    windowOrigin: windowSharedOrigin,
  }),
  apply: applyTeamServerSetting,
});

// SRV-16b: the sign-in status (team-server-status.js), pushed to the window as
// "team-server:status"; the Access team of each host is pinned in team-server.json.
const teamStatus = createTeamServerStatus({
  publish: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("team-server:status", status);
    }
  },
  pins: createTeamPins(app.getPath("userData"), process.env.AGENT_DECK_CF_ACCESS_TEAM_DOMAIN),
  logout: async (origin) => {
    const run = cloudflaredRunner();
    return run ? cloudflaredLogout(run, origin) : false;
  },
  // Remove cached token: only this host's application token files in ~/.cloudflared.
  forget: (origin) =>
    forgetCachedTokens({
      dir: path.join(os.homedir(), ".cloudflared"),
      host: new URL(origin).hostname,
      fs: nodeFs,
    }),
});

/** Point the shared-server client at the configured origin. */
function applyTeamServerSetting() {
  const { origin } = teamServerHandlers.state();
  const previous = sharedServer;
  sharedServer = nextSharedServerClient(sharedServer, origin, (next) =>
    createSharedServerClient({
      origin: next,
      run: cloudflaredRunner(),
      trustTeam: (team, aud) => teamStatus.trustTeam(next, team, aud),
    }),
  );
  // Startup and a changed origin: silent cached-token check, never a browser.
  if (sharedServer !== previous) void teamStatus.attach(sharedServer);
}

ipcMain.handle("team-server:get", (event) => {
  assertTrustedPickerSender(event, "Team server settings are unavailable");
  return teamServerHandlers.get();
});

ipcMain.handle("team-server:set", (event, input) => {
  assertTrustedPickerSender(event, "Team server settings are unavailable");
  const result = teamServerHandlers.set(input);
  // SRV-16b: a changed origin reloads the window once its drafts are flushed.
  if (result.ok && result.restartRequired) requestDraftFlush(false);
  return result;
});

/** SRV-16b: the sign-in status and actions, behind the same sender guard as get/set. */
const teamServerAction = (event, run) => {
  assertTrustedPickerSender(event, "Team server settings are unavailable");
  return run();
};

ipcMain.handle("team-server:status", (event) => {
  assertTrustedPickerSender(event, "Team server settings are unavailable");
  return teamStatus.get();
});

ipcMain.handle("team-server:sign-in", (event) =>
  teamServerAction(event, () => teamStatus.signIn()),
);

ipcMain.handle("team-server:sign-out", (event) =>
  teamServerAction(event, () => teamStatus.signOut()),
);

ipcMain.handle("team-server:accept-team", (event) =>
  teamServerAction(event, () => teamStatus.acceptTeam()),
);

ipcMain.handle("team-server:sign-in-cancel", (event) =>
  teamServerAction(event, () => {
    sharedServer?.cancelSignIn();
    return { ok: true };
  }),
);

ipcMain.handle("team-server:forget-token", (event) =>
  teamServerAction(event, () => teamStatus.forgetToken()),
);

// The Team server screen mounted: re-check a signed-in, unreachable or refused status.
ipcMain.handle("team-server:check", (event) =>
  teamServerAction(event, async () => {
    await teamStatus.recheck();
    return { ok: true };
  }),
);

/** Native folder chooser (the NSOpenPanel equivalent) for the project flow. */
ipcMain.handle("shell:openExternal", async (_event, rawUrl) => {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    await shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("subagents:revealArtifacts", async (event, rawRunId) => {
  const runId = typeof rawRunId === "string" ? rawRunId : "";
  assertTrustedPickerSender(event, "Subagent artifacts are unavailable");
  if (
    !controlPlaneOrigin ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
  ) {
    throw new Error("Subagent artifacts are unavailable");
  }
  const response = await controlPlaneFetch(
    `/subagent-runs/${encodeURIComponent(runId)}/artifact-directory`,
    { headers: { "x-agent-deck-desktop-recovery-token": desktopRecoveryToken } },
  );
  if (!response.ok) throw new Error("Subagent artifacts are unavailable");
  const body = await response.json().catch(() => null);
  if (!body || typeof body.directory !== "string" || !path.isAbsolute(body.directory)) {
    throw new Error("Subagent artifacts are unavailable");
  }
  // The backend/native capability revalidated immediately before this external
  // pathname boundary. shell.showItemInFolder remains an OS API boundary.
  shell.showItemInFolder(body.directory);
  return true;
});

ipcMain.handle("loops:revealArtifacts", async (event, rawRunId) => {
  const runId = typeof rawRunId === "string" ? rawRunId : "";
  const expectedRendererOrigin = expectedRendererOriginNow();
  let senderOrigin = null;
  try {
    senderOrigin = new URL(event.senderFrame?.url ?? "").origin;
  } catch {
    // Rejected below.
  }
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    senderOrigin !== expectedRendererOrigin ||
    !controlPlaneOrigin ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
  ) {
    throw new Error("Loop run is unavailable");
  }
  const response = await controlPlaneFetch(
    `/loops/runs/${encodeURIComponent(runId)}/artifact-directory`,
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : "Artifacts are unavailable");
  }
  const body = await response.json();
  if (!body || typeof body.directory !== "string" || !path.isAbsolute(body.directory)) {
    throw new Error("The backend returned an invalid artifact directory");
  }
  shell.showItemInFolder(body.directory);
  return true;
});

ipcMain.handle("skills:trashRecovery", async (event, rawToken) => {
  assertTrustedPickerSender(event, "Skill recovery is unavailable");
  const token = typeof rawToken === "string" ? rawToken : "";
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !controlPlaneOrigin ||
    token.length < 1 ||
    token.length > 512 ||
    (!legacySkillRecoveryTokenPattern.test(token) && !engineSkillRecoveryTokenPattern.test(token))
  ) {
    throw new Error("Skill recovery is unavailable");
  }
  const headers = { "x-agent-deck-desktop-recovery-token": desktopRecoveryToken };
  const lookup = await controlPlaneFetch(
    `/resources/skill-recoveries/${encodeURIComponent(token)}/trash-path`,
    { headers },
  );
  if (!lookup.ok) throw new Error("Skill recovery could not be revalidated");
  const body = await lookup.json();
  if (!body || typeof body.path !== "string" || !path.isAbsolute(body.path)) {
    throw new Error("The backend returned an invalid skill recovery");
  }
  await shell.trashItem(body.path);
  let acknowledgementPending = false;
  try {
    const acknowledged = await controlPlaneFetch(
      `/resources/skill-recoveries/${encodeURIComponent(token)}/acknowledge`,
      { method: "POST", headers },
    );
    acknowledgementPending = !acknowledged.ok;
  } catch {
    // Trash success is authoritative. The backend list already omits the absent
    // wrapper and acknowledgement is intentionally idempotent/best-effort.
    acknowledgementPending = true;
  }
  return { moved: true, acknowledgementPending };
});

ipcMain.handle("loops:revealWorktree", async (event, rawRunId) => {
  const runId = typeof rawRunId === "string" ? rawRunId : "";
  const expectedRendererOrigin = expectedRendererOriginNow();
  let senderOrigin = null;
  try {
    senderOrigin = new URL(event.senderFrame?.url ?? "").origin;
  } catch {
    // Rejected below.
  }
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    senderOrigin !== expectedRendererOrigin ||
    !controlPlaneOrigin ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
  ) {
    throw new Error("Loop run is unavailable");
  }
  const response = await controlPlaneFetch(
    `/loops/runs/${encodeURIComponent(runId)}/worktree-directory`,
  );
  if (!response.ok) {
    throw new Error("The retained Loop worktree is unavailable for review");
  }
  const body = await response.json().catch(() => null);
  if (!body || typeof body.directory !== "string" || !path.isAbsolute(body.directory)) {
    throw new Error("The retained Loop worktree is unavailable for review");
  }
  shell.showItemInFolder(body.directory);
  return true;
});

function assertTrustedPickerSender(event, errorMessage) {
  const expectedRendererOrigin = expectedRendererOriginNow();
  let senderOrigin = null;
  try {
    senderOrigin = new URL(event.senderFrame?.url ?? "").origin;
  } catch {
    // Rejected below.
  }
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    senderOrigin !== expectedRendererOrigin
  ) {
    throw new Error(errorMessage);
  }
}

function boundedPickerPaths(filePaths) {
  return filePaths
    .filter(
      (file) =>
        typeof file === "string" &&
        path.isAbsolute(file) &&
        file.length <= 4096 &&
        ![...file].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        }),
    )
    .slice(0, 16);
}

ipcMain.handle("drop:classifyPaths", async (event, rawPaths) => {
  assertTrustedPickerSender(event, "Dropped attachments are unavailable");
  const paths = (Array.isArray(rawPaths) ? rawPaths : []).slice(0, 16).flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= 16
    )
      return [];
    const validated = boundedPickerPaths([item.path]);
    return validated.length > 0 ? [{ index: item.index, path: validated[0] }] : [];
  });
  const classified = await Promise.all(
    paths.map(async ({ index, path: candidate }) => {
      try {
        const info = await stat(candidate);
        if (info.isFile()) return { index, path: candidate, kind: "file" };
        if (info.isDirectory()) return { index, path: candidate, kind: "folder" };
      } catch {
        // A disappeared or unreadable drop is omitted and reported by the renderer.
      }
      return null;
    }),
  );
  return classified.filter(Boolean);
});

ipcMain.handle("dialog:openDirectory", async (event, options = {}) => {
  assertTrustedPickerSender(event, "Folder chooser is unavailable");
  const pickerOptions = options && typeof options === "object" ? options : {};
  const properties = ["openDirectory", "createDirectory"];
  if (pickerOptions.multiple === true) properties.push("multiSelections");
  const result = await dialog.showOpenDialog(mainWindow, {
    title: typeof pickerOptions.title === "string" ? pickerOptions.title : "Choose Folder",
    message: typeof pickerOptions.message === "string" ? pickerOptions.message : undefined,
    buttonLabel:
      typeof pickerOptions.buttonLabel === "string" ? pickerOptions.buttonLabel : undefined,
    properties,
  });
  if (result.canceled) return [];
  return boundedPickerPaths(result.filePaths);
});

ipcMain.handle("dialog:openFiles", async (event, options = {}) => {
  assertTrustedPickerSender(event, "File chooser is unavailable");
  const pickerOptions = options && typeof options === "object" ? options : {};
  // Extension filters (PRM-07): validated shape only — a renderer-supplied filter
  // can narrow the picker but never widen any capability (the picker only returns paths).
  const filters = Array.isArray(pickerOptions.filters)
    ? pickerOptions.filters
        .slice(0, 8) // bound BEFORE validating — never scan an unbounded array
        .filter(
          (f) =>
            f &&
            typeof f.name === "string" &&
            Array.isArray(f.extensions) &&
            f.extensions.length > 0 &&
            f.extensions
              .slice(0, 16)
              .every((ext) => typeof ext === "string" && /^[a-z0-9]{1,12}$/i.test(ext)),
        )
        .map((f) => ({ name: f.name.slice(0, 64), extensions: f.extensions.slice(0, 16) }))
    : undefined;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: typeof pickerOptions.title === "string" ? pickerOptions.title : "Choose Files",
    message: typeof pickerOptions.message === "string" ? pickerOptions.message : undefined,
    buttonLabel:
      typeof pickerOptions.buttonLabel === "string" ? pickerOptions.buttonLabel : undefined,
    filters: filters && filters.length > 0 ? filters : undefined,
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return boundedPickerPaths(result.filePaths);
});

/** Open a renderer titlebar button's native menu directly below the top bar. */
ipcMain.handle("app-menu:open", (_event, menuName, anchor) => {
  const name = String(menuName ?? "").toLowerCase();
  if (!new Set(["file", "edit", "view", "resources", "git", "help"]).has(name)) {
    throw new Error("Unknown application menu");
  }
  const item = Menu.getApplicationMenu()?.getMenuItemById(`menu-${name}`);
  if (!item?.submenu) throw new Error("Application menu is unavailable");
  if (!mainWindow || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    throw new Error("Application menu anchor is invalid");
  }
  const [contentWidth, contentHeight] = mainWindow.getContentSize();
  const x = Math.max(0, Math.min(contentWidth, Math.round(anchor.x)));
  const y = Math.max(0, Math.min(contentHeight, Math.round(anchor.y)));
  item.submenu.popup({ window: mainWindow, x, y });
  return true;
});

/** Read the backend-owned durable set. Renderer messages are hints only; they
 * cannot choose the count or claim that an arbitrary session needs review. */
async function refreshDesktopAttention(notificationHint) {
  if (!controlPlaneOrigin) return;
  const generation = ++attentionRefreshGeneration;
  try {
    const response = await controlPlaneFetch("/sessions");
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.sessions)) return;
    const pending = body.sessions.filter(
      (session) => session && typeof session.id === "string" && session.needsAttention === true,
    );
    if (generation !== attentionRefreshGeneration) return;
    const pendingIds = new Set(pending.map((session) => session.id));
    const pendingEpisodes = new Set(pending.map((session) => attentionEpisodeKey(session)));
    for (const key of notifiedAttentionEpisodes) {
      if (!pendingEpisodes.has(key)) notifiedAttentionEpisodes.delete(key);
    }
    if (process.platform === "win32") {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (pendingIds.size === 0) {
          mainWindow.setOverlayIcon(null, "No sessions need attention");
        } else {
          mainWindow.setOverlayIcon(
            createWindowsAttentionOverlay(nativeImage, pendingIds.size),
            windowsAttentionDescription(pendingIds.size),
          );
        }
      }
    } else {
      app.setBadgeCount(pendingIds.size);
    }

    // The episode comes from the backend rows just fetched, never from the
    // renderer's hint: main decides what is pending and which episode it is in.
    const hintedEpisode = attentionEpisodeKey(
      pending.find((session) => session.id === notificationHint?.sessionId),
    );
    if (
      notificationHint &&
      hintedEpisode &&
      !notifiedAttentionEpisodes.has(hintedEpisode) &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.isFocused() &&
      Notification.isSupported()
    ) {
      notifiedAttentionEpisodes.add(hintedEpisode);
      const notification = new Notification({
        title: notificationHint.title,
        body: notificationHint.body,
      });
      notification.on("click", () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        // Route first; renderer acknowledgement still waits for the target chat
        // to become selected, visible, and focused.
        mainWindow.webContents.send("focus-session", notificationHint.sessionId);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      });
      notification.show();
    }
  } catch {
    // Keep the last known badge; a later metadata hint/startup refresh retries.
  }
}

ipcMain.on("attention:sync", (event) => {
  try {
    assertTrustedPickerSender(event, "Attention sync is unavailable");
  } catch {
    return;
  }
  void refreshDesktopAttention();
});

ipcMain.on("attention:notify", (event, payload) => {
  try {
    assertTrustedPickerSender(event, "Attention notification is unavailable");
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const keys = Object.keys(payload);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "sessionId" || key === "title" || key === "body") ||
    typeof payload.sessionId !== "string" ||
    payload.sessionId.length < 1 ||
    payload.sessionId.length > 256 ||
    typeof payload.title !== "string" ||
    payload.title.length < 1 ||
    payload.title.length > 200 ||
    typeof payload.body !== "string" ||
    payload.body.length > 200
  )
    return;
  void refreshDesktopAttention({
    sessionId: payload.sessionId,
    title: payload.title,
    body: payload.body,
  });
});

// --- SRV-16c: cloudflared (cloudflared-resolver.js) ---
/** The cloudflared to use: AGENT_DECK_CLOUDFLARED, stored cloudflaredPath, PATH, install folders. */
function resolvedCloudflared() {
  return resolveCloudflared({
    storedPath: readTeamServerSettings(app.getPath("userData")).cloudflaredPath,
    env: process.env,
  });
}

const execCloudflared = (cloudflared, args, timeout, signal) =>
  execFileAsync(cloudflared, args, { timeout, signal, windowsHide: true }).then((r) => r.stdout);

/** The shared-server client's runner: resolves cloudflared on every call. */
function cloudflaredRunner() {
  return lazyCloudflaredRunner(resolvedCloudflared, execCloudflared);
}

/** { path, source, version, warning } for Settings > Team server, or null when none is found. */
ipcMain.handle("team-server:cloudflared", async (event) => {
  assertTrustedPickerSender(event, "Team server settings are unavailable");
  const found = resolvedCloudflared();
  if (!found.path) return null;
  const version = await cloudflaredVersion((args, timeout) =>
    execCloudflared(found.path, args, timeout),
  );
  return { ...found, version };
});

/**
 * { downloadVersion, warning }: the version a download would fetch (null when
 * there is none for this machine) and the resolver's warning, also when none is found.
 */
ipcMain.handle("team-server:cloudflared-info", (event) => {
  assertTrustedPickerSender(event, "Team server settings are unavailable");
  const supported = CLOUDFLARED_ASSETS[`${process.platform}-${process.arch}`];
  return {
    downloadVersion: supported ? CLOUDFLARED_VERSION : null,
    warning: resolvedCloudflared().warning,
  };
});

let cloudflaredDownload = null;
/**
 * One verified download at a time; progress goes to the asking renderer as
 * 'team-server:cloudflared-progress'. Answers { ok, path, version } or
 * { ok: false, error }; a success records cloudflaredPath, which the client's
 * runner picks up on its next call. Any failure (also the deadline) clears
 * the pending promise, so Download can be retried.
 */
ipcMain.handle("team-server:cloudflared-download", (event) => {
  assertTrustedPickerSender(event, "Team server settings are unavailable");
  const sender = event.sender;
  cloudflaredDownload ??= downloadAndStoreCloudflared({
    userDataDir: app.getPath("userData"),
    onProgress: (progress) => {
      if (!sender.isDestroyed()) sender.send("team-server:cloudflared-progress", progress);
    },
  })
    .then(({ path: cloudflared, version }) => ({ ok: true, path: cloudflared, version }))
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      cloudflaredDownload = null;
    });
  return cloudflaredDownload;
});
// --- end SRV-16c ---

async function bootstrap() {
  startupTrace("bootstrap started");
  if (process.env.AGENT_DECK_REMOTE_SERVER_URL) {
    console.warn(
      "AGENT_DECK_REMOTE_SERVER_URL ignored: remote attach was removed; configure a team server in Settings",
    );
  }
  try {
    // Only a loopback renderer (the Vite dev server) may replace the backend's build.
    rendererUrlOverride = process.env.AGENT_DECK_RENDERER_URL
      ? loopbackHttpUrl(process.env.AGENT_DECK_RENDERER_URL, "AGENT_DECK_RENDERER_URL").href
      : null;
    // SRV-16a: the Settings value, or the env dev override (an invalid one fails startup).
    applyTeamServerSetting();
    const configuredPort = externalServerPort();
    serverPort = configuredPort ?? (await startServer());
    controlPlaneOrigin = `http://127.0.0.1:${serverPort}`;
    startupTrace("server port acquired");
    await waitForHealth(serverPort);
    startupTrace("server health confirmed");
  } catch (error) {
    dialog.showErrorBox("agent-deck failed to start", String(error));
    app.quit();
    return;
  }
  app.setAboutPanelOptions({
    applicationName: "Agent Deck",
    applicationVersion: app.getVersion(),
    credits: "A native harness for the pi coding agent.",
  });
  Menu.setApplicationMenu(buildAppMenu());
  startupTrace("creating main window");
  createWindow();
  void refreshDesktopAttention();
  startupTrace("main window created");
}

// Slice L2 — the general-purpose browser mounts a REAL Chromium <webview> guest.
// Every guest gets (a) force-hardened webPreferences at attach time and (b) its
// OWN navigation/popup policy, independent of the main window's loopback-only
// policy above (which is left untouched).
app.on("web-contents-created", (_event, contents) => {
  // (a) Defense-in-depth: pin the guest's security-critical webPreferences so the
  // <webview> tag's attributes can NEVER weaken them. The guest browses arbitrary
  // sites, so it must stay sandboxed + context-isolated with no Node access and
  // no inherited preload. (Ported from the t3code will-attach-webview idea, but
  // with contextIsolation TRUE — we have no picker preload that needs to share
  // globalThis, so the guest keeps the strongest posture.)
  contents.on("will-attach-webview", (_attachEvent, webPreferences) => {
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.webviewTag = false;
    // The guest must not inherit the host preload (the agentDeck bridge). Any
    // preload the tag tried to set is dropped here.
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
  });

  // (b) Guest-only policy for the in-app browser, which loads ARBITRARY UNTRUSTED
  // web content. Two clamps:
  //
  //   Popups (target=_blank / window.open): never spawn a raw child BrowserWindow.
  //   Modern Electron removed the <webview> `new-window` DOM event, so we
  //   intercept here — deny the native popup and forward ONLY an http(s) target
  //   to the renderer (which opens it as a new internal page-tab). Non-http(s)
  //   targets are DROPPED, never handed to shell.openExternal: forwarding an
  //   attacker-chosen scheme (file: / smb: / ms-msdt: / any custom handler) to
  //   the OS is the canonical Electron shell.openExternal RCE/exfil vector.
  //
  //   Navigation: a general browser navigates http(s) freely, but must not reach
  //   privileged schemes (file:, etc.) or this app's own control-plane origin
  //   (the agent-deck server on 127.0.0.1:serverPort), which has no CSRF/Origin
  //   guard on its REST routes — untrusted page JS must not be able to drive it.
  //   Other loopback origins (the user's own dev servers) stay reachable.
  if (contents.getType() === "webview") {
    const isControlPlane = isControlPlaneUrl;

    contents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return { action: "deny" };
      }
      // Only http(s) popups (and never the app's own control plane) become an
      // internal page-tab; everything else — including all non-http(s) schemes —
      // is dropped.
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !isControlPlane(parsed)
      ) {
        mainWindow?.webContents.send("browser:open-page", url);
      }
      return { action: "deny" };
    });

    // The dev-server PREVIEW guest (PRE-01) is identified by its partition and
    // held to a stricter rule than the general browser: loopback http(s) only,
    // never the control plane. Its renderer-side gate covers only the INITIAL
    // src — post-mount navigation is enforceable only here in main. Applied to
    // will-navigate AND will-redirect (a server-side redirect never fires
    // will-navigate).
    const isPreviewGuest = contents.session === session.fromPartition(PREVIEW_PARTITION);

    const guardNavigation = (event, url) => {
      if (isPreviewGuest) {
        if (!allowPreviewNavigation(url, isControlPlane)) event.preventDefault();
        return;
      }
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return; // an unparseable target won't navigate a webContents anyway
      }
      // The general browser: deny only the genuinely dangerous top-level
      // targets — file: (local-file read) and this app's own control-plane
      // origin (unguarded REST → CSRF). http(s) browses freely (incl. the
      // user's OWN other localhost dev servers), and benign schemes
      // (about:blank, data:) are left alone so the blank new-tab and in-page
      // renders work.
      if (parsed.protocol === "file:" || isControlPlane(parsed)) event.preventDefault();
    };
    contents.on("will-navigate", guardNavigation);
    // Sibling of will-navigate: without this, a SERVER-SIDE redirect could
    // carry either guest to a target the click-time check would have denied.
    contents.on("will-redirect", guardNavigation);
  }
});

app.whenReady().then(() => {
  startupTrace("electron ready");
  registerNativeThemeUpdates();
  // PRE-01: clamp the dev-server preview guest's session before any embed can
  // exist — no permission grants, no downloads (see preview-guard.js).
  configurePreviewSession(session.fromPartition(PREVIEW_PARTITION), isControlPlaneUrl);
  if (process.platform === "win32") {
    app.setAppUserModelId("com.streetcoding.agentdeck");
    startupTrace("Windows application identity configured");
  }
  // `pnpm dev` runs Electron's generic executable rather than a packaged app
  // bundle, so macOS otherwise displays Electron's icon in the Dock. Packaged
  // builds get the same artwork from electron-builder's bundle metadata.
  if (process.platform === "darwin" && !app.isPackaged) {
    try {
      app.dock.setIcon(path.join(repoRoot, "build", "icon.icns"));
    } catch (error) {
      // Branding must never prevent the development app from starting.
      console.warn("Unable to set the development Dock icon:", error);
    }
  }
  return bootstrap();
});

app.on("activate", () => {
  // macOS: re-open a window when the dock icon is clicked and none are open.
  if (BrowserWindow.getAllWindows().length === 0 && controlPlaneOrigin) {
    createWindow();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isCrashed() &&
    !draftsFlushedForQuit
  ) {
    event.preventDefault();
    flushDraftsBeforeQuit();
    return;
  }
  app.isQuiting = true;
});

app.on("will-quit", () => {
  // Kill a pending `cloudflared access login` so it does not outlive the app.
  sharedServer?.cancelSignIn();
  stopServer();
});
