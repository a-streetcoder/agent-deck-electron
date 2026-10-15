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
const SESSION_SUBJECTS = new Set(["session", "turn", "plan", "checkpoint"]);

function actorLabel(actor: EventActor): string {
  if (actor.type === "user") return actor.id ? userDisplayName({ ...actor, id: actor.id }) : "user";
  if (actor.type === "agent") return actor.agentName ?? "agent";
  return "system";
}

/** Where a row's subject link goes: loops open the Loops view; everything else
 * (session, turn, plan, checkpoint, and the runs that live in a transcript)
 * activates its session. Null when the session is unknown here. */
function subjectTarget(
  event: EventEnvelope,
  sessions: SessionMeta[],
): { view: AppView; session?: SessionMeta } | null {
  if (event.subject.type.startsWith("loop")) return { view: "loops" };
  const sessionId =
    event.sessionId ?? (event.subject.type === "session" ? event.subject.id : undefined);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  return session ? { view: "chat", session } : null;
}

function subjectLabel(event: EventEnvelope, sessions: SessionMeta[]): string {
  const { type, id } = event.subject;
  const session = SESSION_SUBJECTS.has(type)
    ? sessions.find((candidate) => candidate.id === (event.sessionId ?? id))
    : undefined;
  return session?.title?.trim() || `${type} ${id.slice(0, 8)}`;
}

/** A1c: the open project's event stream, newest first (the shared server's team stream). */
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
        Activity ({events.length})
      </summary>
      {shown.length === 0 ? (
        <div className="py-2 text-caption text-text-muted">No activity yet.</div>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto pt-1">
          {shown.map((event) => {
            const target = subjectTarget(event, sessions);
            const label = subjectLabel(event, sessions);
            return (
              <li
                key={event.seq}
                className="flex items-baseline gap-1.5 text-detail text-text-secondary"
                data-testid={`activity-${event.seq}`}
              >
                <time className="shrink-0 text-text-muted" dateTime={event.ts}>
                  {new Date(event.ts).toLocaleTimeString(undefined, { timeStyle: "short" })}
                </time>
                <span className="shrink-0">{actorLabel(event.actor)}</span>
                <span className="shrink-0 font-mono text-code-sm">{event.kind}</span>
                {target ? (
                  <ControlButton
                    className="min-w-0 truncate text-left text-accent hover:underline"
                    onClick={() => {
                      setView(target.view);
                      if (target.session) void switchToSession(target.session);
                    }}
                  >
                    {label}
                  </ControlButton>
                ) : (
                  <span className="min-w-0 truncate">{label}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
