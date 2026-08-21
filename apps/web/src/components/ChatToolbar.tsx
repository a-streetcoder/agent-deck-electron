import { ControlButton } from "@/design-system/components/NativeControls";
import {
  FolderTree,
  GitCompareArrows,
  Globe,
  History,
  MonitorPlay,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { isElectron, isMacDesktop } from "@/lib/native";
import { projectDisplayName, sessionDisplayTitle } from "@/lib/sessionTitle";
import { useAppStore } from "../state/store.ts";
import { TranscriptDisplayMenu } from "./TranscriptDisplayMenu.tsx";
import { FinalSystemPromptButton } from "./FinalSystemPromptDialog.tsx";

/**
 * Compact chat-only toolbar: session title, cwd, and the workspace tool toggles
 * that used to live in the workspace header.
 */
export function ChatToolbar() {
  const view = useAppStore((state) => state.view);
  const session = useAppStore((state) => state.session);
  const projects = useAppStore((state) => state.projects);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const toggleWorkspaceTab = useAppStore((state) => state.toggleWorkspaceTab);
  const openTabs = useAppStore((state) =>
    state.session ? state.workspaceTabs[state.session.id]?.tabs : undefined,
  );
  const checkpointCount = useAppStore((state) => state.checkpoints.length);
  const diffRepo = useAppStore((state) => state.diffRepo);
  const diffFileCount = useAppStore((state) => state.diffFiles.length);
  const isChat = view === "chat";
  const chatTitle = session
    ? sessionDisplayTitle(session.title, projectDisplayName(projects, session.projectId))
    : "Pi Agent";
  const macDesktop = isMacDesktop();
  const noDrag = macDesktop ? "[-webkit-app-region:no-drag]" : undefined;

  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-border-subtle bg-surface-elevated px-4 py-1.5",
        macDesktop && "[-webkit-app-region:drag]",
      )}
      data-testid="chat-toolbar"
    >
      <div className="flex min-w-0 items-center gap-3">
        <h1
          className="min-w-0 truncate text-sm font-semibold text-text-primary"
          style={{ fontStretch: "expanded" }}
          data-testid={isChat ? "app-view-title" : undefined}
        >
          {chatTitle}
        </h1>
        {session ? (
          <span
            className="max-w-[40ch] truncate font-mono text-xs text-text-muted"
            data-testid="session-cwd"
          >
            {session.cwd}
          </span>
        ) : null}
      </div>
      <div className={cn("flex shrink-0 items-center gap-1.5", noDrag)}>
        {session ? <FinalSystemPromptButton /> : null}
        <TranscriptDisplayMenu />
        {session ? (
          <ControlButton
            type="button"
            className={cn(
              "rounded-md p-1.5 transition-colors hover:bg-hover",
              openTabs?.includes("files") ? "text-accent" : "text-text-muted",
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
        {session ? (
          <ControlButton
            type="button"
            className={cn(
              "rounded-md p-1.5 transition-colors hover:bg-hover",
              openTabs?.includes("preview") ? "text-accent" : "text-text-muted",
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
        {session && diffRepo ? (
          <ControlButton
            type="button"
            className={cn(
              "relative rounded-md p-1.5 transition-colors hover:bg-hover",
              openTabs?.includes("diff") ? "text-accent" : "text-text-muted",
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
        {session ? (
          <ControlButton
            type="button"
            className={cn(
              "relative rounded-md p-1.5 transition-colors hover:bg-hover",
              openTabs?.includes("checkpoints") ? "text-accent" : "text-text-muted",
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
        {session && isElectron() ? (
          <ControlButton
            type="button"
            className={cn(
              "rounded-md p-1.5 transition-colors hover:bg-hover",
              openTabs?.includes("browser") ? "text-accent" : "text-text-muted",
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
        {session ? (
          <ControlButton
            type="button"
            className={cn(
              "rounded-md p-1.5 transition-colors hover:bg-hover",
              terminalOpen ? "text-accent" : "text-text-muted",
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
      </div>
    </div>
  );
}
