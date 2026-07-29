import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

/**
 * Phase-1 gate for the Electron shell: launching the real app boots the same
 * Fastify+pi server the CLI runs (on a free port, owned by the main process),
 * loads the built web UI same-origin, and exposes the native-bridge preload.
 *
 * Streaming/chat is already gated by the browser e2e against the identical
 * server; here we only prove the desktop shell wires renderer → server → OS
 * bridge together and tears the server down on exit.
 */

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESKTOP_DIR = path.join(WORKSPACE_ROOT, "apps", "desktop");
const WEB_DIST = path.join(WORKSPACE_ROOT, "apps", "web", "dist");

// Resolve Electron's binary from the desktop package so this suite always
// exercises the runtime that ships.
const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
const electronPath = requireFromDesktop("electron") as string;

let app: ElectronApplication;
let electronPid: number | undefined;
// A throwaway directory to "pick" as a project, and an isolated persistence dir.
const projectDir = mkdtempSync(path.join(tmpdir(), "electron-e2e-project-"));
const projectName = path.basename(projectDir);
let validPromptPath: string;
let symlinkPromptPath: string;
let resourceHome: string;

test.beforeAll(async () => {
  if (!existsSync(path.join(WEB_DIST, "index.html"))) {
    execSync("pnpm --filter @agent-deck/web build", { cwd: WORKSPACE_ROOT, stdio: "inherit" });
  }
  // Isolate both app persistence and the Pi resource catalog. The desktop package
  // invokes the workspace's installed pnpm directly, so it does not need the real HOME.
  const dataDir = mkdtempSync(path.join(tmpdir(), "electron-e2e-data-"));
  resourceHome = mkdtempSync(path.join(tmpdir(), "electron-e2e-home-"));
  const agentsDir = path.join(resourceHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "Desktop Loop Agent.md"),
    "---\nname: Desktop Loop Agent\ntools: read, bash, edit\n---\nCreate review evidence.\n",
  );
  const promptsDir = path.join(resourceHome, ".pi", "agent", "prompts");
  mkdirSync(promptsDir, { recursive: true });
  validPromptPath = path.join(promptsDir, "desktop-valid-prompt.md");
  writeFileSync(validPromptPath, "---\ndescription: Desktop valid prompt\n---\nReview this.\n");
  const symlinkTarget = path.join(resourceHome, "prompt-symlink-target.md");
  writeFileSync(symlinkTarget, "---\ndescription: Symlink prompt\n---\nDo not open.\n");
  symlinkPromptPath = path.join(promptsDir, "desktop-symlink-prompt.md");
  symlinkSync(symlinkTarget, symlinkPromptPath, "file");
  execSync("git init -b main", { cwd: projectDir });
  execSync("git config user.email desktop-e2e@example.com", { cwd: projectDir });
  execSync('git config user.name "Desktop E2E"', { cwd: projectDir });
  writeFileSync(path.join(projectDir, "README.md"), "# Desktop E2E\n");
  execSync("git add README.md && git commit -m initial", { cwd: projectDir });
  // Linux CI runs as root, so Electron needs --no-sandbox there. Packaged and
  // local launches retain the sandbox.
  const launchArgs =
    process.env.CI && process.platform === "linux" ? ["--no-sandbox", DESKTOP_DIR] : [DESKTOP_DIR];
  // Keep the Electron-owned server independent from ambient test seams as well
  // as browser harness defaults. The desktop Playwright project has its own
  // worker, but callers can still provide any of these process-wide variables.
  const desktopEnv = { ...process.env };
  for (const key of [
    "AGENT_DECK_TEST",
    "AGENT_DECK_DEFAULT_CWD",
    "AGENT_DECK_DEFAULT_PROVIDER",
    "AGENT_DECK_DEFAULT_MODEL",
    "AGENT_DECK_DEFAULT_EXTENSIONS",
    "AGENT_DECK_PROVIDER_EXTENSIONS",
    "AGENT_DECK_TERMINAL_SHELL",
    "PROMPT",
    "PS1",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    delete desktopEnv[key];
  }
  app = await electron.launch({
    executablePath: electronPath,
    args: launchArgs,
    env: {
      ...desktopEnv,
      HOME: resourceHome,
      USERPROFILE: resourceHome,
      PI_SKIP_VERSION_CHECK: "1",
      // Other specs set this process-level override for their own harnesses.
      // Pin the Electron-owned backend to this app's fixture HOME as well so
      // resource discovery cannot inherit another spec's now-stale catalog.
      AGENT_DECK_PI_ENV: JSON.stringify({
        HOME: resourceHome,
        USERPROFILE: resourceHome,
        PI_SKIP_VERSION_CHECK: "1",
      }),
      AGENT_DECK_DATA_DIR: dataDir,
    },
  });
  electronPid = app.process().pid ?? undefined;

  // A fresh data dir has no projects, so the first-run onboarding modal would
  // cover the UI and intercept clicks. Pre-dismiss it (this suite tests the shell,
  // not onboarding — that has its own web e2e).
  const window = await app.firstWindow();
  await window.addInitScript(() => {
    try {
      localStorage.setItem("agentdeck-onboarding-dismissed", "1");
    } catch {
      // Storage disabled — harmless.
    }
  });
  await window.reload();
});

