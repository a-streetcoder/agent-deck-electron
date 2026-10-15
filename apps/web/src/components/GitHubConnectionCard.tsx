import { Button } from "@/design-system/components/Button";
import { sectionHeaderClass } from "@/design-system/styles";
import { cn } from "@/lib/cn";
import { LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * SRV-06: the signed-in user's GitHub connection (device flow). The server
 * never returns the token; this card only shows the account and the flow's
 * user code. Shared server only: the server reports `available: false` elsewhere.
 */
export interface GitHubConnectionStatus {
  available: boolean;
  configured: boolean;
  connection: { login: string; avatarUrl: string; scopes: string[]; connectedAt: string } | null;
}

type Flow = { id: string; userCode: string; verificationUri: string; interval: number };
type PollResult =
  | { status: "pending"; interval: number }
  | { status: "done"; login: string }
  | { status: "expired" | "denied" | "error"; error: string };

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

/** GET /runtime/github; null until loaded or when the answer is unusable. */
export function useGitHubStatus(enabled: boolean): {
  status: GitHubConnectionStatus | null;
  reload: () => Promise<void>;
} {
  const [status, setStatus] = useState<GitHubConnectionStatus | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch("/runtime/github");
      const body = (await response.json()) as Partial<GitHubConnectionStatus>;
      setStatus(
        response.ok && typeof body.available === "boolean"
          ? (body as GitHubConnectionStatus)
          : null,
      );
    } catch {
      setStatus(null);
    }
  }, [enabled]);
  useEffect(() => void reload(), [reload]);
  return { status, reload };
}

export function GitHubConnectionCard() {
  const { status, reload } = useGitHubStatus(true);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setFlow(null);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const poll = useCallback(
    (current: Flow, seconds: number) => {
      timer.current = setTimeout(
        async () => {
          let result: PollResult;
          try {
            const response = await fetch(
              `/runtime/github/connect/${encodeURIComponent(current.id)}`,
            );
            if (!response.ok) throw new Error(await errorText(response));
            result = (await response.json()) as PollResult;
          } catch (error) {
            stop();
            setMessage(error instanceof Error ? error.message : String(error));
            return;
          }
          if (result.status === "pending") return poll(current, result.interval);
          stop();
          if (result.status === "done") await reload();
          else setMessage(result.error);
        },
        Math.max(seconds, 1) * 1000,
      );
    },
    [reload, stop],
  );

  const connect = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/runtime/github/connect", { method: "POST" });
      if (!response.ok) throw new Error(await errorText(response));
      const started = (await response.json()) as Flow;
      setFlow(started);
      poll(started, started.interval);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/runtime/github", { method: "DELETE" });
      if (!response.ok) throw new Error(await errorText(response));
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!status?.available) return null;
  const connection = status.connection;
  return (
    <section className="mb-5" data-testid="github-connection">
      <h3 className={cn(sectionHeaderClass, "mb-1 px-2 text-text-muted")}>GitHub</h3>
      <div className="rounded-xl border border-border-subtle bg-surface-elevated px-3.5 py-2.5">
        {connection ? (
          <div className="flex items-center gap-3">
            {connection.avatarUrl ? (
              <img src={connection.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-label text-text-primary">
              Connected as <span className="font-medium">@{connection.login}</span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="destructiveOutline"
              leadingIcon={<LogOut size={12} aria-hidden />}
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          </div>
        ) : !status.configured ? (
          <p className="text-caption text-text-muted" data-testid="github-not-configured">
            GitHub app not configured. The server operator registers a GitHub OAuth App and sets its
            client id (AGENT_DECK_GITHUB_CLIENT_ID).
          </p>
        ) : flow ? (
          <div className="space-y-2">
            <p className="text-label text-text-primary">
              Enter <span className="font-mono font-semibold">{flow.userCode}</span> at{" "}
              <a
                href={flow.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline"
              >
                {flow.verificationUri}
              </a>
            </p>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-caption text-text-muted">
                Waiting for authorization on GitHub…
              </span>
              <Button type="button" size="sm" variant="secondary" onClick={stop}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex-1 text-caption text-text-muted">
              Connect GitHub so the pushes and pull requests of the sessions you create are made as
              you. Without it they use the server default.
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void connect()}
            >
              Connect
            </Button>
          </div>
        )}
        {message ? (
          <p className="pt-1 text-caption text-danger" role="alert">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
