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
import { useAppStore } from "../state/store.ts";
import { TranscriptDisplayMenu } from "./TranscriptDisplayMenu.tsx";
import { FinalSystemPromptButton } from "./FinalSystemPromptDialog.tsx";

/**
 * Chat-only tool strip. Session name and folder already live on the Sessions
 * card / new-session summary — this bar is just workspace toggles.
 */
export function ChatToolbar() {
  const session = useAppStore((state) => state.session);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const toggleWorkspaceTab = useAppStore((state) => state.toggleWorkspaceTab);
  const openTabs = useAppStore((state) =>
    state.session ? state.workspaceTabs[state.session.id]?.tabs : undefined,
  );
  const checkpointCount = useAppStore((state) => state.checkpoints.length);
  const diffRepo = useAppStore((state) => state.diffRepo);
  const diffFileCount = useAppStore((state) => state.diffFiles.length);
  const macDesktop = isMacDesktop();
  const noDrag = macDesktop ? "[-webkit-app-region:no-drag]" : undefined;

  return (
    <div
      className={cn(
        "flex items-center justify-end border-b border-border-subtle bg-surface-elevated px-4 py-1.5",
        macDesktop && "[-webkit-app-region:drag]",
      )}
      data-testid="chat-toolbar"
    >
      {session ? (
        <span className="sr-only" data-testid="session-cwd">
          {session.cwd}
        </span>
      ) : null}
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