test.afterAll(async () => {
  // Graceful quit runs the main process's before-quit → server-tree teardown
  // (now synchronous on Windows, so the server tree is reaped before Electron
  // exits). Cap it; only if the graceful quit HANGS do we force-kill the tree.
  const closedGracefully = await Promise.race([
    app
      ?.close()
      .then(() => true)
      .catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  // Only reap when the graceful close timed out (Electron still alive/hung): a
  // tree-kill by the Electron PID after it already exited could hit a reused PID.
  if (!closedGracefully && electronPid) {
    try {
      if (process.platform === "win32") {
        // SIGKILL to the Electron PID does NOT cascade to its spawned child tree
        // (the server via pnpm -> node) on Windows; taskkill /T reaps the whole
        // tree so no orphan keeps the Playwright worker past its teardown deadline.
        execSync(`taskkill /F /T /PID ${electronPid}`, { stdio: "ignore" });
      } else {
        process.kill(electronPid, "SIGKILL");
      }
    } catch {
      // Already gone.
    }
  }
});

test("the desktop shell boots the server and mounts the UI", async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // The sidebar renders → the React bundle served by the in-process server ran.
  await expect(window.getByTestId("nav-projects")).toBeVisible({ timeout: 30_000 });

  // The preload bridge is present → the native folder picker is reachable.
  const bridge = await window.evaluate(
    () =>
      (window as unknown as { agentDeck?: { isElectron?: boolean } }).agentDeck?.isElectron ??
      false,
  );
  expect(bridge).toBe(true);

  // Windows/Linux use the CrunchyMurmur-style integrated title bar while the
  // native window controls remain owned by Electron's titleBarOverlay. macOS
  // instead keeps its native menu bar and traffic-light chrome.
  const platform = await app.evaluate(() => process.platform);
  const titlebar = window.getByTestId("desktop-titlebar");
  await expect(window.getByTestId("sidebar-brand")).toHaveText("AGENTDECK");
  if (platform === "darwin") {
    await expect(titlebar).toHaveCount(0);
  } else {
    await expect(titlebar).toBeVisible();
    const sidebarToggle = window.getByTestId("desktop-sidebar-toggle");
    await expect(sidebarToggle).toHaveAttribute("aria-label", "Hide sidebar");
    await expect(window.getByTestId("desktop-menu-file")).toHaveText("File");
    await expect(window.getByTestId("desktop-menu-edit")).toHaveText("Edit");
    await expect(window.getByTestId("desktop-menu-view")).toHaveText("View");
    await expect(window.getByTestId("desktop-menu-resources")).toHaveText("Resources");
    await expect(window.getByTestId("desktop-menu-git")).toHaveText("Git");
    await expect(window.getByTestId("desktop-menu-help")).toHaveText("Help");

    const chrome = await window.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { querySelector(selector: string): unknown };
        getComputedStyle(
          element: unknown,
          pseudo?: string,
        ): {
          height: string;
          borderTopLeftRadius: string;
          borderTopRightRadius: string;
          backgroundColor: string;
          width: string;
          marginLeft: string;
          minWidth: string;
          overflowX: string;
        };
        agentDeck?: { openAppMenu?: unknown };
      };
      const titlebar = browser.document.querySelector('[data-testid="desktop-titlebar"]');
      const menu = browser.document.querySelector(".desktop-titlebar-menu");
      const workspaceRow = browser.document.querySelector('[data-testid="workspace-row"]');
      const workspace = browser.document.querySelector('[data-testid="workspace-shell"]');
      const sidebar = browser.document.querySelector('[data-testid="sidebar"]');
      const transcript = browser.document.querySelector('[data-testid="transcript"]');
      return {
        titlebarHeight: titlebar ? browser.getComputedStyle(titlebar).height : "",
        workspaceTopLeftRadius: workspace
          ? browser.getComputedStyle(workspace).borderTopLeftRadius
          : "",
        workspaceTopRightRadius: workspace
          ? browser.getComputedStyle(workspace).borderTopRightRadius
          : "",
        workspaceInset: workspace ? browser.getComputedStyle(workspace).marginLeft : "",
        cornerBackgroundMatchesSidebar:
          workspaceRow && sidebar
            ? browser.getComputedStyle(workspaceRow).backgroundColor ===
              browser.getComputedStyle(sidebar).backgroundColor
            : false,
        scrollbarWidth: transcript
          ? browser.getComputedStyle(transcript, "::-webkit-scrollbar").width
          : "",
        menuBridge: typeof browser.agentDeck?.openAppMenu === "function",
        menuMinWidth: menu ? browser.getComputedStyle(menu).minWidth : "",
        menuOverflowX: menu ? browser.getComputedStyle(menu).overflowX : "",
      };
    });
    expect(chrome).toEqual({
      titlebarHeight: "40px",
      workspaceTopLeftRadius: "14px",
      workspaceTopRightRadius: "0px",
      workspaceInset: "0px",
      cornerBackgroundMatchesSidebar: true,
      // Chromium reports overlay scrollbars as zero-width on Linux.
      scrollbarWidth: platform === "linux" ? "0px" : "8px",
      menuBridge: true,
      menuMinWidth: "0px",
      menuOverflowX: "auto",
    });

    // Native menus open at the clicked item's left edge and the titlebar's
    // bottom edge, matching Codex instead of Electron's cursor-position default.
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
      if (!file?.submenu) throw new Error("File menu unavailable");
      const state = globalThis as typeof globalThis & {
        agentDeckPopupAnchor?: { x: number; y: number };
      };
      file.submenu.popup = (options) => {
        state.agentDeckPopupAnchor = { x: options?.x ?? -1, y: options?.y ?? -1 };
      };
    });
    const fileButton = window.getByTestId("desktop-menu-file");
    const fileBounds = await fileButton.boundingBox();
    const titlebarBounds = await titlebar.boundingBox();
    if (!fileBounds || !titlebarBounds) throw new Error("Titlebar bounds unavailable");
    await fileButton.click();
    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            agentDeckPopupAnchor?: { x: number; y: number };
          };
          return state.agentDeckPopupAnchor;
        }),
      )
      .toEqual({
        x: Math.round(fileBounds.x),
        y: Math.round(titlebarBounds.y + titlebarBounds.height),
      });

    // The titlebar icon hides and restores the native-style sidebar. With no
    // sidebar junction, the workspace returns to a square top-left corner.
    await sidebarToggle.click();
    await expect(window.getByTestId("sidebar")).toHaveCount(0);
    await expect(sidebarToggle).toHaveAttribute("aria-label", "Show sidebar");
    await expect(window.getByTestId("workspace-shell")).toHaveCSS("border-top-left-radius", "0px");
    await sidebarToggle.click();
    await expect(window.getByTestId("sidebar")).toBeVisible();
  }

  // The same-origin server the main process spawned answers health checks.
  const health = await window.evaluate(async () => {
    const res = await fetch("/health");
    return res.ok;
  });
  expect(health).toBe(true);
});

