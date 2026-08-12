import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect, useState } from "react";
import {
  FolderTree,
  GitCompareArrows,
  Globe,
  History,
  MonitorPlay,
  SquareTerminal,
} from "lucide-react";
import {
  coerceTranscriptVisibility,
  DEFAULT_TRANSCRIPT_VISIBILITY,
  type KeybindingBinding,
} from "@agent-deck/contracts";
import { Composer } from "./components/Composer.tsx";
import { AppTitleBar } from "./components/AppTitleBar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { KeybindingsEditor } from "./components/KeybindingsEditor.tsx";
import { DeckPanel } from "./components/DeckPanel.tsx";
import { OnboardingOverlay } from "./components/OnboardingOverlay.tsx";
import { ProjectPicker } from "./components/ProjectPicker.tsx";
import { TabbedPane } from "./components/workspace/TabbedPane.tsx";
import { ResizeHandle, useResizable } from "./components/common/Resizable.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TerminalDrawer } from "./components/TerminalDrawer.tsx";
import { Toaster } from "./components/Toaster.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { TranscriptDisplayMenu } from "./components/TranscriptDisplayMenu.tsx";
import { FinalSystemPromptButton } from "./components/FinalSystemPromptDialog.tsx";
import { PiAgentProcessingIndicatorBar } from "@/components/transcript/PiAgentProcessingIndicatorBar";
import { AgentsScreen } from "./screens/AgentsScreen.tsx";
import { ExtensionsScreen } from "./screens/ExtensionsScreen.tsx";
import { InstructionsScreen } from "./screens/InstructionsScreen.tsx";
import { IssuesScreen } from "./screens/IssuesScreen.tsx";
import { McpScreen } from "./screens/McpScreen.tsx";
import { MemoryScreen } from "./screens/MemoryScreen.tsx";
import { ModelsScreen } from "./screens/ModelsScreen.tsx";
import { GitScreen } from "./screens/GitScreen.tsx";
import { LoopsScreen } from "./screens/LoopsScreen.tsx";
import { ProjectsScreen } from "./screens/ProjectsScreen.tsx";
import { PromptsScreen } from "./screens/PromptsScreen.tsx";
import { ProvidersScreen } from "./screens/ProvidersScreen.tsx";
import { DoctorScreen, EnvironmentScreen } from "./screens/RuntimeScreens.tsx";
import { SkillsScreen } from "./screens/SkillsScreen.tsx";
import { cn } from "@/lib/cn";
import { hasIntegratedDesktopChrome, isElectron, isMacDesktop } from "@/lib/native";
import { projectDisplayName, sessionDisplayTitle } from "@/lib/sessionTitle";
import { selectedSessionStatus } from "@/lib/sessionStatus";
import { refreshCheckpoints } from "./state/wsBridge.ts";
import { useAppStore } from "./state/store.ts";
import { useKeyboardShortcuts } from "./state/useKeyboardShortcuts.ts";
import { useMenuCommands } from "./state/useMenuCommands.ts";
import { useDesktopAttention } from "./state/useDesktopAttention.ts";
import { useNotificationRouting } from "./state/useNotificationRouting.ts";

/**
 * Detail routing mirrors the native ContentView: the chat surface stays
 * PERMANENTLY MOUNTED and is shown/hidden purely via opacity + a whisper of
 * scale (SidebarTransition spring ≈ 340ms), so returning to it is instant and
 * streaming state never tears down. Other screens mount on demand and slide
 * in on the same curve.
 */
const DETAIL_MOVE = "transform 340ms cubic-bezier(0.3, 1.04, 0.4, 1)";
const DETAIL_FADE = "opacity 200ms ease-out";

const VIEW_TITLES: Record<string, string> = {
  agents: "Agents",
  skills: "Skills",
  projects: "Projects",
  instructions: "Instructions",
  issues: "Issues",
  git: "Git",
  loops: "Loops",
  prompts: "Prompts",
  models: "Models",
  extensions: "Extensions",
  environment: "Environment",
  providers: "Providers",
  memory: "Memory",
  mcp: "MCP",
  doctor: "Doctor",
};

