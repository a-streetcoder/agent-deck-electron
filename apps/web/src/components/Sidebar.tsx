import { ControlButton } from "@/design-system/components/NativeControls";
import {
  Brain,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Cloud,
  Cpu,
  FileText,
  Folder,
  GitBranch,
  Gauge,
  Key,
  MessageSquareText,
  Repeat,
  Plug,
  Palette,
  Send,
  Server,
  ShieldCheck,
  Stethoscope,
  User,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { sectionHeaderClass } from "@/design-system/styles";
import { cn } from "@/lib/cn";
import { isMacDesktop, teamServer } from "@/lib/native";
import { userDisplayName, userInitials } from "@/lib/userIdentity";
import { useAppStore, type AppView, type CurrentUser } from "../state/store.ts";
import { PANEL_FADE, PANEL_MOVE, SessionsMainPanel } from "./SessionsPanel.tsx";
import { TeamServerIndicator } from "./TeamServerIndicator.tsx";

/**
 * Sidebar structure: pixel-font brand title bar, then two layers. UI-01
 * deliberately inverts the native sidebar (SidebarViews.swift): the sessions
 * panel is the main layer, always in view, with the collapsed "Orchestrate"
 * card (title + user row) pinned at its bottom; the card slides the sectioned
 * nav (icon + label, accent icon when selected) up as a pull-up. When it
 * expands, the sessions layer recedes (scale .98, y -24, fade) with the
 * native CodingAgentPanelLayers motion.
 */

// No "Pi Agent" row: the pi-agent chat isn't a nav destination — it's the
// detail screen you reach by selecting (or starting) a session in the sessions
// panel, like the native sidebar (which excludes .agent).
const WORKSPACE_NAV: Array<{ id: AppView; label: string; icon: typeof Send }> = [
  { id: "projects", label: "Projects", icon: Folder },
  { id: "instructions", label: "Instructions", icon: FileText },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "agents", label: "Agents", icon: Send },
  { id: "skills", label: "Skills", icon: WandSparkles },
  { id: "loops", label: "Loops", icon: Repeat },
  { id: "prompts", label: "Prompts", icon: MessageSquareText },
  { id: "memory", label: "Memory", icon: Brain },
];

const RUNTIME_NAV: Array<{ id: AppView; label: string; icon: typeof Send }> = [
  { id: "themes", label: "Themes", icon: Palette },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "team-server", label: "Team server", icon: Cloud },
  { id: "models", label: "Models", icon: Cpu },
  { id: "providers", label: "Providers", icon: ShieldCheck },
  { id: "environment", label: "Environment", icon: Key },
  { id: "extensions", label: "Extensions", icon: Plug },
  { id: "mcp", label: "MCP", icon: Server },
  { id: "doctor", label: "Doctor", icon: Stethoscope },
];

/** Display name + initials for the user row. No name until /me has answered
 * (avoids a "Local" flash on the shared server); "Local" once it says loopback
 * or when `me` has neither a name nor an email (never the raw id). */
function userRowLabel(
  me: CurrentUser | null,
  meKnown: boolean,
): { name: string | null; initials: string | null } {
  if (!me && !meKnown) return { name: null, initials: null };
  if (!me || (!me.name?.trim() && !me.email)) return { name: "Local", initials: null };
  const identity = { id: me.email, name: me.name };
  return { name: userDisplayName(identity), initials: userInitials(identity) };
}