test("resource file bridges validate agent/prompt catalogs and reject unsafe identities", async () => {
  const window = await app.firstWindow();
  const catalog = await window.evaluate(async () => {
    const [agentsResponse, promptsResponse] = await Promise.all([
      fetch("/resources/agents"),
      fetch("/resources/prompts"),
    ]);
    return {
      agents: (
        (await agentsResponse.json()) as { agents: Array<{ name: string; filePath: string }> }
      ).agents,
      prompts: (
        (await promptsResponse.json()) as {
          prompts: Array<{ name: string; filePath: string }>;
        }
      ).prompts,
    };
  });
  const agentPath = catalog.agents.find((agent) => agent.name === "Desktop Loop Agent")?.filePath;
  const promptPath = catalog.prompts.find(
    (prompt) => prompt.name === "desktop-valid-prompt",
  )?.filePath;
  const catalogedSymlinkPath = catalog.prompts.find(
    (prompt) => prompt.name === "desktop-symlink-prompt",
  )?.filePath;
  expect(agentPath).toBeTruthy();
  expect(promptPath).toBe(validPromptPath);
  expect(catalogedSymlinkPath).toBe(symlinkPromptPath);

  await app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & {
      openedResourceFiles?: string[];
      revealedResourceFiles?: string[];
    };
    state.openedResourceFiles = [];
    state.revealedResourceFiles = [];
    shell.openPath = async (filePath) => {
      state.openedResourceFiles?.push(filePath);
      return "";
    };
    shell.showItemInFolder = (filePath) => {
      state.revealedResourceFiles?.push(filePath);
    };
  });

  const result = await window.evaluate(
    async ({ agentPath, promptPath, symlinkPath, directoryPath }) => {
      const bridge = (
        globalThis as typeof globalThis & {
          agentDeck?: {
            openResourceFile?(request: unknown): Promise<boolean>;
            revealResourceFile?(request: unknown): Promise<boolean>;
          };
        }
      ).agentDeck;
      if (!bridge?.openResourceFile || !bridge.revealResourceFile || !agentPath || !promptPath) {
        return null;
      }
      const valid: boolean[] = [];
      for (const request of [
        { kind: "agent", projectId: null, filePath: agentPath },
        { kind: "prompt", projectId: null, filePath: promptPath },
      ]) {
        valid.push(await bridge.openResourceFile(request));
        valid.push(await bridge.revealResourceFile(request));
      }
      const rejected: boolean[] = [];
      for (const request of [
        { kind: "prompt", projectId: null, filePath: symlinkPath },
        { kind: "prompt", projectId: null, filePath: `${promptPath}.not-in-catalog` },
        { kind: "prompt", projectId: null, filePath: directoryPath },
        { kind: "prompt", projectId: "not-a-real-project", filePath: promptPath },
        { kind: "prompt", projectId: null },
        { kind: "unknown", projectId: null, filePath: promptPath },
      ]) {
        try {
          await bridge.openResourceFile(request);
          rejected.push(false);
        } catch {
          rejected.push(true);
        }
      }
      return { valid, rejected };
    },
    { agentPath, promptPath, symlinkPath: catalogedSymlinkPath, directoryPath: projectDir },
  );
  expect(result).toEqual({ valid: [true, true, true, true], rejected: Array(6).fill(true) });
  const openedAndRevealed = await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      openedResourceFiles?: string[];
      revealedResourceFiles?: string[];
    };
    return { opened: state.openedResourceFiles, revealed: state.revealedResourceFiles };
  });
  const resolvedValidPaths = [agentPath, promptPath].map((filePath) => realpathSync(filePath!));
  expect(openedAndRevealed).toEqual({
    opened: resolvedValidPaths,
    revealed: resolvedValidPaths,
  });
});

