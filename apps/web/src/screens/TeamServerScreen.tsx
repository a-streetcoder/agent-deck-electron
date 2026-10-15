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
} from "@/lib/native";

/** SRV-16a: the status line; SRV-16b adds the signed-in states. */
export function teamServerStatus(state: TeamServerState): string {
  if (state.overridden) return "Set by AGENT_DECK_SHARED_SERVER_URL (dev override)";
  return state.origin ? "Configured, sign-in pending" : "Not configured";
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

/** Whether sign-in has a cloudflared to run, and the verified download when not. */
function CloudflaredSection({ bridge }: { bridge: TeamServerBridge }) {
  // undefined: loading; null: not found.
  const [found, setFound] = useState<CloudflaredStatus | null | undefined>(undefined);
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
  }, [bridge]);

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
  const [state, setState] = useState<TeamServerState | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setSaving(true);
    setError(null);
    try {
      const result = await bridge.set({ serverUrl: draft.trim() || null });
      if (!result.ok) return setError(result.error);
      const { ok: _ok, ...next } = result;
      setState(next);
      setDraft(next.serverUrl ?? "");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

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
          <p
            className="mt-3 text-detail text-text-muted"
            role="status"
            data-testid="team-server-status"
          >
            {teamServerStatus(state)}
          </p>
          {state.restartRequired ? (
            <p className="mt-1 text-detail text-text-muted">
              Restart Agent Deck to use this setting for Make shared.
            </p>
          ) : null}
        </Card>
      )}
      {bridge?.cloudflared ? <CloudflaredSection bridge={bridge} /> : null}
    </PageShell>
  );
}
