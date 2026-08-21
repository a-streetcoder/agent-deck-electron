import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { SectionHero, SectionHeroButton } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileCode2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { conflictingExtensionNames } from "@agent-deck/domain";
import type { InjectedCommandRecord } from "@agent-deck/contracts";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { useAppStore } from "../state/store.ts";
import { sectionHeaderClass } from "@/design-system/styles";

/**
 * Extensions screen (native Runtime → Extensions): user-added pi extension
 * files (.ts/.js) that load into every new session via --extension. Toggle
 * one off to exclude it without forgetting the entry.
 */
interface ExtensionEntry {
  path: string;
  name: string;
  exists: boolean;
  disabled: boolean;
  /** Where it was found — a standard pi dir (discovered) or the manual registry. */
  source?: "discovered" | "added" | "settings" | "package";
  packageRef?: string;
  /** EXT-03: the exact owning location (discovery dir / settings file). */
  origin?: string;
  scope?: "global" | "project" | string;
  /** The app-bridge tool this extension re-registers, if any (kept out of launch). */
  bridgeConflict?: string | null;
}

/** An app-generated bridge (native "Agent Deck bridges" card) — read-only. */
interface AppBridge {
  id: string;
  displayName: string;
  summary: string;
  condition: string;
  toolNames: string[];
  active: boolean;
}

type CatalogLoadResult = "applied" | "failed" | "superseded";

