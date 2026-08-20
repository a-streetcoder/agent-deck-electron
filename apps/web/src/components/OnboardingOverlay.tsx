import { ControlButton, ControlSelect } from "@/design-system/components/NativeControls";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FolderPlus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  SlidersHorizontal,
  Stethoscope,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { PI_THINKING_LEVELS } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { ProvidersScreen } from "../screens/ProvidersScreen.tsx";
import { useAppStore, type AppView } from "../state/store.ts";

/**
 * First-run onboarding (native WelcomeOnboardingSheet): a phased flow, not just a
 * marketing slideshow. Native runs tour → Setup Check → Preferences → Final; this
 * builds tour → Setup Check → Preferences → Final. The Setup
 * Check is a real dependency doctor (the same /runtime/doctor the Doctor screen
 * uses) that flags what's missing with fixes, followed by Preferences and a Final
 * step that smart-routes wherever setup still needs attention.
 * Reuses the native onboarding artwork (public/onboarding/pop-onb-*).
 */

const KEY = "agentdeck-onboarding-dismissed";

interface Page {
  image: string;
  title: string;
  description: string;
}

// Copy ported from native OnboardingViews.swift (Mac-specific wording generalized).
const PAGES: Page[] = [
  {
    image: "/onboarding/pop-onb-1.jpg",
    title: "Command Pi from Agent Deck",
    description:
      "Run Pi coding sessions from a focused workspace with project context, models, repo activity, and session state in one place.",
  },
  {
    image: "/onboarding/pop-onb-2.png",
    title: "Work in a Coding Chat",
    description:
      "Use a customizable chat built for implementation work: full transcripts, tool calls, file previews, attachments, and live controls.",
  },
  {
    image: "/onboarding/pop-onb-3.png",
    title: "Orchestrate Deck Agents",
    description:
      "Delegate focused work to custom Deck agents, run them alone or in parallel, supervise decisions, and keep worktrees isolated.",
  },
  {
    image: "/onboarding/pop-onb-4.png",
    title: "Shape Your Agent System",
    description:
      "Create, organize, assign, and reuse agents, skills, and prompts so project workflows become clear, portable, and repeatable.",
  },
  {
    image: "/onboarding/pop-onb-5.png",
    title: "Manage Project Instructions",
    description:
      "Control system guidance, AGENTS.md, CLAUDE.md, and project-scoped instructions from one place instead of hunting through files.",
  },
  {
    image: "/onboarding/pop-onb-6.png",
    title: "Connect the Wider Workflow",
    description:
      "Bring in GitHub, project folders, environment keys, and model setup when you need them. Setup checks confirm the workspace is ready.",
  },
];

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Force the onboarding to show regardless of projects/dismissed state — a way to
 * replay it (the flow otherwise only appears on genuine first run). Triggered by
 * `?onboarding` in the URL or `localStorage['agentdeck-onboarding-force']='1'`
 * (set via devtools in the desktop app, where the URL is fixed).
 */
const FORCE_KEY = "agentdeck-onboarding-force";
const EMPTY_SETUP_PREVIEW =
  import.meta.env.DEV && import.meta.env.VITE_AGENT_DECK_ONBOARDING_PREVIEW === "empty";
function onboardingForced(): boolean {
  try {
    if (EMPTY_SETUP_PREVIEW) return true;
    if (new URLSearchParams(window.location.search).has("onboarding")) return true;
    return localStorage.getItem(FORCE_KEY) === "1";
  } catch {
    return false;
  }
}

type Phase = "tour" | "setup" | "provider" | "preferences" | "final";

interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
  fixCommand?: string;
}

const EMPTY_SETUP_CHECKS: HealthCheck[] = [
  { id: "pi-binary", label: "Pi", status: "ok", detail: "Included with Agent Deck" },
  { id: "pi-version", label: "Pi version", status: "ok", detail: "0.82.0" },
  {
    id: "node",
    label: "Built-in runtime",
    status: "ok",
    detail: "Included with Agent Deck",
  },
  { id: "bash", label: "Shell tools", status: "ok", detail: "Ready" },
  { id: "git", label: "Git", status: "warn", detail: "Git is not installed" },
  { id: "github", label: "GitHub", status: "warn", detail: "GitHub is not connected" },
  {
    id: "auth",
    label: "AI model connection",
    status: "warn",
    detail: "Connect an AI model provider to run coding sessions",
  },
  { id: "settings", label: "Pi settings", status: "ok", detail: "Fresh defaults" },
];

function emptyPreviewChecks(providerConnected: boolean): HealthCheck[] {
  if (!providerConnected) return EMPTY_SETUP_CHECKS;
  return EMPTY_SETUP_CHECKS.map((check) =>
    check.id === "auth" ? { ...check, status: "ok", detail: "1 connected: AI provider" } : check,
  );
}

/** The onboarding-preferences slice of AppSettings (native OnboardingPreferences). */
interface Prefs {
  autoTitle: boolean;
  worktreeIsolation: boolean;
  keepWorktreeAfterMerge: boolean;
  gitAutomation: boolean;
  subagentsEnabled: boolean;
  defaultModel: string | null;
  defaultThinking: string | null;
}

interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  disabled?: boolean;
}

// Native SetupCheckStatus mapping: ok → Ready, warn → Optional, error → Missing.
const SUMMARY_CHECK_IDS = ["pi-version", "node", "auth", "github"] as const;

function summaryCheckLabel(id: string): string {
  switch (id) {
    case "pi-version":
      return "Pi";
    case "node":
      return "Built-in runtime";
    case "auth":
      return "AI models";
    case "github":
      return "GitHub";
    default:
      return id;
  }
}

function summaryCheckDetail(check: HealthCheck): string {
  if (check.id === "pi-version") return `Version ${check.detail}`;
  if (check.id === "node") {
    const version = check.detail.match(/v?\d+\.\d+\.\d+/)?.[0];
    return version ? `Included • ${version}` : "Included with Agent Deck";
  }
  if (check.id === "auth" && check.status === "ok") {
    const count = check.detail.match(/^\d+/)?.[0];
    return count ? `${count} AI services connected` : "Connected";
  }
  if (check.id === "github" && check.status === "ok") return "Connected";
  return check.status === "ok" ? "Ready" : check.detail;
}

function friendlyCheckDetail(check: HealthCheck): string {
  if (check.status !== "ok") return check.detail;
  if (check.id === "pi-binary") return "Installed and ready";
  if (check.id === "pi-version") return `Version ${check.detail}`;
  if (check.id === "node") return summaryCheckDetail(check);
  if (check.id === "bash") return "Available";
  if (check.id === "git") {
    const version = check.detail.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
    return version ? `Version ${version}` : "Available";
  }
  if (check.id === "github") return "Connected";
  if (check.id === "auth") return summaryCheckDetail(check);
  if (check.id === "settings") return "Configuration looks good";
  return "Ready";
}

const STATUS_META = {
  ok: { label: "Ready", Icon: CheckCircle2, color: "var(--color-success)" },
  warn: { label: "Optional", Icon: TriangleAlert, color: "var(--color-warning)" },
  error: { label: "Missing", Icon: XCircle, color: "var(--color-role-error)" },
} as const;

/** Copy a check's fix command; flips to "Copied" briefly (native Doctor Fix). */
function CopyFixButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = (): void => {
    let promise: Promise<void> | undefined;
    try {
      promise = navigator.clipboard?.writeText(command);
    } catch {
      return;
    }
    void promise?.then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <ControlButton
      data-testid="onboarding-fix-copy"
      data-fix-command={command}
      title={`Copy: ${command}`}
      className="flex shrink-0 items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 font-mono text-micro text-text-secondary hover:text-text-primary"
      onClick={copy}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy fix"}
    </ControlButton>
  );
}

const primaryButtonClass =
  "flex items-center gap-1.5 rounded-capsule px-3.5 py-1.5 text-xs font-medium shadow-capsule";
const overlayBackButtonClass =
  "flex items-center gap-1 rounded-capsule py-1 pr-2.5 text-xs text-text-secondary hover:text-text-primary";

function modelCatalogValue(model: CatalogModel): string {
  return `${model.provider}:${model.id}`;
}

