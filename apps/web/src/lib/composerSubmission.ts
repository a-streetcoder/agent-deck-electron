/** Pure identity helpers for async composer work. */

export interface ComposerSubmitStatus {
  kind: "info" | "rejection" | "image";
  message: string;
}

/** Rejections are durable; only a now-irrelevant running-image warning auto-clears. */
export function statusAfterAgentTransition(
  status: ComposerSubmitStatus | null,
  running: boolean,
): ComposerSubmitStatus | null {
  return !running && status?.kind === "image" ? null : status;
}

export function createPendingImageId(): string {
  return crypto.randomUUID();
}

/** Remove only the exact attachment objects carried by an acknowledged request. */
export function retainUnsubmittedImages<T extends object>(
  current: T[],
  submitted: readonly T[],
): T[] {
  return current.filter((image) => !submitted.includes(image));
}

/** Both session identity and request generation must still match before async cleanup. */
export function isCurrentComposerSubmission(
  originatingSessionId: string,
  generation: number,
  currentSessionId: string | null,
  currentGeneration: number,
): boolean {
  return originatingSessionId === currentSessionId && generation === currentGeneration;
}

/**
 * Settle a whole async image-read batch without publishing partial results.
 * A session switch invalidates the complete batch permanently, even if the user
 * later switches back to the originating session.
 */
export async function settleComposerImageBatch<T>(
  reads: readonly Promise<T | null>[],
  originatingSessionId: string,
  generation: number,
  currentIdentity: () => { sessionId: string | null; generation: number },
): Promise<T[] | null> {
  const settled = await Promise.allSettled(reads);
  const current = currentIdentity();
  if (
    !isCurrentComposerSubmission(
      originatingSessionId,
      generation,
      current.sessionId,
      current.generation,
    )
  ) {
    return null;
  }
  return settled.flatMap((result) =>
    result.status === "fulfilled" && result.value !== null ? [result.value] : [],
  );
}