test("Loop reveal bridges accept only backend-owned opaque run ids", async () => {
  const window = await app.firstWindow();
  const result = await window.evaluate(async () => {
    const bridge = (
      globalThis as typeof globalThis & {
        agentDeck?: {
          revealLoopArtifacts?(runId: string): Promise<boolean>;
          revealLoopWorktree?(runId: string): Promise<boolean>;
        };
      }
    ).agentDeck;
    if (!bridge?.revealLoopArtifacts || !bridge.revealLoopWorktree) return "bridge unavailable";
    const messages: string[] = [];
    for (const reveal of [bridge.revealLoopArtifacts, bridge.revealLoopWorktree]) {
      try {
        await reveal("../../arbitrary-path");
        messages.push("unexpected success");
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    return messages;
  });
  expect(result).toEqual([
    expect.stringContaining("Loop run is unavailable"),
    expect.stringContaining("Loop run is unavailable"),
  ]);
});

test("skill Trash bridge rejects arbitrary renderer paths", async () => {
  const window = await app.firstWindow();
  const message = await window.evaluate(async () => {
    const bridge = (
      globalThis as typeof globalThis & {
        agentDeck?: {
          trashSkillRecovery?(
            token: string,
          ): Promise<{ moved: boolean; acknowledgementPending: boolean }>;
        };
      }
    ).agentDeck;
    if (!bridge?.trashSkillRecovery) return "bridge unavailable";
    try {
      await bridge.trashSkillRecovery("../../arbitrary-path");
      return "unexpected success";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain("Skill recovery is unavailable");
});

test("moves a validated skill recovery through Electron OS Trash", async () => {
  const token = ".trash-test.displaced.123.1";
  const recovery = path.join(resourceHome, ".agents", "skills", token);
  mkdirSync(recovery, { recursive: true });
  writeFileSync(
    path.join(recovery, "SKILL.md"),
    "---\nname: trash-test\ndescription: Trash lifecycle\n---\n\nBody.\n",
  );
  const window = await app.firstWindow();
  await window.reload();
  await window.getByTestId("nav-skills").click();
  await expect(window.getByTestId("skill-recovery-trash-test")).toBeVisible();
  await window.getByTestId("skill-recovery-trash-trash-test").click();
  await expect.poll(() => existsSync(recovery)).toBe(false);
  await expect(window.getByTestId("skill-recovery-trash-test")).toHaveCount(0);
});

test("treats OS Trash as successful when backend acknowledgement transport fails", async () => {
  const token = ".ack-fails.displaced.123.2";
  const recovery = path.join(resourceHome, ".agents", "skills", token);
  mkdirSync(recovery, { recursive: true });
  writeFileSync(
    path.join(recovery, "SKILL.md"),
    "---\nname: ack-fails\ndescription: Ack lifecycle\n---\n\nBody.\n",
  );
  await app.evaluate(() => {
    const runtime = globalThis as typeof globalThis & { __originalRecoveryFetch?: typeof fetch };
    runtime.__originalRecoveryFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/acknowledge")) throw new Error("injected ack transport failure");
      return runtime.__originalRecoveryFetch!(input, init);
    };
  });
  try {
    const window = await app.firstWindow();
    await window.reload();
    await window.getByTestId("nav-skills").click();
    await expect(window.getByTestId("skill-recovery-ack-fails")).toBeVisible();
    await window.getByTestId("skill-recovery-trash-ack-fails").click();
    await expect.poll(() => existsSync(recovery)).toBe(false);
    await expect(window.getByTestId("skill-recovery-ack-fails")).toHaveCount(0);
    await expect(window.getByTestId("error-banner")).not.toBeVisible();
  } finally {
    await app.evaluate(() => {
      const runtime = globalThis as typeof globalThis & { __originalRecoveryFetch?: typeof fetch };
      if (runtime.__originalRecoveryFetch) globalThis.fetch = runtime.__originalRecoveryFetch;
      delete runtime.__originalRecoveryFetch;
    });
  }
});

test("adding a project via the native folder picker registers it", async () => {
  const window = await app.firstWindow();
  // Project selection lives in the toolbar picker popover (native), so open it.
  await window.getByTestId("project-picker").click({ timeout: 30_000 });
  await expect(window.getByTestId("add-project")).toBeVisible({ timeout: 30_000 });

  // Stub the OS folder chooser to return our throwaway project directory, so
  // the real preload → ipcMain → dialog → addProject chain runs headlessly.
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
  }, projectDir);

  await window.getByTestId("add-project").click();

  // The picked folder shows up as a registered project; reopen the picker to see it.
  await window.getByTestId("project-picker").click();
  await expect(window.getByTestId(`project-${projectName}`)).toBeVisible({ timeout: 15_000 });

  const runId = await window.evaluate(async (selectedPath) => {
    const projectsResponse = await fetch("/projects");
    const projects = (await projectsResponse.json()) as {
      projects: Array<{ id: string; path: string }>;
    };
    const project = projects.projects.find((candidate) => candidate.path === selectedPath);
    if (!project) throw new Error("desktop test project was not registered");
    const loopResponse = await fetch("/loops", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Desktop Reveal Checkpoint",
        structure: "humanApproval",
        checkpointPrompt: "Verify artifact reveal.",
      }),
    });
    if (!loopResponse.ok) throw new Error(await loopResponse.text());
    const loopsResponse = await fetch("/loops");
    const { loops } = (await loopsResponse.json()) as {
      loops: Array<{ id: string; name: string }>;
    };
    const loop = loops.find((candidate) => candidate.name === "Desktop Reveal Checkpoint");
    if (!loop) throw new Error("desktop reveal Loop was not persisted");
    const runResponse = await fetch(`/loops/${encodeURIComponent(loop.id)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    if (!runResponse.ok) throw new Error(await runResponse.text());
    return ((await runResponse.json()) as { run: { id: string } }).run.id;
  }, projectDir);
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = (revealedPath) => {
      (globalThis as typeof globalThis & { revealedLoopArtifacts?: string }).revealedLoopArtifacts =
        revealedPath;
    };
  });
  const revealed = await window.evaluate(async (id) => {
    const bridge = (
      globalThis as typeof globalThis & {
        agentDeck?: { revealLoopArtifacts?(runId: string): Promise<boolean> };
      }
    ).agentDeck;
    return await bridge?.revealLoopArtifacts?.(id);
  }, runId);
  expect(revealed).toBe(true);
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { revealedLoopArtifacts?: string })
            .revealedLoopArtifacts,
      ),
    )
    .toContain("loop-artifacts");

  const worktreeRunId = await window.evaluate(async (selectedPath) => {
    const { projects } = (await (await fetch("/projects")).json()) as {
      projects: Array<{ id: string; path: string }>;
    };
    const project = projects.find((candidate) => candidate.path === selectedPath);
    if (!project) throw new Error("desktop test project is unavailable");
    const create = await fetch("/loops", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Desktop Retained Review",
        goal: "Retain a review worktree.",
        agentName: "Desktop Loop Agent",
        writeTarget: "newWorktree",
        maxIterations: 1,
      }),
    });
    if (!create.ok) throw new Error(await create.text());
    const { loops } = (await (await fetch("/loops")).json()) as {
      loops: Array<{ id: string; name: string }>;
    };
    const loop = loops.find((candidate) => candidate.name === "Desktop Retained Review");
    if (!loop) throw new Error("desktop retained Loop was not persisted");
    const started = await fetch(`/loops/${encodeURIComponent(loop.id)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    const startBody = (await started.json()) as { run?: { id: string }; error?: string };
    if (!startBody.run) throw new Error(startBody.error ?? "worktree run did not start");
    await fetch(`/loops/runs/${startBody.run.id}/stop`, { method: "POST" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = (await (await fetch(`/loops/runs/${startBody.run.id}`)).json()) as {
        run: { status: string };
      };
      if (!["running", "stopping"].includes(current.run.status)) return startBody.run.id;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("worktree run did not stop");
  }, projectDir);
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = (revealedPath) => {
      (globalThis as typeof globalThis & { revealedLoopWorktree?: string }).revealedLoopWorktree =
        revealedPath;
    };
  });
  const worktreeRevealed = await window.evaluate(async (id) => {
    const bridge = (
      globalThis as typeof globalThis & {
        agentDeck?: { revealLoopWorktree?(runId: string): Promise<boolean> };
      }
    ).agentDeck;
    return await bridge?.revealLoopWorktree?.(id);
  }, worktreeRunId);
  expect(worktreeRevealed).toBe(true);
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { revealedLoopWorktree?: string })
            .revealedLoopWorktree,
      ),
    )
    .toContain("loop-");
});

