import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppInlineNotice } from "@/design-system/components/AppInlineNotice";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { PageShell } from "@/design-system/components/PageShell";
import { SectionHero } from "@/design-system/components/SectionHero";
import { useEffect, useState } from "react";
import {
  teamServer,
  type CloudflaredProgress,
  type CloudflaredStatus,
  type TeamServerBridge,
  type TeamServerState,
  type TeamServerStatus,
} from "@/lib/native";
import { beginOriginChange, endOriginChange } from "@/lib/sharedTransfers";
import { useTeamServerStatus } from "../components/TeamServerIndicator.tsx";

export const TRANSFER_RUNNING_ERROR =
  "A session is moving to or from the team server. Save again once it has finished.";

export const CLOUDFLARED_MISSING = "cloudflared is not available. Download it below.";

/** The status line: the setting (SRV-16a), then main's sign-in status (SRV-16b). */
export function teamServerStatus(state: TeamServerState, status: TeamServerStatus | null): string {
  if (!state.origin) return "Not configured";
  if (!status || status.checking) return "Checking the sign-in…";
  const team = status.team ? ` (${status.team})` : "";
  switch (status.state) {
    case "signedIn":
      return status.user ? `Signed in as ${status.user.name}${team}` : `Signed in${team}`;
    case "signingIn":
      return "Signing in: finish the login in your browser.";
    case "needsSignIn":
      return status.warning ? `Sign-in waiting for confirmation${team}` : "Not signed in";
    case "unreachable":
      return `Unreachable: ${status.error ?? "the team server did not answer."}`;
    case "forbidden":
      return status.error ?? "Your account is not allowed on this server.";
    case "off":
      return "Configured";
  }
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// --- SRV-16c: cloudflared ---
const CLOUDFLARED_SOURCES: Record<CloudflaredStatus["source"], string> = {
  setting: "downloaded or set in Settings",
  env: "AGENT_DECK_CLOUDFLARED",
  path: "PATH",
  known: "install folder",
};

/** "Found at <path> (<source>, <version>)". */
export function cloudflaredFoundText(found: CloudflaredStatus): string {
  const details = [CLOUDFLARED_SOURCES[found.source], found.version].filter(Boolean).join(", ");
  return `Found at ${found.path} (${details})`;
}

function progressText({ received, total }: CloudflaredProgress): string {
  const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
  return total
    ? `Downloading… ${Math.floor((received / total) * 100)}% (${mb(received)} of ${mb(total)} MB)`
    : `Downloading… ${mb(received)} MB`;
}

/**
 * Whether sign-in has a cloudflared to run, and the verified download when not.
 * SRV-16b: `found` lives in the screen, whose Sign in waits for a non-null one.
 */
function CloudflaredSection({
  bridge,
  found,
  setFound,
}: {
  bridge: TeamServerBridge;
  /** undefined: loading; null: not found (or the lookup failed). */
  found: CloudflaredStatus | null | undefined;
  setFound: (found: CloudflaredStatus | null) => void;
}) {
  const [downloadVersion, setDownloadVersion] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [progress, setProgress] = useState<CloudflaredProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([bridge.cloudflared?.(), bridge.cloudflaredInfo?.()]).then(
      ([status, info]) => {
        if (!live) return;
        setFound(status ?? null);
        setDownloadVersion(info?.downloadVersion ?? null);
        setWarning(info?.warning ?? null);
      },
      (cause: unknown) => {
        if (!live) return;
        setFound(null);
        setError(errorText(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, setFound]);

  const download = async () => {
    if (!bridge.downloadCloudflared || downloading) return;
    setDownloading(true);
    setError(null);
    setProgress(null);
    const unsubscribe = bridge.onCloudflaredProgress?.(setProgress);
    try {
      const result = await bridge.downloadCloudflared();
      if (!result.ok) return setError(result.error);
      setFound((await bridge.cloudflared?.()) ?? null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      unsubscribe?.();
      setDownloading(false);
    }
  };

  return (
    <Card padding="md" className="mt-4" data-testid="cloudflared-section">
      <h2 className="text-label font-medium text-text-primary">cloudflared</h2>
      <p className="mt-1 text-caption text-text-muted">
        Sign-in runs cloudflared, which opens your browser for the team login.
      </p>
      {found === undefined ? (
        <p className="mt-3 text-detail text-text-muted">Looking for cloudflared…</p>
      ) : found ? (
        <p
          className="mt-3 break-all text-detail text-text-secondary"
          data-testid="cloudflared-found"
        >
          {cloudflaredFoundText(found)}
        </p>
      ) : (
        <div className="mt-3 flex flex-col items-start gap-2">
          <p className="text-detail text-text-secondary">
            cloudflared was not found on this computer.
          </p>
          {downloadVersion ? (
            <Button variant="primary" disabled={downloading} onClick={() => void download()}>
              {`Download cloudflared (${downloadVersion})`}
            </Button>
          ) : (
            <p className="text-detail text-text-muted">
              No download is available for this computer; install cloudflared from Cloudflare.
            </p>
          )}
          {downloading ? (
            <p className="text-detail text-text-muted" role="status">
              {progress ? progressText(progress) : "Downloading…"}
            </p>
          ) : null}
        </div>
      )}
      {warning ? (
        <AppInlineNotice tone="warning" className="mt-3">
          {warning}
        </AppInlineNotice>
      ) : null}
      {error ? (
        <AppInlineNotice tone="danger" className="mt-3">
          {error}
        </AppInlineNotice>
      ) : null}
    </Card>
  );
}
// --- end SRV-16c ---

export function TeamServerScreen() {
  const [bridge] = useState(teamServer);
  const status = useTeamServerStatus();
  const [state, setState] = useState<TeamServerState | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // SRV-16c lookup, shared with CloudflaredSection (which asks again after a
  // download resolves): Sign in runs only once a cloudflared was found.
  const [cloudflared, setCloudflared] = useState<CloudflaredStatus | null | undefined>(undefined);

  // Opening the screen re-checks a signed-in, unreachable or refused status.
  useEffect(() => {
    void bridge?.check?.().catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge.get().then(
      (next) => {
        if (!live) return;
        setState(next);
        setDraft(next.serverUrl ?? "");
      },
      (cause: unknown) => live && setError(errorText(cause)),
    );
    return () => {
      live = false;
    };
  }, [bridge]);

  const save = async () => {
    if (!bridge || saving) return;
    // Save may reload the window, which would cut a running move in half; from
    // here until that reload no move or bring-back may start.
    if (!beginOriginChange()) return setError(TRANSFER_RUNNING_ERROR);
    setSaving(true);
    setError(null);
    let reloads = false;
    try {
      const result = await bridge.set({ serverUrl: draft.trim() || null });
      if (!result.ok) return setError(result.error);
      const { ok: _ok, ...next } = result;
      reloads = next.restartRequired;
      setState(next);
      setDraft(next.serverUrl ?? "");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      // A reload replaces this page (and the barrier with it).
      if (!reloads) endOriginChange();
      setSaving(false);
    }
  };

  /** Sign in, sign out or confirm the team; main pushes the new status. */
  const act = async (run?: () => Promise<{ ok: boolean; held?: boolean; error?: string }>) => {
    if (!run || acting) return;
    setActing(true);
    setError(null);
    try {
      const result = await run();
      // A held sign-in shows its warning through the status instead.
      if (!result.ok && !result.held && result.error) setError(result.error);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setActing(false);
    }
  };

  const signingIn = status?.state === "signingIn";
  const canSignIn =
    status !== null &&
    !status.checking &&
    !status.warning &&
    (status.state === "needsSignIn" || status.state === "unreachable");
  const canSignOut =
    status !== null && (status.state === "signedIn" || status.state === "forbidden");

  return (
    <PageShell
      width="page"
      testId="team-server-screen"
      hero={
        <SectionHero
          imageSrc="/onboarding/pop-hero.jpg"
          title="Team server"
          subtitle="Share projects and sessions through your team's Agent Deck server."
        />
      }
    >
      {!bridge ? (
        <AppEmptyState heading="Team server settings are available in the desktop app." />
      ) : !state ? (
        error ? (
          <AppInlineNotice tone="danger">{error}</AppInlineNotice>
        ) : (
          <AppEmptyState heading="Loading team server settings…" />
        )
      ) : (
        <Card padding="md">
          <label className="block" htmlFor="team-server-url">
            <span className="text-label font-medium text-text-primary">Server address</span>
            <span id="team-server-url-help" className="mt-1 block text-caption text-text-muted">
              The https address of the team server, for example https://deck.example.com. Leave it
              empty to use Agent Deck on its own.
            </span>
          </label>
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <AppTextField
              id="team-server-url"
              aria-describedby="team-server-url-help"
              placeholder="https://deck.example.com"
              value={draft}
              disabled={saving}
              onChange={(next) => {
                setDraft(next);
                setError(null);
              }}
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={saving || draft.trim() === (state.serverUrl ?? "")}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </form>
          {error ? (
            <p className="mt-2 text-detail text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <p
              className="min-w-0 flex-1 text-detail text-text-muted"
              role="status"
              data-testid="team-server-status"
            >
              {teamServerStatus(state, status)}
            </p>
            {state.origin && canSignIn ? (
              <Button
                size="sm"
                disabled={acting || !cloudflared}
                aria-describedby={cloudflared ? undefined : "team-server-cloudflared"}
                onClick={() => void act(bridge.signIn)}
              >
                Sign in
              </Button>
            ) : null}
            {state.origin && signingIn ? (
              <Button size="sm" variant="ghost" onClick={() => void bridge.cancelSignIn?.()}>
                Cancel
              </Button>
            ) : null}
            {state.origin && canSignOut ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={acting}
                onClick={() => void act(bridge.signOut)}
              >
                Sign out
              </Button>
            ) : null}
            {state.origin && canSignOut && bridge.forgetToken ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={acting}
                title="Sign out and delete this server's cached cloudflared token, to sign in with another account"
                onClick={() => void act(bridge.forgetToken)}
              >
                Remove cached token
              </Button>
            ) : null}
          </div>
          {state.origin && canSignIn && !cloudflared ? (
            <p id="team-server-cloudflared" className="mt-1 text-detail text-text-muted">
              {CLOUDFLARED_MISSING}
            </p>
          ) : null}
          {state.origin && status?.warning ? (
            <AppInlineNotice
              tone="warning"
              className="mt-2"
              action={
                <span className="flex gap-2">
                  <Button size="sm" disabled={acting} onClick={() => void act(bridge.acceptTeam)}>
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={acting}
                    onClick={() => void act(bridge.signOut)}
                  >
                    Sign out
                  </Button>
                </span>
              }
            >
              {status.warning}
            </AppInlineNotice>
          ) : null}
          {state.overridden ? (
            <p className="mt-1 text-detail text-text-muted" data-testid="team-server-override">
              Set by AGENT_DECK_SHARED_SERVER_URL (dev override)
            </p>
          ) : null}
          {state.restartRequired ? (
            <p className="mt-1 text-detail text-text-muted">
              Agent Deck reloads to use this setting. If it does not, restart Agent Deck.
            </p>
          ) : null}
        </Card>
      )}
      {bridge?.cloudflared ? (
        <CloudflaredSection bridge={bridge} found={cloudflared} setFound={setCloudflared} />
      ) : null}
    </PageShell>
  );
}
