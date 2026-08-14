import { ControlButton, ControlTextArea } from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { useAppStore } from "../state/store.ts";

/**
 * Instructions editor — pi's context files AND the base-prompt override (INS-01).
 * Two scopes (project / global) × two files:
 * - context: AGENTS.md (or its CLAUDE.md fallback), auto-loaded every turn.
 * - system:  SYSTEM.md, which REPLACES pi's built-in base prompt. pi resolves
 *   precedence itself (project SYSTEM.md → global SYSTEM.md → built-in); the app
 *   only catalogs and edits the candidates (native SystemInstructionsViews).
 */
type Scope = "project" | "global";
type FileKind = "context" | "system" | "append";

export function InstructionsScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const projects = useAppStore((state) => state.projects);
  const setError = useAppStore((state) => state.setError);
  const project = projects.find((p) => p.id === currentProjectId) ?? null;

  const [scope, setScope] = useState<Scope>(currentProjectId ? "project" : "global");
  const [fileKind, setFileKind] = useState<FileKind>("context");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileExists, setFileExists] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const activeKey = useRef<string | null>(null);
  const loadedKey = useRef<string | null>(null);

  // The current edit target. `key` identifies it (for stale-load guarding);
  // `url` is null only for project scope with no project selected.
  const key = `${fileKind}:${scope === "global" ? "global" : (currentProjectId ?? "")}`;
  const projectBase = currentProjectId ? `/projects/${encodeURIComponent(currentProjectId)}` : null;
  const routeName =
    fileKind === "context"
      ? "instructions"
      : fileKind === "system"
        ? "system-prompt"
        : "append-prompt";
  const url =
    scope === "global" ? `/runtime/${routeName}` : projectBase && `${projectBase}/${routeName}`;

  const load = useCallback(
    async (loadKey: string, loadUrl: string): Promise<void> => {
      activeKey.current = loadKey;
      try {
        const response = await fetch(loadUrl);
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as {
          content: string;
          path: string;
          exists?: boolean;
        };
        if (activeKey.current !== loadKey) return;
        setContent(data.content);
        setSavedContent(data.content);
        setFilePath(data.path);
        setFileExists(data.exists ?? data.content !== "");
      } catch (err) {
        setError(String(err));
      } finally {
        // Reveal the editor only after the first load, so a fill/keystroke can't
        // race the load resetting the controlled value.
        if (activeKey.current === loadKey) setLoaded(true);
      }
    },
    [setError],
  );

  useEffect(() => {
    // (Re)load when the target changes — scope/file toggle or project switch.
    // Loading once per key avoids a re-fire clobbering unsaved edits.
    if (url && loadedKey.current !== key) {
      loadedKey.current = key;
      setLoaded(false);
      setContent("");
      setSavedContent("");
      // Clear the path too, so the header can't show the PREVIOUS target's
      // resolved filename (e.g. a stale CLAUDE.md) while the new one loads.
      setFilePath("");
      setFileExists(false);
      void load(key, url);
    }
  }, [key, url, load]);

  const save = async (): Promise<void> => {
    if (!url) return;
    // a completion must only mutate the target it was issued FOR — the user may
    // have switched scope/file while the PUT was in flight (review, Codex)
    const targetKey = key;
    setSaving(true);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) throw new Error(await response.text());
      if (loadedKey.current !== targetKey) return;
      setSavedContent(content);
      setFileExists(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  // Remove the base-prompt OVERRIDE (system file only): deleting restores pi's
  // fallback (global SYSTEM.md or the built-in prompt) — an empty save would
  // instead replace the base prompt with nothing.
  const removeOverride = async (): Promise<void> => {
    if (!url || fileKind === "context" || saving) return;
    const targetKey = key;
    try {
      const response = await fetch(url, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, "Couldn't remove the override."));
      }
      if (loadedKey.current !== targetKey) return;
      setContent("");
      setSavedContent("");
      setFileExists(false);
    } catch (err) {
      setError(String(err));
    }
  };

  // INS-03: the inherited ancestor context candidates (read-only) — which parent
  // folders contribute instructions before the project's own context file.
  const [ancestors, setAncestors] = useState<{ dir: string; name: string; path: string }[]>([]);
  const [ancestorsTruncated, setAncestorsTruncated] = useState(false);
  const showAncestors = fileKind === "context" && scope === "project" && Boolean(currentProjectId);
  useEffect(() => {
    // clear FIRST: a project switch must never show the previous project's
    // ancestors while (or after) the new fetch runs (review, Codex)
    setAncestors([]);
    setAncestorsTruncated(false);
    if (!showAncestors || !projectBase) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${projectBase}/instruction-ancestors`);
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as {
          items: { dir: string; name: string; path: string }[];
          truncated?: boolean;
        };
        if (!cancelled) {
          setAncestors(data.items);
          setAncestorsTruncated(data.truncated === true);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showAncestors, projectBase, setError]);

  // INS-04: which file WINS per slot (server-computed, native status labels).
  interface SlotStatus {
    active: "project" | "global" | "builtin" | "none";
    project?: { path: string; exists: boolean };
    global: { path: string; exists: boolean };
  }
  interface ContextStatus {
    path: string;
    exists: boolean;
    shadowedSibling?: string;
  }
  const [status, setStatus] = useState<{
    base: SlotStatus;
    append: SlotStatus;
    context: { global: ContextStatus; project?: ContextStatus };
  } | null>(null);
  useEffect(() => {
    setStatus(null);
    let cancelled = false;
    const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
    void (async () => {
      try {
        const response = await fetch(`/runtime/instruction-status${query}`);
        if (!response.ok) throw new Error(await response.text());
        const data = (await response.json()) as NonNullable<typeof status>;
        if (!cancelled) setStatus(data);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // savedContent/fileExists change on every save/remove, refreshing the labels
  }, [currentProjectId, savedContent, fileExists, setError]);

  const statusChip = ((): string | null => {
    if (!status) return null;
    if (fileKind === "context") return null; // context files stack; shadowing is per-dir
    const slot = fileKind === "system" ? status.base : status.append;
    if (scope === "project") {
      if (!currentProjectId) return null;
      if (slot.active === "project") return "active";
      if (slot.active === "global") return "global file active";
      return fileKind === "system" ? "builtin prompt active" : "no append file";
    }
    if (slot.active === "project") return "overridden by project";
    if (slot.active === "global") return "active";
    return fileKind === "system" ? "builtin prompt active" : "no append file";
  })();
  const contextShadowed =
    fileKind === "context" && status
      ? (scope === "project" ? status.context.project : status.context.global)?.shadowedSibling
      : undefined;

  // INS-05: the assembled prompt preview (read-only; fetched on open).
  interface PreviewSection {
    kind: "base" | "append" | "context" | "placeholder";
    title: string;
    path?: string;
    content?: string;
    contentTruncated?: boolean;
  }
  const [preview, setPreview] = useState<PreviewSection[] | null>(null);
  const previewLoading = useRef(false);
  // a preview is a snapshot of ANOTHER project's files the moment the selection
  // changes — clear it rather than display stale paths (review, Codex)
  useEffect(() => {
    setPreview(null);
    previewLoading.current = false;
  }, [currentProjectId]);
  const togglePreview = async (): Promise<void> => {
    if (preview) {
      setPreview(null);
      return;
    }
    if (previewLoading.current) return; // a rapid second click must not race the first
    previewLoading.current = true;
    const targetProject = currentProjectId;
    try {
      const query = targetProject ? `?projectId=${encodeURIComponent(targetProject)}` : "";
      const response = await fetch(`/runtime/instruction-preview${query}`);
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { sections: PreviewSection[] };
      if (currentProjectId === targetProject) setPreview(data.sections);
    } catch (err) {
      setError(String(err));
    } finally {
      previewLoading.current = false;
    }
  };

  const dirty = content !== savedContent;
  const needsProject = scope === "project" && !project;
  // The effective file pi loads (AGENTS.md/CLAUDE.md for context; SYSTEM.md).
  const fallbackName =
    fileKind === "system" ? "SYSTEM.md" : fileKind === "append" ? "APPEND_SYSTEM.md" : "AGENTS.md";
  const fileName = filePath ? (filePath.split(/[\\/]/).pop() ?? fallbackName) : fallbackName;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="instructions-screen">
      <div className="mx-auto flex h-full max-w-3xl flex-col">
        <div className="flex items-center justify-between pb-1">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-text-secondary" aria-hidden />
            <h2
              className="text-base font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              {scope === "global" ? "Global" : (project?.name ?? "Project")} · {fileName}
            </h2>
            {statusChip ? (
              <span
                data-testid="instructions-status"
                className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
              >
                {statusChip}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-0.5 rounded-capsule border border-border-subtle p-0.5"
              role="group"
              aria-label="Instruction file"
            >
              {(
                [
                  ["context", "Context"],
                  ["system", "Base prompt"],
                  ["append", "Append"],
                ] as const
              ).map(([kind, label]) => (
                <ControlButton
                  key={kind}
                  data-testid={`instructions-file-${kind}`}
                  aria-pressed={fileKind === kind}
                  className={cn(
                    "rounded-capsule px-2.5 py-0.5 text-xs transition-colors",
                    fileKind === kind
                      ? "bg-selection text-text-primary"
                      : "text-text-muted hover:text-text-primary",
                  )}
                  onClick={() => setFileKind(kind)}
                >
                  {label}
                </ControlButton>
              ))}
            </div>
            <div
              className="flex items-center gap-0.5 rounded-capsule border border-border-subtle p-0.5"
              role="group"
              aria-label="Instructions scope"
            >
              {(["project", "global"] as const).map((s) => (
                <ControlButton
                  key={s}
                  data-testid={`instructions-scope-${s}`}
                  aria-pressed={scope === s}
                  className={cn(
                    "rounded-capsule px-2.5 py-0.5 text-xs capitalize transition-colors",
                    scope === s
                      ? "bg-selection text-text-primary"
                      : "text-text-muted hover:text-text-primary",
                  )}
                  onClick={() => setScope(s)}
                >
                  {s}
                </ControlButton>
              ))}
            </div>
            {fileKind !== "context" && fileExists && !needsProject ? (
              <ControlButton
                data-testid="instructions-remove-override"
                className="rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-danger"
                title={
                  fileKind === "system"
                    ? "Delete this SYSTEM.md so pi falls back to its default base prompt"
                    : "Delete this APPEND_SYSTEM.md so pi falls back to the global append file, if any"
                }
                onClick={() => void removeOverride()}
              >
                Remove override
              </ControlButton>
            ) : null}
            <ControlButton
              data-testid="instructions-preview-toggle"
              aria-pressed={preview !== null}
              className="rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
              title="Preview the assembled system prompt pi builds from these files"
              onClick={() => void togglePreview()}
            >
              Preview
            </ControlButton>
            <ControlButton
              data-testid="instructions-save"
              className="rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule disabled:opacity-40"
              style={{
                background:
                  "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                color: "var(--color-accent-foreground)",
              }}
              disabled={!dirty || saving || !loaded || needsProject}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </ControlButton>
          </div>
        </div>

        {needsProject ? (
          <div
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center"
            data-testid="instructions-no-project"
          >
            <div className="max-w-sm text-sm text-text-muted">
              Select a project in the sidebar to edit its{" "}
              <code className="rounded bg-surface px-1 font-mono text-xs">{fallbackName}</code>, or
              switch to <b>Global</b> to edit the instructions that apply to every session.
            </div>
          </div>
        ) : (
          <>
            <p className="truncate pb-3 font-mono text-detail text-text-muted" title={filePath}>
              {filePath}
            </p>
            {fileKind === "system" ? (
              <p className="pb-3 text-xs text-text-muted" data-testid="instructions-system-note">
                {fileExists
                  ? "This file REPLACES pi's built-in base prompt for this scope."
                  : scope === "project"
                    ? "Creating SYSTEM.md overrides pi's base prompt for this project (it wins over the global SYSTEM.md)."
                    : "Creating SYSTEM.md overrides pi's built-in base prompt for every session without a project override."}
              </p>
            ) : null}
            {fileKind === "append" ? (
              <p className="pb-3 text-xs text-text-muted" data-testid="instructions-append-note">
                {scope === "project"
                  ? "APPEND_SYSTEM.md is tacked onto the end of the base prompt — this project's file wins over the global one."
                  : "APPEND_SYSTEM.md is tacked onto the end of the base prompt for sessions without a project append file."}
              </p>
            ) : null}
            {preview ? (
              <div
                data-testid="instructions-preview"
                className="mb-3 max-h-72 space-y-2 overflow-y-auto rounded-lg border border-border px-2.5 py-1.5"
              >
                {preview.map((section, index) => (
                  <div key={`${section.kind}-${index}`}>
                    <div className="text-micro font-semibold uppercase tracking-wide text-text-muted">
                      {section.title}
                      {section.contentTruncated ? " (truncated)" : ""}
                    </div>
                    {section.path ? (
                      <div
                        className="truncate font-mono text-micro text-text-muted"
                        title={section.path}
                      >
                        {section.path}
                      </div>
                    ) : null}
                    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-micro text-text-secondary">
                      {section.content ?? ""}
                    </pre>
                  </div>
                ))}
              </div>
            ) : null}
            {contextShadowed ? (
              <p
                className="pb-3 text-xs text-text-muted"
                data-testid="instructions-context-shadowed"
              >
                Shadowed in this folder (AGENTS.md wins): {contextShadowed}
              </p>
            ) : null}
            {showAncestors && ancestors.length > 0 ? (
              <div
                data-testid="instructions-ancestors"
                className="mb-3 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary"
              >
                <div className="text-micro font-semibold uppercase tracking-wide text-text-muted">
                  Inherited context
                </div>
                <p className="pb-1 text-micro text-text-muted">
                  pi also loads these ancestor files, outermost first, before the project's own
                  context.
                  {ancestorsTruncated
                    ? " Outermost ancestors beyond the depth limit are omitted."
                    : ""}
                </p>
                {ancestors.map((item) => (
                  <div key={item.path} className="truncate font-mono text-micro" title={item.path}>
                    {item.path}
                  </div>
                ))}
              </div>
            ) : null}
            {loaded ? (
              <ControlTextArea
                data-testid="instructions-editor"
                className="min-h-0 flex-1 resize-none rounded-2xl border border-border-subtle bg-surface p-4 font-mono text-sm text-text-primary outline-none focus:border-accent"
                placeholder={
                  fileKind === "system"
                    ? "The replacement base prompt. Leave the override removed to keep pi's default."
                    : fileKind === "append"
                      ? "Extra instructions appended after the base prompt — house rules, tone, policies."
                      : scope === "global"
                        ? "Global context pi reads for every session. Markdown."
                        : "Project context pi reads on every turn. Markdown."
                }
                spellCheck={false}
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            ) : (
              <div
                className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-border-subtle text-sm text-text-muted"
                data-testid="instructions-loading"
              >
                Loading…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
