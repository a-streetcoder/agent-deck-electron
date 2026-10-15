import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect } from "react";
import type { SessionMeta } from "@agent-deck/contracts";
import type { EventActor, EventEnvelope } from "@agent-deck/domain";
import { sectionHeaderClass } from "@/design-system/styles";
import { cn } from "@/lib/cn";
import { userDisplayName } from "@/lib/userIdentity";
import { useAppStore, type AppView } from "../state/store.ts";
import { refreshProjectLog, switchToSession } from "../state/wsBridge.ts";

// ponytail: renders the newest rows only; virtualize if the full 2,000 are ever wanted.
const SHOWN = 100;

export function actorLabel(actor: EventActor): string {
  if (actor.type === "user") return actor.id ? userDisplayName({ ...actor, id: actor.id }) : "user";
  if (actor.type === "agent") return actor.agentName ?? "agent";
  return "system";
}

/** Where a row's subject link goes. Loops open the Loops view (it cannot select a
 * run from outside yet, so the label says so); everything else (session, turn,
 * plan, checkpoint, and the subagent runs, supervisor requests and tool calls that
 * live in a transcript) activates its session, labelled with the session's title. */
function subjectLink(
  event: EventEnvelope,
  sessions: SessionMeta[],
): { label: string; view?: AppView; session?: SessionMeta } {
  const { type, id } = event.subject;
  const fallback = `${type} ${id.slice(0, 8)}`;
  if (type.startsWith("loop")) return { label: `${fallback} (opens Loops)`, view: "loops" };
  const sessionId = event.sessionId ?? (type === "session" ? id : undefined);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return { label: fallback };
  return { label: session.title?.trim() || "Untitled session", view: "chat", session };
}

export function formatEventTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(undefined, { timeStyle: "short" })
    : date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** A1c: the open project's event stream (every project when none is open), newest first. */
export function ActivityList() {
  const projectId = useAppStore((state) => state.currentProjectId);
  const log = useAppStore((state) => state.projectLog);
  const sessions = useAppStore((state) => state.sessions);
  const setView = useAppStore((state) => state.setView);
  useEffect(() => {
    void refreshProjectLog();
  }, [projectId]);

  const events = log?.projectId === projectId ? log.events : [];
  const shown = events.slice(-SHOWN).reverse();
  return (
    <details className="px-1.5 pb-1.5" data-testid="activity-list">
      <summary className={cn(sectionHeaderClass, "cursor-pointer text-text-muted")}>
        {events.length > SHOWN ? `Activity (newest ${SHOWN})` : `Activity (${events.length})`}
      </summary>
      {shown.length === 0 ? (
        <div className="py-2 text-caption text-text-muted">No activity yet.</div>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto pt-1">
          {shown.map((event) => {
            const link = subjectLink(event, sessions);
            return (
              <li
                key={event.seq}
                className="flex items-baseline gap-1.5 text-detail text-text-secondary"
                data-testid={`activity-${event.seq}`}
              >
                <time className="shrink-0 text-text-muted" dateTime={event.ts}>
                  {formatEventTime(event.ts)}
                </time>
                <span className="shrink-0">{actorLabel(event.actor)}</span>
                <span className="shrink-0 font-mono text-code-sm">{event.kind}</span>
                {link.view ? (
                  <ControlButton
                    className="min-w-0 truncate text-left text-accent hover:underline"
                    onClick={() => {
                      if (link.view) setView(link.view);
                      if (link.session) void switchToSession(link.session);
                    }}
                  >
                    {link.label}
                  </ControlButton>
                ) : (
                  <span className="min-w-0 truncate">{link.label}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
