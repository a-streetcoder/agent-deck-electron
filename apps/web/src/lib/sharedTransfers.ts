import { useEffect } from "react";

/**
 * SRV-16b: moves, bring-backs and Make shared in this renderer, and Save on
 * the Team server screen, are mutually exclusive. Each transfer is a chain of
 * local-backend and team-server calls driven from here; a Save that changes
 * the server reloads the window (the only caller of team-server:set is this
 * page), which would cut such a chain in half. So Save is refused while a
 * transfer is held (a running step, or a move or bring-back dialog that is
 * open, also when it waits for a sign-in), and no transfer starts from the
 * moment Save is asked until the reload replaces this page (or the Save turns
 * out not to reload).
 */
const holds = new Set<symbol>();
let originChanging = false;

/** ponytail: one fixed ceiling per hold, so a hung local fetch cannot block Save until a restart. */
export const TRANSFER_HOLD_CEILING_MS = 5 * 60_000;

export const ORIGIN_CHANGING_ERROR =
  "The team server setting is changing and Agent Deck is about to reload. Try again after it has.";

/** Hold Save off until the returned release runs, or TRANSFER_HOLD_CEILING_MS passes. */
export function holdTransfer(): () => void {
  const id = Symbol("transfer");
  holds.add(id);
  const timer = setTimeout(() => holds.delete(id), TRANSFER_HOLD_CEILING_MS);
  return () => {
    clearTimeout(timer);
    holds.delete(id);
  };
}

/** Hold a transfer while `open` (a move or bring-back dialog is shown). */
export function useTransferHold(open: boolean): void {
  useEffect(() => (open ? holdTransfer() : undefined), [open]);
}

/** Run `run` as a transfer step; refused while a Save is pending. */
export async function trackTransfer<T>(run: () => Promise<T>): Promise<T> {
  if (originChanging) throw new Error(ORIGIN_CHANGING_ERROR);
  const release = holdTransfer();
  try {
    return await run();
  } finally {
    release();
  }
}

export function transferRunning(): boolean {
  return holds.size > 0;
}

/**
 * Save's side: false while a transfer is held; otherwise sets the barrier and
 * answers true. End it with endOriginChange() when no reload follows.
 */
export function beginOriginChange(): boolean {
  if (holds.size > 0) return false;
  originChanging = true;
  return true;
}

export function endOriginChange(): void {
  originChanging = false;
}