test("the native File menu exposes New Chat and it creates a session", async () => {
  const window = await app.firstWindow();

  const fileItems = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
    return file?.submenu?.items.map((i) => i.label) ?? [];
  });
  expect(fileItems).toContain("New Chat");
  const helpItems = await app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()?.items.find((i) => i.label === "Help");
    return help?.submenu?.items.map((i) => i.label) ?? [];
  });
  expect(helpItems).toContain("Agent Deck on GitHub");
  expect(helpItems).toContain("About Agent Deck");
  expect(fileItems).toContain("Add Project…");
  // Non-rebindable recovery path into the keybindings editor (the palette's
  // open-chord is itself user-rebindable, so the menu is the reset fallback).
  expect(fileItems).toContain("Edit Keybindings…");

  const sessionCount = () =>
    window.evaluate(async () => {
      const res = await fetch("/sessions");
      const { sessions } = (await res.json()) as { sessions: unknown[] };
      return sessions.length;
    });
  const before = await sessionCount();

  // Trigger the menu item → IPC → renderer newChat() → a new session.
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
    file?.submenu?.items.find((i) => i.label === "New Chat")?.click();
  });
  await expect.poll(sessionCount, { timeout: 10_000 }).toBe(before + 1);
});

test("the View menu exposes question navigation without replacing built-in controls", async () => {
  const window = await app.firstWindow();
  const viewItems = await app.evaluate(({ Menu }) => {
    const viewMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "View");
    return (
      viewMenu?.submenu?.items
        .filter((item) => item.type !== "separator")
        .map((item) => ({ label: item.label, accelerator: item.accelerator ?? null })) ?? []
    );
  });

  expect(viewItems).toEqual(
    expect.arrayContaining([
      { label: "Previous Question", accelerator: null },
      { label: "Next Question", accelerator: null },
      { label: "Reload", accelerator: "CmdOrCtrl+R" },
      { label: "Force Reload", accelerator: "Shift+CmdOrCtrl+R" },
      { label: "Toggle Developer Tools", accelerator: expect.any(String) },
      { label: "Actual Size", accelerator: expect.any(String) },
      { label: "Zoom In", accelerator: expect.any(String) },
      { label: "Zoom Out", accelerator: expect.any(String) },
      { label: "Toggle Full Screen", accelerator: expect.any(String) },
    ]),
  );

  // Give the identity-bound command a current session, then exercise main →
  // preload allowlist → typed renderer listener → shared command.
  await app.evaluate(({ Menu }) => {
    const fileMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
    fileMenu?.submenu?.items.find((item) => item.label === "New Chat")?.click();
  });
  await expect(window.getByTestId("browser-toggle")).toBeVisible({ timeout: 15_000 });
  await app.evaluate(({ Menu }) => {
    const viewMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === "View");
    viewMenu?.submenu?.items.find((item) => item.label === "Previous Question")?.click();
  });
  await expect(window.getByTestId("transcript").getByRole("status")).toHaveText(
    "No previous question.",
  );
});

