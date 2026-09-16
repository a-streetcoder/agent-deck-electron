import {
  ControlButton,
  ControlInput,
  ControlTextArea,
} from "@/design-system/components/NativeControls";
import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppInlineNotice } from "@/design-system/components/AppInlineNotice";
import { AppScrollView } from "@/design-system/components/AppScrollView";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { IconButton } from "@/design-system/components/IconButton";
import { DetailHeader } from "@/design-system/components/DetailHeader";
import { MasterDetailSplit } from "@/design-system/components/MasterDetailSplit";
import { PageShell } from "@/design-system/components/PageShell";
import { PageToolbar } from "@/design-system/components/PageToolbar";
import { SectionHero, SectionHeroButton } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FileText, Globe, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { PromptInfo } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { chooseFiles, openResourceFile, revealResourceFile } from "../lib/native.ts";
import { useAppStore } from "../state/store.ts";
import { updateProject } from "../state/wsBridge.ts";
import { ScopeChip } from "../components/ScopeChip.tsx";

/**
 * Prompts screen (native piResources → Prompts): CRUD for prompt-template .md
 * files that pi exposes as `/<name>` slash commands (native prompt.invocation;
 * pi matches the file's basename). Single markdown files with a name +
 * description + optional argument-hint; project scope wins over global.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the transient textarea path for insecure/denied contexts.
  }
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}

export function filterPrompts(prompts: PromptInfo[], search: string): PromptInfo[] {
  const query = search.trim().toLowerCase();
  if (!query) return prompts;

  return prompts.filter((prompt) =>
    [
      prompt.name,
      prompt.invocation,
      prompt.description,
      prompt.scope,
      prompt.filePath,
      prompt.body,
    ].some((field) => field?.toLowerCase().includes(query)),
  );
}

interface Draft {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
  scope: "global" | "library";
  /** The project this edit targets, captured when the editor opened. */
  projectId: string | null;
  original?: string; // set when editing an existing prompt (its name)
  /** On-disk path of an existing prompt (native "File" metadata row); absent for a new draft. */
  filePath?: string;
}

