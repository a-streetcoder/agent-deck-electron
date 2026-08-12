import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { useEffect, useRef, useState } from "react";
import {
  BellRing,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  GitFork,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import type { SessionMeta } from "@agent-deck/contracts";
import { cn } from "@/lib/cn";
import { sortSessionsByActivity, sortSessionsWithPins } from "@/lib/sessionOrdering";
import { projectDisplayName, sessionDisplayTitle } from "@/lib/sessionTitle";
import { useAppStore } from "../state/store.ts";
import {
  deleteSession,
  forkSession,
  newChat,
  renameSession,
  setSessionPinned,
  switchToSession,
} from "../state/wsBridge.ts";

/**
 * The Coding-Agent sessions panel, ported from the native sidebar
 * (CodingAgentSidebarPanel.swift + CodingAgentPanelLayers in ContentView.swift).
 *
 * Two permanently-mounted layers below the brand title bar:
 *   - the NAV layer (sections + the collapsed sessions card at its bottom),
 *     which recedes (scale .98, y -24, fade) when the panel expands;
 *   - the EXPANDED layer, which fills the whole area below the logo and
 *     slides up to dock there (origin bottom, y +52 → 0, scale .94 → 1).
 * Motion and fade run on separate curves (spring ~420ms / ease-out 220ms);
 * only transform/opacity animate — never layout.
 */

export const PANEL_MOVE = "transform 420ms cubic-bezier(0.32, 1.06, 0.38, 1)";
export const PANEL_FADE = "opacity 220ms ease-out";

function TypingDots() {
  return (
    <span className="flex items-center gap-0.5" data-testid="typing-dots">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/** Native session-row caption (PiAgentSessionListViews.swift:439): abbreviated
 * date + short time of the last activity (updatedAt, falling back to createdAt). */
function formatSessionTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function SessionRow({
  session,
  displayTitle,
  active,
  running,
  detailed = false,
  onSelect,
}: {
  session: SessionMeta;
  displayTitle: string;
  active: boolean;
  running: boolean;
  /** The expanded browsing list shows native's per-row last-active caption. */
  detailed?: boolean;
  onSelect: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title ?? "");
  const rowRef = useRef<HTMLDivElement>(null);
  const pinControlRef = useRef<HTMLButtonElement>(null);

  const commitRename = (): void => {
    const title = draft.trim();
    setRenaming(false);
    if (title && title !== session.title) void renameSession(session.id, title);
  };

  const togglePinned = async (): Promise<void> => {
    await setSessionPinned(session.id, !session.pinnedAt);
    // Pinning can move a deep row to the top (and unpinning can move it back
    // down). Wait for that keyed reorder, then preserve keyboard focus and
    // bring the affected row back into the nearest visible edge.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    pinControlRef.current?.focus({ preventScroll: true });
    rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  if (renaming) {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-2.5 py-1"
        data-testid={`chat-${session.id}`}
      >
        <ControlInput
          autoFocus
          data-testid={`chat-rename-input-${session.id}`}
          className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-label text-text-primary outline-none focus:border-accent"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") setRenaming(false);
          }}
          onBlur={commitRename}
        />
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
        active ? "bg-selection text-text-primary" : "text-text-secondary hover:bg-hover",
        !active &&
          session.endedAt &&
          session.status !== "failed" &&
          session.needsAttention !== true &&
          "opacity-60 saturate-50",
      )}
      data-testid={`chat-${session.id}`}
      data-active={active ? "true" : "false"}
      data-needs-attention={session.needsAttention === true ? "true" : "false"}
      data-status={
        session.status ??
        (session.endedAt ? "ended" : session.parkedAt ? "parked" : running ? "running" : "idle")
      }
      title={session.agentName ? `agent: ${session.agentName}` : undefined}
      aria-label={`${displayTitle}${
        session.status === "failed"
          ? `, failed${session.lastError ? `: ${session.lastError}` : ""}`
          : session.parkedAt
            ? ", Parked; resumes on next command"
            : ""
      }${session.needsAttention === true ? ", needs attention" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate text-label font-medium"
          style={{ fontStretch: "expanded" }}
          data-testid="chat-title"
        >
          {displayTitle}
        </span>
        {session.status === "failed" ? (
          <span
            className="mt-0.5 flex items-center gap-1 truncate text-detail text-danger"
            data-testid="chat-failure-subtitle"
          >
            <CircleAlert size={10} className="shrink-0" aria-hidden="true" />
            <span className="truncate">
              Failed{session.lastError ? ` · ${session.lastError}` : ""}
            </span>
          </span>
        ) : null}
        {session.parkedAt && !session.endedAt && session.status !== "failed" ? (
          <span
            className="mt-0.5 truncate text-detail text-text-muted"
            data-testid={`chat-parked-${session.id}`}
          >
            Parked · resumes on next command
          </span>
        ) : null}
        {session.needsAttention === true ? (
          <span
            className="mt-0.5 flex w-fit max-w-full items-center gap-1 truncate rounded border border-selection-stroke bg-accent-surface px-1.5 py-0.5 text-detail font-semibold text-text-primary"
            data-testid={`chat-attention-${session.id}`}
          >
            <BellRing size={10} className="shrink-0" aria-hidden="true" />
            <span>Needs attention</span>
          </span>
        ) : null}
        {detailed && session.agentName ? (
          <span
            className="flex items-center gap-1 truncate text-detail text-text-muted"
            data-testid="chat-agent-name"
          >
            <Send size={10} className="shrink-0" />
            <span className="truncate">{session.agentName}</span>
          </span>
        ) : null}
        {detailed ? (
          <span className="truncate text-detail text-text-muted" data-testid="chat-timestamp">
            {formatSessionTime(session.updatedAt ?? session.createdAt)}
          </span>
        ) : null}
      </div>
      {running ? <TypingDots /> : null}
      {session.pinnedAt ? (
        <Pin
          size={11}
          className="shrink-0 text-accent"
          aria-label="Pinned"
          data-testid={`chat-pinned-${session.id}`}
        />
      ) : null}
      {/* Hover-reveal actions (native session row). */}
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <ControlButton
          ref={pinControlRef}
          data-testid={`chat-pin-${session.id}`}
          className="rounded p-0.5 text-text-muted hover:text-text-primary"
          title={session.pinnedAt ? "Unpin session" : "Pin session"}
          aria-label={session.pinnedAt ? "Unpin session" : "Pin session"}
          onClick={(event) => {
            event.stopPropagation();
            void togglePinned();
          }}
        >
          {session.pinnedAt ? <PinOff size={12} /> : <Pin size={12} />}
        </ControlButton>
        <ControlButton
          data-testid={`chat-rename-${session.id}`}
          className="rounded p-0.5 text-text-muted hover:text-text-primary"
          title="Rename"
          onClick={(event) => {
            event.stopPropagation();
            setDraft(session.title ?? "");
            setRenaming(true);
          }}
        >
          <Pencil size={12} />
        </ControlButton>
        <ControlButton
          data-testid={`chat-fork-${session.id}`}
          className="rounded p-0.5 text-text-muted enabled:hover:text-text-primary disabled:opacity-30"
          title={session.piSessionFile ? "Duplicate" : "Nothing to duplicate yet"}
          disabled={!session.piSessionFile}
          onClick={(event) => {
            event.stopPropagation();
            void forkSession(session.id);
          }}
        >
          <GitFork size={12} />
        </ControlButton>
        <ControlButton
          data-testid={`chat-delete-${session.id}`}
          className="rounded p-0.5 text-text-muted hover:text-danger"
          title="Delete"
          onClick={(event) => {
            event.stopPropagation();
            if (
              session.worktreePath &&
              !session.loopReviewRunId &&
              !window.confirm(
                "Delete this isolated session? Its worktree and app-owned branch, including any unmerged commits, will be permanently removed.",
              )
            ) {
              return;
            }
            void deleteSession(session.id);
          }}
        >
          <Trash2 size={12} />
        </ControlButton>
      </span>
    </div>
  );
}

function useSessionsData() {
  const sessions = useAppStore((state) => state.sessions);
  const projects = useAppStore((state) => state.projects);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const currentSession = useAppStore((state) => state.session);
  const agentStatus = useAppStore((state) => state.transcript.agentStatus);
  const setView = useAppStore((state) => state.setView);

  // Project section ordering remains activity-based. Pin promotion is applied
  // only inside each project's session list, matching native.
  const byNewest = sortSessionsByActivity(sessions);
  const projectName = (id?: string): string => projectDisplayName(projects, id);

  const pendingAttentionCount = sessions.filter(
    (session) => session.needsAttention === true,
  ).length;
  return {
    byNewest,
    currentProjectId,
    currentSession,
    agentStatus,
    setView,
    projectName,
    pendingAttentionCount,
  };
}

/** Collapsed card — lives at the bottom of the NAV layer. */
export function SessionsCollapsedCard({ onExpand }: { onExpand: () => void }) {
  const {
    byNewest,
    currentProjectId,
    currentSession,
    agentStatus,
    setView,
    projectName,
    pendingAttentionCount,
  } = useSessionsData();
  const currentProjectSessions = sortSessionsWithPins(
    byNewest.filter((s) => (s.projectId ?? null) === currentProjectId),
  );

  return (
    <div className="px-2 pb-2">
      <div className="rounded-2xl border border-border-subtle bg-surface-elevated p-2 shadow-card">
        <div className="flex items-center justify-between px-1.5 pb-1">
          <span
            className="text-xs font-semibold text-text-primary"
            style={{ fontStretch: "expanded" }}
          >
            Sessions
            {pendingAttentionCount > 0 ? (
              <span
                className="ml-1.5 rounded-full bg-accent-surface px-1.5 py-0.5 text-micro text-text-primary"
                data-testid="sessions-attention-count"
                aria-label={`${pendingAttentionCount} sessions across all projects need attention`}
                title="Sessions needing attention across all projects"
              >
                {pendingAttentionCount}
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-1">
            <ControlButton
              data-testid="new-chat"
              className="rounded-capsule p-1 text-text-muted hover:bg-hover hover:text-text-primary"
              title="New chat"
              onClick={() => {
                setView("chat");
                void newChat();
              }}
            >
              <Plus size={14} />
            </ControlButton>
            <ControlButton
              data-testid="sessions-expand"
              className="rounded-capsule p-1 text-text-muted hover:bg-hover hover:text-text-primary"
              title="All sessions"
              onClick={onExpand}
            >
              <ChevronUp size={14} />
            </ControlButton>
          </span>
        </div>
        <div className="space-y-0.5" data-testid="chat-list">
          {currentProjectSessions.slice(0, 5).map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              displayTitle={sessionDisplayTitle(session.title, projectName(session.projectId))}
              active={currentSession?.id === session.id}
              running={currentSession?.id === session.id && agentStatus === "running"}
              onSelect={() => {
                setView("chat");
                void switchToSession(session);
              }}
            />
          ))}
          {currentProjectSessions.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-text-muted">No sessions yet.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Expanded layer — fills the entire area below the brand title bar and
 * slides up to dock there. Rendered as `absolute inset-0` by the sidebar.
 */
export function SessionsExpandedOverlay({
  expanded,
  onCollapse,
}: {
  expanded: boolean;
  onCollapse: () => void;
}) {
  const { byNewest, currentSession, agentStatus, setView, projectName, pendingAttentionCount } =
    useSessionsData();
  const [search, setSearch] = useState("");

  // Search sessions by title OR content (native Sessions search 18.1 "by title
  // or content"). Title is matched client-side over the displayed title (falls
  // back to the project name); content is matched server-side (GET
  // /sessions/search scans each session's pi file), debounced, and unioned in.
  const query = search.trim().toLowerCase();
  const [contentIds, setContentIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!query) {
      setContentIds(new Set());
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void fetch(`/sessions/search?q=${encodeURIComponent(query)}`)
        .then((response) => response.json())
        .then((data: { ids: string[] }) => {
          if (!cancelled) setContentIds(new Set(data.ids));
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  const filtered = query
    ? byNewest.filter(
        (s) =>
          sessionDisplayTitle(s.title, projectName(s.projectId)).toLowerCase().includes(query) ||
          contentIds.has(s.id),
      )
    : byNewest;

  const groups = new Map<string, SessionMeta[]>();
  for (const session of filtered) {
    const key = projectName(session.projectId);
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col px-2 pb-2"
      data-testid="sessions-expanded"
      inert={!expanded}
      aria-hidden={!expanded}
      style={{
        transition: `${PANEL_MOVE}, ${PANEL_FADE}`,
        transformOrigin: "bottom",
        transform: expanded ? "none" : "scale(0.94) translateY(52px)",
        opacity: expanded ? 1 : 0,
        pointerEvents: expanded ? "auto" : "none",
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border-subtle bg-surface-elevated p-2 shadow-elevated">
        <div className="flex items-center justify-between px-1.5 pb-1.5">
          <span
            className="text-xs font-semibold text-text-primary"
            style={{ fontStretch: "expanded" }}
          >
            All sessions
            {pendingAttentionCount > 0 ? (
              <span
                className="ml-1.5 rounded-full bg-accent-surface px-1.5 py-0.5 text-micro text-text-primary"
                data-testid="sessions-expanded-attention-count"
                aria-label={`${pendingAttentionCount} sessions across all projects need attention`}
                title="Sessions needing attention across all projects"
              >
                {pendingAttentionCount}
              </span>
            ) : null}
          </span>
          <ControlButton
            data-testid="sessions-collapse"
            className="rounded-capsule p-1 text-text-muted hover:bg-hover hover:text-text-primary"
            onClick={onCollapse}
          >
            <ChevronDown size={14} />
          </ControlButton>
        </div>
        <ControlInput
          data-testid="sessions-search"
          className="mb-1.5 w-full rounded-lg border border-border-subtle bg-surface px-2.5 py-1 text-xs text-text-primary outline-none focus:border-accent"
          placeholder="Search sessions by title or content…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto" data-testid="sessions-scroll">
          {filtered.length === 0 ? (
            <div
              className="py-6 text-center text-xs text-text-muted"
              data-testid="sessions-search-empty"
            >
              {query ? "No sessions match your search." : "No sessions yet."}
            </div>
          ) : null}
          {[...groups.entries()].map(([group, groupSessions]) => (
            <div key={group}>
              <div className="px-2.5 pb-0.5 pt-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                {group}
              </div>
              <div className="space-y-0.5">
                {sortSessionsWithPins(groupSessions).map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    displayTitle={sessionDisplayTitle(session.title, group)}
                    active={currentSession?.id === session.id}
                    running={currentSession?.id === session.id && agentStatus === "running"}
                    detailed
                    onSelect={() => {
                      // Stay expanded while moving between sessions (native:
                      // selecting a session never collapses the panel).
                      setView("chat");
                      void switchToSession(session);
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
