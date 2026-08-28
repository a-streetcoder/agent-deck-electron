import { Button } from "@/design-system/components/Button";
import { ControlButton } from "@/design-system/components/NativeControls";
import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppSpinner } from "@/design-system/components/AppSpinner";
import { AppTextField } from "@/design-system/components/AppTextField";
import { PageShell } from "@/design-system/components/PageShell";
import { PageToolbar } from "@/design-system/components/PageToolbar";
import { SectionHero } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, KeyRound, LogOut, Search, UserRound } from "lucide-react";
import { ProviderLoginSheet } from "../components/ProviderLoginSheet.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { useAppStore } from "../state/store.ts";
import { sectionHeaderClass } from "@/design-system/styles";
import { cn } from "@/lib/cn";

interface ProviderEntry {
  id: string;
  name: string;
  configured: boolean;
  source?: string;
  label?: string;
  signedIn: boolean;
  supportsAPIKey: boolean;
  supportsOAuth: boolean;
}

type AuthType = "api_key" | "oauth";

export function ProvidersScreen({
  onProviderConnected,
}: { onProviderConnected?: () => void } = {}) {
  const setError = useAppStore((state) => state.setError);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [methodProvider, setMethodProvider] = useState<ProviderEntry | null>(null);
  const [login, setLogin] = useState<{ provider: ProviderEntry; authType: AuthType } | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    try {
      const response = await fetch("/runtime/providers");
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { providers: ProviderEntry[] };
      if (generation !== loadGenerationRef.current) return;
      setProviders(data.providers);
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setError(String(error));
    } finally {
      if (generation === loadGenerationRef.current) setLoaded(true);
    }
  }, [setError]);

  useEffect(() => void load(), [load, resourcesVersion]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return providers.filter(
      (provider) =>
        !query || provider.name.toLowerCase().includes(query) || provider.id.includes(query),
    );
  }, [providers, search]);
  const subscriptions = visible.filter((provider) => provider.supportsOAuth);
  const apiKeyOnly = visible.filter(
    (provider) => provider.supportsAPIKey && !provider.supportsOAuth,
  );

  const selectProvider = (provider: ProviderEntry): void => {
    if (provider.supportsOAuth && provider.supportsAPIKey) setMethodProvider(provider);
    else setLogin({ provider, authType: provider.supportsOAuth ? "oauth" : "api_key" });
  };

  const signOutProvider = async (provider: ProviderEntry): Promise<void> => {
    if (!provider.signedIn || disconnectingId) return;
    setDisconnectingId(provider.id);
    setError(null);
    try {
      const response = await fetch(`/runtime/providers/${encodeURIComponent(provider.id)}/logout`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await response.text());
      await load();
    } catch (error) {
      setError(String(error));
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <PageShell
      width="page"
      testId="providers-screen"
      hero={
        <SectionHero
          imageSrc="/onboarding/pop-hero.jpg"
          title="Providers"
          subtitle="Use an existing subscription or an API key. Credentials are handled by Pi and stored in your private Agent Deck configuration."
        />
      }
      toolbar={
        <PageToolbar
          leading={
            <AppTextField
              size="sm"
              showClear
              leadingIcon={<Search size={14} aria-hidden />}
              placeholder="Search providers"
              value={search}
              onChange={setSearch}
              aria-label="Search providers"
            />
          }
        />
      }
    >
      <div data-testid="provider-scroll-area">
        {!loaded ? (
          <AppEmptyState heading="Loading providers…" icon={<AppSpinner size="md" />} />
        ) : null}
        <ProviderGroup
          title="Subscriptions"
          providers={subscriptions}
          onSelect={selectProvider}
          onSignOut={(provider) => void signOutProvider(provider)}
          disconnectingId={disconnectingId}
        />
        <ProviderGroup
          title="API key"
          providers={apiKeyOnly}
          onSelect={selectProvider}
          onSignOut={(provider) => void signOutProvider(provider)}
          disconnectingId={disconnectingId}
        />
        {loaded && visible.length === 0 ? <AppEmptyState heading="No matching providers." /> : null}
      </div>

      {methodProvider ? (
        <div
          className="app-modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-overlay p-4 sm:p-8"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMethodProvider(null);
          }}
        >
          <div
            className="app-modal-panel w-full max-w-[460px] rounded-2xl border border-border-strong bg-surface-elevated p-4 shadow-elevated"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-method-title"
          >
            <h3 id="provider-method-title" className="text-label font-semibold text-text-primary">
              Connect {methodProvider.name}
            </h3>
            <p className="mt-1 text-caption text-text-muted">Choose how you want to connect.</p>
            <div className="mt-4 space-y-2">
              <MethodButton
                icon={UserRound}
                title="Use a subscription"
                detail={`Sign in with your ${methodProvider.name} account.`}
                onClick={() => {
                  setLogin({ provider: methodProvider, authType: "oauth" });
                  setMethodProvider(null);
                }}
              />
              <MethodButton
                icon={KeyRound}
                title="Use an API key"
                detail="Paste an API key for this provider."
                onClick={() => {
                  setLogin({ provider: methodProvider, authType: "api_key" });
                  setMethodProvider(null);
                }}
              />
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                size="md"
                variant="secondary"
                onClick={() => setMethodProvider(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {login ? (
        <ProviderLoginSheet
          provider={login.provider}
          authType={login.authType}
          onClose={() => setLogin(null)}
          onDone={() => {
            void load();
            onProviderConnected?.();
          }}
        />
      ) : null}
    </PageShell>
  );
}

function ProviderGroup({
  title,
  providers,
  onSelect,
  onSignOut,
  disconnectingId,
}: {
  title: string;
  providers: ProviderEntry[];
  onSelect: (provider: ProviderEntry) => void;
  onSignOut: (provider: ProviderEntry) => void;
  disconnectingId: string | null;
}) {
  if (providers.length === 0) return null;
  return (
    <section className="mb-5">
      <h3 className={cn(sectionHeaderClass, "mb-1 px-2 text-text-muted")}>{title}</h3>
      <div className="space-y-1" data-testid="provider-list">
        {providers.map((provider) => (
          <div
            key={provider.id}
            className="flex items-center rounded-xl border border-border-subtle bg-surface-elevated px-3.5 py-2.5"
          >
            <ControlButton
              data-provider-id={provider.id}
              data-configured={provider.configured ? "true" : "false"}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left"
              disabled={disconnectingId !== null}
              onClick={() => onSelect(provider)}
            >
              <ProviderLogo providerId={provider.id} size={20} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-label font-medium text-text-primary">
                {provider.name}
              </span>
              {provider.configured ? (
                <CheckCircle2 size={15} className="shrink-0 text-success" aria-label="Connected" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-text-muted" />
              )}
            </ControlButton>
            {provider.signedIn ? (
              <Button
                type="button"
                data-testid={`provider-signout-${provider.id}`}
                size="sm"
                variant="destructiveOutline"
                leadingIcon={<LogOut size={12} aria-hidden />}
                aria-label={`Sign out of ${provider.name}`}
                title={`Sign out of ${provider.name} and remove its stored credentials`}
                disabled={disconnectingId !== null}
                onClick={() => onSignOut(provider)}
              >
                {disconnectingId === provider.id ? "Signing out…" : "Sign out"}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function MethodButton({
  icon: Icon,
  title,
  detail,
  onClick,
}: {
  icon: typeof KeyRound;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <ControlButton
      className="flex w-full items-center gap-3 rounded-xl border border-border-subtle p-3 text-left hover:bg-surface-subtle"
      onClick={onClick}
    >
      <Icon size={18} className="text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-label font-medium text-text-primary">{title}</span>
        <span className="block text-caption text-text-muted">{detail}</span>
      </span>
      <ChevronRight size={14} className="text-text-muted" />
    </ControlButton>
  );
}
