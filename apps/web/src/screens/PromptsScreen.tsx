import {
  ControlButton,
  ControlInput,
  ControlTextArea,
} from "@/design-system/components/NativeControls";
import { AppTextField } from "@/design-system/components/AppTextField";
import { SectionHero, SectionHeroButton } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Globe, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { PromptInfo } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { chooseFiles, openResourceFile, revealResourceFile } from "../lib/native.ts";
import { useAppStore } from "../state/store.ts";
import { updateProject } from "../state/wsBridge.ts";

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
    <div className="flex min-h-0 flex-1 flex-col" data-testid="prompts-screen">
      <SectionHero
        imageSrc="/screen-art/screen-art-prompts.jpg"
        title="Prompt templates"
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
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
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
              <ControlButton
                data-testid="prompt-external-confirm"
                className="rounded-capsule border border-border-strong px-2.5 text-detail text-text-secondary hover:text-text-primary disabled:opacity-40"
                disabled={!externalPath.trim()}
                onClick={() => void addExternalRef()}
              >
                Reference
              </ControlButton>
            </div>
          ) : null}
          <p className="pb-3 text-caption text-text-muted">
            Reusable prompts pi exposes as <code className="font-mono">/&lt;name&gt;</code> slash
            commands. Project prompts override global ones of the same name.
          </p>

          <AppTextField
            data-testid="prompt-search"
            className="mb-3"
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

          {draft ? (
            <div
              className="mb-4 space-y-2 rounded-2xl border border-border-strong bg-surface-elevated p-4"
              data-testid="prompt-editor"
            >
              <ControlInput
                ref={promptNameInputRef}
                data-testid="prompt-name"
                className="w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent disabled:opacity-50"
                placeholder="name (e.g. review)"
                value={draft.name}
                disabled={draft.original !== undefined}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <ControlInput
                data-testid="prompt-description"
                className="w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-label text-text-primary outline-none focus:border-accent"
                placeholder="description"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
              <ControlInput
                data-testid="prompt-argument-hint-input"
                className="w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
                placeholder="argument hint (e.g. <pr-number>) — shown next to /name"
                value={draft.argumentHint}
                onChange={(e) => setDraft({ ...draft, argumentHint: e.target.value })}
              />
              <ControlTextArea
                data-testid="prompt-body"
                className="h-48 w-full resize-none rounded-lg border border-border-strong bg-surface p-3 font-mono text-code text-text-primary outline-none focus:border-accent"
                placeholder="The prompt template. Markdown."
                spellCheck={false}
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              {/* On-disk path (native "File" metadata row, PromptsViews.swift:700);
                mirrors the Skills editor's path line. Only for an existing prompt. */}
              {draft.filePath ? (
                <div
                  data-testid="prompt-file-path"
                  className="truncate text-detail text-text-muted"
                  title={draft.filePath}
                >
                  {draft.filePath}
                </div>
              ) : null}
              {/* Per-project availability (native assignedPromptTemplateNames). Like
                the All-Projects default, this is a GLOBAL concept: assigning a
                global prompt to a project injects it as --prompt-template there.
                Shown only when editing an existing global prompt. */}
              {draft.original !== undefined && draft.scope === "global" && projects.length > 0 ? (
                <div
                  className="rounded-lg border border-border-subtle bg-surface p-2.5"
                  data-testid="prompt-availability"
                >
                  <div className="pb-1 text-micro font-semibold uppercase tracking-overline text-text-muted">
                    Available in projects
                  </div>
                  <p className="pb-1.5 text-detail text-text-muted">
                    Inject this prompt as a <code className="font-mono">/{draft.name}</code> command
                    in specific projects (in addition to any All Projects default).
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
                </div>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <ControlButton
                  className="rounded-capsule px-3 py-1 text-detail text-text-secondary hover:text-text-primary"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </ControlButton>
                <ControlButton
                  data-testid="prompt-save"
                  className="rounded-capsule px-3 py-1 text-detail font-medium shadow-capsule disabled:opacity-40"
                  style={{
                    background:
                      "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                    color: "var(--color-accent-foreground)",
                  }}
                  disabled={!draft.name.trim()}
                  onClick={() => void save()}
                >
                  Save
                </ControlButton>
              </div>
            </div>
          ) : null}

          {packageWarnings.length > 0 ? (
            <div
              data-testid="prompt-package-warnings"
              className="mb-2 rounded-lg border border-border px-2.5 py-1.5 text-detail text-text-secondary"
              role="status"
            >
              {packageWarnings.map((warning) => (
                <div key={warning} className="truncate" title={warning}>
                  {warning}
                </div>
              ))}
            </div>
          ) : null}
          <div
            className="space-y-1.5"
            data-testid="prompt-list"
            role="list"
            aria-label="Prompt templates"
          >
            {visiblePrompts.map((prompt) => (
              <div
                key={prompt.filePath}
                data-prompt-name={prompt.name}
                data-selected={selectedPromptFilePath === prompt.filePath}
                className={cn(
                  "group flex items-center gap-3 rounded-xl border bg-surface px-3.5 py-2.5",
                  selectedPromptFilePath === prompt.filePath
                    ? "border-selection-stroke bg-selection"
                    : "border-border-subtle",
                )}
                role="listitem"
                aria-current={selectedPromptFilePath === prompt.filePath ? "true" : undefined}
                aria-label={`${prompt.invocation}${
                  selectedPromptFilePath === prompt.filePath ? ", selected" : ""
                }`}
                tabIndex={0}
                onClick={() => useAppStore.getState().setSelectedPromptFilePath(prompt.filePath)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    useAppStore.getState().setSelectedPromptFilePath(prompt.filePath);
                  }
                }}
              >
                {renaming?.name === prompt.name && renaming.scope === prompt.scope ? (
                  <>
                    <span className="font-mono text-code text-text-muted">/</span>
                    <ControlInput
                      autoFocus
                      data-testid={`prompt-rename-input-${prompt.name}`}
                      className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2 py-1 font-mono text-code text-text-primary outline-none focus:border-accent"
                      value={renaming.value}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                    <ControlButton
                      data-testid={`prompt-rename-confirm-${prompt.name}`}
                      className="rounded p-1 text-text-muted hover:text-accent"
                      title="Rename"
                      onClick={() => void rename()}
                    >
                      <Check size={14} />
                    </ControlButton>
                    <ControlButton
                      data-testid={`prompt-rename-cancel-${prompt.name}`}
                      className="rounded p-1 text-text-muted hover:text-text-primary"
                      title="Cancel"
                      onClick={() => setRenaming(null)}
                    >
                      <X size={14} />
                    </ControlButton>
                  </>
                ) : (
                  <>
                    <ControlButton
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onClick={() => startEdit(prompt)}
                    >
                      <span
                        data-testid="prompt-invocation"
                        className="font-mono text-code font-medium text-text-primary"
                        style={{ fontStretch: "expanded" }}
                      >
                        {prompt.invocation}
                      </span>
                      {prompt.argumentHint ? (
                        <span
                          data-testid="prompt-argument-hint"
                          className="shrink-0 rounded-capsule border border-border-subtle px-1.5 font-mono text-micro text-text-muted"
                        >
                          {prompt.argumentHint}
                        </span>
                      ) : null}
                      <span
                        data-testid="scope-chip"
                        data-scope={prompt.scope}
                        className={cn(
                          "rounded-capsule border px-1.5 text-micro",
                          prompt.scope === "library"
                            ? "border-border-strong text-text-secondary"
                            : "border-border-subtle text-text-muted",
                        )}
                      >
                        {prompt.scope}
                      </span>
                      {prompt.description ? (
                        <span className="min-w-0 flex-1 truncate text-caption text-text-muted">
                          {prompt.description}
                        </span>
                      ) : null}
                    </ControlButton>
                    {/* "All Projects" default is a GLOBAL concept — the backend
                      resolves a default name global-first, so the toggle shows for
                      global-scope prompts, plus EXTERNAL references (PRM-05): they
                      resolve as launchable defaults too. */}
                    {(prompt.scope === "global" || prompt.external) &&
                      (() => {
                        const on = defaultPrompts.includes(prompt.name);
                        return (
                          <ControlButton
                            data-testid={`prompt-default-${prompt.name}`}
                            aria-pressed={on}
                            className={cn(
                              "flex shrink-0 items-center gap-1 rounded-capsule border px-1.5 py-0.5 text-micro transition-colors",
                              on
                                ? "border-border-strong bg-selection text-text-primary"
                                : "border-border-subtle text-text-muted opacity-0 hover:text-text-primary group-hover:opacity-100",
                            )}
                            title={
                              on
                                ? "Enabled for All Projects — remove"
                                : "Enable this prompt for All Projects (injected as --prompt-template)"
                            }
                            onClick={() => void toggleDefault(prompt.name, !on)}
                          >
                            <Globe size={11} /> All Projects
                          </ControlButton>
                        );
                      })()}
                    {prompt.scope === "builtin" && prompt.disabled ? (
                      <span
                        data-testid={`prompt-disabled-badge-${prompt.name}`}
                        className="shrink-0 rounded-capsule border border-border-strong px-1.5 text-micro text-text-muted"
                        title="Disabled: excluded from launches until re-enabled"
                      >
                        disabled
                      </span>
                    ) : null}
                    {prompt.scope === "builtin" ? (
                      <ControlButton
                        data-testid={`prompt-builtin-toggle-${prompt.name}`}
                        className="rounded-capsule border border-border-strong px-2 py-0.5 text-micro text-text-secondary opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
                        title={
                          prompt.disabled
                            ? "Re-enable this builtin prompt"
                            : "Disable this builtin prompt (excluded from launches)"
                        }
                        onClick={() => void toggleBuiltinDisabled(prompt)}
                      >
                        {prompt.disabled ? "Enable" : "Disable"}
                      </ControlButton>
                    ) : null}
                    {prompt.source === "settings" ? (
                      <span
                        data-testid={`prompt-settings-${prompt.name}`}
                        className="shrink-0 rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
                        title={`Declared by settings.json: ${prompt.filePath}`}
                      >
                        settings
                      </span>
                    ) : null}
                    {prompt.external ? (
                      <>
                        <span
                          data-testid={`prompt-external-${prompt.name}`}
                          className="shrink-0 rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
                          title={`Referenced in place: ${prompt.filePath}`}
                        >
                          external
                        </span>
                        <ControlButton
                          data-testid={`prompt-remove-external-${prompt.name}`}
                          className="rounded-capsule border border-border-strong px-2 py-0.5 text-micro text-text-secondary opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                          title="Remove the reference — the file itself is not deleted"
                          onClick={() => void removeExternalRef(prompt)}
                        >
                          Remove reference
                        </ControlButton>
                      </>
                    ) : null}
                    {/* Builtin/package prompts are bundled/installed and immutable, and an
                      external reference's file is not a catalog file — no rename/delete;
                      opening one drafts a global copy instead (PRM-02/03/05). */}
                    {!isReadOnlyPrompt(prompt) ? (
                      <>
                        <ControlButton
                          data-testid={`prompt-rename-${prompt.name}`}
                          className="rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
                          title="Rename"
                          onClick={() =>
                            setRenaming({
                              name: prompt.name,
                              scope: prompt.scope,
                              value: prompt.name,
                            })
                          }
                        >
                          <Pencil size={13} />
                        </ControlButton>
                        <ControlButton
                          data-testid={`prompt-delete-${prompt.name}`}
                          className="rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                          title="Delete"
                          onClick={() => {
                            if (confirm(`Delete prompt "${prompt.name}"? This removes its file.`)) {
                              void remove(prompt);
                            }
                          }}
                        >
                          <Trash2 size={13} />
                        </ControlButton>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            ))}
            {promptsLoaded &&
            prompts.length > 0 &&
            hasSearchQuery &&
            visiblePrompts.length === 0 ? (
              <div
                className="py-8 text-center text-body text-text-muted"
                data-testid="prompt-search-empty"
                role="status"
              >
                No prompt templates match your search.
              </div>
            ) : null}
            {promptsLoaded && prompts.length === 0 && !draft ? (
              <div className="py-8 text-center text-body text-text-muted">
                No prompt templates yet. Create one to use it as a slash command.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
