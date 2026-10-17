import { useState } from "react";
import { sessionOwner } from "@agent-deck/domain";
import { Button } from "@/design-system/components/Button";
import { allowSandboxHost } from "@/state/wsBridge";
import { useAppStore } from "../state/store.ts";

/**
 * ADR 0007: "Allow <host> for this project" under a refused-host line. Shown
 * to the session's owner or the operator (the server refuses anyone else);
 * the running Pi keeps the list it started with, so the line says when the
 * host applies.
 */
export function SandboxAllowHost({ host }: { host: string }) {
  const session = useAppStore((state) => state.session);
  const me = useAppStore((state) => state.me);
  const [state, setState] = useState<
    { status: "idle" | "busy" } | { status: "done" } | { status: "error"; message: string }
  >({ status: "idle" });
  if (!session) return null;
  const mayAllow = !me || me.operator === true || sessionOwner(session)?.id === me.id;
  if (!mayAllow) return null;
  if (state.status === "done") {
    return (
      <div className="mt-1 text-text-muted">
        Allowed {host} for this project. It applies when this session's Pi next starts.
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        className="rounded-capsule"
        disabled={state.status === "busy"}
        onClick={() => {
          setState({ status: "busy" });
          allowSandboxHost(session.id, host).then(
            () => setState({ status: "done" }),
            (error: unknown) =>
              setState({
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              }),
          );
        }}
      >
        {state.status === "busy" ? "Allowing…" : `Allow ${host} for this project`}
      </Button>
      {state.status === "error" ? (
        <span role="alert" className="text-danger">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
