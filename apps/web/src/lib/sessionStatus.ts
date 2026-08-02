import type { SessionMeta } from "@agent-deck/contracts";
import type { ConnectionStatus } from "../state/store.ts";

/** Selected-chat status priority: transport, live activity, durable failure, idle. */
export function selectedSessionStatus(
  connection: ConnectionStatus,
  agentStatus: "running" | "idle",
  durableStatus: SessionMeta["status"] | undefined,
): ConnectionStatus | "responding" | "failed" | "idle" {
  if (connection !== "open") return connection;
  if (agentStatus === "running") return "responding";
  if (durableStatus === "failed") return "failed";
  return "idle";
}
