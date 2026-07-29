export interface ForkableSessionAttachmentStore {
  fork(sourceSessionId: string, targetSessionId: string): void;
  deleteSession(sessionId: string): void;
}

/**
 * Optional attachment projections are isolated from one another. A damaged
 * sidecar may lose only its own projection; it must not roll back a healthy
 * sibling store or prevent the canonical Pi session from forking.
 */
export function forkSessionAttachmentStores(
  stores: readonly ForkableSessionAttachmentStore[],
  sourceSessionId: string,
  targetSessionId: string,
): () => void {
  const copied: ForkableSessionAttachmentStore[] = [];
  for (const store of stores) {
    try {
      store.fork(sourceSessionId, targetSessionId);
      copied.push(store);
    } catch {
      try {
        store.deleteSession(targetSessionId);
      } catch {
        // Best-effort cleanup is intentionally local to the failed store.
      }
    }
  }
  return () => {
    for (const store of copied) {
      try {
        store.deleteSession(targetSessionId);
      } catch {
        // A later launch failure still attempts every independent rollback.
      }
    }
  };
}