function ChatColumn() {
  const agentStatus = useAppStore((state) => state.transcript.agentStatus);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Transcript />
          <PiAgentProcessingIndicatorBar
            message={agentStatus === "running" ? "Pi is working…" : null}
            className="px-6"
          />
          <Composer />
        </div>
        <DeckPanel />
        {/* The single right-side workspace pane (Slice L1): a Chrome-style tab
            strip + one tool body. The diff / files / preview / checkpoints tools
            open as TABS here instead of four side-by-side asides; renders null
            when the current session has no open tab. The DeckPanel (above) stays
            its own auto aside and the terminal (below) stays the bottom drawer. */}
        <TabbedPane />
      </div>
      {/* The per-session terminal drawer (Slice 8b) spans the full chat surface
          bottom, like the donor's thread drawer. Renders null while closed. */}
      <TerminalDrawer />
    </div>
  );
}

export function App() {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  // The left sidebar is drag-resizable (Slice L4a), persisted + clamped.
  const sidebar = useResizable({
    storageKey: "agentdeck:sidebar-width",
    defaultWidth: 280,
    min: 200,
    max: 460,
    edge: "right",
  });
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const toggleWorkspaceTab = useAppStore((state) => state.toggleWorkspaceTab);
  const openTabs = useAppStore((state) =>
    state.session ? state.workspaceTabs[state.session.id]?.tabs : undefined,
  );
  const checkpointCount = useAppStore((state) => state.checkpoints.length);
  const diffRepo = useAppStore((state) => state.diffRepo);
  const diffFileCount = useAppStore((state) => state.diffFiles.length);
  const connection = useAppStore((state) => state.connection);
  const agentStatus = useAppStore((state) => state.transcript.agentStatus);
  const session = useAppStore((state) => state.session);
  const projects = useAppStore((state) => state.projects);
  const error = useAppStore((state) => state.error);
  const attentionAnnouncement = useAppStore((state) => state.attentionAnnouncement);
  const view = useAppStore((state) => state.view);
  const isChat = view === "chat";
  const chatTitle = session
    ? sessionDisplayTitle(session.title, projectDisplayName(projects, session.projectId))
    : "Pi Agent";
  const setKeybindings = useAppStore((state) => state.setKeybindings);
  const setTranscriptVisibility = useAppStore((state) => state.setTranscriptVisibility);
  const setTranscriptVisibilityLoaded = useAppStore((state) => state.setTranscriptVisibilityLoaded);
  const setTranscriptVisibilityLoadError = useAppStore(
    (state) => state.setTranscriptVisibilityLoadError,
  );
  useMenuCommands();
  useKeyboardShortcuts();
  // Slice 22a: forward turn-complete / approval-needed transitions on the active
  // session to the Electron shell (native notification + taskbar/dock badge).
  useDesktopAttention();
  // A native notification click selects its originating chat and restores the
  // chat surface through the same race-guarded activation path as the sidebar.
  useNotificationRouting();
  // Seed the user's keybinding overrides once on boot so the global handler and
  // the palette resolve chords against the persisted map (Slice 14). The editor
  // keeps the store in sync thereafter.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    void fetch("/settings", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            settings?: {
              keybindings?: KeybindingBinding[];
              piAgentTranscriptVisibility?: unknown;
            };
          } | null,
        ) => {
          if (!data) throw new Error("Settings request failed");
          if (!active) return;
          if (data?.settings?.keybindings) setKeybindings(data.settings.keybindings);
          setTranscriptVisibility(
            coerceTranscriptVisibility(data.settings?.piAgentTranscriptVisibility),
          );
          setTranscriptVisibilityLoadError(null);
          setTranscriptVisibilityLoaded(true);
        },
      )
      .catch(() => {
        if (!active) return;
        // Keep the safe, all-visible defaults usable and let the display menu retry.
        setTranscriptVisibility({ ...DEFAULT_TRANSCRIPT_VISIBILITY });
        setTranscriptVisibilityLoadError("Transcript preferences could not be loaded.");
        setTranscriptVisibilityLoaded(true);
      })
      .finally(() => {
        window.clearTimeout(timeout);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    setKeybindings,
    setTranscriptVisibility,
    setTranscriptVisibilityLoaded,
    setTranscriptVisibilityLoadError,
  ]);
  // Slice 18b: refresh the checkpoint timeline whenever a turn settles back to
  // idle (a new checkpoint was captured) for the current session. The subscribe
  // path seeds the first list; this keeps it live turn-over-turn (and drives the
  // header's available-checkpoints indicator) without a dedicated push.
  useEffect(() => {
    if (session && agentStatus !== "running") void refreshCheckpoints(session.id);
  }, [session, agentStatus]);
  // The frameless macOS window needs a drag region across the top bar so the
  // window can be moved by its header (the sidebar strip is already draggable).
  const macDesktop = isMacDesktop();
  const integratedDesktopChrome = hasIntegratedDesktopChrome();

  // Live transport/activity outrank durable terminal metadata. `agent_end`
  // changes only transcript activity and must not erase a persisted failure.
  const statusLabel = selectedSessionStatus(connection, agentStatus, session?.status);
  const statusColor =
    connection !== "open"
      ? "var(--color-warning)"
      : agentStatus === "running"
        ? "var(--color-brand-accent)"
        : session?.status === "failed"
          ? "var(--color-danger)"
          : "var(--color-success)";

  return (
    <div className="flex h-full flex-col">
      <AppTitleBar
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
      />
      <div
        className={cn(
          "relative flex min-h-0 flex-1",
          integratedDesktopChrome && "bg-surface-elevated",
        )}
        data-testid="workspace-row"
      >
        <OnboardingOverlay />
        {sidebarVisible ? (
          <>
            <Sidebar width={sidebar.width} />
            <ResizeHandle
              handleProps={sidebar.handleProps}
              isDragging={sidebar.isDragging}
              testId="sidebar-resize"
              ariaLabel="Resize sidebar"
              width={sidebar.width}
              min={sidebar.min}
              max={sidebar.max}
            />
          </>
        ) : null}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            integratedDesktopChrome &&
              sidebarVisible &&
              "overflow-hidden rounded-tl-[14px] border-l border-t border-border-strong bg-surface shadow-card",
            integratedDesktopChrome &&
              !sidebarVisible &&
              "overflow-hidden border-t border-border-strong bg-surface",
          )}
          data-testid="workspace-shell"
        >
          <header
            className={cn(
              "flex items-center justify-between border-b border-border-subtle bg-surface-elevated px-6 py-2.5",
              macDesktop && "[-webkit-app-region:drag]",
            )}
          >
            <div className="flex items-center gap-3">
              <ProjectPicker />
              <div className="h-4 w-px bg-border-subtle" />
              <h1
                className="text-sm font-semibold text-text-primary"
                style={{ fontStretch: "expanded" }}
                data-testid="app-view-title"
              >
                {isChat ? chatTitle : VIEW_TITLES[view]}
              </h1>
              {session && isChat ? (
                <span
                  className="max-w-[40ch] truncate font-mono text-xs text-text-muted"
                  data-testid="session-cwd"
                >
                  {session.cwd}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              {session && isChat ? <FinalSystemPromptButton /> : null}
              {isChat ? <TranscriptDisplayMenu /> : null}
              {/* Files toggle (Slice 13b): a lazy project-tree browser +
                  read-only preview. Ungated by git — shown for any chat
                  session (it browses the session cwd). */}
              {session && isChat ? (
                <ControlButton
                  type="button"
                  className={cn(
                    "rounded-md p-1.5 transition-colors hover:bg-hover",
                    openTabs?.includes("files") ? "text-accent" : "text-text-muted",
                    macDesktop && "[-webkit-app-region:no-drag]",
                  )}
                  title="Toggle files"
                  aria-label="Toggle files"
                  aria-pressed={openTabs?.includes("files") ?? false}
                  data-testid="files-toggle"
                  onClick={() => toggleWorkspaceTab(session.id, "files")}
                >
                  <FolderTree className="h-4 w-4" />
                </ControlButton>
              ) : null}
              {/* Preview toggle (Slice 15b): runs project dev scripts and embeds
                  the discovered dev-server URL. Ungated by git — shown for any
                  chat session (it browses the session's package.json scripts). */}
              {session && isChat ? (
                <ControlButton
                  type="button"
                  className={cn(
                    "rounded-md p-1.5 transition-colors hover:bg-hover",
                    openTabs?.includes("preview") ? "text-accent" : "text-text-muted",
                    macDesktop && "[-webkit-app-region:no-drag]",
                  )}
                  title="Toggle preview"
                  aria-label="Toggle preview"
                  aria-pressed={openTabs?.includes("preview") ?? false}
                  data-testid="preview-toggle"
                  onClick={() => toggleWorkspaceTab(session.id, "preview")}
                >
                  <MonitorPlay className="h-4 w-4" />
                </ControlButton>
              ) : null}
              {/* Changed-files toggle (Slice 10): only for git-repo sessions
                  (repo:false keeps the whole surface hidden); the badge tracks
                  the server-refreshed changed-file count live. */}
              {session && isChat && diffRepo ? (
                <ControlButton
                  type="button"
                  className={cn(
                    "relative rounded-md p-1.5 transition-colors hover:bg-hover",
                    openTabs?.includes("diff") ? "text-accent" : "text-text-muted",
                    macDesktop && "[-webkit-app-region:no-drag]",
                  )}
                  title="Toggle changed files"
                  aria-label="Toggle changed files"
                  aria-pressed={openTabs?.includes("diff") ?? false}
                  data-testid="diff-toggle"
                  onClick={() => toggleWorkspaceTab(session.id, "diff")}
                >
                  <GitCompareArrows className="h-4 w-4" />
                  {diffFileCount > 0 ? (
                    <span
                      className="absolute -right-0.5 -top-0.5 rounded-capsule bg-accent px-1 text-overline font-semibold leading-[14px] text-on-accent"
                      data-testid="diff-badge"
                    >
                      {diffFileCount}
                    </span>
                  ) : null}
                </ControlButton>
              ) : null}
              {/* Checkpoints toggle (Slice 18b): a per-turn rewind timeline.
                  Ungated (every session captures per turn); the badge tracks the
                  available-checkpoint count so a session with none shows nothing
                  extra, one with captures shows a subtle indicator. */}
              {session && isChat ? (
                <ControlButton
                  type="button"
                  className={cn(
                    "relative rounded-md p-1.5 transition-colors hover:bg-hover",
                    openTabs?.includes("checkpoints") ? "text-accent" : "text-text-muted",
                    macDesktop && "[-webkit-app-region:no-drag]",
                  )}
                  title="Toggle checkpoints"
                  aria-label="Toggle checkpoints"
                  aria-pressed={openTabs?.includes("checkpoints") ?? false}
                  data-testid="checkpoints-toggle"
                  onClick={() => toggleWorkspaceTab(session.id, "checkpoints")}
                >
                  <History className="h-4 w-4" />
                  {checkpointCount > 0 ? (
                    <span
                      className="absolute -right-0.5 -top-0.5 rounded-capsule bg-accent px-1 text-overline font-semibold leading-[14px] text-on-accent"
                      data-testid="checkpoints-badge"
                    >
                      {checkpointCount}
                    </span>
                  ) : null}
                </ControlButton>
              ) : null}
              {/* Browser toggle (Slice L2): a real general-purpose Chromium guest
                  (<webview>) as a workspace tab. Desktop-only — the <webview> tag
                  only instantiates in the Electron shell, so the header button is
                  never rendered in the web build (the "+" menu still lists it, but
                  disabled with an "Available in the desktop app." reason). */}
              {session && isChat && isElectron() ? (
                <ControlButton
                  type="button"
                  className={cn(
                    "rounded-md p-1.5 transition-colors hover:bg-hover",
                    openTabs?.includes("browser") ? "text-accent" : "text-text-muted",
                    macDesktop && "[-webkit-app-region:no-drag]",
                  )}
                  title="Toggle browser"
                  aria-label="Toggle browser"
                  aria-pressed={openTabs?.includes("browser") ?? false}
                  data-testid="browser-toggle"
                  onClick={() => toggleWorkspaceTab(session.id, "browser")}
                >
                  <Globe className="h-4 w-4" />
                </ControlButton>
              ) : null}
              {session && isChat ? (
                <ControlButton
                  type="button"
                  className={cn(
                    "rounded-md p-1.5 transition-colors hover:bg-hover",
                    terminalOpen ? "text-accent" : "text-text-muted",
                    macDesktop && "[-webkit-app-region:no-drag]",
                  )}
                  title="Toggle terminal (⌘`)"
                  aria-label="Toggle terminal"
                  aria-pressed={terminalOpen}
                  data-testid="terminal-toggle"
                  onClick={() => setTerminalOpen(!terminalOpen)}
                >
                  <SquareTerminal className="h-4 w-4" />
                </ControlButton>
              ) : null}
              <div
                className="flex items-center gap-2"
                data-testid="status-indicator"
                data-status={statusLabel}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: statusColor }}
                />
                <span className="text-sm text-text-secondary">{statusLabel}</span>
              </div>
            </div>
          </header>
          {error ? (
            <div
              className="max-w-full break-words bg-danger-subtle px-6 py-2 text-sm text-danger [overflow-wrap:anywhere]"
              data-testid="error-banner"
              role="alert"
              aria-live="assertive"
            >
              {error}
            </div>
          ) : null}

          <main className="relative min-h-0 flex-1">
            {/* Chat layer: always mounted. */}
            <div
              className="absolute inset-0"
              data-testid="chat-layer"
              inert={!isChat}
              aria-hidden={!isChat}
              style={{
                transition: `${DETAIL_MOVE}, ${DETAIL_FADE}`,
                transform: isChat ? "none" : "scale(0.985)",
                opacity: isChat ? 1 : 0,
                pointerEvents: isChat ? "auto" : "none",
              }}
            >
              <ChatColumn />
            </div>

            {/* Other screens: mount on demand, slide in on the same curve. */}
            {!isChat ? (
              <div className="detail-enter absolute inset-0 flex flex-col overflow-hidden">
                {view === "agents" ? (
                  <AgentsScreen />
                ) : view === "skills" ? (
                  <SkillsScreen />
                ) : view === "projects" ? (
                  <ProjectsScreen />
                ) : view === "instructions" ? (
                  <InstructionsScreen />
                ) : view === "issues" ? (
                  <IssuesScreen />
                ) : view === "git" ? (
                  <GitScreen />
                ) : view === "loops" ? (
                  <LoopsScreen />
                ) : view === "prompts" ? (
                  <PromptsScreen />
                ) : view === "models" ? (
                  <ModelsScreen />
                ) : view === "extensions" ? (
                  <ExtensionsScreen />
                ) : view === "environment" ? (
                  <EnvironmentScreen />
                ) : view === "providers" ? (
                  <ProvidersScreen />
                ) : view === "memory" ? (
                  <MemoryScreen />
                ) : view === "mcp" ? (
                  <McpScreen />
                ) : (
                  <DoctorScreen />
                )}
              </div>
            ) : null}
          </main>
        </div>
      </div>
      <CommandPalette />
      <KeybindingsEditor />
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="attention-announcer"
      >
        {attentionAnnouncement ? (
          <span key={attentionAnnouncement.id}>{attentionAnnouncement.text}</span>
        ) : null}
      </div>
      <Toaster />
    </div>
  );
}
