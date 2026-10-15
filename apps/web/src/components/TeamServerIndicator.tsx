import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { teamServer, type TeamServerBridge, type TeamServerStatus } from "@/lib/native";

/**
 * SRV-16b: main's team server sign-in status, live: asked once, then pushed
 * by main on every change. Null outside the local desktop app or until known.
 */
export function useTeamServerStatus(): TeamServerStatus | null {
  const [bridge] = useState<TeamServerBridge | undefined>(teamServer);
  const [status, setStatus] = useState<TeamServerStatus | null>(null);
  useEffect(() => {
    if (!bridge?.status) return;
    let live = true;
    const unsubscribe = bridge.onStatus?.((next) => live && setStatus(next));
    bridge.status().then(
      (next) => live && setStatus(next),
      () => undefined,
    );
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [bridge]);
  return status;
}

/** The short word for a state, as in "Team server: signed in". */
export function teamServerStateLabel(status: TeamServerStatus): string {
  if (status.checking) return "checking";
  switch (status.state) {
    case "off":
      return "off";
    case "needsSignIn":
      return status.warning ? "confirm the team" : "sign-in needed";
    case "signingIn":
      return "signing in";
    case "signedIn":
      return "signed in";
    case "unreachable":
      return "unreachable";
    case "forbidden":
      return "not allowed";
  }
}

const dotClass = (status: TeamServerStatus): string => {
  if (status.checking || status.state === "signingIn") return "bg-text-muted";
  if (status.state === "signedIn") return "bg-success";
  if (status.state === "needsSignIn") return "bg-warning";
  return "bg-danger";
};

/** Sidebar footer: a dot and "Team server: <state>", only with a server configured. */
export function TeamServerIndicator() {
  const status = useTeamServerStatus();
  if (!status || status.state === "off") return null;
  const label = `Team server: ${teamServerStateLabel(status)}`;
  return (
    <span
      className="flex items-center gap-2 px-1.5 pt-1 text-detail text-text-muted"
      data-testid="team-server-indicator"
      title={status.error ?? status.warning ?? label}
    >
      <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", dotClass(status))} />
      <span className="truncate">{label}</span>
    </span>
  );
}
