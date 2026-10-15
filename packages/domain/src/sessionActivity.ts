// SRV-15b: what a session is doing now, for every row of the sessions list.
// Computed by the server from the live runtime and the meta, never from the event
// log alone: the startup reconcile closes runs and plans only, so a turn left open
// in the log by a restart would otherwise read "running" forever.
import type { SessionActivity, SessionMeta } from "@agent-deck/contracts";

export type { SessionActivity };

export function sessionActivity(
  meta: Pick<SessionMeta, "status" | "needsAttention" | "parkedAt">,
  /** The live runtime, when one exists (absent: no process, whatever the log says). */
  live?: { idle: boolean },
  /** An open A8 human node belongs to this session. */
  openHuman = false,
): SessionActivity {
  if (openHuman) return "needsInput";
  if (live && !live.idle) return "running";
  if (meta.status === "failed") return "failed";
  if (meta.needsAttention === true) return "attention";
  if (meta.parkedAt) return "parked";
  return "idle";
}
