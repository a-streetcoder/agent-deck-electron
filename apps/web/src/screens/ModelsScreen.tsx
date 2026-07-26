import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Cpu, Eye, EyeOff, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { useAppStore } from "../state/store.ts";
import { sendSetModel } from "../state/wsBridge.ts";

/** A model returned by either Pi's live-session catalog or read-only discovery. */
interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  /** Hidden from the picker (app-level curation). */
  disabled?: boolean;
}

interface ActiveModel {
  provider: string;
  id: string;
}

type DiscoveryState = "idle" | "loading" | "success" | "error";

function formatTokens(n?: number): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

export function ModelsScreen() {
  const session = useAppStore((state) => state.session);
  const setError = useAppStore((state) => state.setError);
  const sessionId = session?.id ?? null;
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [active, setActive] = useState<ActiveModel | null>(null);
  const [search, setSearch] = useState("");
  const [discoveryState, setDiscoveryState] = useState<DiscoveryState>("idle");
  const [pendingCuration, setPendingCuration] = useState<Set<string>>(() => new Set());
  const activeRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const focusSearchRequest = useRef<number | null>(null);
  // The ref closes the same-render double-click window before React can commit
  // the disabled button; state drives the visible pending affordance.
  const pendingCurationRef = useRef<Set<string>>(new Set());

  // Pi's authoritative active model — used on load and to reconcile a select().
  const loadState = useCallback(async (id: string, signal?: AbortSignal): Promise<void> => {
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(id)}/state`, { signal });
      if (!res.ok || activeRef.current !== id) return;
      const { state } = (await res.json()) as {
        state: { model?: { provider: string; id: string } };
      };
      if (activeRef.current !== id || signal?.aborted) return;
      setActive(state.model ? { provider: state.model.provider, id: state.model.id } : null);
    } catch {
      // Transient or cancelled; a later load reconciles.
    }
  }, []);

  const loadSource = useCallback(
    (restoreSearchFocus = false): void => {
      requestAbort.current?.abort();
      const controller = new AbortController();
      requestAbort.current = controller;
      const request = ++requestRef.current;
      focusSearchRequest.current = restoreSearchFocus ? request : null;
      const id = sessionId;
      const sourceChanged = activeRef.current !== id;
      activeRef.current = id;
      if (sourceChanged) {
        setModels([]);
        setActive(null);
      }

      if (id) {
        setDiscoveryState("idle");
        void (async () => {
          try {
            const res = await fetch(`/sessions/${encodeURIComponent(id)}/models`, {
              signal: controller.signal,
            });
            if (res.ok && request === requestRef.current && !controller.signal.aborted) {
              const data = (await res.json()) as { models: CatalogModel[] };
              if (request === requestRef.current && !controller.signal.aborted) {
                setModels(data.models);
              }
            }
            await loadState(id, controller.signal);
          } catch (error) {
            if (request === requestRef.current && !controller.signal.aborted)
              setError(String(error));
          }
        })();
        return;
      }

      setDiscoveryState("loading");
      void fetch("/runtime/models/discover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error("model discovery failed");
          return response.json() as Promise<{ models: CatalogModel[] }>;
        })
        .then((data) => {
          if (request !== requestRef.current || controller.signal.aborted) return;
          setModels(data.models);
          setDiscoveryState("success");
        })
        .catch(() => {
          if (request !== requestRef.current || controller.signal.aborted) return;
          setDiscoveryState("error");
        });
    },
    [loadState, sessionId, setError],
  );

  useEffect(() => {
    loadSource();
    return () => {
      requestAbort.current?.abort();
      requestRef.current += 1;
      if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
    };
  }, [loadSource]);

  // Focus only after the successful catalog render has committed the search
  // input. A newer source/request clears the token, so stale completions cannot
  // steal focus after a session transition or cancellation.
  useEffect(() => {
    const request = focusSearchRequest.current;
    if (
      discoveryState !== "success" ||
      request === null ||
      request !== requestRef.current ||
      requestAbort.current?.signal.aborted
    ) {
      return;
    }
    searchInput.current?.focus();
    focusSearchRequest.current = null;
  }, [discoveryState, models]);

  const select = (model: CatalogModel): void => {
    if (!sessionId) return;
    sendSetModel(model.provider, model.id);
    setActive({ provider: model.provider, id: model.id }); // optimistic for live sessions only
    // Reconcile against Pi's actual state — set_model can reject a model.
    if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
    reconcileTimer.current = setTimeout(() => {
      if (activeRef.current) void loadState(activeRef.current);
    }, 500);
  };

  const toggleDisabled = async (model: CatalogModel): Promise<void> => {
    const key = `${model.provider}:${model.id}`;
    if (pendingCurationRef.current.has(key)) return;
    pendingCurationRef.current.add(key);
    setPendingCuration(new Set(pendingCurationRef.current));
    try {
      const response = await fetch("/runtime/models/disabled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: model.provider, id: model.id, disabled: !model.disabled }),
      });
      if (!response.ok) return;
      if (sessionId) {
        loadSource(); // preserve the live route as the source of truth
      } else {
        setModels((current) =>
          current.map((entry) =>
            entry.provider === model.provider && entry.id === model.id
              ? { ...entry, disabled: !model.disabled }
              : entry,
          ),
        );
      }
    } catch {
      // Keep the authoritative row unchanged; a later click can retry.
    } finally {
      pendingCurationRef.current.delete(key);
      setPendingCuration(new Set(pendingCurationRef.current));
    }
  };

  const query = search.trim().toLowerCase();
  const filtered = query
    ? models.filter((m) => `${m.name ?? ""} ${m.id} ${m.provider}`.toLowerCase().includes(query))
    : models;
  const byProvider = new Map<string, CatalogModel[]>();
  for (const model of filtered) {
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  }

  const showCatalog = sessionId
    ? models.length > 0
    : discoveryState === "success" && models.length > 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="models-screen">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 pb-1">
          <Cpu size={16} className="text-text-secondary" aria-hidden />
          <h2
            className="text-base font-semibold text-text-primary"
            style={{ fontStretch: "expanded" }}
          >
            Models
          </h2>
        </div>
        <p className="pb-3 text-xs text-text-muted">
          {sessionId
            ? "Models available to the current session. Select one to make it active."
            : "Browse and curate available models now. Start a session to activate a model."}
        </p>

        {!sessionId && discoveryState === "loading" ? (
          <div
            className="py-8 text-center text-sm text-text-muted"
            role="status"
            data-testid="models-loading"
          >
            Discovering available models…
          </div>
        ) : !sessionId && discoveryState === "error" ? (
          <div
            className="py-8 text-center text-sm text-text-muted"
            role="alert"
            data-testid="models-error"
          >
            <p>Models could not be discovered.</p>
            <ControlButton
              type="button"
              data-testid="models-retry"
              className="mt-3 rounded-capsule border border-border-strong px-3 py-1 text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => loadSource(true)}
            >
              Retry
            </ControlButton>
          </div>
        ) : (!sessionId && discoveryState === "success" && models.length === 0) ||
          (sessionId && models.length === 0) ? (
          <div
            className="py-8 text-center text-sm text-text-muted"
            role="status"
            data-testid="models-empty"
          >
            No models available — check your provider configuration in Environment.
          </div>
        ) : showCatalog ? (
          <>
            <ControlInput
              ref={searchInput}
              data-testid="models-search"
              className="mb-3 w-full rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="Search models by name, id, or provider…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {filtered.length === 0 ? (
              <div
                className="py-8 text-center text-sm text-text-muted"
                data-testid="models-search-empty"
              >
                No models match your search.
              </div>
            ) : null}
            <div className="space-y-4">
              {[...byProvider.entries()].map(([provider, providerModels]) => (
                <div key={provider}>
                  <div className="flex items-center gap-1.5 px-1 pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                    <ProviderLogo providerId={provider} size={13} className="text-text-secondary" />
                    {provider}
                  </div>
                  <div className="space-y-1.5">
                    {providerModels.map((model) => {
                      const isActive =
                        Boolean(sessionId) &&
                        active?.provider === provider &&
                        active?.id === model.id;
                      const modelKey = `${model.provider}:${model.id}`;
                      const isCurationPending = pendingCuration.has(modelKey);
                      const ctx = formatTokens(model.contextWindow);
                      const out = formatTokens(model.maxTokens);
                      return (
                        <div
                          key={model.id}
                          data-testid={`model-${model.id}`}
                          data-active={isActive}
                          data-disabled={model.disabled ? "true" : "false"}
                          className={cn(
                            "flex items-center gap-1 rounded-xl border transition-colors",
                            isActive
                              ? "border-accent bg-selection"
                              : "border-border-subtle bg-surface",
                          )}
                        >
                          <ControlButton
                            type="button"
                            data-testid={`model-select-${model.id}`}
                            disabled={!sessionId || model.disabled}
                            title={
                              !sessionId ? "Start a session to activate this model" : undefined
                            }
                            className={cn(
                              "flex min-w-0 flex-1 items-center gap-3 rounded-l-[14px] px-3.5 py-2.5 text-left",
                              sessionId && !model.disabled && !isActive && "hover:bg-hover",
                              (!sessionId || model.disabled) && "cursor-default",
                            )}
                            onClick={() => select(model)}
                          >
                            <div className={cn("min-w-0 flex-1", model.disabled && "opacity-60")}>
                              <div className="flex items-center gap-2">
                                <span
                                  className="truncate text-sm font-medium text-text-primary"
                                  style={{ fontStretch: "expanded" }}
                                >
                                  {model.name ?? model.id}
                                </span>
                                {model.reasoning ? (
                                  <span
                                    data-testid="reasoning-badge"
                                    className="flex items-center gap-0.5 rounded-capsule border border-border-subtle px-1.5 text-micro text-text-secondary"
                                  >
                                    <Sparkles size={9} aria-hidden /> reasoning
                                  </span>
                                ) : null}
                              </div>
                              <div className="truncate font-mono text-detail text-text-muted">
                                {model.id}
                              </div>
                            </div>
                            <div
                              className={cn(
                                "flex shrink-0 items-center gap-3 text-detail text-text-muted",
                                model.disabled && "opacity-60",
                              )}
                            >
                              {ctx ? <span title="Context window">{ctx} ctx</span> : null}
                              {out ? <span title="Max output tokens">{out} out</span> : null}
                              {model.input?.includes("image") ? <span>image</span> : null}
                              {!sessionId ? (
                                <span data-testid={`model-activation-help-${model.id}`}>
                                  Browse only · Start a session to activate
                                </span>
                              ) : null}
                              {isActive ? (
                                <Check
                                  size={15}
                                  style={{ color: "var(--color-brand-accent)" }}
                                  aria-label="Active model"
                                />
                              ) : null}
                            </div>
                          </ControlButton>
                          <ControlButton
                            type="button"
                            data-testid={`model-toggle-${model.id}`}
                            aria-label={model.disabled ? "Enable model" : "Disable model"}
                            aria-busy={isCurationPending}
                            title={model.disabled ? "Show in picker" : "Hide from picker"}
                            disabled={isCurationPending}
                            className="flex shrink-0 items-center gap-1.5 rounded-r-[14px] px-3 py-2.5 text-detail text-text-secondary outline-none hover:bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
                            onClick={() => void toggleDisabled(model)}
                          >
                            {model.disabled ? (
                              <EyeOff size={15} aria-hidden />
                            ) : (
                              <Eye size={15} aria-hidden />
                            )}
                            <span>
                              {model.disabled ? "Hidden from pickers" : "Shown in pickers"}
                            </span>
                          </ControlButton>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
