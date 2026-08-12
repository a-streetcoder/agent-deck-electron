export type SessionMutationKind = "history" | "delete" | "merge" | "attention";

/** Synchronous per-session transaction claim shared by destructive routes. */
export class SessionMutationClaims {
  private readonly claims = new Map<string, SessionMutationKind>();

  tryClaim(sessionId: string, kind: SessionMutationKind): (() => void) | null {
    if (this.claims.has(sessionId)) return null;
    this.claims.set(sessionId, kind);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.claims.get(sessionId) === kind) this.claims.delete(sessionId);
    };
  }

  owner(sessionId: string): SessionMutationKind | undefined {
    return this.claims.get(sessionId);
  }
}