test("the native Resources menu groups all resource commands without accelerators", async () => {
  const items = await app.evaluate(({ Menu }) => {
    const resources = Menu.getApplicationMenu()?.items.find((item) => item.label === "Resources");
    return (
      resources?.submenu?.items.map((group) => ({
        label: group.label,
        items:
          group.submenu?.items.map((item) => ({
            label: item.label,
            accelerator: item.accelerator ?? null,
          })) ?? [],
      })) ?? []
    );
  });
  expect(items).toEqual([
    {
      label: "Agents",
      items: [
        { label: "New Agent", accelerator: null },
        { label: "Open Selected Agent File", accelerator: null },
        { label: "Reveal Selected Agent", accelerator: null },
        { label: "Enable/Disable Selected Agent", accelerator: null },
      ],
    },
    { label: "Skills", items: [{ label: "Import Skills", accelerator: null }] },
    {
      label: "Prompts",
      items: [
        { label: "New Prompt", accelerator: null },
        { label: "Copy Selected Prompt Invocation", accelerator: null },
        { label: "Open Selected Prompt File", accelerator: null },
        { label: "Reveal Selected Prompt", accelerator: null },
      ],
    },
  ]);

  await app.evaluate(({ Menu }) => {
    const resources = Menu.getApplicationMenu()?.items.find((item) => item.label === "Resources");
    const agents = resources?.submenu?.items.find((item) => item.label === "Agents");
    agents?.submenu?.items.find((item) => item.label === "New Agent")?.click();
  });
  const window = await app.firstWindow();
  await expect(window.getByTestId("agent-editor")).toBeVisible();
  await window.getByTestId("agent-editor").getByRole("button", { name: "Close" }).click();
});

test("the native Git menu routes commands without bypassing disabled actions", async () => {
  const window = await app.firstWindow();

  // Make the gate explicit rather than depending on onboarding state left by
  // earlier desktop tests.
  await window.evaluate(async () => {
    const response = await fetch("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gitAutomation: false }),
    });
    if (!response.ok) throw new Error(await response.text());
  });

  // Git is a top-level menu with semantic actions and no fixed accelerators;
  // clicking routes through preload → useMenuCommands → the shared catalog.
  const gitItems = await app.evaluate(({ Menu }) => {
    const gitMenu = Menu.getApplicationMenu()?.items.find((i) => i.label === "Git");
    return (
      gitMenu?.submenu?.items
        .filter((item) => item.type !== "separator")
        .map((item) => ({ label: item.label, accelerator: item.accelerator ?? null })) ?? []
    );
  });
  expect(gitItems).toEqual([
    { label: "Commit all", accelerator: null },
    { label: "Push branch", accelerator: null },
    { label: "Merge worktree", accelerator: null },
    { label: "Release…", accelerator: null },
  ]);
  await app.evaluate(({ Menu }) => {
    const gitMenu = Menu.getApplicationMenu()?.items.find((i) => i.label === "Git");
    gitMenu?.submenu?.items.find((i) => i.label === "Commit all")?.click();
  });
  await expect(window.getByTestId("git-screen")).toBeVisible();
  // This fixture deliberately leaves gitAutomation disabled. Menu routing must
  // reach GitScreen but cannot bypass that existing preference gate.
  await expect(window.getByTestId("git-actions-off")).toBeVisible();
  await expect(window.getByTestId("git-commit-message")).toHaveCount(0);
});

test("File → Edit Keybindings… opens the editor (palette-independent recovery)", async () => {
  const window = await app.firstWindow();
  const editor = window.getByTestId("keybindings-editor");
  await expect(editor).toHaveCount(0);

  // Fire the native menu item → IPC → renderer opens the editor, with no
  // dependency on the (rebindable) command-palette open-chord.
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
    file?.submenu?.items.find((i) => i.label === "Edit Keybindings…")?.click();
  });
  await expect(editor).toBeVisible();
  await window.getByTestId("keybindings-editor-close").click();
  await expect(editor).toHaveCount(0);
});