export function PromptsScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const setError = useAppStore((state) => state.setError);
  const projects = useAppStore((state) => state.projects);
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [promptsLoaded, setPromptsLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const resourceRequest = useAppStore((state) => state.resourceCommandRequest);
  const selectedPromptFilePath = useAppStore((state) => state.selectedPromptFilePath);
  const loadSeq = useRef(0);
  const promptNameInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // PRM-03: package-prompt resolution warnings from the catalog scan.
  const [packageWarnings, setPackageWarnings] = useState<string[]>([]);
  // PRM-05: the external-reference path input (null = closed).
  const [externalPath, setExternalPath] = useState<string | null>(null);

  const referencePath = async (refPath: string): Promise<void> => {
    const response = await fetch("/resources/prompts/external-refs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: refPath }),
    });
    if (!response.ok) {
      throw new Error(await responseErrorMessage(response, "Couldn't reference that prompt file."));
    }
  };

  const addExternalRef = async (): Promise<void> => {
    const refPath = (externalPath ?? "").trim();
    if (!refPath) return;
    try {
      await referencePath(refPath);
      setExternalPath(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  // PRM-07 (native importPromptTemplate): the trusted OS file picker references each
  // chosen file in place. No picker (browser dev) or cancel falls back to the
  // typed-path input, keeping the button's toggle behavior.
  const importExternalPrompt = async (): Promise<void> => {
    try {
      const files = await chooseFiles({
        title: "Import Prompt",
        buttonLabel: "Import Prompt",
        filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
      });
      if (files.length === 0) {
        setExternalPath((v) => (v === null ? "" : null));
        return;
      }
      // every picked file is attempted; one rejection must not strand the rest
      // (review, Codex). Failures are reported together after the loop.
      const failures: string[] = [];
      for (const file of files) {
        try {
          await referencePath(file);
        } catch (err) {
          failures.push(`${file}: ${String(err)}`);
        }
      }
      await load();
      if (failures.length > 0) setError(failures.join(" · "));
    } catch (err) {
      setError(String(err));
    }
  };

  // Silence/re-enable a bundled builtin (PRM-06, native setBundledPromptDisabled):
  // still listed, excluded from launch resolution while disabled.
  const toggleBuiltinDisabled = async (prompt: PromptInfo): Promise<void> => {
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          setBuiltinPromptDisabled: { name: prompt.name, disabled: !prompt.disabled },
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  // Remove the REFERENCE — the file itself stays where the user keeps it (PRM-05).
  const removeExternalRef = async (prompt: PromptInfo): Promise<void> => {
    try {
      const response = await fetch("/resources/prompts/external-refs", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: prompt.filePath }),
      });
      if (!response.ok) {
        throw new Error(
          await responseErrorMessage(response, "Couldn't remove the prompt reference."),
        );
      }
      await load();
    } catch (err) {
      setError(String(err));
    }
  };
  // Builtin/package prompts are bundled/installed files, and external references
  // (PRM-05) are the user's files OUTSIDE the catalogs — none are catalog-editable:
  // no rename/delete; opening one drafts a global copy to customize (PRM-02/03/05).
  const isReadOnlyPromptScope = (scope: PromptInfo["scope"]): boolean =>
    scope === "builtin" || scope === "package";
  const isReadOnlyPrompt = (prompt: PromptInfo): boolean =>
    isReadOnlyPromptScope(prompt.scope) ||
    prompt.external === true ||
    // PRM-04: settings-declared prompts live wherever settings.json points,
    // outside the catalog dirs — not catalog-editable either
    prompt.source === "settings";
  // "All Projects" default prompt templates (native defaultPromptTemplateNames):
  // enabled ones are injected into every project's parent sessions as
  // --prompt-template flags. Tracked by name, read from app settings.
  const [defaultPrompts, setDefaultPrompts] = useState<string[]>([]);
  // Inline rename target (native RenameResourceSheet): the prompt being renamed.
  const [renaming, setRenaming] = useState<{
    name: string;
    scope: PromptInfo["scope"];
    value: string;
  } | null>(null);
  const visiblePrompts = useMemo(() => filterPrompts(prompts, search), [prompts, search]);
  const hasSearchQuery = search.trim().length > 0;
  const selectedPrompt =
    prompts.find((prompt) => prompt.filePath === selectedPromptFilePath) ?? null;

  const load = useCallback(async (): Promise<void> => {
    const projectId = currentProjectId;
    const seq = ++loadSeq.current;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    setPrompts([]);
    setPromptsLoaded(false);
    setLoadedProjectId(projectId);
    try {
      const response = await fetch(`/resources/prompts${query}`);
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const data = (await response.json()) as {
        prompts: PromptInfo[];
        packagePromptWarnings?: string[];
      };
      if (seq === loadSeq.current) {
        setPrompts(data.prompts);
        setPackageWarnings(data.packagePromptWarnings ?? []);
        setPromptsLoaded(true);
      }
    } catch (err) {
      if (seq === loadSeq.current) setError(String(err));
    }
  }, [currentProjectId, setError]);

  // Monotonic token: a slow /settings GET must not clobber a newer optimistic
  // flip or a newer refresh. Bumped on every refresh AND on every toggle.
  const defaultsSeq = useRef(0);
  const refreshDefaults = useCallback(async (): Promise<void> => {
    const seq = ++defaultsSeq.current;
    try {
      const response = await fetch("/settings");
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const { settings } = (await response.json()) as {
        settings: { defaultPromptTemplates?: string[] };
      };
      if (seq === defaultsSeq.current) setDefaultPrompts(settings.defaultPromptTemplates ?? []);
    } catch (err) {
      if (seq === defaultsSeq.current) setError(String(err));
    }
  }, [setError]);

  useEffect(() => {
    void load();
    void refreshDefaults();
  }, [load, refreshDefaults, resourcesVersion]);

  // Toggle a prompt's "All Projects" default (native defaultPromptTemplateNames).
  // The PATCH RESPONSE returns the authoritative updated settings, so we apply
  // that (not a separate GET) under a per-toggle token — the latest toggle wins
  // and no interleaved refresh can land stale state over a newer flip.
  const toggleDefault = async (name: string, enabled: boolean): Promise<void> => {
    const seq = ++defaultsSeq.current;
    // Optimistic — the toggle must flip immediately.
    setDefaultPrompts((prev) =>
      enabled ? [...new Set([...prev, name])] : prev.filter((n) => n !== name),
    );
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setDefaultPromptTemplate: { name, enabled } }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const { settings } = (await response.json()) as {
        settings: { defaultPromptTemplates?: string[] };
      };
      // Reconcile to the server's authoritative list only if still the latest.
      if (seq === defaultsSeq.current) setDefaultPrompts(settings.defaultPromptTemplates ?? []);
    } catch (err) {
      // Revert the optimistic flip so the UI can't claim a change that failed.
      if (seq === defaultsSeq.current) {
        setDefaultPrompts((prev) =>
          enabled ? prev.filter((n) => n !== name) : [...new Set([...prev, name])],
        );
      }
      setError(String(err));
    }
  };

  // Close the editor when the project changes so an in-progress edit can't be
  // saved against a different project than it was opened in.
  useEffect(() => {
    setDraft(null);
  }, [currentProjectId]);

  const startNew = (): void =>
    setDraft({
      name: "",
      description: "",
      argumentHint: "",
      body: "",
      scope: "library",
      projectId: currentProjectId,
    });

  const newDraftOpen = draft !== null && draft.original === undefined;
  useEffect(() => {
    if (newDraftOpen) promptNameInputRef.current?.focus();
  }, [newDraftOpen]);

  const startEdit = (prompt: PromptInfo): void => {
    // A builtin/package/external prompt is not a catalog file (PRM-02/03/05): opening
    // it drafts a COPY that saves into the global prompts dir — native's "copy one
    // into your prompts directory to customize it". The copy then shadows the
    // original by name. When a same-named global copy ALREADY exists, edit THAT — an
    // original-less draft would silently overwrite the user's customization (review, Codex).
    let target = prompt;
    let isReadOnly = isReadOnlyPrompt(prompt);
    if (isReadOnly) {
      const existingCopy = prompts.find((p) => p.name === prompt.name && p.scope === "global");
      if (existingCopy) {
        target = existingCopy;
        isReadOnly = false;
      }
    }
    useAppStore.getState().setSelectedPromptFilePath(target.filePath);
    setDraft({
      name: target.name,
      description: target.description ?? "",
      argumentHint: target.argumentHint ?? "",
      body: target.body,
      // a read-only COPY draft always lands in the user's global prompts — an
      // external ref carries library scope, but saving there would overwrite an
      // unrelated library prompt (review, Codex)
      scope: isReadOnly ? "global" : target.scope === "library" ? "library" : "global",
      projectId: currentProjectId,
      original: isReadOnly ? undefined : target.name,
      filePath: isReadOnly ? undefined : target.filePath,
    });
  };

  useEffect(() => {
    if (!resourceRequest?.action.startsWith("prompt.")) return;
    if (currentProjectId !== resourceRequest.projectId) {
      useAppStore.getState().clearResourceCommandRequest(resourceRequest.token);
      return;
    }
    const store = useAppStore.getState();
    if (resourceRequest.action === "prompt.new") {
      store.clearResourceCommandRequest(resourceRequest.token);
      startNew();
      return;
    }
    if (!promptsLoaded || loadedProjectId !== resourceRequest.projectId) return;
    store.clearResourceCommandRequest(resourceRequest.token);
    const target = resourceRequest.filePath
      ? prompts.find((prompt) => prompt.filePath === resourceRequest.filePath)
      : undefined;
    if (!target) {
      store.pushToast({ kind: "info", message: "Select a prompt first." });
      return;
    }
    if (resourceRequest.action === "prompt.copyInvocation") {
      void copyText(target.invocation).then((copied) => {
        useAppStore.getState().pushToast({
          kind: copied ? "success" : "error",
          message: copied
            ? `Copied ${target.invocation} to the clipboard.`
            : "Couldn't copy the prompt invocation.",
        });
      });
      return;
    }
    const request = {
      kind: "prompt" as const,
      projectId: resourceRequest.projectId,
      filePath: target.filePath,
    };
    void (
      resourceRequest.action === "prompt.openFile"
        ? openResourceFile(request)
        : revealResourceFile(request)
    ).then((available) => {
      if (!available) {
        useAppStore.getState().pushToast({
          kind: "info",
          message: "Opening resource files is unavailable in this browser.",
        });
      }
    });
  }, [currentProjectId, loadedProjectId, prompts, promptsLoaded, resourceRequest]);

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return;
    try {
      const response = await fetch("/resources/prompts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: draft.projectId ?? undefined,
          scope: draft.scope,
          name: draft.name.trim(),
          edit: {
            description: draft.description,
            body: draft.body,
            argumentHint: draft.argumentHint,
          },
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      setDraft(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const rename = async (): Promise<void> => {
    if (!renaming) return;
    const newName = renaming.value.trim();
    if (!newName || newName === renaming.name) {
      setRenaming(null);
      return;
    }
    try {
      const response = await fetch("/resources/prompts/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId ?? undefined,
          scope: renaming.scope,
          name: renaming.name,
          newName,
        }),
      });
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, "Couldn't rename the prompt."));
      }
      setRenaming(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (prompt: PromptInfo): Promise<void> => {
    try {
      const response = await fetch("/resources/prompts", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId ?? undefined,
          scope: prompt.scope === "library" ? "library" : "global",
          name: prompt.name,
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <PageShell
      width="split"
      testId="prompts-screen"
      hero={
        <SectionHero
          imageSrc="/screen-art/screen-art-prompts.jpg"
          title="Prompts"
          subtitle="Create reusable prompts and reference files in place."
          actions={
            <>
              <SectionHeroButton
                data-testid="prompt-add-external"
                variant="ghost"
                title="Reference an existing markdown or text file in place — it stays where you keep it (never copied)"
                onClick={() => void importExternalPrompt()}
              >
                Reference file…
              </SectionHeroButton>
              <SectionHeroButton data-testid="prompt-new" variant="primary" onClick={startNew}>
                <Plus size={13} /> New prompt
              </SectionHeroButton>
            </>
          }
        />
      }
    >
      <MasterDetailSplit
        master={
          <>
            <PageToolbar
              inset="panel"
              leading={
                <AppTextField
                  data-testid="prompt-search"
                  size="sm"
                  aria-label="Search prompt templates"
                  placeholder="Search prompts"
                  value={search}
                  onChange={setSearch}
                  leadingIcon={<Search aria-hidden />}
                  showClear
                  clearLabel="Clear prompt search"
                  autoComplete="off"
                  spellCheck={false}
                />
              }
            />
            <AppScrollView className="flex-1" contentClassName="px-4 py-4">
              {externalPath !== null ? (
                <div className="mb-3 flex gap-2">
                  <ControlInput
                    autoFocus
                    data-testid="prompt-external-path"
                    className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
                    placeholder="absolute path to an existing prompt file (.md, .markdown, .mdown, .txt)"
                    value={externalPath}
                    onChange={(event) => setExternalPath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void addExternalRef();
                      if (event.key === "Escape") setExternalPath(null);
                    }}
                  />
                  <Button
                    data-testid="prompt-external-confirm"
                    size="sm"
                    variant="secondary"
                    disabled={!externalPath.trim()}
                    onClick={() => void addExternalRef()}
                  >
                    Reference
                  </Button>
                </div>
              ) : null}
              <p className="pb-3 text-caption text-text-muted">
                Reusable prompts pi exposes as <code className="font-mono">/&lt;name&gt;</code>{" "}
                slash commands. Project prompts override global ones of the same name.
              </p>

              {packageWarnings.length > 0 ? (
                <div data-testid="prompt-package-warnings" className="mb-2">
                  <AppInlineNotice tone="neutral">
                    {packageWarnings.map((warning) => (
                      <div key={warning} className="truncate" title={warning}>
                        {warning}
                      </div>
                    ))}
                  </AppInlineNotice>
                </div>
              ) : null}
              <div
                className="space-y-1.5"
                data-testid="prompt-list"
                role="list"
                aria-label="Prompt templates"
              >
                {visiblePrompts.map((prompt) => (
                  <ControlButton
                    key={prompt.filePath}
                    data-prompt-name={prompt.name}
                    data-selected={selectedPromptFilePath === prompt.filePath}
                    className={cn(
                      "group flex w-full min-w-0 items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      selectedPromptFilePath === prompt.filePath
                        ? "border-selection-stroke bg-selection"
                        : "border-transparent bg-surface-elevated hover:border-border-subtle hover:bg-hover",
                      prompt.disabled && "opacity-60 saturate-50",
                    )}
                    role="listitem"
                    aria-current={selectedPromptFilePath === prompt.filePath ? "true" : undefined}
                    aria-label={`${prompt.invocation}${
                      selectedPromptFilePath === prompt.filePath ? ", selected" : ""
                    }`}
                    tabIndex={0}
                    onClick={() =>
                      useAppStore.getState().setSelectedPromptFilePath(prompt.filePath)
                    }
                  >
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-source-library/10 text-source-library">
                      <FileText size={14} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          data-testid="prompt-invocation"
                          className="truncate font-mono text-code font-medium text-text-primary"
                        >
                          {prompt.invocation}
                        </span>
                        {prompt.disabled ? (
                          <span
                            data-testid={`prompt-disabled-badge-${prompt.name}`}
                            className="shrink-0 rounded-capsule border border-border-strong px-1.5 text-micro text-text-muted"
                          >
                            disabled
                          </span>
                        ) : null}
                      </span>
                      {prompt.description ? (
                        <span className="mt-0.5 line-clamp-2 block text-detail text-text-muted">
                          {prompt.description}
                        </span>
                      ) : null}
                      <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                        <ScopeChip scope={prompt.scope} />
                        {prompt.argumentHint ? (
                          <span
                            data-testid="prompt-argument-hint"
                            className="max-w-full truncate rounded-capsule border border-border-subtle px-2 py-0.5 font-mono text-micro text-text-muted"
                          >
                            {prompt.argumentHint}
                          </span>
                        ) : null}
                        {defaultPrompts.includes(prompt.name) ? (
                          <span className="inline-flex items-center gap-1 rounded-capsule border border-accent/40 px-2 py-0.5 text-micro text-accent">
                            <Globe size={10} /> all projects
                          </span>
                        ) : null}
                        {prompt.external ? (
                          <span
                            data-testid={`prompt-external-${prompt.name}`}
                            className="rounded-capsule border border-border-subtle px-2 py-0.5 text-micro text-text-muted"
                          >
                            external
                          </span>
                        ) : null}
                        {prompt.source === "settings" ? (
                          <span
                            data-testid={`prompt-settings-${prompt.name}`}
                            className="rounded-capsule border border-border-subtle px-2 py-0.5 text-micro text-text-muted"
                          >
                            settings
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </ControlButton>
                ))}
                {promptsLoaded &&
                prompts.length > 0 &&
                hasSearchQuery &&
                visiblePrompts.length === 0 ? (
                  <AppEmptyState
                    data-testid="prompt-search-empty"
                    heading="No matches"
                    body="No prompt templates match your search."
                  />
                ) : null}
                {promptsLoaded && prompts.length === 0 && !draft ? (
                  <AppEmptyState heading="No prompt templates yet. Create one to use it as a slash command." />
                ) : null}
              </div>
            </AppScrollView>
          </>
        }
        detail={
          draft ? (
            <>
              <DetailHeader
                title={draft.original === undefined ? "New prompt" : `Edit /${draft.name}`}
                subtitle={draft.scope === "library" ? "Library prompt" : "Global prompt"}
                trailing={
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      data-testid="prompt-save"
                      disabled={!draft.name.trim()}
                      onClick={() => void save()}
                    >
                      Save prompt
                    </Button>
                  </>
                }
              />
              <AppScrollView className="flex-1" contentClassName="px-page-x py-page-y">
                <div className="mx-auto max-w-page space-y-4" data-testid="prompt-editor">
                  <Card title="Prompt details">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <label className="block text-caption font-medium text-text-secondary">
                        Command name
                        <AppTextField
                          ref={promptNameInputRef}
                          data-testid="prompt-name"
                          className="mt-1.5 font-mono"
                          placeholder="review"
                          value={draft.name}
                          disabled={draft.original !== undefined}
                          onChange={(name) => setDraft({ ...draft, name })}
                        />
                      </label>
                      <label className="block text-caption font-medium text-text-secondary">
                        Argument hint
                        <AppTextField
                          data-testid="prompt-argument-hint-input"
                          className="mt-1.5 font-mono"
                          placeholder="<pr-number>"
                          value={draft.argumentHint}
                          onChange={(argumentHint) => setDraft({ ...draft, argumentHint })}
                        />
                      </label>
                    </div>
                    <label className="mt-4 block text-caption font-medium text-text-secondary">
                      Description
                      <AppTextField
                        data-testid="prompt-description"
                        className="mt-1.5"
                        placeholder="What this prompt helps with"
                        value={draft.description}
                        onChange={(description) => setDraft({ ...draft, description })}
                      />
                    </label>
                  </Card>
                  <Card title="Prompt template">
                    <label className="block text-caption font-medium text-text-secondary">
                      Markdown instructions
                      <ControlTextArea
                        data-testid="prompt-body"
                        className="mt-1.5 min-h-64 w-full resize-y rounded-control border border-border-strong bg-surface p-3 font-mono text-code text-text-primary outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30"
                        placeholder="Write the reusable prompt instructions…"
                        spellCheck={false}
                        value={draft.body}
                        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      />
                    </label>
                  </Card>
                  {draft.filePath ? (
                    <p
                      data-testid="prompt-file-path"
                      className="truncate font-mono text-detail text-text-muted"
                      title={draft.filePath}
                    >
                      {draft.filePath}
                    </p>
                  ) : null}
                  {draft.original !== undefined &&
                  draft.scope === "global" &&
                  projects.length > 0 ? (
                    <Card title="Available in projects" data-testid="prompt-availability">
                      <p className="pb-2 text-detail text-text-muted">
                        Inject this prompt as a <code className="font-mono">/{draft.name}</code>{" "}
                        command in specific projects (in addition to any All Projects default).
                      </p>
                      <div className="space-y-0.5">
                        {projects.map((project) => {
                          const assigned = (project.assignedPrompts ?? []).includes(draft.name);
                          return (
                            <label
                              key={project.id}
                              className="flex items-center gap-2.5 rounded px-1.5 py-1 hover:bg-hover"
                            >
                              <ControlInput
                                type="checkbox"
                                data-testid={`prompt-assign-${draft.name}-${project.name}`}
                                checked={assigned}
                                onChange={(event) => {
                                  const next = new Set(project.assignedPrompts ?? []);
                                  if (event.target.checked) next.add(draft.name);
                                  else next.delete(draft.name);
                                  void updateProject(project.id, { assignedPrompts: [...next] });
                                }}
                              />
                              <span className="text-label text-text-primary">{project.name}</span>
                              <span className="truncate font-mono text-detail text-text-muted">
                                {project.path}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </Card>
                  ) : null}
                </div>
              </AppScrollView>
            </>
          ) : selectedPrompt ? (
            <>
              <DetailHeader
                title={selectedPrompt.invocation}
                subtitle={selectedPrompt.description || selectedPrompt.filePath}
                trailing={
                  <Button size="sm" variant="primary" onClick={() => startEdit(selectedPrompt)}>
                    {isReadOnlyPrompt(selectedPrompt) ? "Customize" : "Edit"}
                  </Button>
                }
              />
              <AppScrollView className="flex-1" contentClassName="px-page-x py-page-y">
                <div className="mx-auto max-w-page space-y-4">
                  <div className="flex flex-wrap items-center gap-2" aria-label="Prompt actions">
                    {(selectedPrompt.scope === "global" || selectedPrompt.external) &&
                      (() => {
                        const on = defaultPrompts.includes(selectedPrompt.name);
                        return (
                          <Button
                            data-testid={`prompt-default-${selectedPrompt.name}`}
                            size="sm"
                            variant="pill"
                            isActive={on}
                            aria-pressed={on}
                            leadingIcon={<Globe size={12} />}
                            onClick={() => void toggleDefault(selectedPrompt.name, !on)}
                          >
                            {on ? "All Projects on" : "Use in All Projects"}
                          </Button>
                        );
                      })()}
                    {selectedPrompt.scope === "builtin" ? (
                      <Button
                        data-testid={`prompt-builtin-toggle-${selectedPrompt.name}`}
                        size="sm"
                        variant="secondary"
                        onClick={() => void toggleBuiltinDisabled(selectedPrompt)}
                      >
                        {selectedPrompt.disabled ? "Enable builtin" : "Disable builtin"}
                      </Button>
                    ) : null}
                    {selectedPrompt.external ? (
                      <Button
                        data-testid={`prompt-remove-external-${selectedPrompt.name}`}
                        size="sm"
                        variant="destructiveOutline"
                        onClick={() => void removeExternalRef(selectedPrompt)}
                      >
                        Remove reference
                      </Button>
                    ) : null}
                    {!isReadOnlyPrompt(selectedPrompt) ? (
                      <>
                        <Button
                          data-testid={`prompt-rename-${selectedPrompt.name}`}
                          size="sm"
                          variant="secondary"
                          leadingIcon={<Pencil size={12} />}
                          onClick={() =>
                            setRenaming({
                              name: selectedPrompt.name,
                              scope: selectedPrompt.scope,
                              value: selectedPrompt.name,
                            })
                          }
                        >
                          Rename
                        </Button>
                        <Button
                          data-testid={`prompt-delete-${selectedPrompt.name}`}
                          size="sm"
                          variant="destructiveOutline"
                          leadingIcon={<Trash2 size={12} />}
                          onClick={() => {
                            if (
                              confirm(
                                `Delete prompt "${selectedPrompt.name}"? This removes its file.`,
                              )
                            )
                              void remove(selectedPrompt);
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    ) : null}
                  </div>

                  {renaming?.name === selectedPrompt.name &&
                  renaming.scope === selectedPrompt.scope ? (
                    <Card title="Rename prompt">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-code text-text-muted">/</span>
                        <AppTextField
                          autoFocus
                          data-testid={`prompt-rename-input-${selectedPrompt.name}`}
                          className="font-mono"
                          value={renaming.value}
                          onChange={(value) => setRenaming({ ...renaming, value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void rename();
                            if (event.key === "Escape") setRenaming(null);
                          }}
                        />
                        <IconButton
                          data-testid={`prompt-rename-confirm-${selectedPrompt.name}`}
                          size="sm"
                          aria-label="Rename"
                          title="Rename"
                          icon={<Check />}
                          onClick={() => void rename()}
                        />
                        <IconButton
                          data-testid={`prompt-rename-cancel-${selectedPrompt.name}`}
                          size="sm"
                          aria-label="Cancel"
                          title="Cancel"
                          icon={<X />}
                          onClick={() => setRenaming(null)}
                        />
                      </div>
                    </Card>
                  ) : null}

                  <Card title="Prompt information">
                    <dl className="grid gap-3 text-caption sm:grid-cols-2">
                      <div>
                        <dt className="text-text-muted">Scope</dt>
                        <dd className="mt-1">
                          <ScopeChip scope={selectedPrompt.scope} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-text-muted">Argument hint</dt>
                        <dd className="mt-1 font-mono text-text-primary">
                          {selectedPrompt.argumentHint || "None"}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-text-muted">File</dt>
                        <dd className="mt-1 break-all font-mono text-detail text-text-secondary">
                          {selectedPrompt.filePath}
                        </dd>
                      </div>
                    </dl>
                  </Card>
                  <Card title="Prompt template">
                    <pre className="whitespace-pre-wrap font-mono text-code text-text-primary">
                      {selectedPrompt.body || "_(empty)_"}
                    </pre>
                  </Card>
                </div>
              </AppScrollView>
            </>
          ) : (
            <AppEmptyState
              layout="fill"
              icon={<FileText size={28} />}
              heading="Select a prompt"
              body="Choose a prompt from the list to inspect its template and manage it."
              role="presentation"
            />
          )
        }
      />
    </PageShell>
  );
}
