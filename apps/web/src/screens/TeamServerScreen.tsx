import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppInlineNotice } from "@/design-system/components/AppInlineNotice";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { PageShell } from "@/design-system/components/PageShell";
import { SectionHero } from "@/design-system/components/SectionHero";
import { useEffect, useState } from "react";
import { teamServer, type TeamServerState } from "@/lib/native";

/** SRV-16a: the status line; SRV-16b adds the signed-in states. */
export function teamServerStatus(state: TeamServerState): string {
  if (state.overridden) return "Set by AGENT_DECK_SHARED_SERVER_URL (dev override)";
  return state.origin ? "Configured, sign-in pending" : "Not configured";
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

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
    </PageShell>
  );
}