function CommandCatalog({ resourcesVersion }: { resourcesVersion: number }) {
  const setError = useAppStore((state) => state.setError);
  const [commands, setCommands] = useState<InjectedCommandRecord[]>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setCatalogState("loading");
    try {
      const response = await fetch("/resources/commands", { signal: controller.signal });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const data = (await response.json()) as { commands: InjectedCommandRecord[] };
      if (sequence !== loadSequence.current) return;
      setCommands(data.commands);
      setCatalogState("ready");
    } catch (error) {
      if (controller.signal.aborted || sequence !== loadSequence.current) return;
      setCatalogState("error");
      setError(String(error));
    } finally {
      if (loadController.current === controller) loadController.current = null;
    }
  }, [setError]);

  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
  }, [load, resourcesVersion]);

  const importFile = async (file: File): Promise<void> => {
    setBusy("import");
    try {
      const response = await fetch("/resources/commands/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, content: await file.text() }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      await load();
    } catch (error) {
      setError(String(error));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
      setBusy(null);
    }
  };

  const mutate = async (command: InjectedCommandRecord, action: "toggle" | "delete") => {
    if (busy) return;
    setBusy(command.id);
    try {
      const response = await fetch(
        action === "delete" ? "/resources/commands" : "/resources/commands/toggle",
        {
          method: action === "delete" ? "DELETE" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "delete"
              ? { id: command.id }
              : { id: command.id, enabled: command.status !== "enabled" },
          ),
        },
      );
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      await load();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(null);
    }
  };

  const group = (source: InjectedCommandRecord["source"], label: string) => {
    const entries = commands.filter((command) => command.source === source);
    return (
      <div data-testid={`command-group-${source}`}>
        <div className={cn(sectionHeaderClass, "pb-1.5 text-text-muted")}>{label}</div>
        {entries.length === 0 ? (
          <div className="rounded-xl border border-border-subtle px-3.5 py-4 text-body text-text-muted">
            {source === "library" ? "No imported commands." : "No bundled commands available."}
          </div>
        ) : (
          <div className="space-y-1.5">
            {entries.map((command) => {
              const enabled = command.status === "enabled";
              return (
                <div
                  key={command.id}
                  data-testid={`command-${command.id}`}
                  className={cn(
                    "flex flex-col gap-2 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5 sm:flex-row sm:items-center",
                    !enabled && "opacity-55",
                  )}
                  aria-busy={busy === command.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-code font-medium text-text-primary">
                        {command.slashName}
                      </span>
                      <span className="text-caption text-text-secondary">{command.title}</span>
                      <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
                        {source === "built-in" ? "bundled with Agent Deck" : "Agent Deck library"}
                      </span>
                    </div>
                    <p className="pt-0.5 text-detail text-text-muted">{command.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                    <ControlButton
                      data-testid={`command-toggle-${command.id}`}
                      aria-label={`${enabled ? "Disable" : "Enable"} ${command.slashName}`}
                      disabled={busy !== null}
                      className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail text-text-secondary disabled:opacity-40"
                      onClick={() => void mutate(command, "toggle")}
                    >
                      {busy === command.id ? "Saving…" : enabled ? "Disable" : "Enable"}
                    </ControlButton>
                    {source === "library" ? (
                      <ControlButton
                        data-testid={`command-delete-${command.id}`}
                        aria-label={`Delete ${command.slashName} from Agent Deck's library`}
                        title="Delete imported command"
                        disabled={busy !== null}
                        className="rounded p-1 text-text-muted hover:text-danger disabled:opacity-40"
                        onClick={() => void mutate(command, "delete")}
                      >
                        <Trash2 size={13} />
                      </ControlButton>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="mb-5" aria-labelledby="commands-heading" data-testid="command-catalog">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <div className="flex items-center gap-2">
          <FileCode2 size={15} className="text-text-secondary" aria-hidden />
          <h3 id="commands-heading" className="text-label font-semibold text-text-primary">
            Commands
          </h3>
        </div>
        <ControlButton
          data-testid="command-import"
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-3 py-1 text-detail text-text-secondary disabled:opacity-40"
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={12} aria-hidden /> {busy === "import" ? "Importing…" : "Import command"}
        </ControlButton>
        <ControlInput
          ref={inputRef}
          data-testid="command-file-input"
          className="sr-only"
          type="file"
          accept=".ts,.js,text/javascript,application/javascript"
          aria-label="Choose a TypeScript or JavaScript command file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </div>
      <p className="pb-2 text-caption text-text-muted">
        App-managed slash commands for ordinary project sessions. Imported files are copied into
        Agent Deck and start disabled; their original path is never retained.
      </p>
      <p
        role="note"
        className="mb-3 rounded-lg border border-warning bg-surface-subtle px-3 py-2 text-detail font-medium text-text-primary"
      >
        Trust enabled imports: they execute as Pi extensions with extension-runtime capabilities.
        Use ordinary Extensions for privileged code that does more than register one command.
      </p>
      {catalogState === "loading" ? (
        <div role="status" className="py-5 text-center text-body text-text-muted">
          Loading commands…
        </div>
      ) : catalogState === "error" ? (
        <div
          role="alert"
          className="rounded-xl border border-danger px-3.5 py-4 text-label text-danger"
        >
          Commands are unavailable. Retry when Agent Deck reports the catalog is ready.
        </div>
      ) : (
        <div className="space-y-3">
          {group("built-in", "Bundled")}
          {group("library", "Imported")}
        </div>
      )}
    </section>
  );
}

export function ExtensionsScreen() {
  const setError = useAppStore((state) => state.setError);
  const pushToast = useAppStore((state) => state.pushToast);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const [extensions, setExtensions] = useState<ExtensionEntry[]>([]);
  const [bridges, setBridges] = useState<AppBridge[]>([]);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState("");
  const [modeBusy, setModeBusy] = useState(false);
  const modeBusyRef = useRef(false);
  const [bulkAction, setBulkAction] = useState<boolean | null>(null);
  const bulkBusyRef = useRef(false);
  const [extensionBusy, setExtensionBusy] = useState<Record<string, "toggle" | "remove">>({});
  const extensionBusyRef = useRef(new Set<string>());
  const refreshingRef = useRef(false);
  const loadSeq = useRef(0);
  const latestLoad = useRef<Promise<CatalogLoadResult> | null>(null);

  const load = useCallback((): Promise<CatalogLoadResult> => {
    const seq = ++loadSeq.current;
    const pending = (async (): Promise<CatalogLoadResult> => {
      try {
        // Pass the current project so project-scoped extensions are discovered too.
        const url = currentProjectId
          ? `/resources/extensions?projectId=${encodeURIComponent(currentProjectId)}`
          : "/resources/extensions";
        const response = await fetch(url);
        if (!response.ok) throw new Error(await responseErrorMessage(response));
        const data = (await response.json()) as { extensions: ExtensionEntry[] };
        if (seq !== loadSeq.current) return "superseded";
        setExtensions(data.extensions);
        return "applied";
      } catch (err) {
        if (seq !== loadSeq.current) return "superseded";
        setError(String(err));
        return "failed";
      }
    })();
    latestLoad.current = pending;
    return pending;
  }, [setError, currentProjectId]);

  useEffect(() => {
    void load();
  }, [load, resourcesVersion]);

  const refreshFromDisk = async (): Promise<void> => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setError(null);
    try {
      let pending = load();
      for (;;) {
        const result = await pending;
        if (result === "failed") return;
        if (result === "applied") break;
        const winner = latestLoad.current;
        if (!winner || winner === pending) return;
        pending = winner;
      }
      pushToast({ kind: "success", message: "Refreshed extensions" });
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  // Extension loading mode (native PiAgentExtensionLoadingMode): whether the
  // user's own extensions load alongside Agent Deck's bridges, or only the
  // bridges do. Read on mount; written optimistically.
  type LoadingMode = "useMyExtensions" | "agentDeckManaged";
  // `null` until the setting loads, so the mode section (and its bulk actions)
  // never flashes the wrong mode first — a flash of the bulk buttons could let a
  // stray click mutate everything before the real mode arrives.
  const [loadingMode, setLoadingMode] = useState<LoadingMode | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/settings");
        if (!response.ok) throw new Error(await responseErrorMessage(response));
        const data = (await response.json()) as {
          settings: { extensionLoadingMode: LoadingMode };
        };
        setLoadingMode(data.settings.extensionLoadingMode);
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [setError]);
  const setMode = async (mode: LoadingMode): Promise<void> => {
    if (modeBusyRef.current || mode === loadingMode) return;
    modeBusyRef.current = true;
    setModeBusy(true);
    const prev = loadingMode;
    setLoadingMode(mode); // optimistic
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extensionLoadingMode: mode }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
    } catch (err) {
      setLoadingMode(prev); // no later mode request can make this rollback stale
      setError(String(err));
    } finally {
      modeBusyRef.current = false;
      setModeBusy(false);
    }
  };
  // Bulk enable/disable every listed extension (native All / None).
  const setAllDisabled = async (disabled: boolean): Promise<void> => {
    // Bulk and per-extension writes share the same server collection. Do not
    // calculate a bulk request from a list with an in-flight individual write.
    if (bulkBusyRef.current || extensionBusyRef.current.size > 0) return;
    bulkBusyRef.current = true;
    setBulkAction(disabled);
    try {
      const results = await Promise.allSettled(
        extensions
          .filter((ext) => ext.disabled !== disabled)
          .map(async (ext) => {
            const response = await fetch("/resources/extensions/disabled", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ path: ext.path, disabled }),
            });
            if (!response.ok) throw new Error(await responseErrorMessage(response));
          }),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) setError(String(failure.reason));
      // All writes have settled before reloading, so the refreshed list cannot
      // miss a late sibling after a partial failure.
      await load();
    } finally {
      bulkBusyRef.current = false;
      setBulkAction(null);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/runtime/bridges");
        if (!response.ok) return;
        const data = (await response.json()) as { bridges: AppBridge[] };
        setBridges(data.bridges);
      } catch {
        // Non-critical: the bridge inventory is informational only.
      }
    })();
  }, [resourcesVersion]);

  const add = async (): Promise<void> => {
    const path = draft.trim();
    if (!path) return;
    try {
      const response = await fetch("/resources/extensions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      setDraft("");
      setAdding(false);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const mutateExtension = async (
    ext: ExtensionEntry,
    action: "toggle" | "remove",
  ): Promise<void> => {
    if (bulkBusyRef.current || extensionBusyRef.current.has(ext.path)) return;
    extensionBusyRef.current.add(ext.path);
    setExtensionBusy((current) => ({ ...current, [ext.path]: action }));
    try {
      const response = await fetch(
        action === "remove" ? "/resources/extensions" : "/resources/extensions/disabled",
        {
          method: action === "remove" ? "DELETE" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "remove" ? { path: ext.path } : { path: ext.path, disabled: !ext.disabled },
          ),
        },
      );
      if (!response.ok) throw new Error(await responseErrorMessage(response));
    } catch (err) {
      setError(String(err));
    } finally {
      // Reconcile even on failure: the server may have applied a mutation before
      // returning an error, and another client may have changed this entry.
      await load();
      extensionBusyRef.current.delete(ext.path);
      setExtensionBusy((current) => {
        const next = { ...current };
        delete next[ext.path];
        return next;
      });
    }
  };

  const toggle = (ext: ExtensionEntry): Promise<void> => mutateExtension(ext, "toggle");
  const remove = (ext: ExtensionEntry): Promise<void> => mutateExtension(ext, "remove");

  // Names loaded by 2+ enabled extensions — pi would load duplicates (§16.2).
  const conflicts = conflictingExtensionNames(extensions);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="extensions-screen">
      <SectionHero
        imageSrc="/screen-art/screen-art-extensions.jpg"
        title="Extensions"
        actions={
          <>
            <SectionHeroButton
              data-testid="extension-refresh"
              variant="ghost"
              disabled={refreshing}
              onClick={() => void refreshFromDisk()}
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </SectionHeroButton>
            <SectionHeroButton
              data-testid="extension-add"
              variant="primary"
              onClick={() => setAdding((v) => !v)}
            >
              <Plus size={13} /> Add extension
            </SectionHeroButton>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
          <p className="pb-3 text-caption text-text-muted">
            pi extension files loaded into every new session. Disabled ones stay listed but
            don&apos;t load.
          </p>

          <CommandCatalog resourcesVersion={resourcesVersion} />

          {bridges.length > 0 ? (
            <div className="mb-4" data-testid="app-bridges">
              <div className={cn(sectionHeaderClass, "pb-1.5 text-text-muted")}>
                Agent Deck bridges
              </div>
              <p className="pb-2 text-detail text-text-muted">
                Features Agent Deck injects into pi over its own bridge (not your files). Read-only.
              </p>
              <div className="space-y-1.5">
                {bridges.map((b) => (
                  <div
                    key={b.id}
                    data-testid={`bridge-${b.id}`}
                    data-active={b.active ? "true" : "false"}
                    className={cn(
                      "rounded-xl border border-border-subtle bg-surface-subtle px-3.5 py-2.5",
                      !b.active && "opacity-55",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-label font-medium text-text-primary">
                        {b.displayName}
                      </span>
                      <span
                        data-testid={`bridge-state-${b.id}`}
                        className={cn(
                          "rounded-capsule border px-1.5 text-micro",
                          b.active
                            ? "border-success text-success"
                            : "border-border-subtle text-text-muted",
                        )}
                      >
                        {b.active ? "active" : "off"}
                      </span>
                    </div>
                    <div className="pt-0.5 text-detail text-text-muted">{b.summary}</div>
                    {b.toolNames.length > 0 ? (
                      <div className="truncate pt-0.5 font-mono text-detail text-text-muted">
                        {b.toolNames.join(", ")}
                      </div>
                    ) : (
                      <div className="pt-0.5 text-detail text-text-muted italic">{b.condition}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {adding ? (
            <div className="mb-3 flex gap-2">
              <ControlInput
                autoFocus
                data-testid="extension-path"
                className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
                placeholder="/path/to/extension.ts"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                  if (e.key === "Escape") setAdding(false);
                }}
              />
              <ControlButton
                data-testid="extension-add-confirm"
                className="rounded-capsule px-3 py-1.5 text-detail font-medium shadow-capsule disabled:opacity-40"
                style={{
                  background:
                    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                  color: "var(--color-accent-foreground)",
                }}
                disabled={!draft.trim()}
                onClick={() => void add()}
              >
                Add
              </ControlButton>
            </div>
          ) : null}

          {/* Loading mode (native PiAgentExtensionLoadingMode) + bulk enable/disable.
            Hidden until the setting loads so the wrong mode never flashes. */}
          {loadingMode !== null ? (
            <div className="mb-3 rounded-lg border border-border-subtle bg-surface px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-detail font-medium text-text-primary">Loading mode</span>
                <div
                  className="flex rounded-capsule border border-border-subtle p-0.5"
                  role="group"
                  aria-busy={modeBusy}
                >
                  {(
                    [
                      ["useMyExtensions", "Use my extensions"],
                      ["agentDeckManaged", "Agent Deck managed"],
                    ] as const
                  ).map(([mode, label]) => (
                    <ControlButton
                      key={mode}
                      data-testid={`extension-mode-${mode}`}
                      data-active={loadingMode === mode}
                      disabled={modeBusy}
                      className={cn(
                        "rounded-capsule px-2.5 py-0.5 text-detail transition-colors disabled:opacity-40",
                        loadingMode === mode
                          ? "bg-selection text-text-primary"
                          : "text-text-secondary hover:text-text-primary",
                      )}
                      onClick={() => void setMode(mode)}
                    >
                      {label}
                    </ControlButton>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-detail text-text-muted">
                {loadingMode === "agentDeckManaged"
                  ? "Only Agent Deck's built-in bridges load. Your own pi extensions stay off (still listed below)."
                  : "Your enabled pi extensions load alongside Agent Deck's bridges. Toggle any off below."}
              </p>
              {loadingMode === "useMyExtensions" && extensions.length > 0 ? (
                <div className="mt-2 flex items-center gap-2" aria-busy={bulkAction !== null}>
                  <ControlButton
                    data-testid="extension-enable-all"
                    className="rounded-capsule border border-border-strong px-2.5 py-0.5 text-detail text-text-secondary hover:text-text-primary disabled:opacity-40"
                    disabled={bulkAction !== null || Object.keys(extensionBusy).length > 0}
                    onClick={() => void setAllDisabled(false)}
                  >
                    {bulkAction === false ? "Enabling all…" : "Enable all"}
                  </ControlButton>
                  <ControlButton
                    data-testid="extension-disable-all"
                    className="rounded-capsule border border-border-strong px-2.5 py-0.5 text-detail text-text-secondary hover:text-text-primary disabled:opacity-40"
                    disabled={bulkAction !== null || Object.keys(extensionBusy).length > 0}
                    onClick={() => void setAllDisabled(true)}
                  >
                    {bulkAction === true ? "Disabling all…" : "Disable all"}
                  </ControlButton>
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            className={cn("space-y-1.5", loadingMode === "agentDeckManaged" && "opacity-55")}
            data-testid="extension-list"
          >
            {extensions.map((ext) => {
              const conflicting = !ext.disabled && conflicts.has(ext.name);
              const busyAction = extensionBusy[ext.path];
              const controlsBusy = bulkAction !== null || busyAction !== undefined;
              return (
                <div
                  key={ext.path}
                  data-extension-name={ext.name}
                  data-conflict={conflicting ? "true" : "false"}
                  aria-busy={controlsBusy}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border bg-surface px-3.5 py-2.5",
                    conflicting ? "border-warning" : "border-border-subtle",
                    ext.disabled && "opacity-55",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-label font-medium text-text-primary">
                        {ext.name}
                      </span>
                      {/* Where it came from (native scope/source label). */}
                      <span
                        data-testid={`extension-source-${ext.name}`}
                        className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
                        title={
                          ext.source === "package"
                            ? `Provided by package ${ext.packageRef ?? ""}`.trim()
                            : ext.origin
                              ? `Declared by ${ext.origin}`
                              : undefined
                        }
                      >
                        {ext.source === "added"
                          ? "added"
                          : ext.source === "settings"
                            ? `${ext.scope === "project" ? "project" : "global"} · settings.json`
                            : ext.source === "package"
                              ? `package · ${(ext.packageRef ?? "").split(/[\\/]/).pop() || "package"}`
                              : `${ext.scope === "project" ? "project" : "global"} · discovered`}
                      </span>
                    </div>
                    <div className="truncate font-mono text-detail text-text-muted">{ext.path}</div>
                  </div>
                  {ext.bridgeConflict ? (
                    <span
                      data-testid={`extension-bridge-conflict-${ext.name}`}
                      title={`This extension registers "${ext.bridgeConflict}", a tool Agent Deck provides through its own bridge. The bridge takes precedence, so this extension is not loaded — rename its tool to use it.`}
                      className="flex items-center gap-1 rounded-capsule border border-danger px-1.5 text-micro text-danger"
                    >
                      <AlertTriangle size={10} /> shadowed by bridge
                    </span>
                  ) : null}
                  {conflicting ? (
                    <span
                      data-testid="extension-conflict"
                      title="Another enabled extension has the same filename. pi loads both (it keys by path), but two extensions sharing a name is usually a mistake — disable or remove one."
                      className="flex items-center gap-1 rounded-capsule border border-warning px-1.5 text-micro text-warning"
                    >
                      <AlertTriangle size={10} /> conflict
                    </span>
                  ) : null}
                  {!ext.exists ? (
                    <span className="rounded-capsule border border-danger px-1.5 text-micro text-danger">
                      missing
                    </span>
                  ) : null}
                  <ControlButton
                    data-testid={`extension-toggle-${ext.name}`}
                    data-enabled={!ext.disabled}
                    className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail text-text-secondary hover:text-text-primary disabled:opacity-40"
                    disabled={controlsBusy}
                    onClick={() => void toggle(ext)}
                  >
                    {busyAction === "toggle"
                      ? ext.disabled
                        ? "Enabling…"
                        : "Disabling…"
                      : ext.disabled
                        ? "Enable"
                        : "Disable"}
                  </ControlButton>
                  {/* Only registry entries can be removed; discovered files live on
                    disk and settings.json entries belong to that file (EXT-01). */}
                  {ext.source === "added" ? (
                    <ControlButton
                      data-testid={`extension-remove-${ext.name}`}
                      className="rounded p-1 text-text-muted hover:text-danger disabled:opacity-40"
                      title={busyAction === "remove" ? "Removing…" : "Remove"}
                      aria-label={
                        busyAction === "remove" ? `Removing ${ext.name}` : `Remove ${ext.name}`
                      }
                      disabled={controlsBusy}
                      onClick={() => void remove(ext)}
                    >
                      <Trash2 size={13} />
                    </ControlButton>
                  ) : null}
                </div>
              );
            })}
            {extensions.length === 0 && !adding ? (
              <div className="py-8 text-center text-body text-text-muted">
                No extensions added. Point at a pi extension file to load it into sessions.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
