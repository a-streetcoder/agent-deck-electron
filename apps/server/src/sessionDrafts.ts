import type { SessionMeta, ServerMessage, ThinkingLevel } from "@agent-deck/contracts";
import type { LaunchPlan } from "@agent-deck/pi-host";
import type { SessionIndex } from "./persistence.ts";
import type { ManagedSession, SessionManager } from "./SessionManager.ts";

export interface SessionDraftGateway {
  find(id: string): SessionMeta | undefined;
  start(id: string): Promise<ManagedSession>;
  setModel(id: string, provider: string, modelId: string): Promise<void>;
  setThinking(id: string, level: ThinkingLevel): Promise<void>;
}

/** Drafts are durable catalog rows. Runtime allocation is a claimed transaction
 * performed only by the first prompt; failures retain the same draft identity. */
export function createSessionDraftGateway(deps: {
  index: SessionIndex;
  sessions: SessionManager;
  broadcast(message: ServerMessage): void;
  launch(draft: SessionMeta): Promise<ManagedSession>;
  validateModel?(provider: string, modelId: string): Promise<void>;
}): SessionDraftGateway {
  const pending = new Map<string, Promise<ManagedSession>>();
  const find = (id: string) => deps.index.find((row) => row.id === id && row.lifecycle === "draft");
  const update = (id: string, change: (draft: SessionMeta) => SessionMeta) => {
    if (deps.sessions.mutationClaims.owner(id))
      throw new Error("Session is starting. Try again after startup.");
    const draft = find(id);
    if (!draft) throw new Error("Session is no longer a draft.");
    const next = { ...change(draft), updatedAt: new Date().toISOString() };
    deps.index.upsert(next);
    deps.broadcast({ type: "session_meta", session: next });
  };
  return {
    find,
    start(id) {
      const existing = pending.get(id);
      if (existing) return existing;
      const live = deps.sessions.get(id);
      if (live?.isRunning) return Promise.resolve(live);
      const draft = find(id);
      if (!draft) return Promise.reject(new Error("unknown draft"));
      const release = deps.sessions.mutationClaims.tryClaim(id, "resume");
      if (!release)
        return Promise.reject(new Error("Another session mutation is already in progress."));
      const operation = Promise.resolve()
        .then(() => deps.launch(draft))
        .then((session) => {
          deps.broadcast({ type: "session_rebind", sessionId: id });
          return session;
        })
        .catch((error: unknown) => {
          deps.index.upsert(draft);
          deps.broadcast({ type: "session_meta", session: draft });
          throw error;
        })
        .finally(() => {
          pending.delete(id);
          release();
        });
      pending.set(id, operation);
      return operation;
    },
    async setModel(id, provider, modelId) {
      await deps.validateModel?.(provider, modelId);
      update(id, (draft) => ({
        ...draft,
        launchPlan: { ...(draft.launchPlan as LaunchPlan), provider, model: modelId },
        launchResourceConfig: {
          ...draft.launchResourceConfig,
          version: 1,
          providerOverride: provider,
          modelOverride: modelId,
        },
      }));
    },
    async setThinking(id, level) {
      update(id, (draft) => ({ ...draft, draftThinkingLevel: level }));
    },
  };
}