test("the browser workspace tab mounts a real <webview> guest and navigates", async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // (a) The host BrowserWindow enables the <webview> tag (else the guest can't
  // instantiate). getLastWebPreferences reflects the constructor webPreferences.
  const webviewTagEnabled = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    // getLastWebPreferences() exists at runtime but is missing from the bundled
    // WebContents type — cast to reach it.
    const wc = win?.webContents as
      | { getLastWebPreferences(): { webviewTag?: boolean } | null }
      | undefined;
    return wc?.getLastWebPreferences()?.webviewTag ?? false;
  });
  expect(webviewTagEnabled).toBe(true);

  // A chat session makes the desktop-only header browser toggle available.
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
    file?.submenu?.items.find((i) => i.label === "New Chat")?.click();
  });
  const browserToggle = window.getByTestId("browser-toggle");
  await expect(browserToggle).toBeVisible({ timeout: 15_000 });

  // (b) Toggling opens the browser tab: the workspace body, a real <webview>
  // guest, and the toolbar (address input + back/forward) are all present.
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toBeVisible();
  await expect(window.getByTestId("browser-url-input")).toBeVisible();
  await expect(window.getByTestId("browser-back")).toBeVisible();
  await expect(window.getByTestId("browser-forward")).toBeVisible();
  // One live guest for the single starting page.
  await expect(window.locator("webview")).toHaveCount(1);

  // (c) Drive a navigation via the address bar to a data: URL (no network in CI)
  // and assert the nav state (title from page-title-updated, url from
  // did-navigate) flows into the panel.
  const dataUrl = "data:text/html,<title>L2%20Browser</title><h1>hi</h1>";
  const input = window.getByTestId("browser-url-input");
  await input.click();
  await input.fill(dataUrl);
  await input.press("Enter");
  await expect(window.getByTestId("browser-page-title")).toHaveText("L2 Browser", {
    timeout: 15_000,
  });
  await expect(input).toHaveValue(/^data:text\/html/);

  // (d) Opening a new internal page-tab yields a SECOND <webview> — the first
  // guest stays mounted (keep-alive), so both live at once.
  await window.getByTestId("browser-new-page").click();
  await expect(window.locator("webview")).toHaveCount(2);

  // Leave the workspace clean for the following tests: close the browser tab.
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toHaveCount(0);
});

test("closing + reopening the browser tab restores the page strip (L4b persist)", async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // A fresh session (browser state is per-session).
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
    file?.submenu?.items.find((i) => i.label === "New Chat")?.click();
  });
  const browserToggle = window.getByTestId("browser-toggle");
  await expect(browserToggle).toBeVisible({ timeout: 15_000 });
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toBeVisible();

  // Navigate page 0 to a data: URL with a known title (no network in CI).
  const dataUrl = "data:text/html,<title>Restored</title><h1>persisted</h1>";
  const input = window.getByTestId("browser-url-input");
  await input.click();
  await input.fill(dataUrl);
  await input.press("Enter");
  await expect(window.getByTestId("browser-page-title")).toHaveText("Restored", {
    timeout: 15_000,
  });

  // Open a SECOND page (two live guests), then re-activate page 0 so it is the
  // active page that a restore brings back to the front.
  await window.getByTestId("browser-new-page").click();
  await expect(window.locator("webview")).toHaveCount(2);
  await window.getByTestId("browser-page-tab").first().click();

  // Close the browser workspace tab — the panel (and both guests) unmount.
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toHaveCount(0);
  await expect(window.locator("webview")).toHaveCount(0);

  // Reopen: the page strip is RESTORED from the store — BOTH pages come back as
  // live guests, and page 0 re-navigates to its stored data: URL (title + URL).
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toBeVisible();
  await expect(window.locator("webview")).toHaveCount(2);
  await expect(window.getByTestId("browser-page-title")).toHaveText("Restored", {
    timeout: 15_000,
  });
  await expect(window.getByTestId("browser-url-input")).toHaveValue(/^data:text\/html/);

  // Clean up.
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toHaveCount(0);
});

test("the browser element picker captures a clicked element as composer context (L3)", async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // A session is required for the pick to attach to a composer, and to expose
  // the header browser toggle.
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "File");
    file?.submenu?.items.find((i) => i.label === "New Chat")?.click();
  });
  const browserToggle = window.getByTestId("browser-toggle");
  await expect(browserToggle).toBeVisible({ timeout: 15_000 });
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toBeVisible();

  // The pick button starts DISABLED on a blank (about:blank) tab — nothing to pick.
  const pick = window.getByTestId("browser-pick");
  await expect(pick).toBeVisible();
  await expect(pick).toBeDisabled();

  // Navigate to a data: URL with a known element (no network in CI).
  const dataUrl = "data:text/html,<title>L3</title><button id=%22go%22>Hi there</button>";
  const input = window.getByTestId("browser-url-input");
  await input.click();
  await input.fill(dataUrl);
  await input.press("Enter");
  await expect(window.getByTestId("browser-page-title")).toHaveText("L3", { timeout: 15_000 });

  // With a navigable page the pick button enables; activating it toggles state.
  await expect(pick).toBeEnabled();
  await pick.click();
  await expect(pick).toHaveAttribute("data-active", "true");

  // Drive the pick from the guest side: dispatch a real capture-phase click on
  // the #go button via the guest webContents (the picker's listener resolves the
  // Promise the renderer is awaiting). Poll until the guest is found + clicked,
  // since the picker script installs asynchronously after pick.click().
  await expect
    .poll(
      async () =>
        app.evaluate(async ({ webContents }) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === "webview" && wc.getURL().startsWith("data:text/html"));
          if (!guest) return false;
          return guest.executeJavaScript(
            `(() => {
               const overlay = document.getElementById("__agentdeck_pick_overlay__");
               const el = document.getElementById("go");
               if (!overlay || !el) return false;
               el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
               return true;
             })()`,
            true,
          );
        }),
      { timeout: 15_000 },
    )
    .toBe(true);

  // The pick resolves → a pending element-context chip appears in the composer,
  // carrying the computed #go selector, and pick mode auto-deactivates.
  const card = window.getByTestId("pending-element-card").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute("data-selector", "#go");
  await expect(pick).toHaveAttribute("data-active", "false");

  // Clean up: remove the chip and close the browser tab.
  await window.getByTestId("pending-element-remove").first().click();
  await browserToggle.click();
  await expect(window.getByTestId("workspace-body-browser")).toHaveCount(0);
});

