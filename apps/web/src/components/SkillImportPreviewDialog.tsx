import { Button } from "@/design-system/components/Button";
import { IconButton } from "@/design-system/components/IconButton";
import { ControlInput } from "@/design-system/components/NativeControls";
import { FolderInput, GitBranch, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { cn } from "@/lib/cn";

/** One discoverable skill from `/resources/skills/inspect-git` (SKL-03). */
export interface SkillPreviewItem {
  /** Engine skill name (the import selection key). */
  name: string;
  /** Selection identity when names can collide across sources (defaults to `name`). */
  id?: string;
  /** Where this skill was discovered — shown per row for multi-source scans (SKL-07). */
  sourceLabel?: string;
  /** SKILL.md frontmatter name, or the folder name when absent. */
  displayName: string;
  description?: string;
  /** Files beyond SKILL.md itself — shown as a badge when > 0. */
  extraFileCount: number;
  /** Local-folder scans (engine >=0.1.10): the entry is a symlink and this is where it
   *  resolves — `~/.claude/skills/<name>` is such a link after fan-out. Shown as a badge. */
  linkTarget?: string;
  /** A skill with this name is already in the catalog: rendered greyed out and unselectable,
   *  so a scan of a folder full of imported skills doesn't collide on every one of them. */
  alreadyImported?: boolean;
}

/**
 * Import preview + per-skill selection (SKL-03/SKL-04): what native's SkillImportSheet does for
 * the git path. The parent fetched the preview; this dialog owns selection and hands back the
 * chosen skill names. Cancel (button or Escape) tells the parent to discard the cached preview.
 */
export function SkillImportPreviewDialog({
  sourceLabel,
  sourceKind = "git",
  skills,
  defaultSelected,
  onImport,
  onCancel,
}: {
  /** The reference the user gave (repo URL or folder path) — shown so they know the source. */
  sourceLabel: string;
  /** Picks the header icon; the selection/import behavior is identical for all kinds. */
  sourceKind?: "git" | "local" | "known";
  /** Initial selection keys; defaults to every skill. Multi-source scans pass a name-deduped
   *  set so two same-name skills don't both import into one catalog name (review, Codex). */
  defaultSelected?: string[];
  skills: SkillPreviewItem[];
  /** Import the selection; reject (throw) to keep the dialog open with the error shown. */
  onImport: (selected: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, cancelRef);
  // Native pre-selects every importable skill; deselection is the exception. Multi-source
  // scans pass a name-deduped defaultSelected instead (review, Codex).
  const keyOf = (s: SkillPreviewItem): string => s.id ?? s.name;
  // Already-imported skills are never selectable: importing one can only collide (the engine
  // refuses to clobber), and one collision fails the whole folder's import.
  const selectable = (s: SkillPreviewItem): boolean => !s.alreadyImported;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => {
    const blocked = new Set(skills.filter((s) => !selectable(s)).map(keyOf));
    return new Set((defaultSelected ?? skills.map(keyOf)).filter((k) => !blocked.has(k)));
  });
  // A preview whose items change under an open dialog (a rescan, a partial import) must not keep
  // stale keys selected — they'd count in "N selected" while matching nothing on screen.
  useEffect(() => {
    const live = new Set(skills.filter(selectable).map(keyOf));
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [skills]);
  const alreadyImportedCount = skills.filter((s) => !selectable(s)).length;
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous locks: React state commits too late to stop a double-activation, and a cancel
  // during an in-flight import would discard the preview the import is using (review, Codex).
  const importLock = useRef(false);
  const cancelSafely = (): void => {
    if (importLock.current) return;
    onCancel();
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelSafely();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onCancel]);

  const visible = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return skills;
    return skills.filter((s) => {
      const haystack =
        `${s.displayName} ${s.name} ${s.description ?? ""} ${s.sourceLabel ?? ""}`.toLowerCase();
      return tokens.every((t) => haystack.includes(t));
    });
  }, [skills, query]);

  const visibleSelectable = visible.filter(selectable);
  const allVisibleSelected =
    visibleSelectable.length > 0 && visibleSelectable.every((s) => selected.has(keyOf(s)));
  const toggleVisible = (): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visibleSelectable) {
        if (allVisibleSelected) next.delete(keyOf(s));
        else next.add(keyOf(s));
      }
      return next;
    });
  };

  const doImport = async (): Promise<void> => {
    if (selected.size === 0 || importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setError(null);
    try {
      await onImport([...selected]);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      importLock.current = false;
      setImporting(false);
    }
  };

  const bulkLabel = query.trim()
    ? allVisibleSelected
      ? "Deselect visible"
      : "Select visible"
    : allVisibleSelected
      ? "Deselect all"
      : "Select all";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 [-webkit-app-region:no-drag]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-import-preview-title"
        data-testid="skill-import-preview-dialog"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-elevated shadow-elevated"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2
              id="skill-import-preview-title"
              className="flex items-center gap-2 font-medium text-text-primary"
            >
              {sourceKind === "git" ? (
                <GitBranch size={15} aria-hidden />
              ) : (
                <FolderInput size={15} aria-hidden />
              )}
              Import skills
            </h2>
            <p className="truncate font-mono text-code text-text-muted" title={sourceLabel}>
              {sourceLabel}
            </p>
          </div>
          <IconButton
            aria-label="Cancel import"
            size="md"
            disabled={importing}
            onClick={cancelSafely}
            icon={<X />}
          />
        </header>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <ControlInput
            data-testid="skill-import-preview-search"
            className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-detail text-text-primary outline-none focus:border-accent"
            placeholder="Search skills"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search skills"
          />
          <Button
            data-testid="skill-import-preview-toggle-all"
            size="sm"
            variant="ghost"
            disabled={visibleSelectable.length === 0 || importing}
            onClick={toggleVisible}
          >
            {bulkLabel}
          </Button>
        </div>

        <p
          className="px-4 pt-2 text-caption text-text-muted"
          data-testid="skill-import-preview-count"
        >
          Showing {visible.length} of {skills.length} skill{skills.length === 1 ? "" : "s"} •{" "}
          {selected.size} selected
          {alreadyImportedCount > 0 ? ` • ${alreadyImportedCount} already imported` : ""}
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {visible.length === 0 ? (
            <p className="px-2 py-6 text-center text-caption text-text-muted">
              No importable skills match your search.
            </p>
          ) : (
            <ul className="flex flex-col">
              {visible.map((skill) => (
                <li key={keyOf(skill)} className="border-b border-border last:border-b-0">
                  <label
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg px-2 py-2.5",
                      skill.alreadyImported
                        ? "cursor-default opacity-50"
                        : "cursor-pointer hover:bg-hover",
                    )}
                    data-testid={
                      skill.alreadyImported
                        ? `skill-import-preview-imported-${keyOf(skill)}`
                        : undefined
                    }
                  >
                    <ControlInput
                      type="checkbox"
                      data-testid={`skill-import-preview-check-${keyOf(skill)}`}
                      className="mt-0.5 accent-accent"
                      checked={selected.has(keyOf(skill))}
                      disabled={importing || skill.alreadyImported === true}
                      aria-disabled={skill.alreadyImported === true}
                      onChange={() => {
                        if (skill.alreadyImported) return; // belt and braces with `disabled`
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(keyOf(skill))) next.delete(keyOf(skill));
                          else next.add(keyOf(skill));
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-2">
                        <span className="text-label font-medium text-text-primary">
                          {skill.displayName}
                        </span>
                        {skill.extraFileCount > 0 ? (
                          <span className="rounded-capsule border border-border px-1.5 text-micro text-text-muted">
                            {skill.extraFileCount} file{skill.extraFileCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {skill.alreadyImported ? (
                          <span className="rounded-capsule border border-border px-1.5 text-micro text-text-muted">
                            Already imported
                          </span>
                        ) : null}
                        {skill.linkTarget ? (
                          <span
                            className="rounded-capsule border border-border px-1.5 text-micro text-text-muted"
                            title={`Symlink → ${skill.linkTarget}`}
                          >
                            linked
                          </span>
                        ) : null}
                      </span>
                      {skill.description ? (
                        <span className="mt-0.5 line-clamp-2 block text-caption text-text-secondary">
                          {skill.description}
                        </span>
                      ) : null}
                      <span className="mt-0.5 block truncate font-mono text-micro text-text-muted">
                        {skill.sourceLabel ? `${skill.sourceLabel} · ` : ""}
                        {skill.name}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p
            className="min-w-0 flex-1 truncate text-detail text-danger"
            data-testid="skill-import-preview-error"
            role="status"
            aria-live="polite"
            title={error ?? undefined}
          >
            {error}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              ref={cancelRef}
              data-testid="skill-import-preview-cancel"
              size="md"
              variant="secondary"
              disabled={importing}
              onClick={cancelSafely}
            >
              Cancel
            </Button>
            <Button
              size="md"
              variant="primary"
              data-testid="skill-import-preview-import"
              disabled={selected.size === 0 || importing}
              onClick={() => void doImport()}
            >
              {importing
                ? "Importing…"
                : `Import ${selected.size} skill${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
