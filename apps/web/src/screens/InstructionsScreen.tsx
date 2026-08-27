import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppLabelTag } from "@/design-system/components/AppLabelTag";
import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { Button } from "@/design-system/components/Button";
import { ControlTextArea } from "@/design-system/components/NativeControls";
import { PageShell } from "@/design-system/components/PageShell";
import { PageToolbar } from "@/design-system/components/PageToolbar";
import { SectionHero } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import { useAppStore } from "../state/store.ts";
import { sectionHeaderClass } from "@/design-system/styles";

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

  return (
    <PageShell
      width="split"
      testId="instructions-screen"
      hero={
        <SectionHero
          imageSrc="/screen-art/screen-art-instructions.jpg"
          title="Instructions"
          subtitle="Manage the project and system guidance agents receive."
        />
      }
      toolbar={
        <PageToolbar
          leading={
            <AppSegmentedPicker
              aria-label="Instruction file"
              size="sm"
              value={fileKind}
              onChange={setFileKind}
              options={[
                { id: "context", label: "Context", "data-testid": "instructions-file-context" },
                { id: "system", label: "Base prompt", "data-testid": "instructions-file-system" },
                { id: "append", label: "Append", "data-testid": "instructions-file-append" },
              ]}
            />
          }
          trailing={
            <>
              <AppSegmentedPicker
                aria-label="Instructions scope"
                size="sm"
                value={scope}
                onChange={setScope}
                options={[
                  { id: "project", label: "Project", "data-testid": "instructions-scope-project" },
                  { id: "global", label: "Global", "data-testid": "instructions-scope-global" },
                ]}
              />
              {fileKind !== "context" && fileExists && !needsProject ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="instructions-remove-override"
                  title={
                    fileKind === "system"
                      ? "Delete this SYSTEM.md so pi falls back to its default base prompt"
                      : "Delete this APPEND_SYSTEM.md so pi falls back to the global append file, if any"
                  }
                  onClick={() => void removeOverride()}
                >
                  Remove override
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                data-testid="instructions-preview-toggle"
                aria-pressed={preview !== null}
                title="Preview the assembled system prompt pi builds from these files"
                onClick={() => void togglePreview()}
              >
                Preview
              </Button>
              <Button
                size="sm"
                data-testid="instructions-save"
                disabled={!dirty || saving || !loaded || needsProject}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : dirty ? "Save" : "Saved"}
              </Button>
            </>
          }
        />
      }
    >
      <div className="flex min-h-0 w-full flex-1 flex-col px-page-x py-page-y">
        {needsProject ? (
          <AppEmptyState
            layout="fill"
            data-testid="instructions-no-project"
            heading={`Select a project in the sidebar to edit its ${fallbackName}, or switch to Global to edit the instructions that apply to every session.`}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 pb-3">
              <p
                className="min-w-0 truncate font-mono text-detail text-text-muted"
                title={filePath}
              >
                {filePath}
              </p>
              {statusChip ? (
                <AppLabelTag data-testid="instructions-status" variant="neutral">
                  {statusChip}
                </AppLabelTag>
              ) : null}
            </div>
            {fileKind === "system" ? (
              <p
                className="pb-3 text-caption text-text-muted"
                data-testid="instructions-system-note"
              >
                {fileExists
                  ? "This file REPLACES pi's built-in base prompt for this scope."
                  : scope === "project"
                    ? "Creating SYSTEM.md overrides pi's base prompt for this project (it wins over the global SYSTEM.md)."
                    : "Creating SYSTEM.md overrides pi's built-in base prompt for every session without a project override."}
              </p>
            ) : null}
            {fileKind === "append" ? (
              <p
                className="pb-3 text-caption text-text-muted"
                data-testid="instructions-append-note"
              >
                {scope === "project"
                  ? "APPEND_SYSTEM.md is tacked onto the end of the base prompt — this project's file wins over the global one."
                  : "APPEND_SYSTEM.md is tacked onto the end of the base prompt for sessions without a project append file."}
              </p>
            ) : null}
            {preview ? (
              <div
                data-testid="instructions-preview"
                className="mb-3 max-h-72 space-y-2 overflow-y-auto rounded-lg border border-border-subtle px-2.5 py-1.5"
              >
                {preview.map((section, index) => (
                  <div key={`${section.kind}-${index}`}>
                    <div className={cn(sectionHeaderClass, "text-text-muted")}>
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
                className="pb-3 text-detail text-text-muted"
                data-testid="instructions-context-shadowed"
              >
                Shadowed in this folder (AGENTS.md wins): {contextShadowed}
              </p>
            ) : null}
            {showAncestors && ancestors.length > 0 ? (
              <div
                data-testid="instructions-ancestors"
                className="mb-3 rounded-lg border border-border-subtle px-2.5 py-1.5 text-detail text-text-secondary"
              >
                <div className={cn(sectionHeaderClass, "text-text-muted")}>Inherited context</div>
                <p className="pb-1 text-caption text-text-muted">
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
                className="min-h-0 flex-1 resize-none rounded-2xl border border-border-subtle bg-surface p-4 font-mono text-code text-text-primary outline-none focus:border-accent"
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
              <AppEmptyState data-testid="instructions-loading" heading="Loading…" />
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}
