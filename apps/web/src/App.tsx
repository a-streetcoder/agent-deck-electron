import { useEffect, useState } from "react";
import {
  coerceTranscriptVisibility,
  DEFAULT_TRANSCRIPT_VISIBILITY,
  type KeybindingBinding,
} from "@agent-deck/contracts";
import { Composer } from "./components/Composer.tsx";
import { AppTitleBar } from "./components/AppTitleBar.tsx";
import { ChatToolbar } from "./components/ChatToolbar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { KeybindingsEditor } from "./components/KeybindingsEditor.tsx";
import { DeckPanel } from "./components/DeckPanel.tsx";
import { OnboardingOverlay } from "./components/OnboardingOverlay.tsx";
import { TabbedPane } from "./components/workspace/TabbedPane.tsx";
import { ResizeHandle, useResizable } from "./components/common/Resizable.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TerminalDrawer } from "./components/TerminalDrawer.tsx";
import { Toaster } from "./components/Toaster.tsx";
import { Transcript } from "./components/Transcript.tsx";
import { PiAgentProcessingIndicatorBar } from "@/components/transcript/PiAgentProcessingIndicatorBar";
import { AgentsScreen } from "./screens/AgentsScreen.tsx";
import { ExtensionsScreen } from "./screens/ExtensionsScreen.tsx";
import { InstructionsScreen } from "./screens/InstructionsScreen.tsx";
import { IssuesScreen } from "./screens/IssuesScreen.tsx";
import { McpScreen } from "./screens/McpScreen.tsx";
import { MemoryScreen } from "./screens/MemoryScreen.tsx";
import { ModelsScreen } from "./screens/ModelsScreen.tsx";
import { PerformanceScreen } from "./screens/PerformanceScreen.tsx";
import { GitScreen } from "./screens/GitScreen.tsx";
import { LoopsScreen } from "./screens/LoopsScreen.tsx";
import { ProjectsScreen } from "./screens/ProjectsScreen.tsx";
import { PromptsScreen } from "./screens/PromptsScreen.tsx";
import { ProvidersScreen } from "./screens/ProvidersScreen.tsx";
import { DoctorScreen, EnvironmentScreen } from "./screens/RuntimeScreens.tsx";
import { SkillsScreen } from "./screens/SkillsScreen.tsx";
import { cn } from "@/lib/cn";
import { hasIntegratedDesktopChrome } from "@/lib/native";
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

function ChatColumn() {
  const agentStatus = useAppStore((state) => state.transcript.agentStatus);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <ChatToolbar />
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
  const session = useAppStore((state) => state.session);
  const agentStatus = useAppStore((state) => state.transcript.agentStatus);
  const error = useAppStore((state) => state.error);
  const attentionAnnouncement = useAppStore((state) => state.attentionAnnouncement);
  const view = useAppStore((state) => state.view);
  const isChat = view === "chat";
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
  const integratedDesktopChrome = hasIntegratedDesktopChrome();

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
            "flex min-w-0 flex-1 flex-col overflow-hidden bg-surface",
          )}
          data-testid="workspace-shell"
        >
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
                ) : view === "performance" ? (
                  <PerformanceScreen />
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
