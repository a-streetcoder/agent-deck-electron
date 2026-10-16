import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect, useMemo, useState } from "react";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  eventLabel,
  humanKindLabel,
  type EventActor,
  type EventEnvelope,
  type OpenHumanRequest,
} from "@agent-deck/domain";
import { sectionHeaderClass } from "@/design-system/styles";
import { cn } from "@/lib/cn";
import { userDisplayName } from "@/lib/userIdentity";
import { useAppStore, type AppView } from "../state/store.ts";
import { refreshProjectLog, switchToSession } from "../state/wsBridge.ts";
import { forkOriginText, forkSourceOf } from "./ForkProvenanceCard.tsx";

// ponytail: renders the newest rows only; virtualize if the full 2,000 are ever wanted.
const SHOWN = 100;

/** Server-wide boundaries, not the project's activity. */
const SERVER_KINDS = new Set(["server.started", "writer.acquired"]);

/**
 * A8: the open human requests of the project over the whole log (a durable loop
 * approval may be far older than the tail), refetched on every project log nudge.
 */
function useOpenHumanRequests(projectId: string | null, nudge: number | undefined) {
  const [requests, setRequests] = useState<OpenHumanRequest[]>([]);
  useEffect(() => {
    let live = true;
    const query = projectId === null ? "" : `?projectId=${encodeURIComponent(projectId)}`;
    fetch(`/events/open-human${query}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { requests?: OpenHumanRequest[] } | null) => {
        if (live && body?.requests) setRequests(body.requests);
      })
      .catch(() => {
        // Transient: the next nudge refetches.
      });
    return () => {
      live = false;
    };
  }, [projectId, nudge]);
  return requests;
}

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

/**
 * SRV-15b: the member a row belongs to: the person who acted, else the owner of
 * the session it happened in. Asymmetric on purpose: Bob's prompt in Alice's
 * session is Bob's row, the agent's replies to it are Alice's.
 */
export function memberOf(
  actor: EventActor,
  sessionId: string | undefined,
  owners: ReadonlyMap<string, string>,
): string | undefined {
  if (actor.type === "user") return actor.id;
  const id = sessionId ?? (actor.type === "agent" ? actor.sessionId : undefined);
  return id === undefined ? undefined : owners.get(id);
}

/** A1c: the open project's event stream (every project when none is open), newest first.
 * `member`: the sessions list's member chip (SRV-15b); null shows everyone. */
export function ActivityList({ member = null }: { member?: string | null } = {}) {
  const projectId = useAppStore((state) => state.currentProjectId);
  const log = useAppStore((state) => state.projectLog);
  const sessions = useAppStore((state) => state.sessions);
  const me = useAppStore((state) => state.me);
  const setView = useAppStore((state) => state.setView);
  useEffect(() => {
    void refreshProjectLog();
  }, [projectId]);

  const all = log?.projectId === projectId ? log.events : undefined;
  const events = useMemo(() => {
    const owners = new Map<string, string>();
    for (const session of sessions) {
      if (session.createdBy) owners.set(session.id, session.createdBy.id);
    }
    return (all ?? []).filter(
      (event) =>
        !SERVER_KINDS.has(event.kind) &&
        (member === null || memberOf(event.actor, event.sessionId, owners) === member),
    );
  }, [all, member, sessions]);
  const shown = events.slice(-SHOWN).reverse();
  // A8: requests waiting on a person, first and outside the collapsed list. Never
  // filtered by the member chip: whoever is looking may be the one to answer, and a
  // loop approval (system actor, no session) belongs to no member.
  const waiting = useOpenHumanRequests(projectId, log?.lastSeq);
  return (
    <>
      {waiting.length > 0 ? (
        <ul
          className="space-y-0.5 px-1.5 pb-1"
          data-testid="activity-waiting"
          aria-label="Waiting on a person"
        >
          {waiting.map((request) => {
            const session = sessions.find((candidate) => candidate.id === request.sessionId);
            const target: AppView | undefined = session
              ? "chat"
              : request.kind === "loopApproval"
                ? "loops"
                : undefined;
            const label = eventLabel(request.prompt) || "Waiting on a person";
            return (
              <li
                key={request.id}
                className="flex items-baseline gap-1.5 text-detail text-text-secondary"
                data-testid="activity-waiting-row"
              >
                <span className="shrink-0 font-medium text-text-primary">
                  {humanKindLabel(request.kind)}
                </span>
                <span className="shrink-0">{actorLabel(request.actor)}</span>
                {target ? (
                  <ControlButton
                    className="min-w-0 truncate text-left text-accent hover:underline"
                    onClick={() => {
                      setView(target);
                      if (session) void switchToSession(session);
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
      ) : null}
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
              // SRV-15b: who forked whom (session.created names the source as parent).
              const forkParent =
                event.kind === "session.created" && event.parent?.type === "session"
                  ? event.parent.id
                  : undefined;
              const forkSource = sessions.find((candidate) => candidate.id === forkParent);
              const origin = forkSourceOf(link.session);
              const forkedFrom =
                forkParent !== undefined
                  ? forkOriginText(
                      origin?.title ?? forkSource?.title,
                      origin?.owner ?? forkSource?.createdBy,
                      me,
                    )
                  : null;
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
                  {forkedFrom ? (
                    <span
                      className="min-w-0 truncate text-text-muted"
                      data-testid="activity-forked-from"
                    >
                      {forkedFrom.replace(/^Forked/, "forked")}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </details>
    </>
  );
}