test("attention events notify + badge while unfocused, and focus clears the badge", async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Install main-process spies (Slice 22a): record setBadgeCount + notification
  // shows, force isFocused()=false so the focus gate lets events through, and
  // force Notification.isSupported()=true. Stubbing Notification.prototype.show
  // works because main.js's `new Notification(...)` shares this exact prototype.
  await app.evaluate(({ app: electronApp, BrowserWindow, Notification }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("no window");
    const g = globalThis as typeof globalThis & {
      agentDeckAttention?: {
        badge: number[];
        notifications: Array<{ title: string; body: string }>;
      };
    };
    g.agentDeckAttention = { badge: [], notifications: [] };
    electronApp.setBadgeCount = (n: number) => {
      g.agentDeckAttention!.badge.push(n);
      return true;
    };
    win.isFocused = () => false;
    Notification.isSupported = () => true;
    (Notification.prototype as unknown as { show: () => void }).show = function (this: {
      title?: string;
      body?: string;
    }) {
      g.agentDeckAttention!.notifications.push({ title: this.title ?? "", body: this.body ?? "" });
    };
    // Re-baseline the counter + recording so a stray startup focus can't skew it.
    win.emit("focus");
    g.agentDeckAttention = { badge: [], notifications: [] };
  });

  const readAttention = () =>
    app.evaluate(() => {
      const g = globalThis as typeof globalThis & {
        agentDeckAttention?: {
          badge: number[];
          notifications: Array<{ title: string; body: string }>;
        };
      };
      return g.agentDeckAttention ?? { badge: [], notifications: [] };
    });

  // Turn complete while unfocused → one notification + badge 1.
  await window.evaluate(() => {
    (
      window as unknown as { agentDeck?: { signalAttention?(p: unknown): void } }
    ).agentDeck?.signalAttention?.({
      kind: "turn-complete",
      title: "My session",
      body: "Turn complete",
    });
  });
  await expect.poll(async () => (await readAttention()).badge.at(-1)).toBe(1);
  {
    const state = await readAttention();
    expect(state.notifications).toContainEqual({ title: "My session", body: "Turn complete" });
  }

  // Approval needed while unfocused → a second notification + badge 2.
  await window.evaluate(() => {
    (
      window as unknown as { agentDeck?: { signalAttention?(p: unknown): void } }
    ).agentDeck?.signalAttention?.({
      kind: "approval-needed",
      title: "My session",
      body: "Run rm -rf build?",
    });
  });
  await expect.poll(async () => (await readAttention()).badge.at(-1)).toBe(2);
  {
    const state = await readAttention();
    expect(state.notifications).toContainEqual({ title: "My session", body: "Run rm -rf build?" });
  }

  // Focusing the window clears the badge (attention "seen").
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.emit("focus");
  });
  await expect.poll(async () => (await readAttention()).badge.at(-1)).toBe(0);

  // A focused window suppresses both notification and badge bump.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.isFocused = () => true;
    const g = globalThis as typeof globalThis & {
      agentDeckAttention?: { badge: number[]; notifications: Array<unknown> };
    };
    g.agentDeckAttention = { badge: [], notifications: [] };
  });
  await window.evaluate(() => {
    (
      window as unknown as { agentDeck?: { signalAttention?(p: unknown): void } }
    ).agentDeck?.signalAttention?.({
      kind: "turn-complete",
      title: "My session",
      body: "Turn complete",
    });
  });
  // Give the fire-and-forget IPC a beat, then assert nothing was recorded.
  await window.waitForTimeout(200);
  {
    const state = await readAttention();
    expect(state.badge).toEqual([]);
    expect(state.notifications).toEqual([]);
  }
});

test("the app presents itself as Agent Deck", async () => {
  const identity = await app.evaluate(({ app: electronApp, Menu }) => ({
    name: electronApp.getName(),
    platform: process.platform,
    firstMenuLabel: Menu.getApplicationMenu()?.items[0]?.label,
  }));
  expect(identity.name).toBe("Agent Deck");
  if (identity.platform === "darwin") expect(identity.firstMenuLabel).toBe("Agent Deck");
});