/** Collapsed Orchestrate card — pinned at the bottom of the sessions layer. */
export function OrchestrateCollapsedCard({
  onExpand,
  openerRef,
}: {
  onExpand: () => void;
  openerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const me = useAppStore((state) => state.me);
  const meKnown = useAppStore((state) => state.meKnown);
  const { name, initials } = userRowLabel(me, meKnown);
  return (
    <div className="px-2 pb-2">
      <ControlButton
        ref={openerRef}
        data-testid="orchestrate-expand"
        className="w-full rounded-2xl border border-border-subtle bg-surface-elevated p-2 text-left shadow-card hover:bg-hover"
        onClick={onExpand}
      >
        <span className="flex items-center justify-between gap-1 px-1.5 pb-1">
          <span className="text-detail font-semibold text-text-primary">Orchestrate</span>
          <ChevronUp size={14} className="text-text-muted" />
        </span>
        {/* Display only for now; user settings come later (UI-01). */}
        <span
          className="flex items-center gap-2 px-1.5"
          title={me?.email}
          data-testid="orchestrate-user"
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-selection-stroke bg-accent-surface text-detail font-semibold text-text-primary"
            data-testid="orchestrate-user-icon"
          >
            {initials ?? <User size={13} aria-hidden />}
          </span>
          {name ? <span className="truncate text-detail text-text-secondary">{name}</span> : null}
        </span>
        <TeamServerIndicator />
      </ControlButton>
    </div>
  );
}

/**
 * Orchestrate pull-up — the nav sections. Fills the entire area below the
 * brand title bar and slides up to dock there; rendered `absolute inset-0`.
 */
export function OrchestrateExpandedOverlay({
  expanded,
  onCollapse,
  pullUpRef,
  collapseRef,
}: {
  expanded: boolean;
  onCollapse: () => void;
  pullUpRef?: RefObject<HTMLDivElement | null>;
  collapseRef?: RefObject<HTMLButtonElement | null>;
}) {
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  // Background sessions needing attention stay visible on nav screens.
  const attentionCount = useAppStore(
    (state) => state.sessions.filter((session) => session.needsAttention === true).length,
  );

  const rowClass = (active: boolean): string =>
    cn(
      "flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left text-label font-medium tracking-ui transition-colors",
      active ? "bg-selection text-text-primary" : "text-text-secondary hover:bg-hover",
    );

  const sectionHeader = (label: string) => (
    <div className={cn("px-4 pb-1 pt-3", sectionHeaderClass, "text-text-muted")}>{label}</div>
  );

  // Selecting a screen keeps the pull-up open (setView no longer collapses it).
  const navSection = (items: typeof WORKSPACE_NAV) => (
    <nav className="space-y-0.5 px-2">
      {items.map((item) => {
        const Icon = item.icon;
        const active = view === item.id;
        return (
          <ControlButton
            key={item.id}
            className={rowClass(active)}
            data-testid={`nav-${item.id}`}
            onClick={() => setView(item.id)}
          >
            <Icon size={15} style={{ color: active ? "var(--color-brand-accent)" : undefined }} />
            <span>{item.label}</span>
          </ControlButton>
        );
      })}
    </nav>
  );

  return (
    <div
      ref={pullUpRef}
      className="absolute inset-0 z-10 flex flex-col px-2 pb-2"
      data-testid="orchestrate-expanded"
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
        <div className="flex items-center justify-between gap-1 px-1.5 pb-1.5">
          <span className="text-detail font-semibold text-text-primary">Orchestrate</span>
          <span className="flex items-center gap-1">
            {attentionCount > 0 ? (
              <span
                className="rounded-full bg-accent-surface px-1.5 py-0.5 text-micro text-text-primary"
                data-testid="orchestrate-attention-count"
                aria-label={`${attentionCount} sessions across all projects need attention`}
                title="Sessions needing attention across all projects"
              >
                {attentionCount}
              </span>
            ) : null}
            <ControlButton
              ref={collapseRef}
              data-testid="orchestrate-collapse"
              className="rounded-capsule p-1 text-text-muted hover:bg-hover hover:text-text-primary"
              title="Back to sessions"
              onClick={onCollapse}
            >
              <ChevronDown size={14} />
            </ControlButton>
          </span>
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto pb-2">
          {sectionHeader("Workspace")}
          {navSection(WORKSPACE_NAV)}
          {sectionHeader("Runtime")}
          {navSection(
            // SRV-16a: a desktop-only setting; the browser has no team server bridge.
            teamServer() ? RUNTIME_NAV : RUNTIME_NAV.filter((item) => item.id !== "team-server"),
          )}
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ width }: { width?: number }) {
  const view = useAppStore((state) => state.view);
  const panelExpanded = useAppStore((state) => state.panelExpanded);
  const setPanelExpanded = useAppStore((state) => state.setPanelExpanded);
  // On the macOS desktop build the window's traffic lights overlap the top-left,
  // so drop the wordmark below them and make the strip a drag region.
  const macDesktop = isMacDesktop();
  const isChat = view === "chat";

  // Focus handoff: the layer going inert must not keep focus. Opening moves it
  // to the collapse button, closing back to the Orchestrate card — but only when
  // focus was in the layer being hidden (or already dropped to body), so a
  // toggle from the composer or a dialog never steals it.
  const sessionsLayerRef = useRef<HTMLDivElement>(null);
  const pullUpRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const shownExpanded = useRef(panelExpanded);
  useEffect(() => {
    if (shownExpanded.current === panelExpanded) return;
    shownExpanded.current = panelExpanded;
    const active = document.activeElement;
    const hidden = panelExpanded ? sessionsLayerRef.current : pullUpRef.current;
    if (active && active !== document.body && !hidden?.contains(active)) return;
    (panelExpanded ? collapseRef : openerRef).current?.focus();
  }, [panelExpanded]);

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden bg-surface-elevated",
        isChat
          ? "border-r border-border-subtle"
          : "after:pointer-events-none after:absolute after:bottom-0 after:right-0 after:top-section-hero after:w-px after:bg-border-subtle",
      )}
      style={{ width: `${width ?? 280}px` }}
      data-testid="sidebar"
    >
      {/* Brand title bar — the pixel wordmark's only appearance (native rule). */}
      <div
        className={cn(
          "flex items-center gap-3 px-4 pb-1",
          macDesktop ? "pt-9 [-webkit-app-region:drag]" : "pt-2.5",
        )}
        data-testid="sidebar-brand"
        aria-label="Agent Deck"
      >
        {(["AGENT", "DECK"] as const).map((word) => (
          <span
            key={word}
            className="translate-y-px whitespace-nowrap font-pixel text-lg leading-none text-text-primary"
          >
            {word}
          </span>
        ))}
      </div>

      {/* Panel host: everything below the logo. Two permanently-mounted
          layers — the sessions panel (with the collapsed Orchestrate card at
          its bottom) recedes while the Orchestrate nav slides up and docks. */}
      <div className="relative min-h-0 flex-1">
        {/* Sessions layer — the main one, always in view. */}
        <div
          ref={sessionsLayerRef}
          className="absolute inset-0 flex flex-col"
          data-testid="sessions-layer"
          inert={panelExpanded}
          aria-hidden={panelExpanded}
          style={{
            transition: `${PANEL_MOVE}, ${PANEL_FADE}`,
            transformOrigin: "top",
            transform: panelExpanded ? "scale(0.98) translateY(-24px)" : "none",
            opacity: panelExpanded ? 0 : 1,
            pointerEvents: panelExpanded ? "none" : "auto",
          }}
        >
          <SessionsMainPanel />
          <OrchestrateCollapsedCard onExpand={() => setPanelExpanded(true)} openerRef={openerRef} />
        </div>

        {/* Orchestrate layer — docks below the logo, full height. */}
        <OrchestrateExpandedOverlay
          expanded={panelExpanded}
          onCollapse={() => setPanelExpanded(false)}
          pullUpRef={pullUpRef}
          collapseRef={collapseRef}
        />
      </div>
    </aside>
  );
}
