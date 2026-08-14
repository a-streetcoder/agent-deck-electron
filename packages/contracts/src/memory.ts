export type SemanticRecallReadiness =
  | "not_requested"
  | "not_checked"
  | "checking"
  | "ready"
  | "unavailable"
  | "error";

export type MemoryRecallMode = "lexical" | "semantic" | "lexical_fallback";

export type SemanticRecallReason =
  | "optional_dependency_missing"
  | "initialization_failed"
  | "embedding_failed"
  | "invalid_embedding";

/** Safe, path-free server-owned semantic recall state exposed to every client. */
export interface SemanticRecallStatus {
  readiness: SemanticRecallReadiness;
  mode: MemoryRecallMode;
  reason: SemanticRecallReason | null;
  message: string;
}