function PrefModelPicker({
  models,
  value,
  disabled,
  onChange,
  triggerRef,
}: {
  models: CatalogModel[];
  value: string | null;
  disabled: boolean;
  onChange: (next: string | null) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(null);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) {
      setProviderId(null);
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, triggerRef]);

  const byProvider = new Map<string, CatalogModel[]>();
  for (const model of models) {
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  }
  const selected = models.find((model) => modelCatalogValue(model) === value);
  const triggerLabel = !value
    ? "Pi's default"
    : (selected?.name ?? selected?.id ?? `${value} (saved)`);
  const savedMissing = Boolean(
    value && !models.some((model) => modelCatalogValue(model) === value),
  );
  const close = (): void => {
    setOpen(false);
    setProviderId(null);
  };
  const select = (next: string | null): void => {
    if (disabled) return;
    onChange(next);
    close();
  };
  const providerModels = providerId ? (byProvider.get(providerId) ?? []) : [];

  return (
    <div className="relative">
      <ControlButton
        ref={triggerRef}
        id="pref-model"
        data-testid="pref-model"
        data-value={value ?? ""}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-2 py-1.5 text-left text-sm text-text-primary outline-none focus:border-accent disabled:opacity-40"
        onClick={() => setOpen(true)}
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown size={16} className="shrink-0 text-text-muted" aria-hidden />
      </ControlButton>
      {open
        ? createPortal(
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center bg-overlay px-5"
              role="dialog"
              aria-modal="true"
              aria-label="Default model"
              data-testid="pref-model-dialog"
            >
              <ControlButton
                type="button"
                tabIndex={-1}
                className="absolute inset-0 cursor-default"
                aria-label="Close model picker"
                data-testid="pref-model-dialog-backdrop"
                onClick={close}
              />
              <div className="relative z-10 flex max-h-[min(70vh,40rem)] w-full min-w-0 max-w-lg shrink-0 flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-elevated p-5 shadow-elevated">
                {providerId === null ? (
                  <div className="min-h-0 overflow-y-auto">
                    <ControlButton
                      type="button"
                      data-testid="pref-model-option-default"
                      className={cn(
                        "block w-full truncate rounded-md px-2 py-2 text-left text-sm",
                        !value
                          ? "bg-selection text-text-primary"
                          : "text-text-secondary hover:bg-hover",
                      )}
                      onClick={() => select(null)}
                    >
                      Pi&apos;s default
                    </ControlButton>
                    {savedMissing && value ? (
                      <ControlButton
                        type="button"
                        data-testid={`pref-model-option-${value}`}
                        className="block w-full truncate rounded-md bg-selection px-2 py-2 text-left text-sm text-text-primary"
                        onClick={() => select(value)}
                      >
                        {value} (saved)
                      </ControlButton>
                    ) : null}
                    {[...byProvider.keys()].map((provider) => (
                      <ControlButton
                        key={provider}
                        type="button"
                        data-testid={`pref-model-provider-${provider}`}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-text-secondary hover:bg-hover hover:text-text-primary"
                        onClick={() => setProviderId(provider)}
                      >
                        <ProviderLogo
                          providerId={provider}
                          size={18}
                          className="text-text-secondary"
                        />
                        <span className="text-micro font-semibold uppercase tracking-wider">
                          {provider}
                        </span>
                      </ControlButton>
                    ))}
                  </div>
                ) : (
                  <>
                    <ControlButton
                      type="button"
                      data-testid="pref-model-providers-back"
                      className="flex items-center gap-1 self-start rounded-md px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                      onClick={() => setProviderId(null)}
                    >
                      <ArrowLeft size={13} /> Back
                    </ControlButton>
                    <div className="flex items-center gap-2 px-2 py-2 text-micro font-semibold uppercase tracking-wider text-text-muted">
                      <ProviderLogo
                        providerId={providerId}
                        size={16}
                        className="text-text-secondary"
                      />
                      <span className="truncate">{providerId}</span>
                    </div>
                    <div className="border-t border-border-subtle" />
                    <div className="min-h-0 flex-1 overflow-y-auto pt-2">
                      {providerModels.map((model) => {
                        const optionValue = modelCatalogValue(model);
                        const active = optionValue === value;
                        return (
                          <ControlButton
                            key={optionValue}
                            type="button"
                            data-testid={`pref-model-option-${optionValue}`}
                            className={cn(
                              "block w-full truncate rounded-md px-2 py-2 text-left text-sm",
                              active
                                ? "bg-selection text-text-primary"
                                : "text-text-secondary hover:bg-hover",
                            )}
                            onClick={() => select(optionValue)}
                          >
                            {model.name ?? model.id}
                          </ControlButton>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
const primaryButtonStyle = {
  background:
    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
  color: "var(--color-accent-foreground)",
} as const;

/**
 * ONB-01 — the final step's smart-routing (native OnboardingFinalView
 * primaryTarget: "land the user in the one place that fixes what's still
 * missing"). Precedence: broken pi/node → Doctor; no provider → Providers;
 * provider connected but NO usable models (native's pi-models row) →
 * Providers to load models; no project → Projects; green → Start Coding.
 * Pure and exported for the unit pin.
 */
export function finalCtaFor(flags: {
  piMissing: boolean;
  providerMissing: boolean;
  modelsMissing: boolean;
  projectMissing: boolean;
}): { label: string; view: AppView } {
  if (flags.piMissing) return { label: "Review Setup", view: "doctor" };
  if (flags.providerMissing) return { label: "Connect a Provider", view: "providers" };
  if (flags.modelsMissing) return { label: "Load AI Models", view: "providers" };
  if (flags.projectMissing) return { label: "Add a Project", view: "projects" };
  return { label: "Start Coding", view: "chat" };
}

export function OnboardingOverlay() {
  const projects = useAppStore((state) => state.projects);
  const projectsLoaded = useAppStore((state) => state.projectsLoaded);
  const setView = useAppStore((state) => state.setView);
  const forced = onboardingForced();
  // When forced, ignore a prior dismissal so a returning user can still replay it.
  const [dismissed, setDismissed] = useState(() => (forced ? false : wasDismissed()));
  const [phase, setPhase] = useState<Phase>("tour");
  const [page, setPage] = useState(0);
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [modelState, setModelState] = useState<
    "idle" | "initial-loading" | "loading" | "success" | "error"
  >("idle");
  const modelReq = useRef(0);
  const modelAbort = useRef<AbortController | null>(null);
  const modelSelect = useRef<HTMLButtonElement | null>(null);
  // Monotonic request id: a slow earlier /runtime/doctor response must not
  // overwrite a newer one (rapid Re-check, or the setup→final refetch).
  const checksReq = useRef(0);
  // Credentials in the empty preview are real but isolated in its temporary home.
  const previewProviderConnected = useRef(false);
  // Serializes preference PATCHes so two writes to the same key can't land out
  // of order (last click must win on the server, not last-to-arrive).
  const patchChain = useRef<Promise<unknown>>(Promise.resolve());

  // First-run setup is proactive: start the doctor as soon as onboarding mounts
  // instead of making the user advance through the tour before checks begin.
  useEffect(() => {
    const req = ++checksReq.current;
    setChecksLoading(true);
    if (EMPTY_SETUP_PREVIEW) {
      const timer = window.setTimeout(() => {
        if (req === checksReq.current) {
          setChecks(emptyPreviewChecks(previewProviderConnected.current));
          setChecksLoading(false);
        }
      }, 1_200);
      return () => window.clearTimeout(timer);
    }
    void fetch("/runtime/doctor")
      .then((response) => response.json())
      .then((data: { report: { checks: HealthCheck[] } }) => {
        if (req === checksReq.current) setChecks(data.report.checks);
      })
      .catch(() => {
        if (req === checksReq.current) setChecks([]);
      })
      .finally(() => {
        if (req === checksReq.current) setChecksLoading(false);
      });
  }, []);

  useEffect(
    () => () => {
      modelAbort.current?.abort();
      modelReq.current += 1;
    },
    [],
  );

  // The tour advances on its own, while direct controls remain on the artwork.
  useEffect(() => {
    if (phase !== "tour" || page === PAGES.length - 1) return;
    const timer = window.setTimeout(() => {
      setPage((current) => Math.min(current + 1, PAGES.length - 1));
    }, 6_000);
    return () => window.clearTimeout(timer);
  }, [page, phase]);

  // A close during this session always wins (even when forced via ?onboarding,
  // where the URL param would otherwise keep re-showing it).
  if (dismissed) return null;
  // Wait for the initial fetch so a returning user never flashes the overlay.
  // `forced` replays it regardless of projects/dismissal — used for testing.
  if (!forced && (!projectsLoaded || projects.length > 0)) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(KEY, "1");
      localStorage.removeItem(FORCE_KEY); // clear the replay flag so it doesn't reappear
    } catch {
      // Storage disabled — it just won't be remembered across reloads.
    }
    setDismissed(true);
  };
  const finishTo = (view: AppView): void => {
    dismiss();
    setView(view);
  };

  const runChecks = (): void => {
    const req = ++checksReq.current;
    setChecksLoading(true);
    if (EMPTY_SETUP_PREVIEW) {
      window.setTimeout(() => {
        if (req === checksReq.current) {
          setChecks(emptyPreviewChecks(previewProviderConnected.current));
          setChecksLoading(false);
        }
      }, 1_200);
      return;
    }
    void fetch("/runtime/doctor")
      .then((response) => response.json())
      .then((data: { report: { checks: HealthCheck[] } }) => {
        if (req === checksReq.current) setChecks(data.report.checks);
      })
      .catch(() => {
        if (req === checksReq.current) setChecks([]);
      })
      .finally(() => {
        if (req === checksReq.current) setChecksLoading(false);
      });
  };
  const discoverModels = (initial: boolean, restoreSelectFocus = false): void => {
    modelAbort.current?.abort();
    const controller = new AbortController();
    modelAbort.current = controller;
    const req = ++modelReq.current;
    setModelState(initial ? "initial-loading" : "loading");
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
        if (req !== modelReq.current || controller.signal.aborted) return;
        setModels(data.models.filter((model) => !model.disabled));
        setModelState("success");
        if (restoreSelectFocus) {
          window.requestAnimationFrame(() => {
            if (req === modelReq.current && !controller.signal.aborted) {
              modelSelect.current?.focus();
            }
          });
        }
      })
      .catch(() => {
        if (req !== modelReq.current || controller.signal.aborted) return;
        setModelState("error");
      });
  };

  // Load saved settings once, but discover models on every Preferences entry so
  // a newly connected provider is reflected without a session or a client cache.
  const loadPreferences = (): void => {
    // Load the saved settings ONCE — refetching after the user has toggled would
    // overwrite the optimistic local edits with (possibly stale) server state.
    if (prefs === null) {
      void fetch("/settings")
        .then((response) => response.json())
        .then((data: { settings: Prefs }) => {
          const s = data.settings;
          setPrefs({
            autoTitle: s.autoTitle,
            worktreeIsolation: s.worktreeIsolation,
            keepWorktreeAfterMerge: s.keepWorktreeAfterMerge,
            gitAutomation: s.gitAutomation,
            subagentsEnabled: s.subagentsEnabled,
            defaultModel: s.defaultModel,
            defaultThinking: s.defaultThinking,
          });
        })
        .catch(() => {});
    }
    discoverModels(true);
  };
  // Optimistic locally; the PATCH is serialized through a chain so two writes to
  // the same key land in click order. The server merges only the provided fields.
  const patchPref = (patch: Partial<Prefs>): void => {
    setPrefs((p) => (p ? { ...p, ...patch } : p));
    patchChain.current = patchChain.current
      .catch(() => {})
      .then(() =>
        fetch("/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }).catch(() => {}),
      );
  };

  const goto = (next: Phase): void => {
    if (next !== "preferences") {
      modelAbort.current?.abort();
      modelAbort.current = null;
    }
    setPhase(next);
    if (next === "setup" || next === "final") runChecks();
    // ONB-01 (native's pi-models gate): the final step needs the model catalog
    // to judge readiness. Re-kick discovery unless a catalog already loaded —
    // the abort above can strand modelState at "loading" (the aborted fetch's
    // catch returns without resetting), so gating on "idle" would silently
    // never re-run and the gate could never fire.
    if (next === "final" && modelState !== "success") discoverModels(true);
    if (next === "preferences") loadPreferences();
  };

  // Final-step routing gates (native OnboardingFinalView.primaryTarget). pi/node
  // hard-error → Review Setup; no provider creds → Connect a Provider; no project
  // → Add a Project; otherwise everything's ready → Start Coding.
  const checkById = (id: string): HealthCheck | undefined => checks.find((c) => c.id === id);
  // Native's piPassed is STRICT (every runtime row green): any core runtime
  // check that is not ok routes to Doctor — the CTA is never a disabled dead
  // end for a state it cannot name (Codex: pi-version/bash used to disable
  // the button while the route still said Start Coding).
  const piMissing = ["pi-binary", "pi-version", "node", "bash"].some(
    (id) => (checkById(id)?.status ?? "warn") !== "ok",
  );
  const providerMissing = (checkById("auth")?.status ?? "warn") !== "ok";
  const projectMissing = projects.length === 0;
  const requiredSetupIds = ["pi-binary", "pi-version", "node", "bash", "auth"];
  const setupReady = requiredSetupIds.every((id) => checkById(id)?.status === "ok");
  const nextSetupCheck = requiredSetupIds
    .map((id) => checkById(id))
    .find((check) => check?.status !== "ok");
  const setupActionLabel = setupReady
    ? "Get Started"
    : nextSetupCheck?.id === "auth"
      ? "Connect an AI model"
      : "Finish setup";
  const performSetupAction = (): void => {
    if (setupReady) {
      goto("preferences");
    } else if (nextSetupCheck?.id === "auth") {
      setPhase("provider");
    } else {
      setPhase("setup");
    }
  };
  // ONB-01 (native's pi-models setup row): a CONNECTED provider whose catalog
  // is empty or failed is NOT ready to code. Unknown (idle/still loading) is
  // not "missing" — the gate only fires on a KNOWN-bad catalog.
  const modelsMissing =
    !providerMissing &&
    (modelState === "error" || (modelState === "success" && models.length === 0));
  // While the catalog verdict is PENDING for a connected provider, readiness is
  // unknown — the CTA waits instead of flashing an actionable "Start Coding"
  // that discovery may immediately contradict (Codex).
  const modelsPending = !providerMissing && modelState !== "success" && modelState !== "error";
  const routed = finalCtaFor({ piMissing, providerMissing, modelsMissing, projectMissing });
  const finalCta: { label: string; view: AppView; Icon: typeof Rocket } = {
    label: routed.label,
    view: routed.view,
    Icon:
      routed.view === "doctor"
        ? Stethoscope
        : routed.view === "providers"
          ? ShieldCheck
          : routed.view === "projects"
            ? FolderPlus
            : Rocket,
  };

  const tourPage = PAGES[page]!;

  return (
    <section
      className="absolute inset-0 z-[100] overflow-y-auto bg-surface"
      data-testid="onboarding"
      aria-label="Welcome to Agent Deck"
    >
      <div className="flex h-full w-full flex-col bg-surface-elevated">
        {phase === "tour" ? (
          <>
            <div className="relative h-[48%] min-h-80 w-full shrink-0 bg-surface-subtle">
              {PAGES.map((slide, index) => (
                <img
                  key={slide.image}
                  data-testid={index === page ? "onboarding-image" : undefined}
                  src={slide.image}
                  alt=""
                  className={cn(
                    "absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-in-out motion-reduce:transition-none",
                    index === page ? "opacity-100" : "opacity-0",
                  )}
                />
              ))}
              <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-6xl flex-col gap-2 px-8 pb-7 text-white">
                <div key={tourPage.image} className="onboarding-slide-copy">
                  <h2
                    data-testid="onboarding-title"
                    className="text-2xl font-semibold"
                    style={{ fontStretch: "expanded" }}
                  >
                    {tourPage.title}
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/80">
                    {tourPage.description}
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-1" aria-label="Carousel controls">
                  {PAGES.map((p, i) => (
                    <ControlButton
                      key={p.image}
                      aria-label={`Show welcome slide ${i + 1}`}
                      aria-current={i === page ? "true" : undefined}
                      className="h-1.5 w-5 overflow-hidden rounded-full bg-white/30"
                      onClick={() => setPage(i)}
                    >
                      {i === page ? (
                        <span
                          key={`${page}-${phase}`}
                          className={cn(
                            "block h-full origin-left rounded-full bg-white",
                            page < PAGES.length - 1 && "onboarding-slide-progress",
                          )}
                        />
                      ) : null}
                    </ControlButton>
                  ))}
                  <ControlButton
                    className="rounded-full bg-media-overlay p-1 text-white/80 hover:text-white"
                    aria-label="Next welcome slide"
                    onClick={() => setPage((current) => (current + 1) % PAGES.length)}
                  >
                    <ArrowRight size={14} />
                  </ControlButton>
                </div>
              </div>
            </div>
            <div
              className="mx-auto w-full max-w-6xl flex-1 border-t border-border-subtle px-8 py-5"
              data-testid="onboarding-setup-summary"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                    {checksLoading ? (
                      <RefreshCw size={15} className="animate-spin text-accent" />
                    ) : (
                      <Stethoscope size={15} />
                    )}
                    {checksLoading
                      ? "Initializing Agent Deck…"
                      : setupReady
                        ? "Agent Deck is ready"
                        : "Almost ready"}
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {setupReady
                      ? "Everything needed to start is ready."
                      : "One quick setup step still needs your attention."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-capsule px-2.5 py-1 text-detail font-medium",
                      setupReady
                        ? "bg-success-subtle text-success"
                        : "bg-warning-subtle text-warning",
                    )}
                  >
                    {setupReady ? "Ready to start" : "Action needed"}
                  </span>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {checksLoading && checks.length === 0
                  ? Array.from({ length: 4 }, (_, index) => (
                      <div
                        key={index}
                        className="flex animate-pulse items-center gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2"
                      >
                        <span className="h-3.5 w-3.5 rounded-full bg-border-strong" />
                        <span className="h-2.5 w-20 rounded bg-border-strong" />
                      </div>
                    ))
                  : null}
                {checks
                  .filter((check) =>
                    SUMMARY_CHECK_IDS.includes(check.id as (typeof SUMMARY_CHECK_IDS)[number]),
                  )
                  .map((check) => {
                    const { label, Icon, color } = STATUS_META[check.status];
                    const statusLabel =
                      requiredSetupIds.includes(check.id) && check.status !== "ok"
                        ? "Needs setup"
                        : label;
                    return (
                      <div
                        key={check.id}
                        className="flex min-w-0 items-start gap-2.5 rounded-lg border border-border-subtle bg-surface px-3 py-2.5"
                      >
                        <Icon size={14} style={{ color }} className="mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs font-medium text-text-primary">
                              {summaryCheckLabel(check.id)}
                            </span>
                            <span
                              className="text-overline uppercase tracking-wide"
                              style={{ color }}
                            >
                              {statusLabel}
                            </span>
                          </div>
                          <div
                            className="mt-0.5 truncate text-micro text-text-muted"
                            title={check.detail}
                          >
                            {summaryCheckDetail(check)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
            <div className="mt-auto flex w-full items-center justify-end border-t border-border-subtle px-8 py-4">
              <ControlButton
                data-testid="onboarding-get-started"
                className={cn(
                  primaryButtonClass,
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
                style={primaryButtonStyle}
                disabled={checksLoading}
                title={setupReady ? "Open Agent Deck" : setupActionLabel}
                onClick={performSetupAction}
              >
                {nextSetupCheck?.id === "auth" ? (
                  <ShieldCheck size={13} aria-hidden />
                ) : (
                  <Rocket size={13} aria-hidden />
                )}
                {checksLoading ? "Checking…" : setupActionLabel}
              </ControlButton>
            </div>
          </>
        ) : null}

        {phase === "setup" ? (
          <div
            className="mx-auto flex min-h-0 w-full max-w-6xl flex-col px-8 py-8"
            data-testid="onboarding-setup"
          >
            <div className="flex items-center justify-between pb-2 pt-4">
              <div className="flex items-center gap-2">
                <Stethoscope size={16} className="text-text-secondary" />
                <h2
                  className="text-base font-semibold text-text-primary"
                  style={{ fontStretch: "expanded" }}
                >
                  Finish setup
                </h2>
              </div>
              <ControlButton
                data-testid="onboarding-recheck"
                className="flex items-center gap-1 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                disabled={checksLoading}
                onClick={runChecks}
              >
                <RefreshCw size={11} className={checksLoading ? "animate-spin" : undefined} />
                {checksLoading ? "Checking…" : "Re-check"}
              </ControlButton>
            </div>
            <p className="mb-4 text-sm text-text-secondary">
              Complete the item below, then ask Agent Deck to check again.
            </p>
            <div className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto pb-3 md:grid-cols-2">
              {checks.length === 0 && checksLoading ? (
                <div className="py-6 text-center text-sm text-text-muted">Checking your setup…</div>
              ) : null}
              {checks
                .filter((check) => requiredSetupIds.includes(check.id) && check.status !== "ok")
                .map((check) => {
                  const { label, Icon, color } = STATUS_META[check.status];
                  const isProvider = check.id === "auth";
                  return (
                    <div
                      key={check.id}
                      className="flex items-start gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-3"
                      data-testid="onboarding-check"
                      data-check-id={check.id}
                      data-check-status={check.status}
                    >
                      <Icon size={16} style={{ color }} className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">
                            {check.label}
                          </span>
                          <span className="text-micro uppercase tracking-wide" style={{ color }}>
                            {label}
                          </span>
                        </div>
                        <div className="mt-0.5 break-words text-detail leading-relaxed text-text-muted">
                          {friendlyCheckDetail(check)}
                        </div>
                        {isProvider && check.status !== "ok" ? (
                          <ControlButton
                            data-testid="onboarding-connect-provider"
                            className="mt-1.5 rounded-capsule border border-border-strong px-2 py-0.5 text-detail text-text-secondary hover:text-text-primary"
                            onClick={() => setPhase("provider")}
                          >
                            Connect an AI model
                          </ControlButton>
                        ) : null}
                      </div>
                      {check.fixCommand ? <CopyFixButton command={check.fixCommand} /> : null}
                    </div>
                  );
                })}
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle py-3">
              <ControlButton
                data-testid="onboarding-setup-back"
                className={overlayBackButtonClass}
                onClick={() => setPhase("tour")}
              >
                <ArrowLeft size={13} /> Back
              </ControlButton>
              <ControlButton
                data-testid="onboarding-setup-continue"
                className={cn(
                  primaryButtonClass,
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
                style={primaryButtonStyle}
                disabled={checksLoading}
                onClick={setupReady ? performSetupAction : runChecks}
              >
                {checksLoading ? "Checking…" : setupReady ? "Get Started" : "Check again"}
                <ArrowRight size={13} aria-hidden />
              </ControlButton>
            </div>
          </div>
        ) : null}

        {phase === "provider" ? (
          <div className="flex min-h-0 flex-1 flex-col" data-testid="onboarding-provider">
            <ProvidersScreen
              onProviderConnected={() => {
                previewProviderConnected.current = true;
                runChecks();
                setPhase("tour");
              }}
            />
            <div className="flex shrink-0 items-center justify-between border-t border-border-subtle px-8 py-4">
              <ControlButton
                className={overlayBackButtonClass}
                onClick={() => {
                  setPhase("tour");
                  runChecks();
                }}
              >
                <ArrowLeft size={13} /> Back
              </ControlButton>
              <span className="text-xs text-text-muted">
                Connect at least one provider to continue.
              </span>
            </div>
          </div>
        ) : null}

        {phase === "preferences" ? (
          <div
            className="mx-auto flex min-h-0 w-full max-w-3xl flex-col py-8"
            data-testid="onboarding-preferences"
          >
            <div className="flex items-center gap-2 px-5 pb-1 pt-4">
              <SlidersHorizontal size={16} className="text-text-secondary" />
              <h2
                className="text-base font-semibold text-text-primary"
                style={{ fontStretch: "expanded" }}
              >
                Preferences
              </h2>
            </div>
            <p className="px-5 pb-2 text-xs text-text-muted">
              Defaults for new sessions — you can change these anytime later.
            </p>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-3">
              {prefs ? (
                <>
                  <PrefToggle
                    testid="pref-auto-title"
                    label="Auto-name sessions"
                    description="Generate a session title from your first message."
                    checked={prefs.autoTitle}
                    onChange={(v) => patchPref({ autoTitle: v })}
                  />
                  <PrefToggle
                    testid="pref-subagents"
                    label="Let sessions delegate to subagents"
                    description="Sessions may hand focused work to a subagent and run several in parallel. Turn off to keep every session doing its own work."
                    checked={prefs.subagentsEnabled}
                    onChange={(v) => patchPref({ subagentsEnabled: v })}
                  />
                  <PrefToggle
                    testid="pref-worktree"
                    label="Isolate sessions in a worktree"
                    description="Run each project session in its own git worktree. Session creation stops if isolation cannot be made."
                    checked={prefs.worktreeIsolation}
                    onChange={(v) => patchPref({ worktreeIsolation: v })}
                  />
                  <PrefToggle
                    testid="pref-keep-worktree"
                    label="Keep worktree and branch after a successful merge"
                    description="Applies only with worktree isolation. On by default so you can keep iterating; turn off to remove the worktree and branch only after a successful merge. Deleting a session removes its worktree regardless."
                    disabledDescription="Enable worktree isolation to change this preference."
                    checked={prefs.keepWorktreeAfterMerge}
                    disabled={!prefs.worktreeIsolation}
                    onChange={(v) => patchPref({ keepWorktreeAfterMerge: v })}
                  />
                  <PrefToggle
                    testid="pref-git-automation"
                    label="Enable git actions"
                    description="Show Commit / Push / Merge actions on the Git screen."
                    checked={prefs.gitAutomation}
                    onChange={(v) => patchPref({ gitAutomation: v })}
                  />
                  <div className="flex flex-col gap-1 pt-1">
                    <label className="text-sm font-medium text-text-primary" htmlFor="pref-model">
                      Default model
                    </label>
                    <PrefModelPicker
                      models={models}
                      value={prefs.defaultModel}
                      disabled={modelState === "initial-loading"}
                      onChange={(next) => patchPref({ defaultModel: next })}
                      triggerRef={modelSelect}
                    />
                    {modelState === "initial-loading" ? (
                      <span className="text-detail text-text-muted" role="status">
                        Discovering available models…
                      </span>
                    ) : modelState === "loading" ? (
                      <span className="text-detail text-text-muted" role="status">
                        Trying model discovery again…
                      </span>
                    ) : modelState === "success" && models.length === 0 ? (
                      <span className="text-detail text-text-muted" role="status">
                        No models are currently available from connected providers.
                      </span>
                    ) : modelState === "error" ? (
                      <div
                        className="flex items-center gap-2 text-detail text-text-muted"
                        role="alert"
                      >
                        <span>Models could not be discovered.</span>
                        <ControlButton
                          data-testid="pref-model-retry"
                          className="rounded-capsule border border-border-strong px-2 py-0.5 text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent"
                          onClick={() => discoverModels(false, true)}
                        >
                          Retry
                        </ControlButton>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1">
                    <label
                      className="text-sm font-medium text-text-primary"
                      htmlFor="pref-thinking"
                    >
                      Default thinking
                    </label>
                    <ControlSelect
                      id="pref-thinking"
                      data-testid="pref-thinking"
                      className="rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                      value={prefs.defaultThinking ?? ""}
                      onChange={(event) =>
                        patchPref({ defaultThinking: event.target.value || null })
                      }
                    >
                      <option value="">Pi&apos;s default</option>
                      {PI_THINKING_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </ControlSelect>
                    <p className="mt-1 text-xs text-text-muted">
                      Applied when supported by the selected model; Pi may clamp unsupported levels.
                    </p>
                  </div>
                </>
              ) : (
                <div className="py-6 text-center text-sm text-text-muted">Loading preferences…</div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3">
              <ControlButton
                data-testid="onboarding-preferences-back"
                className={overlayBackButtonClass}
                onClick={() => goto("tour")}
              >
                <ArrowLeft size={13} /> Back
              </ControlButton>
              <ControlButton
                data-testid="onboarding-preferences-continue"
                className={primaryButtonClass}
                style={primaryButtonStyle}
                onClick={() => goto("final")}
              >
                Continue <ArrowRight size={13} aria-hidden />
              </ControlButton>
            </div>
          </div>
        ) : null}

        {phase === "final" ? (
          <div
            className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-3 px-5 py-8"
            data-testid="onboarding-final"
          >
            <h2
              className="text-base font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              {routed.view === "chat" && !modelsPending ? "You're all set" : "Almost there"}
            </h2>
            <p className="text-sm leading-relaxed text-text-secondary">
              {piMissing
                ? "Pi isn't ready yet — review setup to finish installing it."
                : providerMissing
                  ? "Connect a model provider so Pi has a model to run."
                  : modelsMissing
                    ? "Your provider is connected, but no usable models loaded — load models so Pi can run."
                    : modelsPending
                      ? "Checking which models your provider offers…"
                      : projectMissing
                        ? "Add a project folder to start a coding session in it."
                        : "Your workspace is ready. Jump into a coding session with Pi."}
            </p>
            <div className="flex flex-col gap-1.5 py-1">
              <FinalGate label="Pi runtime" ok={!piMissing} />
              <FinalGate label="Model provider" ok={!providerMissing} />
              <FinalGate
                label="AI models"
                ok={!providerMissing && !modelsMissing && !modelsPending}
              />
              <FinalGate label="A project" ok={!projectMissing} />
            </div>
            <div className="flex items-center justify-between pt-1">
              <ControlButton
                data-testid="onboarding-final-back"
                className={overlayBackButtonClass}
                onClick={() => goto("preferences")}
              >
                <ArrowLeft size={13} /> Back
              </ControlButton>
              <ControlButton
                data-testid="onboarding-finish"
                data-target={finalCta.view}
                className={cn(
                  primaryButtonClass,
                  "disabled:cursor-not-allowed disabled:opacity-40",
                )}
                style={primaryButtonStyle}
                // Never a dead end (native's button always routes somewhere
                // corrective): disabled ONLY while a verdict is pending —
                // checks in flight, or a connected provider's catalog unknown.
                disabled={checksLoading || modelsPending}
                onClick={() => finishTo(finalCta.view)}
              >
                <finalCta.Icon size={13} aria-hidden /> {finalCta.label}
              </ControlButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function PrefToggle({
  testid,
  label,
  description,
  checked,
  onChange,
  disabled = false,
  disabledDescription,
}: {
  testid: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  disabledDescription?: string;
}) {
  const descriptionId = `${testid}-description`;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary">{label}</div>
        <div id={descriptionId} className="text-xs text-text-muted">
          {description}
          {disabled && disabledDescription ? ` ${disabledDescription}` : ""}
        </div>
      </div>
      <ControlButton
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={descriptionId}
        data-testid={testid}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-capsule transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          checked ? "bg-accent" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </ControlButton>
    </div>
  );
}

function FinalGate({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs" data-testid="onboarding-gate" data-ok={ok}>
      {ok ? (
        <CheckCircle2 size={13} style={{ color: "var(--color-success)" }} />
      ) : (
        <XCircle size={13} style={{ color: "var(--color-role-error)" }} />
      )}
      <span className={ok ? "text-text-secondary" : "text-text-primary"}>{label}</span>
    </div>
  );
}
