import type { SemanticRecallStatus } from "@agent-deck/contracts";
import {
  createOnDeviceEmbedder,
  EmbedderUnavailableError,
  searchMemories,
  semanticSearchMemoriesWithOutcome,
  type Embedder,
  type MemorySearchHit,
  type MemoryStore,
} from "@agent-deck/memory";

export interface MemoryRecallResult {
  hits: MemorySearchHit[];
  recall: SemanticRecallStatus;
}

const STATUSES = {
  notRequested: {
    readiness: "not_requested",
    mode: "lexical",
    reason: null,
    message: "Semantic ranking is not requested. Recall is using lexical ranking.",
  },
  notChecked: {
    readiness: "not_checked",
    mode: "lexical",
    reason: null,
    message:
      "Semantic ranking has not been checked. Recall remains available with lexical ranking.",
  },
  checking: {
    readiness: "checking",
    mode: "lexical",
    reason: null,
    message: "Checking semantic ranking readiness. Recall remains available with lexical ranking.",
  },
  ready: {
    readiness: "ready",
    mode: "semantic",
    reason: null,
    message: "Semantic ranking is ready.",
  },
  unavailable: {
    readiness: "unavailable",
    mode: "lexical_fallback",
    reason: "optional_dependency_missing",
    message:
      "Semantic ranking is unavailable because its optional component is not installed. Recall is using lexical fallback.",
  },
  initializationFailed: {
    readiness: "error",
    mode: "lexical_fallback",
    reason: "initialization_failed",
    message: "Semantic ranking could not be initialized. Recall is using lexical fallback.",
  },
  embeddingFailed: {
    readiness: "error",
    mode: "lexical_fallback",
    reason: "embedding_failed",
    message: "Semantic ranking failed for the latest recall. Recall used lexical fallback.",
  },
  invalidEmbedding: {
    readiness: "error",
    mode: "lexical_fallback",
    reason: "invalid_embedding",
    message:
      "Semantic ranking returned an invalid result for the latest recall. Recall used lexical fallback.",
  },
} as const satisfies Record<string, SemanticRecallStatus>;

/** Server-owned semantic readiness and recall outcome coordinator. */
export class SemanticRecallCoordinator {
  private embedder: Embedder | undefined;
  private initialization: Promise<Embedder | undefined> | undefined;
  private status: SemanticRecallStatus = STATUSES.notChecked;

  constructor(
    private readonly requested: () => boolean,
    private readonly suppliedEmbedder?: Embedder,
    private readonly createEmbedder: () => Promise<Embedder> = createOnDeviceEmbedder,
  ) {}

  /** Passive snapshot. It never initializes or otherwise touches the optional runtime. */
  getStatus(): SemanticRecallStatus {
    return this.requested() ? this.status : STATUSES.notRequested;
  }

  /** Keep preference mutation passive while making the next enabled state truthful. */
  preferenceChanged(enabled: boolean): void {
    if (!enabled || this.initialization) return;
    this.status = this.embedder ? STATUSES.ready : STATUSES.notChecked;
  }

  /** Explicit readiness check. A completed initialization failure is retried;
   * runtime failures require a successful recall before readiness is restored. */
  async check(): Promise<SemanticRecallStatus> {
    if (!this.requested()) return STATUSES.notRequested;
    if (this.embedder && this.isRuntimeFailure()) return this.getStatus();
    const embedder = await this.resolveEmbedder(true);
    if (embedder && !this.isRuntimeFailure()) this.status = STATUSES.ready;
    return this.getStatus();
  }

  async recall(store: MemoryStore, query: string, limit?: number): Promise<MemoryRecallResult> {
    if (!this.requested()) {
      return { hits: searchMemories(store, query, limit), recall: STATUSES.notRequested };
    }
    const embedder = await this.resolveEmbedder(false);
    if (!this.requested()) {
      return { hits: searchMemories(store, query, limit), recall: STATUSES.notRequested };
    }
    if (!embedder) {
      return { hits: searchMemories(store, query, limit), recall: this.status };
    }
    const outcome = await semanticSearchMemoriesWithOutcome(
      store,
      query,
      embedder,
      limit === undefined ? {} : { limit },
    );
    // Preference can change while the runtime is embedding. Discard both the
    // semantic result and its lifecycle outcome so a disabled request remains
    // lexical and cannot make the next passive status snapshot sticky.
    if (!this.requested()) {
      return { hits: searchMemories(store, query, limit), recall: STATUSES.notRequested };
    }
    if (outcome.mode === "semantic") {
      this.status = STATUSES.ready;
    } else {
      this.status =
        outcome.reason === "invalid_embedding"
          ? STATUSES.invalidEmbedding
          : STATUSES.embeddingFailed;
    }
    return { hits: outcome.hits, recall: this.status };
  }

  private isRuntimeFailure(): boolean {
    return this.status.reason === "embedding_failed" || this.status.reason === "invalid_embedding";
  }

  private async resolveEmbedder(retry: boolean): Promise<Embedder | undefined> {
    if (this.embedder) return this.embedder;
    if (this.initialization) return this.initialization;
    // A missing optional dependency is stable for this process unless the user
    // explicitly retries. Initialization failures may be transient (for example,
    // a first model download), so the next active recall retries automatically.
    if (!retry && this.status.readiness === "unavailable") return undefined;
    this.status = STATUSES.checking;
    this.initialization = (async () => {
      try {
        // Always cross an await boundary so `initialization` is assigned before
        // the finally block clears it, including for an injected embedder.
        const embedder = this.suppliedEmbedder
          ? await Promise.resolve(this.suppliedEmbedder)
          : await this.createEmbedder();
        this.embedder = embedder;
        this.status = STATUSES.ready;
        return embedder;
      } catch (error) {
        this.status =
          error instanceof EmbedderUnavailableError
            ? STATUSES.unavailable
            : STATUSES.initializationFailed;
        return undefined;
      } finally {
        this.initialization = undefined;
      }
    })();
    return this.initialization;
  }
}
