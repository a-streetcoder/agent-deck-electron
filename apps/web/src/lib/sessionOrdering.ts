import type { SessionMeta } from "@agent-deck/contracts";

export function sessionActivityAt(session: SessionMeta): string {
  return session.updatedAt ?? session.createdAt;
}

export function sortSessionsByActivity(sessions: readonly SessionMeta[]): SessionMeta[] {
  return [...sessions].sort(
    (a, b) =>
      sessionActivityAt(b).localeCompare(sessionActivityAt(a)) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/** Native expanded-project ordering: newest pin first, then normal activity. */
export function sortSessionsWithPins(sessions: readonly SessionMeta[]): SessionMeta[] {
  return sortSessionsByActivity(sessions).sort((a, b) => {
    if (a.pinnedAt && b.pinnedAt) return b.pinnedAt.localeCompare(a.pinnedAt);
    if (a.pinnedAt) return -1;
    if (b.pinnedAt) return 1;
    return 0;
  });
}
