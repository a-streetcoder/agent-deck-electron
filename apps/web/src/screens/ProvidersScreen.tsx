import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, KeyRound, Search, ShieldCheck, UserRound } from "lucide-react";
import { ProviderLoginSheet } from "../components/ProviderLoginSheet.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { useAppStore } from "../state/store.ts";

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

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/runtime/providers");
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { providers: ProviderEntry[] };
      setProviders(data.providers);
    } catch (error) {
      setError(String(error));
    } finally {
      setLoaded(true);
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

  return (
    <div className="min-h-0 flex-1 overflow-hidden px-6 py-5" data-testid="providers-screen">
      <div className="mx-auto flex h-full max-w-3xl flex-col">
        <div className="flex items-center gap-2 pb-1">
          <ShieldCheck size={16} className="text-text-secondary" aria-hidden />
          <h2 className="text-base font-semibold text-text-primary">Connect an AI provider</h2>
        </div>
        <p className="pb-4 text-xs text-text-muted">
          Use an existing subscription or an API key. Credentials are handled by Pi and stored in
          your private Agent Deck configuration.
        </p>
        <label className="mb-4 flex items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2">
          <Search size={14} className="text-text-muted" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none"
            placeholder="Search providers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="min-h-0 flex-1 overflow-y-auto pr-3" data-testid="provider-scroll-area">
          {!loaded ? <SkeletonRows count={5} /> : null}
          <ProviderGroup
            title="Subscriptions"
            providers={subscriptions}
            onSelect={selectProvider}
          />
          <ProviderGroup title="API key" providers={apiKeyOnly} onSelect={selectProvider} />
          {loaded && visible.length === 0 ? (
            <div className="py-8 text-center text-sm text-text-muted">No matching providers.</div>
          ) : null}
        </div>
      </div>

      {methodProvider ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-8">
          <div className="w-[460px] rounded-2xl border border-border-strong bg-surface-elevated p-4 shadow-elevated">
            <h3 className="text-sm font-semibold text-text-primary">
              Connect {methodProvider.name}
            </h3>
            <p className="mt-1 text-xs text-text-muted">Choose how you want to connect.</p>
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
              <button
                className="text-xs text-text-secondary"
                onClick={() => setMethodProvider(null)}
              >
                Cancel
              </button>
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
    </div>
  );
}

function ProviderGroup({
  title,
  providers,
  onSelect,
}: {
  title: string;
  providers: ProviderEntry[];
  onSelect: (provider: ProviderEntry) => void;
}) {
  if (providers.length === 0) return null;
  return (
    <section className="mb-5">
      <h3 className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </h3>
      <div className="space-y-1" data-testid="provider-list">
        {providers.map((provider) => (
          <button
            key={provider.id}
            data-provider-id={provider.id}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-subtle"
            onClick={() => onSelect(provider)}
          >
            <ProviderLogo providerId={provider.id} size={20} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
              {provider.name}
            </span>
            {provider.configured ? (
              <CheckCircle2 size={15} className="text-[var(--color-success)]" />
            ) : (
              <ChevronRight size={14} className="text-text-muted" />
            )}
          </button>
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
    <button
      className="flex w-full items-center gap-3 rounded-xl border border-border-subtle p-3 text-left hover:bg-surface-subtle"
      onClick={onClick}
    >
      <Icon size={18} className="text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        <span className="block text-xs text-text-muted">{detail}</span>
      </span>
      <ChevronRight size={14} className="text-text-muted" />
    </button>
  );
}
