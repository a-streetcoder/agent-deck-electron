import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  FolderInput,
  FolderSearch,
  GitBranch,
  Grid3x3,
  Pencil,
  Power,
  PowerOff,
  Plus,
  Search,
  Tag,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import type { SkillInfo } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { responseErrorMessage } from "@/lib/responseError";
import {
  SkillImportPreviewDialog,
  type SkillPreviewItem,
} from "../components/SkillImportPreviewDialog.tsx";

interface SkillPathConflict {
  path: string;
  local: "file" | "directory" | "missing";
  remote: "file" | "directory" | "missing";
}
interface SkillMergeConflict {
  name: string;
  mergeId: string;
  paths: SkillPathConflict[];
}

/** A git-imported skill repo (native ImportedSkillRepository), for re-sync. */
interface SkillRecovery {
  token: string;
  skillName: string;
}

/** A Codex plugin skill reference (SKL-09) — the persisted identity, never a path. */
interface CodexPluginRef {
  marketplace: string;
  plugin: string;
  relPath: string;
}

interface SkillRepo {
  id: string;
  remoteUrl: string;
  ref?: string;
  subdir?: string;
  storageMode?: "collection-v1";
  skillNames: string[];
  lastSyncedCommit: string;
  importedAt: string;
  available: boolean;
  unavailable?: { code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE"; message: string };
  pendingMerges?: SkillMergeConflict[];
}
import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { IconButton } from "@/design-system/components/IconButton";

import { PageShell } from "@/design-system/components/PageShell";
import { PageToolbar } from "@/design-system/components/PageToolbar";
import { SectionHero } from "@/design-system/components/SectionHero";
import { MarkdownDocument } from "@/design-system/markdown/MarkdownDocument";
import { useAppStore } from "../state/store.ts";
import { deleteSkill, renameSkill, setSkillDisabled, updateProject } from "../state/wsBridge.ts";
import { ScopeChip } from "../components/ScopeChip.tsx";
import { chooseDirectory, trashSkillRecovery } from "../lib/native.ts";
import { sectionHeaderClass } from "@/design-system/styles";

/**
 * Full-width skill catalog with an in-place full-page detail route. Rows use
 * the wand glyph (source-green when assigned), detail renders SKILL.md, and
 * the assignment card — an "All Projects" row followed by per-project
 * checkbox rows that dim while All Projects is on
 * (SkillManagementViews.swift projectAssignmentList).
 */

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-label text-text-primary outline-none focus:border-accent";

/**
 * Mirrors pi's skill-name validity (skills.js validateName): ≤64 chars,
 * lowercase a-z / 0-9 / hyphens only, no leading/trailing or doubled hyphens.
 * The `/skill:<name>` invocation is only shown for a valid name, so the command
 * we display always actually resolves in pi (its parser stops at the first
 * space and it warns on — but still loads — otherwise-invalid names).
 */
function isValidSkillCommandName(name: string): boolean {
  return (
    name.length <= 64 &&
    /^[a-z0-9-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.endsWith("-") &&
    !name.includes("--")
  );
}

interface SkillDraft {
  name: string;
  scope: "global" | "project";
  description: string;
  body: string;
  isNew: boolean;
}

function SkillEditSheet({ draft, onClose }: { draft: SkillDraft; onClose: () => void }) {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const [form, setForm] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dirty =
    form.name !== draft.name || form.description !== draft.description || form.body !== draft.body;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
        (el) => !el.hasAttribute("disabled"),
      );
    focusables()[1]?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !dirtyRef.current) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async (): Promise<void> => {
    try {
      const response = await fetch("/resources/skills", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: currentProjectId ?? undefined,
          scope: form.scope,
          name: form.name.trim(),
          edit: { description: form.description, body: form.body },
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !dirty) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="flex max-h-[85vh] w-[560px] flex-col rounded-2xl border border-border-strong bg-surface-elevated shadow-elevated"
        data-testid="skill-editor"
        role="dialog"
        aria-modal="true"
        aria-label={draft.isNew ? "New skill" : `Edit ${draft.name}`}
      >
        <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-source-project-subtle text-source-project">
            <WandSparkles size={15} />
          </span>
          <div className="flex-1 truncate text-label font-semibold text-text-primary">
            {draft.isNew ? "New Skill" : `Edit ${draft.name}`}
          </div>
          <IconButton aria-label="Close" size="md" icon={<X />} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {draft.isNew ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="text-caption font-medium text-text-muted">
                Name
                <ControlInput
                  data-testid="skill-editor-name"
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="text-caption font-medium text-text-muted">
                Scope
                <ControlSelect
                  data-testid="skill-editor-scope"
                  className={inputClass}
                  value={form.scope}
                  onChange={(e) =>
                    setForm({ ...form, scope: e.target.value as "global" | "project" })
                  }
                >
                  <option value="global">global</option>
                  {currentProjectId ? <option value="project">project</option> : null}
                </ControlSelect>
              </label>
            </div>
          ) : null}
          <label className="block text-caption font-medium text-text-muted">
            Description
            <ControlInput
              data-testid="skill-editor-description"
              className={inputClass}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label className="block text-caption font-medium text-text-muted">
            SKILL.md body
            <ControlTextArea
              data-testid="skill-editor-body"
              className={cn(inputClass, "min-h-[220px] font-mono text-code")}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </label>
          {error ? (
            <div className="text-label" style={{ color: "var(--color-role-error)" }}>
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <Button size="md" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="skill-editor-save"
            size="md"
            variant="primary"
            disabled={!form.name.trim()}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function SkillCompareDialog({
  compare,
  onClose,
}: {
  compare: { left: SkillInfo; right: SkillInfo };
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const background = document.querySelector<HTMLElement>('[data-testid="skills-screen"]');
    background?.setAttribute("inert", "");
    background?.setAttribute("aria-hidden", "true");
    const frame = requestAnimationFrame(() => doneRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      background?.removeAttribute("inert");
      background?.removeAttribute("aria-hidden");
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-6">
      <div
        ref={dialogRef}
        data-testid="skill-compare-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Compare copies of ${compare.left.name}`}
        onKeyDown={onKeyDown}
        className="flex max-h-[90vh] w-[900px] max-w-full flex-col rounded-2xl border border-border-strong bg-surface-elevated shadow-elevated"
      >
        <div className="border-b border-border-subtle px-5 py-4">
          <div className="text-label font-semibold text-text-primary">Compare skills</div>
          <div className="text-detail text-text-muted">
            Review both copies of &quot;{compare.left.name}&quot; before choosing which one to keep.
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto min-[720px]:grid-cols-2 min-[720px]:divide-x min-[720px]:divide-border-subtle">
          {[compare.left, compare.right].map((side) => (
            <div key={side.filePath} className="flex min-h-0 min-w-0 flex-col">
              <div className="border-b border-border-subtle px-4 py-2">
                <div
                  className="truncate font-mono text-micro text-text-secondary"
                  title={side.filePath}
                >
                  {side.filePath}
                </div>
                <ScopeChip scope={side.scope} />
              </div>
              <div className="min-h-0 px-4 py-3 min-[720px]:overflow-y-auto">
                <MarkdownDocument source={side.body || "_(empty)_"} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end border-t border-border-subtle px-5 py-3">
          <Button
            ref={doneRef}
            data-testid="skill-compare-done"
            size="md"
            variant="secondary"
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AssignmentCard({ skill }: { skill: SkillInfo }) {
  const projects = useAppStore((state) => state.projects);
  const setError = useAppStore((state) => state.setError);
  const [defaultSkills, setDefaultSkills] = useState<string[]>([]);
  const [allProjectsBusy, setAllProjectsBusy] = useState(false);
  const allProjectsBusyRef = useRef(false);
  // A slower settings read must not overwrite a newer optimistic toggle or its
  // authoritative PATCH response.
  const settingsSeq = useRef(0);

  const refreshSettings = useCallback(
    async (force = false): Promise<void> => {
      // A skill-selection refresh is unnecessary while the global settings PATCH
      // owns the state. Failure recovery passes force=true after the PATCH settles.
      if (allProjectsBusyRef.current && !force) return;
      const seq = ++settingsSeq.current;
      try {
        const response = await fetch("/settings");
        if (!response.ok) throw new Error(await responseErrorMessage(response));
        const { settings } = (await response.json()) as { settings: { defaultSkills?: string[] } };
        if (seq === settingsSeq.current) setDefaultSkills(settings.defaultSkills ?? []);
      } catch (err) {
        if (seq === settingsSeq.current) setError(String(err));
      }
    },
    [setError],
  );

  // Refetch when the selected skill changes so another tab's edits show up.
  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings, skill.name]);

  const allProjects = defaultSkills.includes(skill.name);

  const toggleAllProjects = async (enabled: boolean): Promise<void> => {
    // The ref closes the same-render gap before disabled reaches the DOM.
    if (allProjectsBusyRef.current) return;
    allProjectsBusyRef.current = true;
    setAllProjectsBusy(true);
    const seq = ++settingsSeq.current;
    setDefaultSkills((current) =>
      enabled
        ? [...new Set([...current, skill.name])]
        : current.filter((name) => name !== skill.name),
    );
    try {
      // Atomic membership op: the server computes against CURRENT state, so
      // concurrent edits to other skills can't be clobbered.
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setDefaultSkill: { name: skill.name, enabled } }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const { settings } = (await response.json()) as { settings: { defaultSkills?: string[] } };
      if (seq === settingsSeq.current) setDefaultSkills(settings.defaultSkills ?? []);
    } catch (err) {
      // Immediately undo the optimistic claim, then reload the server's current
      // value in case another client changed it while this request failed.
      if (seq === settingsSeq.current) {
        setDefaultSkills((current) =>
          enabled
            ? current.filter((name) => name !== skill.name)
            : [...new Set([...current, skill.name])],
        );
      }
      setError(String(err));
      await refreshSettings(true);
    } finally {
      allProjectsBusyRef.current = false;
      setAllProjectsBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3">
      <div className={cn(sectionHeaderClass, "pb-1 text-text-muted")}>Project Usage</div>
      <p className="pb-2 text-caption text-text-muted">
        Assigned skills are passed to new sessions as explicit --skill paths (no ambient discovery).
        Changes apply to the next session.
      </p>
      {skill.disabled ? (
        <p className="pb-2 text-detail" style={{ color: "var(--color-warning)" }}>
          This skill is disabled — enable it to assign it to projects.
        </p>
      ) : null}
      <label className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover">
        <ControlInput
          type="checkbox"
          data-testid={`assign-skill-all-${skill.name}`}
          checked={allProjects}
          disabled={skill.disabled || allProjectsBusy}
          aria-busy={allProjectsBusy}
          onChange={(event) => void toggleAllProjects(event.target.checked)}
        />
        <Grid3x3 size={14} className="text-text-muted" />
        <span className="text-label text-text-primary">All Projects</span>
        <span className="text-caption text-text-muted">enable this skill for every project</span>
      </label>
      <div className="my-1.5 border-t border-border-subtle" />
      <div
        className={cn(
          "space-y-0.5",
          (allProjects || skill.disabled) && "pointer-events-none opacity-40",
        )}
      >
        {projects.map((project) => {
          const assigned = (project.assignedSkills ?? []).includes(skill.name);
          return (
            <label
              key={project.id}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover"
            >
              <ControlInput
                type="checkbox"
                data-testid={`assign-skill-${skill.name}-${project.name}`}
                checked={assigned}
                disabled={allProjects || skill.disabled}
                onChange={(event) => {
                  const next = new Set(project.assignedSkills ?? []);
                  if (event.target.checked) next.add(skill.name);
                  else next.delete(skill.name);
                  void updateProject(project.id, { assignedSkills: [...next] });
                }}
              />
              <span className="text-label text-text-primary">{project.name}</span>
              <span className="truncate font-mono text-code text-text-muted">{project.path}</span>
            </label>
          );
        })}
        {projects.length === 0 ? (
          <div className="px-2 py-1.5 text-detail text-text-muted">No projects registered.</div>
        ) : null}
      </div>
    </div>
  );
}

export function SkillsScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const projects = useAppStore((state) => state.projects);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const resourceRequest = useAppStore((state) => state.resourceCommandRequest);
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<"catalog" | "detail" | "sources">("catalog");
  const [importOpen, setImportOpen] = useState(false);
  const catalogRef = useRef<HTMLDivElement>(null);
  const importMenuRef = useRef<HTMLDetailsElement>(null);
  const importSummaryRef = useRef<HTMLElement>(null);
  // After a rename the skill's filePath changes (its directory moves), so a
  // filePath-keyed selection would fall back to visible[0] and show the wrong
  // skill. Remember the renamed skill by its EXACT new filePath (deterministic:
  // renameSkillDir moves the dir to <catalog>/<newName>) and re-select it once
  // the refetch lands. Keying on the precise path — not (name, scope) — avoids
  // re-pointing to an unrelated same-name skill.
  const [pendingSelectPath, setPendingSelectPath] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillDraft | null>(null);
  // Inline rename of the selected skill; value === null when not renaming.
  const [renameValue, setRenameValue] = useState<string | null>(null);
  // Multi-select for bulk actions (native 7.5), by filePath.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Local-import path input (native SkillImportSheet); null when not importing.
  const [importPath, setImportPath] = useState<string | null>(null);
  // Git-repo import URL input (native SkillRepositorySync); null when not importing.
  const [gitUrl, setGitUrl] = useState<string | null>(null);
  const [gitImporting, setGitImporting] = useState(false);
  const setGlobalError = useAppStore((state) => state.setError);
  // Imported skill repos (native ImportedSkillRepository) + which have an update
  // available (a per-repo ls-remote check), and which is busy updating/forgetting.
  const [repos, setRepos] = useState<SkillRepo[]>([]);
  const [updatable, setUpdatable] = useState<Set<string>>(new Set());
  const [repoBusy, setRepoBusy] = useState<Record<string, "update" | "forget" | "remove-record">>(
    {},
  );
  const repoBusyRef = useRef(new Map<string, "update" | "forget" | "remove-record">());
  // Per-repo unresolved conflicts (skills the user edited locally that an update
  // held back rather than overwriting) — native Keep Mine / Take Remote.
  const [conflicts, setConflicts] = useState<Record<string, SkillMergeConflict[]>>({});
  const [conflictChoices, setConflictChoices] = useState<Record<string, "mine" | "remote">>({});
  const [resolvingConflicts, setResolvingConflicts] = useState<Record<string, "apply" | "refresh">>(
    {},
  );
  const [staleConflicts, setStaleConflicts] = useState<Record<string, boolean>>({});
  const resolvingConflictsRef = useRef(new Set<string>());
  const conflictActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const repoUpdateRefs = useRef(new Map<string, HTMLButtonElement>());
  const repoRemoveRecordRefs = useRef(new Map<string, HTMLButtonElement>());
  const [repoRecordRemovalAnnouncement, setRepoRecordRemovalAnnouncement] = useState("");
  const [mergeAnnouncement, setMergeAnnouncement] = useState("");
  const [recoveries, setRecoveries] = useState<SkillRecovery[]>([]);
  const [recoveryBusy, setRecoveryBusy] = useState<Record<string, "trash" | "restore">>({});
  const [recoveryAnnouncement, setRecoveryAnnouncement] = useState("");
  const recoveryActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const recoveryTombstones = useRef(new Set<string>());
  const recoveryRequestGeneration = useRef(0);

  // Package/library skills are reference sources: visible with provenance, never editable
  // in-app (SKL-08/11 — native's "Package Skill" read-only posture).
  const isReadOnlyScope = (scope: SkillInfo["scope"]): boolean =>
    scope === "library" || scope === "package";
  // Package + Codex-plugin resolution warnings share one notice block.
  const [packageWarnings, setPackageWarnings] = useState<string[]>([]);
  // SKL-09: persisted Codex plugin skill references (resolved server-side each scan).
  const [pluginRefs, setPluginRefs] = useState<CodexPluginRef[]>([]);

  useEffect(() => {
    const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
    setSkills([]);
    setSkillCandidates([]);
    setCompare(null); // a copy from the previous project/refresh must not linger
    setPackageWarnings([]);
    setPluginRefs([]);
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/resources/skills${query}`);
        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(
              response,
              `Couldn't load skills (${response.status}). Reload to try again.`,
            ),
          );
        }
        const data = (await response.json()) as {
          skills: SkillInfo[];
          packageWarnings?: string[];
          codexPluginRefs?: CodexPluginRef[];
          codexPluginWarnings?: string[];
        };
        if (!cancelled) {
          setSkills(data.skills);
          setPackageWarnings([
            ...(data.packageWarnings ?? []),
            ...(data.codexPluginWarnings ?? []),
          ]);
          setPluginRefs(data.codexPluginRefs ?? []);
        }
        try {
          const vis = await fetch(`/resources/skills/visibility${query}`);
          if (vis.ok) {
            const dupes = (await vis.json()) as { skills: SkillInfo[] };
            if (!cancelled) setSkillCandidates(dupes.skills);
          } else if (!cancelled) {
            setSkillCandidates([]);
          }
        } catch {
          if (!cancelled) setSkillCandidates([]);
        }
      } catch (error) {
        if (!cancelled) setGlobalError(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, resourcesVersion, setGlobalError]);

  const refreshRecoveries = useCallback(async (): Promise<void> => {
    const generation = ++recoveryRequestGeneration.current;
    try {
      const response = await fetch("/resources/skill-recoveries");
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const data = (await response.json()) as { recoveries: SkillRecovery[] };
      if (generation !== recoveryRequestGeneration.current) return;
      setRecoveries(data.recoveries.filter((item) => !recoveryTombstones.current.has(item.token)));
    } catch (error) {
      if (generation === recoveryRequestGeneration.current) setGlobalError(String(error));
    }
  }, [setGlobalError]);

  useEffect(() => {
    void refreshRecoveries();
  }, [resourcesVersion, refreshRecoveries]);

  useEffect(() => {
    if (resourceRequest?.action !== "skills.import") return;
    const store = useAppStore.getState();
    store.clearResourceCommandRequest(resourceRequest.token);
    if (currentProjectId === resourceRequest.projectId) setImportPath("");
  }, [currentProjectId, resourceRequest]);

  const assignedNames = useMemo(() => {
    const names = new Set<string>();
    for (const project of projects) {
      for (const name of project.assignedSkills ?? []) names.add(name);
    }
    return names;
  }, [projects]);

  // SKL-12: which managed collection (imported repository) each catalog skill belongs to —
  // native's repositoryBySkillID, joined by catalog name because the engine materializes
  // collection skills into the GLOBAL catalog. Only confirmed collection-v1 records
  // participate, and only a global-scope skill can be the materialized one — a project
  // skill sharing the name is a different file and must not inherit the provenance
  // (review, Codex).
  const collectionByName = useMemo(() => {
    const map = new Map<string, SkillRepo>();
    for (const repo of repos) {
      if (repo.storageMode !== "collection-v1") continue;
      for (const name of repo.skillNames) if (!map.has(name)) map.set(name, repo);
    }
    return map;
  }, [repos]);

  const collectionFor = (skill: SkillInfo): SkillRepo | undefined =>
    skill.scope === "global" ? collectionByName.get(skill.name) : undefined;

  const repoLabel = (repo: SkillRepo): string =>
    repo.remoteUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "");

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return skills.filter(
      (skill) =>
        query === "" ||
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query),
    );
  }, [skills, search]);

  // Intersect with the live skills so a stale filePath (deleted skill) drops out.
  const checkedSkills = skills.filter((s) => checked.has(s.filePath));
  const toggleCheck = (filePath: string): void =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });

  // Prune the selection to live skills after any reload: successfully deleted
  // skills drop out on their own, a FAILED delete stays checked (retry set
  // preserved), and no ghost filePaths accumulate.
  useEffect(() => {
    setChecked((prev) => {
      const live = new Set(skills.map((s) => s.filePath));
      const next = new Set([...prev].filter((fp) => live.has(fp)));
      return next.size === prev.size ? prev : next;
    });
  }, [skills]);

  const bulkDelete = async (): Promise<void> => {
    // deleteSkill reloads on success; the prune effect then clears the deleted
    // ones from the selection (no blanket clear, so failures stay selected).
    await Promise.all(checkedSkills.map((s) => deleteSkill(s.scope, s.name)));
  };

  const doImport = async (): Promise<void> => {
    const sourcePath = (importPath ?? "").trim();
    if (!sourcePath) return;
    try {
      const res = await fetch("/resources/skills/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global", sourcePath }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? "Couldn't import the skill.");
      }
      setImportPath(null); // the new skill arrives via the resources_changed refetch
    } catch (err) {
      setGlobalError(String(err));
    }
  };

  // SKL-03/04: preview-first git import. Inspect discovers what the repository contains (the
  // engine caches the clone), the dialog owns per-skill selection, and the confirmed import
  // materializes exactly what was shown. Cancel discards the cached preview.
  // SKL-21: the candidates view (shadowed copies included) powers the duplicate
  // diagnostic + compare sheet. Diagnostic-only, so a failed fetch degrades to
  // "no duplicates" instead of an error.
  const [skillCandidates, setSkillCandidates] = useState<SkillInfo[]>([]);
  // Names already in the GLOBAL catalog — where every folder/known-source import lands. The
  // import dialog greys these out instead of letting a scan of `~/.claude/skills` (mostly
  // fan-out links back into the catalog) pre-select 20 guaranteed collisions.
  const importedGlobalNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of skills) if (s.scope === "global") names.add(s.name);
    for (const s of skillCandidates) if (s.scope === "global") names.add(s.name);
    return names;
  }, [skills, skillCandidates]);
  const [compare, setCompare] = useState<{ left: SkillInfo; right: SkillInfo } | null>(null);
  const compareTriggerRef = useRef<HTMLButtonElement | null>(null);

  // SKL-20: on-demand AI summaries (native SkillDescriptionGenerationService),
  // keyed by scope:name; the server caches by content hash so re-clicks are free.
  const [skillSummary, setSkillSummary] = useState<
    Record<string, { text?: string; error?: string; busy?: boolean }>
  >({});
  // key includes the project so a same-named skill in another project never
  // shows this one's summary (Codex)
  const summaryKey = (skill: SkillInfo): string =>
    `${currentProjectId ?? ""}:${skill.scope}:${skill.name}`;
  const doSummarize = async (skill: SkillInfo): Promise<void> => {
    const key = summaryKey(skill);
    setSkillSummary((prev) => ({ ...prev, [key]: { ...prev[key], busy: true } }));
    try {
      const res = await fetch("/resources/skills/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: skill.scope,
          name: skill.name,
          ...(currentProjectId ? { projectId: currentProjectId } : {}),
        }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, "Couldn't generate a summary."));
      const data = (await res.json()) as { summary: string };
      setSkillSummary((prev) => ({ ...prev, [key]: { text: data.summary } }));
    } catch (error) {
      setSkillSummary((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const [gitPreview, setGitPreview] = useState<{
    repoId: string;
    url: string;
    ref?: string;
    subdir?: string;
    skills: SkillPreviewItem[];
    /** SKL-13 additive widening: preselect only skills not already in the collection. */
    defaultSelected?: string[];
  } | null>(null);
  // Synchronous locks + a request generation: React state commits too late to stop a
  // double-activation, and a response landing after the input row was dismissed must not
  // reopen the dialog (review, Codex).
  const inspectLock = useRef(false);
  const inspectSeq = useRef(0);
  const previewRepoId = useRef<string | null>(null);
  previewRepoId.current = gitPreview?.repoId ?? null;

  const discardPreview = (repoId: string): void => {
    // best-effort: an unconfirmed preview is also reclaimed by the next inspect
    void fetch("/resources/skills/discard-git-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId }),
    }).catch(() => undefined);
  };

  // Leaving the screen with a preview open would leak the engine's cached clone (review, Codex)
  useEffect(
    () => () => {
      if (previewRepoId.current) discardPreview(previewRepoId.current);
    },
    [],
  );

  // `source` bypasses the URL input (SKL-13's per-repo "Add skills"); the engine
  // answers for an IMPORTED collection with `alreadyImported`, which drives the
  // preview's default selection so only genuinely new skills start checked. The row's
  // ref/subdir travel explicitly — its bare remoteUrl alone would name a different source.
  const doGitInspect = async (source?: {
    url: string;
    ref?: string;
    subdir?: string;
  }): Promise<void> => {
    const url = (source ? source.url : (gitUrl ?? "")).trim();
    if (!url || inspectLock.current || localPreview || knownPreview) return;
    inspectLock.current = true;
    const seq = ++inspectSeq.current;
    setGitImporting(true);
    try {
      const res = await fetch("/resources/skills/inspect-git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, ref: source?.ref, subdir: source?.subdir }),
      });
      if (!res.ok)
        throw new Error(await responseErrorMessage(res, "Couldn't read that repository."));
      const data = (await res.json()) as {
        repoId: string;
        skills: SkillPreviewItem[];
        alreadyImported?: string[];
      };
      if (seq !== inspectSeq.current) {
        // the user dismissed or superseded this request while it was in flight
        discardPreview(data.repoId);
        return;
      }
      if (data.skills.length === 0) {
        // the engine already cleaned the empty preview up — nothing importable to show
        throw new Error("No skills with a SKILL.md were found in that repository.");
      }
      const already = new Set(data.alreadyImported ?? []);
      setGitPreview((prev) => {
        if (prev && prev.repoId !== data.repoId) discardPreview(prev.repoId); // no leaked replacement
        return {
          repoId: data.repoId,
          url,
          ref: source?.ref,
          subdir: source?.subdir,
          skills: data.skills,
          defaultSelected:
            already.size > 0
              ? data.skills.filter((s) => !already.has(s.name)).map((s) => s.name)
              : undefined,
        };
      });
      setGitUrl(null);
    } catch (err) {
      if (seq === inspectSeq.current) setGlobalError(String(err));
    } finally {
      inspectLock.current = false;
      setGitImporting(false);
    }
  };

  const confirmGitImport = async (selected: string[]): Promise<void> => {
    if (!gitPreview) return;
    const res = await fetch("/resources/skills/import-git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        url: gitPreview.url,
        ref: gitPreview.ref,
        subdir: gitPreview.subdir,
        selected,
      }),
    });
    if (!res.ok) {
      // thrown back into the dialog, which stays open with the error visible
      throw new Error(await responseErrorMessage(res, "Couldn't import from that repository."));
    }
    setGitPreview(null); // the imported skills arrive via the resources_changed refetch
  };

  const cancelGitPreview = (): void => {
    const repoId = gitPreview?.repoId;
    setGitPreview(null);
    if (repoId) discardPreview(repoId);
  };

  // SKL-05/06: local FOLDER import — same preview-then-select flow as git, no engine-side
  // preview state to clean up (local inspect is a pure read).
  const [localPreview, setLocalPreview] = useState<{
    path: string;
    skills: SkillPreviewItem[];
  } | null>(null);

  const doLocalFolderImport = async (): Promise<void> => {
    // one import flow at a time: the shared lock + the open-dialog checks keep a second picker,
    // a stale response, or a SECOND aria-modal dialog from ever appearing (review, Codex)
    if (inspectLock.current || gitPreview || knownPreview || localPreview) return;
    inspectLock.current = true;
    const seq = ++inspectSeq.current;
    try {
      const [folder] = await chooseDirectory();
      if (!folder) {
        // no native picker (browser dev) or the user cancelled — fall back to the path input,
        // keeping the button's original toggle-open/close behavior
        setImportPath((v) => (v === null ? "" : null));
        return;
      }
      const res = await fetch("/resources/skills/inspect-local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: folder }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, "Couldn't read that folder."));
      const data = (await res.json()) as { skills: SkillPreviewItem[] };
      if (seq !== inspectSeq.current) return; // superseded while in flight
      if (data.skills.length === 0) {
        throw new Error("No skills with a SKILL.md were found in that folder.");
      }
      setLocalPreview({
        path: folder,
        skills: data.skills.map((s) => ({
          ...s,
          alreadyImported: importedGlobalNames.has(s.name),
        })),
      });
    } catch (err) {
      if (seq === inspectSeq.current) setGlobalError(String(err));
    } finally {
      inspectLock.current = false;
    }
  };

  // SKL-07/10: scan the KNOWN external skill folders (Claude/Codex, global + per-project) and
  // feed every discovered skill into the same preview dialog, labeled by source. Copy-on-import
  // like every engine import; per-root scan failures degrade to a note instead of killing the scan.
  // SKL-09: Codex plugin skills join the same scan, but as REFERENCES — confirming records a
  // ref the server resolves fresh each scan (version-follow), never a copy.
  const [knownPreview, setKnownPreview] = useState<{
    items: (SkillPreviewItem & { sourcePath: string; pluginRef?: CodexPluginRef })[];
    failures: string[];
    defaultSelected: string[];
  } | null>(null);

  const doKnownScan = async (): Promise<void> => {
    if (inspectLock.current || gitPreview || localPreview || knownPreview) return;
    inspectLock.current = true;
    const seq = ++inspectSeq.current;
    try {
      const res = await fetch("/resources/skills/known-sources");
      if (!res.ok) {
        throw new Error(await responseErrorMessage(res, "Couldn't list known skill folders."));
      }
      const { sources } = (await res.json()) as {
        sources: { path: string; label: string }[];
      };
      const items: (SkillPreviewItem & { sourcePath: string; pluginRef?: CodexPluginRef })[] = [];
      const failures: string[] = [];
      for (const src of sources) {
        try {
          const r = await fetch("/resources/skills/inspect-local", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: src.path }),
          });
          if (!r.ok) throw new Error(await responseErrorMessage(r, "unreadable"));
          const data = (await r.json()) as { skills: SkillPreviewItem[] };
          for (const s of data.skills) {
            items.push({
              ...s,
              id: `${src.path}::${s.name}`,
              sourceLabel: src.label,
              sourcePath: src.path,
              // greyed out in the dialog: importing it can only collide with the catalog copy
              alreadyImported: importedGlobalNames.has(s.name),
            });
          }
        } catch {
          // ANY per-root failure (HTTP, network, malformed JSON) degrades to a note — one bad
          // root must not kill the whole scan or masquerade as "no skills" (review, Codex)
          failures.push(src.label);
        }
      }
      // SKL-09: plugin-cache skills join the same dialog as reference candidates. Already-
      // referenced skills are not offered again; the catalog degrades like any other root.
      try {
        const r = await fetch("/resources/skills/codex-plugin-catalog");
        if (!r.ok) throw new Error(await responseErrorMessage(r, "unreadable"));
        const data = (await r.json()) as {
          items: (CodexPluginRef & { version: string; name: string; description?: string })[];
          refs: CodexPluginRef[];
        };
        const referenced = new Set(
          data.refs.map((ref) => `${ref.marketplace}::${ref.plugin}::${ref.relPath}`),
        );
        for (const item of data.items) {
          const key = `${item.marketplace}::${item.plugin}::${item.relPath}`;
          if (referenced.has(key)) continue;
          items.push({
            name: item.name,
            displayName: item.name,
            description: item.description,
            extraFileCount: 0,
            id: `plugin::${key}`,
            sourceLabel: `Codex Plugin · ${item.plugin} ${item.version} · ${item.marketplace}`,
            sourcePath: "",
            pluginRef: {
              marketplace: item.marketplace,
              plugin: item.plugin,
              relPath: item.relPath,
            },
          });
        }
      } catch {
        failures.push("Codex Plugins");
      }
      if (seq !== inspectSeq.current) return; // superseded while in flight
      if (items.length === 0) {
        throw new Error(
          failures.length > 0
            ? `Couldn't read the known skill folders: ${failures.join(", ")}.`
            : "No Claude or Codex skills with a SKILL.md were found in known folders.",
        );
      }
      // default selection dedupes by NAME (first source wins): two same-name discoveries both
      // import into ONE catalog name, so both-selected would always collide (review, Codex)
      const seenNames = new Set<string>();
      const defaultSelected: string[] = [];
      for (const item of items) {
        if (item.alreadyImported) continue; // never pre-select a guaranteed collision
        if (seenNames.has(item.name)) continue;
        seenNames.add(item.name);
        if (item.id) defaultSelected.push(item.id);
      }
      setKnownPreview({ items, failures, defaultSelected });
    } catch (err) {
      if (seq === inspectSeq.current) setGlobalError(String(err));
    } finally {
      inspectLock.current = false;
    }
  };

  const confirmKnownImport = async (selectedIds: string[]): Promise<void> => {
    if (!knownPreview) return;
    // group the selection back into per-root imports (ids are path-qualified);
    // plugin candidates become REFERENCES instead (SKL-09)
    const byRoot = new Map<string, { label: string; selected: string[] }>();
    const refs: CodexPluginRef[] = [];
    for (const id of selectedIds) {
      const item = knownPreview.items.find((i) => i.id === id);
      if (!item) continue;
      if (item.pluginRef) {
        refs.push(item.pluginRef);
        continue;
      }
      const entry = byRoot.get(item.sourcePath) ?? {
        label: item.sourceLabel ?? item.sourcePath,
        selected: [],
      };
      entry.selected.push(item.name);
      byRoot.set(item.sourcePath, entry);
    }
    // record references first: idempotent server-side, so a later folder failure + retry
    // may re-post them safely, while a ref failure aborts before any folder copies
    if (refs.length > 0) {
      const res = await fetch("/resources/skills/codex-plugin-refs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refs }),
      });
      if (!res.ok) {
        const message = await responseErrorMessage(res, "reference failed");
        throw new Error(`Codex Plugins failed: ${message}`);
      }
      // the just-referenced skills leave the dialog so a folder-failure retry won't re-offer them
      const recorded = new Set(refs.map((r) => `${r.marketplace}::${r.plugin}::${r.relPath}`));
      setKnownPreview((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.filter(
                (i) =>
                  !i.pluginRef ||
                  !recorded.has(
                    `${i.pluginRef.marketplace}::${i.pluginRef.plugin}::${i.pluginRef.relPath}`,
                  ),
              ),
            }
          : prev,
      );
    }
    const done: string[] = [];
    for (const [rootPath, { label, selected }] of byRoot) {
      const res = await fetch("/resources/skills/import-local-folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: rootPath, selected }),
      });
      if (!res.ok) {
        const message = await responseErrorMessage(res, "import failed");
        // drop the roots that DID land so a retry only re-attempts the remainder, and name
        // both sides so the error is actionable (review, Codex)
        setKnownPreview((prev) =>
          prev ? { ...prev, items: prev.items.filter((i) => !done.includes(i.sourcePath)) } : prev,
        );
        throw new Error(
          done.length > 0
            ? `Imported from ${done.length} folder(s); ${label} failed: ${message}`
            : `${label} failed: ${message}`,
        );
      }
      done.push(rootPath);
    }
    setKnownPreview(null);
  };

  // Un-import a plugin reference (SKL-09): the skill leaves the catalog on the next scan;
  // nothing on disk to delete, because a reference never copied anything.
  const removePluginRef = async (ref: CodexPluginRef): Promise<void> => {
    try {
      const res = await fetch("/resources/skills/codex-plugin-refs", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
      });
      if (!res.ok) {
        throw new Error(await responseErrorMessage(res, "Couldn't remove the plugin reference."));
      }
      setPluginRefs((prev) =>
        prev.filter(
          (item) =>
            item.marketplace !== ref.marketplace ||
            item.plugin !== ref.plugin ||
            item.relPath !== ref.relPath,
        ),
      );
    } catch (error) {
      setGlobalError(String(error));
    }
  };

  const confirmLocalImport = async (selected: string[]): Promise<void> => {
    if (!localPreview) return;
    const res = await fetch("/resources/skills/import-local-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: localPreview.path, selected }),
    });
    if (!res.ok) {
      // thrown back into the dialog, which stays open with the error visible
      throw new Error(await responseErrorMessage(res, "Couldn't import from that folder."));
    }
    setLocalPreview(null); // the imported skills arrive via the resources_changed refetch
  };

  // Load imported repositories and check each for an available update.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/resources/skill-repos");
        if (!response.ok) {
          throw new Error(
            await responseErrorMessage(
              response,
              `Couldn't load skill repositories (${response.status}). Reload to try again.`,
            ),
          );
        }
        const data = (await response.json()) as { repos: SkillRepo[] };
        if (cancelled) return;
        setRepos(data.repos);
        setConflicts(
          Object.fromEntries(
            data.repos
              .filter((repo) => (repo.pendingMerges?.length ?? 0) > 0)
              .map((repo) => [repo.id, repo.pendingMerges!]),
          ),
        );
        for (const repo of data.repos) {
          if (repo.available === false) continue;
          void (async () => {
            try {
              let checkResponse: Response | undefined;
              for (let attempt = 0; attempt < 4; attempt += 1) {
                checkResponse = await fetch(`/resources/skill-repos/${repo.id}/check`, {
                  method: "POST",
                });
                if (checkResponse.status !== 409 || attempt === 3 || cancelled) break;
                // A notification-driven native snapshot rebuild can briefly own
                // this repository. Retry the read-only check instead of leaking
                // that internal busy window into the UI.
                await new Promise((resolve) => window.setTimeout(resolve, 100 * (attempt + 1)));
              }
              if (!checkResponse?.ok) {
                throw new Error(
                  checkResponse
                    ? await responseErrorMessage(
                        checkResponse,
                        `Couldn't check ${repo.remoteUrl} for updates (${checkResponse.status}). Retry by reloading.`,
                      )
                    : `Couldn't check ${repo.remoteUrl} for updates. Retry by reloading.`,
                );
              }
              const check = (await checkResponse.json()) as { updateAvailable: boolean };
              if (!cancelled && check.updateAvailable) {
                setUpdatable((prev) => new Set(prev).add(repo.id));
              }
            } catch (error) {
              if (!cancelled) setGlobalError(String(error));
            }
          })();
        }
      } catch (error) {
        if (!cancelled) setGlobalError(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resourcesVersion, setGlobalError]);

  const focusAfterRecoveryRemoval = (token: string): void => {
    const index = recoveries.findIndex((item) => item.token === token);
    const remaining = recoveries.filter((item) => item.token !== token);
    const next = remaining[index] ?? remaining[Math.max(0, index - 1)];
    requestAnimationFrame(() => {
      if (next) recoveryActionRefs.current.get(next.token)?.focus();
      else repoUpdateRefs.current.values().next().value?.focus();
    });
  };

  const moveRecoveryToTrash = async (recovery: SkillRecovery): Promise<void> => {
    if (recoveryBusy[recovery.token]) return;
    const invoked = recoveryActionRefs.current.get(recovery.token);
    const ownedFocus = invoked !== undefined && document.activeElement === invoked;
    setRecoveryBusy((current) => ({ ...current, [recovery.token]: "trash" }));
    try {
      const result = await trashSkillRecovery(recovery.token);
      if (!result) throw new Error("Move to Trash is available in the desktop app.");
      recoveryTombstones.current.add(recovery.token);
      setRecoveries((current) => current.filter((item) => item.token !== recovery.token));
      setRecoveryAnnouncement(
        result.acknowledgementPending
          ? `${recovery.skillName} recovery moved to OS Trash; catalog acknowledgement will retry automatically.`
          : `${recovery.skillName} recovery moved to OS Trash.`,
      );
      void refreshRecoveries();
      if (ownedFocus) focusAfterRecoveryRemoval(recovery.token);
    } catch (error) {
      setGlobalError(
        `Couldn't move ${recovery.skillName} recovery to Trash. ${error instanceof Error ? error.message : String(error)} You can restore it safely instead.`,
      );
      requestAnimationFrame(() => {
        if (
          ownedFocus &&
          (document.activeElement === invoked || document.activeElement === document.body)
        ) {
          invoked?.focus();
        }
      });
    } finally {
      setRecoveryBusy((current) => {
        const next = { ...current };
        delete next[recovery.token];
        return next;
      });
    }
  };

  const restoreRecovery = async (recovery: SkillRecovery): Promise<void> => {
    if (recoveryBusy[recovery.token]) return;
    const invoked = recoveryActionRefs.current.get(`${recovery.token}:restore`);
    const ownedFocus = invoked !== undefined && document.activeElement === invoked;
    setRecoveryBusy((current) => ({ ...current, [recovery.token]: "restore" }));
    try {
      const response = await fetch(
        `/resources/skill-recoveries/${encodeURIComponent(recovery.token)}/restore`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      recoveryTombstones.current.add(recovery.token);
      setRecoveries((current) => current.filter((item) => item.token !== recovery.token));
      setRecoveryAnnouncement(`${recovery.skillName} restored to the active catalog.`);
      void refreshRecoveries();
      if (ownedFocus) focusAfterRecoveryRemoval(recovery.token);
    } catch (error) {
      setGlobalError(
        `Couldn't restore ${recovery.skillName}. ${error instanceof Error ? error.message : String(error)}`,
      );
      requestAnimationFrame(() => {
        if (
          ownedFocus &&
          (document.activeElement === invoked || document.activeElement === document.body)
        ) {
          invoked?.focus();
        }
      });
    } finally {
      setRecoveryBusy((current) => {
        const next = { ...current };
        delete next[recovery.token];
        return next;
      });
    }
  };

  const handleNewRecoveries = (items: SkillRecovery[] | undefined): void => {
    if (!items?.length) return;
    setRecoveries((current) => {
      const byToken = new Map(current.map((item) => [item.token, item]));
      for (const item of items) byToken.set(item.token, item);
      return [...byToken.values()];
    });
    for (const item of items) void moveRecoveryToTrash(item);
  };

  const updateRepo = async (id: string): Promise<void> => {
    if (repoBusyRef.current.has(id)) return;
    repoBusyRef.current.set(id, "update");
    setRepoBusy((current) => ({ ...current, [id]: "update" }));
    try {
      const res = await fetch(`/resources/skill-repos/${id}/update`, { method: "POST" });
      if (!res.ok) throw new Error(await responseErrorMessage(res));
      const data = (await res.json()) as {
        mergeConflicts?: SkillMergeConflict[];
        recoveries?: SkillRecovery[];
      };
      handleNewRecoveries(data.recoveries);
      // Clear the badge; the resources_changed broadcast refetches the skills.
      setUpdatable((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Surface any locally-edited skills the update held back.
      setConflicts((prev) => {
        const next = { ...prev };
        if (data.mergeConflicts && data.mergeConflicts.length > 0) next[id] = data.mergeConflicts;
        else delete next[id];
        return next;
      });
      setConflictChoices((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) if (key.startsWith(`${id}\0`)) delete next[key];
        return next;
      });
    } catch (err) {
      setGlobalError(String(err));
    } finally {
      repoBusyRef.current.delete(id);
      setRepoBusy((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const resolveConflict = async (id: string, conflict: SkillMergeConflict): Promise<void> => {
    const key = `${id}\0${conflict.mergeId}`;
    if (resolvingConflictsRef.current.has(key)) return;
    const invokedAction = conflictActionRefs.current.get(key);
    const ownedFocus = invokedAction !== undefined && document.activeElement === invokedAction;
    const focusMayBeRestored = (): boolean =>
      ownedFocus &&
      (document.activeElement === invokedAction || document.activeElement === document.body);
    resolvingConflictsRef.current.add(key);
    setResolvingConflicts((current) => ({ ...current, [key]: "apply" }));
    try {
      const choices = conflict.paths.map((item) => ({
        path: item.path,
        resolution: conflictChoices[`${key}\0${item.path}`] ?? "mine",
      }));
      const res = await fetch(`/resources/skill-repos/${id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: conflict.name, mergeId: conflict.mergeId, choices }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
        if (res.status === 409 && body.code === "LEGACY_MERGE_STALE") {
          throw Object.assign(new Error(body.error ?? "Review is stale."), { stale: true });
        }
        throw new Error(body.error ?? `Couldn't apply conflict choices (${res.status}).`);
      }
      const data = (await res.json()) as { recoveries?: SkillRecovery[] };
      handleNewRecoveries(data.recoveries);
      setMergeAnnouncement(`Conflict choices applied for ${conflict.name}.`);
      let nextConflictId: string | undefined;
      setConflicts((previous) => {
        const currentConflicts = previous[id] ?? [];
        const removedIndex = currentConflicts.findIndex((item) => item.name === conflict.name);
        const remaining = currentConflicts.filter((item) => item.name !== conflict.name);
        nextConflictId =
          removedIndex >= 0
            ? (remaining[removedIndex]?.mergeId ??
              remaining[Math.max(0, removedIndex - 1)]?.mergeId)
            : remaining[0]?.mergeId;
        const next = { ...previous };
        if (remaining.length > 0) next[id] = remaining;
        else delete next[id];
        return next;
      });
      setConflictChoices((current) => {
        const next = { ...current };
        for (const choiceKey of Object.keys(next)) {
          if (choiceKey.startsWith(`${key}\0`)) delete next[choiceKey];
        }
        return next;
      });
      setStaleConflicts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      requestAnimationFrame(() => {
        if (!focusMayBeRestored()) return;
        const nextApply = nextConflictId
          ? conflictActionRefs.current.get(`${id}\0${nextConflictId}`)
          : undefined;
        if (nextApply && !nextApply.disabled) nextApply.focus();
        else repoUpdateRefs.current.get(id)?.focus();
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if ((err as Error & { stale?: boolean }).stale) {
        setStaleConflicts((current) => ({ ...current, [key]: true }));
      }
      setGlobalError(`Couldn't resolve ${conflict.name}. ${detail} Try again.`);
      requestAnimationFrame(() => {
        if (focusMayBeRestored()) invokedAction?.focus();
      });
    } finally {
      resolvingConflictsRef.current.delete(key);
      setResolvingConflicts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const refreshConflict = async (id: string, conflict: SkillMergeConflict): Promise<void> => {
    const oldKey = `${id}\0${conflict.mergeId}`;
    if (resolvingConflictsRef.current.has(oldKey)) return;
    const invokedAction =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ownedFocus = invokedAction !== null;
    resolvingConflictsRef.current.add(oldKey);
    setResolvingConflicts((current) => ({ ...current, [oldKey]: "refresh" }));
    try {
      const response = await fetch(`/resources/skill-repos/${id}/refresh-merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: conflict.name }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const data = (await response.json()) as { mergeConflict: SkillMergeConflict };
      setConflicts((current) => ({
        ...current,
        [id]: (current[id] ?? []).map((item) =>
          item.mergeId === conflict.mergeId ? data.mergeConflict : item,
        ),
      }));
      setConflictChoices((current) => {
        const next = { ...current };
        for (const choiceKey of Object.keys(next)) {
          if (choiceKey.startsWith(`${oldKey}\0`)) delete next[choiceKey];
        }
        return next;
      });
      setStaleConflicts((current) => {
        const next = { ...current };
        delete next[oldKey];
        return next;
      });
      setMergeAnnouncement(`Review refreshed for ${conflict.name}. Choices reset to Keep Mine.`);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (
            ownedFocus &&
            (document.activeElement === invokedAction || document.activeElement === document.body)
          ) {
            conflictActionRefs.current.get(`${id}\0${data.mergeConflict.mergeId}`)?.focus();
          }
        });
      });
    } catch (error) {
      setGlobalError(
        `Couldn't refresh ${conflict.name}. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      resolvingConflictsRef.current.delete(oldKey);
      setResolvingConflicts((current) => {
        const next = { ...current };
        delete next[oldKey];
        return next;
      });
    }
  };

  const forgetRepo = async (id: string): Promise<void> => {
    if (repoBusyRef.current.has(id)) return;
    repoBusyRef.current.set(id, "forget");
    setRepoBusy((current) => ({ ...current, [id]: "forget" }));
    try {
      const response = await fetch(`/resources/skill-repos/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Couldn't forget the repository (${response.status}).`);
      }
      setRepos((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setGlobalError(String(err));
    } finally {
      repoBusyRef.current.delete(id);
      setRepoBusy((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const removeUnavailableRecord = async (repo: SkillRepo): Promise<void> => {
    if (repo.available !== false || repoBusyRef.current.has(repo.id)) return;
    if (
      !window.confirm(
        "Remove only this unavailable repository record? The clone will not be opened or deleted. You will need to import it again after restoring the folder.",
      )
    ) {
      return;
    }
    const invoked = repoRemoveRecordRefs.current.get(repo.id);
    const ownedFocus = invoked !== undefined && document.activeElement === invoked;
    repoBusyRef.current.set(repo.id, "remove-record");
    setRepoBusy((current) => ({ ...current, [repo.id]: "remove-record" }));
    try {
      const response = await fetch(`/resources/skill-repos/${repo.id}/record`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const index = repos.findIndex((candidate) => candidate.id === repo.id);
      const remaining = repos.filter((candidate) => candidate.id !== repo.id);
      const next = remaining[index] ?? remaining[Math.max(0, index - 1)];
      setRepoRecordRemovalAnnouncement(
        "Unavailable repository record removed. Clone files were left untouched.",
      );
      setRepos(remaining);
      requestAnimationFrame(() => {
        if (!ownedFocus || document.activeElement !== document.body) return;
        const target = next
          ? next.available !== false
            ? repoUpdateRefs.current.get(next.id)
            : repoRemoveRecordRefs.current.get(next.id)
          : document.querySelector<HTMLButtonElement>('[data-testid="skill-import-git"]');
        target?.focus();
      });
    } catch (error) {
      setGlobalError(`Couldn't remove the unavailable repository record. ${String(error)}`);
      requestAnimationFrame(() => {
        if (ownedFocus && document.activeElement === document.body) {
          repoRemoveRecordRefs.current.get(repo.id)?.focus();
        }
      });
    } finally {
      repoBusyRef.current.delete(repo.id);
      setRepoBusy((current) => {
        const next = { ...current };
        delete next[repo.id];
        return next;
      });
    }
  };

  // A manual selection (row click) supersedes any pending post-rename re-select,
  // so a delayed refetch can't yank the user off a skill they just clicked.
  const selectSkill = useCallback((filePath: string, openDetail = false): void => {
    setPendingSelectPath(null);
    setSelectedKey(filePath);
    if (openDetail) setView("detail");
  }, []);

  // Once the post-rename refetch lands the renamed skill (by its exact new path),
  // re-point the selection to it so the detail stays on it (native master-detail
  // keeps the renamed row selected).
  useEffect(() => {
    if (!pendingSelectPath) return;
    if (skills.some((s) => s.filePath === pendingSelectPath)) {
      setSelectedKey(pendingSelectPath);
      setPendingSelectPath(null);
    }
  }, [skills, pendingSelectPath]);

  // A project switch abandons any pending re-select — it belonged to the old
  // project's catalog.
  useEffect(() => {
    setPendingSelectPath(null);
  }, [currentProjectId]);

  const selected =
    skills.find((skill) => skill.filePath === selectedKey) ??
    (selectedKey === null ? (visible[0] ?? null) : null);
  const catalogSelected =
    visible.find((skill) => skill.filePath === selectedKey) ?? visible[0] ?? null;
  const closeImportMenu = useCallback((restoreFocus = false): void => {
    setImportOpen(false);
    if (restoreFocus) requestAnimationFrame(() => importSummaryRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!importOpen) return;
    const dismiss = (event: MouseEvent): void => {
      if (!importMenuRef.current?.contains(event.target as Node)) closeImportMenu(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeImportMenu(true);
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [closeImportMenu, importOpen]);

  const closeCompare = (): void => {
    setCompare(null);
    requestAnimationFrame(() => compareTriggerRef.current?.focus());
  };

  const sourceIssueCount =
    packageWarnings.length +
    recoveries.length +
    repos.filter((repo) => repo.available === false).length +
    Object.values(conflicts).reduce((total, items) => total + items.length, 0) +
    updatable.size;

  const returnToCatalog = (): void => {
    setView("catalog");
    requestAnimationFrame(() => {
      const rows = catalogRef.current?.querySelectorAll<HTMLElement>("[data-skill-path]");
      [...(rows ?? [])].find((row) => row.dataset.skillPath === selected?.filePath)?.focus();
    });
  };

  // Close an open rename if the selected skill changes, so a pending value can't
  // apply to a different skill.
  useEffect(() => {
    setRenameValue(null);
  }, [selected?.filePath]);

  const editDraft = (skill: SkillInfo): SkillDraft => ({
    name: skill.name,
    scope: skill.scope === "project" ? "project" : "global",
    description: skill.description,
    body: skill.body,
    isNew: false,
  });

  const submitRename = async (skill: SkillInfo): Promise<void> => {
    const newName = (renameValue ?? "").trim();
    if (!newName || newName === skill.name) {
      setRenameValue(null);
      return;
    }
    if (await renameSkill(skill.scope, skill.name, newName)) {
      setRenameValue(null);
      // Keep the detail on the renamed skill once the refetch replaces its path.
      // renameSkillDir moves the dir to <catalog>/<newName>, keeping the file's
      // basename, so the new path is the old baseDir's parent + newName + file.
      const sep = skill.baseDir.includes("\\") ? "\\" : "/";
      const parent = skill.baseDir.slice(0, skill.baseDir.lastIndexOf(sep));
      const fileName = skill.filePath.slice(skill.filePath.lastIndexOf(sep) + 1);
      setPendingSelectPath(`${parent}${sep}${newName}${sep}${fileName}`);
    }
  };

  return (
    <PageShell
      width="split"
      testId="skills-screen"
      hero={
        <SectionHero
          imageSrc="/screen-art/screen-art-skills.jpg"
          title="Skills"
          subtitle="Manage reusable capabilities and assign them to projects."
        />
      }
    >
      <div
        ref={catalogRef}
        data-testid="skills-catalog"
        aria-hidden={view === "detail"}
        className={cn("flex min-h-0 flex-1 flex-col", view === "detail" && "hidden")}
      >
        <PageToolbar
          className={cn(view !== "catalog" && "hidden")}
          leading={
            <AppTextField
              data-testid="skill-search"
              size="sm"
              leadingIcon={<Search aria-hidden />}
              aria-label="Search skills"
              placeholder="Search skills"
              value={search}
              onChange={setSearch}
              showClear
              clearLabel="Clear skill search"
              autoComplete="off"
              spellCheck={false}
            />
          }
          trailing={
            <>
              <Button
                data-testid="new-skill"
                size="sm"
                variant="primary"
                leadingIcon={<Plus size={14} />}
                onClick={() =>
                  setEditing({ name: "", scope: "global", description: "", body: "", isNew: true })
                }
              >
                New Skill
              </Button>
              <details
                ref={importMenuRef}
                open={importOpen}
                className="relative"
                data-testid="skill-import-menu"
                onToggle={(event) => setImportOpen(event.currentTarget.open)}
              >
                <summary
                  ref={importSummaryRef}
                  aria-expanded={importOpen}
                  aria-haspopup="menu"
                  className="flex min-h-control-sm cursor-pointer list-none items-center gap-1.5 rounded-control border border-border-strong bg-surface-elevated px-control-x-sm text-detail font-medium tracking-ui text-text-primary shadow-card hover:bg-hover"
                  onClick={(event) => {
                    event.preventDefault();
                    setImportOpen((open) => !open);
                  }}
                >
                  Import <ChevronDown size={13} aria-hidden="true" />
                </summary>
                <div
                  role="menu"
                  aria-label="Import skills"
                  className="absolute right-0 z-dropdown mt-1 w-64 max-w-[calc(100vw-2rem)] space-y-1 rounded-xl border border-border-strong bg-surface-elevated p-1.5 shadow-elevated sm:max-w-[calc(100vw-3rem)] lg:max-w-[calc(100vw-4rem)]"
                >
                  <ControlButton
                    data-testid="skill-import"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-detail text-text-secondary hover:bg-hover hover:text-text-primary"
                    aria-label="Import skills from a local folder or .md file"
                    onClick={() => {
                      closeImportMenu(true);
                      void doLocalFolderImport();
                    }}
                  >
                    <FolderInput size={14} /> Import Local
                  </ControlButton>
                  <ControlButton
                    data-testid="skill-scan-known"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-detail text-text-secondary hover:bg-hover hover:text-text-primary"
                    aria-label="Scan Claude and Codex skill folders"
                    onClick={() => {
                      closeImportMenu(true);
                      void doKnownScan();
                    }}
                  >
                    <FolderSearch size={14} /> Scan Known Folders
                  </ControlButton>
                  <ControlButton
                    data-testid="skill-import-git"
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-detail text-text-secondary hover:bg-hover hover:text-text-primary"
                    aria-label="Import skills from a git repository"
                    onClick={() => {
                      closeImportMenu(true);
                      setGitUrl((value) => (value === null ? "" : null));
                    }}
                  >
                    <GitBranch size={14} /> Import Git Repository
                  </ControlButton>
                </div>
              </details>
              <Button
                data-testid="skill-manage-sources"
                size="sm"
                variant="secondary"
                onClick={() => setView("sources")}
              >
                Manage Sources
              </Button>
            </>
          }
        />
        <PageToolbar
          className={cn(view !== "sources" && "hidden")}
          leading={
            <Button
              data-testid="skill-sources-back"
              size="sm"
              variant="ghost"
              leadingIcon={<ArrowLeft size={14} />}
              onClick={() => setView("catalog")}
            >
              Back to Skills
            </Button>
          }
          trailing={<span className="text-detail text-text-muted">Manage Sources</span>}
        />
        {importPath !== null ? (
          <div
            className={cn(
              "mx-auto mb-2 flex w-full max-w-7xl gap-2 px-4 sm:px-6 lg:px-8",
              view !== "catalog" && "hidden",
            )}
          >
            <ControlInput
              autoFocus
              data-testid="skill-import-path"
              className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
              placeholder="/path/to/skill.md"
              value={importPath}
              onChange={(event) => setImportPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void doImport();
                if (event.key === "Escape") setImportPath(null);
              }}
            />
            <Button
              data-testid="skill-import-confirm"
              size="sm"
              variant="secondary"
              disabled={!importPath.trim()}
              onClick={() => void doImport()}
            >
              Import
            </Button>
          </div>
        ) : null}
        {gitUrl !== null ? (
          <div
            className={cn(
              "mx-auto mb-2 flex w-full max-w-7xl gap-2 px-4 sm:px-6 lg:px-8",
              view !== "catalog" && "hidden",
            )}
          >
            <ControlInput
              autoFocus
              data-testid="skill-import-git-url"
              className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
              placeholder="owner/repo, skills.sh/…, or a git URL"
              value={gitUrl}
              onChange={(event) => setGitUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void doGitInspect();
                if (event.key === "Escape") {
                  inspectSeq.current++; // an in-flight preview must not reopen a dismissed row
                  setGitUrl(null);
                }
              }}
            />
            <Button
              data-testid="skill-import-git-confirm"
              size="sm"
              variant="secondary"
              disabled={!gitUrl.trim() || gitImporting}
              onClick={() => void doGitInspect()}
            >
              {gitImporting ? "Fetching…" : "Preview"}
            </Button>
          </div>
        ) : null}
        {gitPreview ? (
          <SkillImportPreviewDialog
            sourceLabel={gitPreview.url}
            sourceKind="git"
            skills={gitPreview.skills}
            defaultSelected={gitPreview.defaultSelected}
            onImport={confirmGitImport}
            onCancel={cancelGitPreview}
          />
        ) : null}
        {localPreview ? (
          <SkillImportPreviewDialog
            sourceLabel={localPreview.path}
            sourceKind="local"
            skills={localPreview.skills}
            onImport={confirmLocalImport}
            onCancel={() => setLocalPreview(null)}
          />
        ) : null}
        {knownPreview ? (
          <SkillImportPreviewDialog
            sourceLabel={
              knownPreview.failures.length > 0
                ? `Claude & Codex folders · couldn't read: ${knownPreview.failures.join(", ")}`
                : "Claude & Codex folders"
            }
            sourceKind="known"
            skills={knownPreview.items}
            defaultSelected={knownPreview.defaultSelected}
            onImport={confirmKnownImport}
            onCancel={() => setKnownPreview(null)}
          />
        ) : null}
        <div
          className={cn("min-h-0 flex-1 overflow-y-auto", view !== "sources" && "hidden")}
          data-testid="skill-sources-view"
        >
          <div className="mx-auto w-full max-w-7xl space-y-3 px-4 pb-page-y sm:px-6 lg:px-8">
            <header className="pt-2">
              <h2 className="text-title font-semibold tracking-title text-text-primary">
                Manage Sources
              </h2>
              <p className="mt-1 max-w-3xl text-body text-text-secondary">
                Review imported repositories, plugin references, source warnings, recoveries, and
                pending updates.
              </p>
            </header>
            {packageWarnings.length > 0 ? (
              <div
                data-testid="skill-package-warnings"
                className="rounded-lg border border-border-subtle px-3 py-2 text-detail text-text-secondary"
                role="status"
              >
                {packageWarnings.map((warning) => (
                  <div key={warning} className="truncate" title={warning}>
                    {warning}
                  </div>
                ))}
              </div>
            ) : null}
            {pluginRefs.length > 0 ? (
              <div
                data-testid="skill-plugin-refs"
                className="space-y-1 rounded-lg border border-border-subtle px-3 py-2 text-detail text-text-secondary"
              >
                <div className={cn(sectionHeaderClass, "text-text-muted")}>
                  Codex plugin references
                </div>
                {pluginRefs.map((ref) => {
                  const key = `${ref.marketplace}::${ref.plugin}::${ref.relPath}`;
                  return (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <span className="truncate" title={key}>
                        {ref.plugin} · {ref.relPath}{" "}
                        <span className="text-text-muted">({ref.marketplace})</span>
                      </span>
                      <Button
                        data-testid={`skill-plugin-ref-remove-${key}`}
                        size="sm"
                        variant="ghost"
                        onClick={() => void removePluginRef(ref)}
                      >
                        Remove
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div
              data-testid="skill-repo-record-removal-status"
              className="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {repoRecordRemovalAnnouncement}
            </div>
            <div className="sr-only" role="status" aria-live="polite">
              {recoveryAnnouncement}
            </div>
            {recoveries.length > 0 || repos.length > 0 ? (
              <div data-testid="skill-management-panels" className="min-h-0 space-y-3">
                {recoveries.length > 0 ? (
                  <div className="space-y-1" data-testid="skill-recoveries">
                    <div className={cn(sectionHeaderClass, "px-0.5 text-text-muted")}>
                      Safe recovery
                    </div>
                    {recoveries.map((recovery) => {
                      const busy = recoveryBusy[recovery.token];
                      return (
                        <div
                          key={recovery.token}
                          className="rounded-lg border border-warning bg-surface px-2.5 py-2"
                          aria-busy={busy !== undefined}
                          data-testid={`skill-recovery-${recovery.skillName}`}
                        >
                          <div className="font-mono text-detail text-text-primary">
                            {recovery.skillName}
                          </div>
                          <p className="text-caption text-text-muted">
                            {busy === "trash"
                              ? "This completed-update backup is being moved to OS Trash automatically."
                              : "A displaced or interrupted tree was retained safely. Restore is available only while the active skill is absent, or move this retained tree to OS Trash."}
                          </p>
                          {busy === "trash" ? null : (
                            <div className="mt-1 flex gap-2">
                              <Button
                                ref={(element) => {
                                  if (element)
                                    recoveryActionRefs.current.set(recovery.token, element);
                                  else recoveryActionRefs.current.delete(recovery.token);
                                }}
                                size="sm"
                                variant="destructiveOutline"
                                disabled={busy !== undefined}
                                onClick={() => void moveRecoveryToTrash(recovery)}
                                data-testid={`skill-recovery-trash-${recovery.skillName}`}
                              >
                                Move to Trash
                              </Button>
                              <Button
                                ref={(element) => {
                                  const key = `${recovery.token}:restore`;
                                  if (element) recoveryActionRefs.current.set(key, element);
                                  else recoveryActionRefs.current.delete(key);
                                }}
                                size="sm"
                                variant="secondary"
                                disabled={busy !== undefined}
                                onClick={() => void restoreRecovery(recovery)}
                                data-testid={`skill-recovery-restore-${recovery.skillName}`}
                              >
                                {busy === "restore" ? "Restoring…" : "Restore"}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {repos.length > 0 ? (
                  <div className="space-y-1" data-testid="skill-repos">
                    <div className={cn(sectionHeaderClass, "px-0.5 text-text-muted")}>
                      Imported repositories
                    </div>
                    {repos.map((repo) => (
                      <div key={repo.id}>
                        <div
                          data-testid={`skill-repo-${repo.id}`}
                          className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5"
                          aria-busy={repoBusy[repo.id] !== undefined}
                        >
                          <GitBranch size={12} className="shrink-0 text-text-secondary" />
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-detail text-text-primary"
                            title={repo.remoteUrl}
                          >
                            {repoLabel(repo)}
                          </span>
                          {repo.ref ? (
                            <span
                              className="max-w-24 shrink-0 truncate font-mono text-micro text-text-muted"
                              title={repo.ref}
                            >
                              @{repo.ref}
                            </span>
                          ) : null}
                          {repo.subdir ? (
                            <span
                              className="max-w-32 shrink-0 truncate font-mono text-micro text-text-muted"
                              title={repo.subdir}
                            >
                              /{repo.subdir}
                            </span>
                          ) : null}
                          {repo.available === false ? (
                            <span
                              data-testid={`skill-repo-unavailable-${repo.id}`}
                              className="rounded-capsule border border-warning/55 bg-warning/10 px-1.5 py-0.5 text-micro font-medium text-warning"
                            >
                              Unavailable
                            </span>
                          ) : null}
                          {repo.available !== false && updatable.has(repo.id) ? (
                            <span
                              data-testid={`skill-repo-updatable-${repo.id}`}
                              className="rounded-capsule px-1.5 py-0.5 text-micro font-medium"
                              style={{
                                background: "var(--color-selection-fill)",
                                color: "var(--color-brand-accent)",
                              }}
                            >
                              Update available
                            </span>
                          ) : null}
                          <Button
                            data-testid={`skill-repo-add-${repo.id}`}
                            size="sm"
                            variant="ghost"
                            title="Preview this repository and add more of its skills to the collection"
                            disabled={
                              !repo.remoteUrl ||
                              repo.available === false ||
                              repoBusy[repo.id] !== undefined
                            }
                            onClick={() =>
                              void doGitInspect({
                                url: repo.remoteUrl,
                                ref: repo.ref,
                                subdir: repo.subdir,
                              })
                            }
                          >
                            Add skills
                          </Button>
                          <Button
                            ref={(element) => {
                              if (element) repoUpdateRefs.current.set(repo.id, element);
                              else repoUpdateRefs.current.delete(repo.id);
                            }}
                            data-testid={`skill-repo-update-${repo.id}`}
                            size="sm"
                            variant="secondary"
                            disabled={repo.available === false || repoBusy[repo.id] !== undefined}
                            onClick={() => void updateRepo(repo.id)}
                          >
                            {repoBusy[repo.id] === "update" ? "Updating…" : "Update"}
                          </Button>
                          <IconButton
                            data-testid={`skill-repo-forget-${repo.id}`}
                            size="sm"
                            variant="ghost"
                            icon={<X />}
                            title={
                              repo.storageMode === "collection-v1"
                                ? "Forget this repository and remove its managed skill collection"
                                : "Forget this repository (keeps the imported skills)"
                            }
                            aria-label={
                              repoBusy[repo.id] === "forget" ? "Forgetting…" : "Forget repository"
                            }
                            disabled={repo.available === false || repoBusy[repo.id] !== undefined}
                            onClick={() => void forgetRepo(repo.id)}
                          />
                          {repo.available === false ? (
                            <Button
                              ref={(element) => {
                                if (element) repoRemoveRecordRefs.current.set(repo.id, element);
                                else repoRemoveRecordRefs.current.delete(repo.id);
                              }}
                              data-testid={`skill-repo-remove-record-${repo.id}`}
                              size="sm"
                              variant="destructiveOutline"
                              disabled={repoBusy[repo.id] !== undefined}
                              onClick={() => void removeUnavailableRecord(repo)}
                            >
                              {repoBusy[repo.id] === "remove-record"
                                ? "Removing…"
                                : "Remove record only"}
                            </Button>
                          ) : null}
                        </div>
                        {repo.available === false ? (
                          <div
                            data-testid={`skill-repo-unavailable-guidance-${repo.id}`}
                            className="px-2.5 py-1 text-micro text-text-muted"
                            role="status"
                          >
                            Restore the original managed repository folder, then restart Agent Deck
                            to recover it. “Remove record only” leaves all clone files untouched.
                          </div>
                        ) : null}
                        {(conflicts[repo.id] ?? []).length > 0 ? (
                          <div
                            data-testid={`skill-repo-conflicts-${repo.id}`}
                            className="mt-1 space-y-1 rounded-lg border border-warning bg-surface px-2.5 py-1.5"
                          >
                            <div className="text-micro text-text-muted" role="status">
                              Non-overlapping changes were merged. Review overlapping paths; Keep
                              Mine is the default.
                            </div>
                            {conflicts[repo.id]!.map((conflict) => {
                              const key = `${repo.id}\0${conflict.mergeId}`;
                              const conflictBusy = resolvingConflicts[key] !== undefined;
                              return (
                                <div
                                  key={conflict.mergeId}
                                  className="space-y-1"
                                  aria-busy={conflictBusy}
                                >
                                  <div
                                    className="truncate font-mono text-detail text-text-primary"
                                    title={conflict.name}
                                  >
                                    {conflict.name}
                                  </div>
                                  <div
                                    className="max-h-40 space-y-1 overflow-auto"
                                    role="group"
                                    aria-label={`Conflicting paths for ${conflict.name}`}
                                  >
                                    {conflict.paths.map((item) => {
                                      const choiceKey = `${key}\0${item.path}`;
                                      const choice = conflictChoices[choiceKey] ?? "mine";
                                      return (
                                        <fieldset
                                          key={item.path}
                                          className="flex min-w-0 items-center gap-2 text-micro"
                                          disabled={conflictBusy}
                                        >
                                          <legend className="sr-only">
                                            Resolution for {item.path}
                                          </legend>
                                          <span
                                            className="min-w-0 flex-1 truncate font-mono"
                                            title={item.path}
                                          >
                                            {item.path}
                                          </span>
                                          <span className="text-text-muted">
                                            {item.local} → {item.remote}
                                          </span>
                                          {(["mine", "remote"] as const).map((value) => (
                                            <label
                                              key={value}
                                              className="flex items-center gap-1 whitespace-nowrap"
                                            >
                                              <ControlInput
                                                type="radio"
                                                name={choiceKey}
                                                checked={choice === value}
                                                aria-label={`${value === "mine" ? "Keep Mine" : "Take Remote"} for ${item.path}`}
                                                onChange={() =>
                                                  setConflictChoices((current) => ({
                                                    ...current,
                                                    [choiceKey]: value,
                                                  }))
                                                }
                                              />
                                              {value === "mine" ? "Keep Mine" : "Take Remote"}
                                            </label>
                                          ))}
                                        </fieldset>
                                      );
                                    })}
                                  </div>
                                  {staleConflicts[key] ? (
                                    <Button
                                      data-testid={`skill-conflict-refresh-${repo.id}-${conflict.name}`}
                                      size="sm"
                                      variant="ghost"
                                      disabled={conflictBusy}
                                      onClick={() => void refreshConflict(repo.id, conflict)}
                                    >
                                      {resolvingConflicts[key] === "refresh"
                                        ? "Refreshing…"
                                        : "Refresh review"}
                                    </Button>
                                  ) : null}
                                  <Button
                                    ref={(element) => {
                                      if (element) conflictActionRefs.current.set(key, element);
                                      else conflictActionRefs.current.delete(key);
                                    }}
                                    data-conflict-primary="true"
                                    data-testid={`skill-conflict-apply-${repo.id}-${conflict.name}`}
                                    size="sm"
                                    variant="secondary"
                                    disabled={conflictBusy}
                                    onClick={() => void resolveConflict(repo.id, conflict)}
                                  >
                                    {conflictBusy ? "Applying…" : "Apply choices"}
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <div className="sr-only" role="status" aria-live="polite" data-testid="skill-merge-status">
          {mergeAnnouncement}
        </div>
        {view === "catalog" && sourceIssueCount > 0 ? (
          <div
            className="mx-auto mb-2 flex w-full max-w-7xl items-center gap-2 px-4 text-detail sm:px-6 lg:px-8"
            data-testid="skill-sources-summary"
          >
            <span className="rounded-capsule border border-warning/55 bg-warning/10 px-2 py-0.5 text-warning">
              {sourceIssueCount} source {sourceIssueCount === 1 ? "item needs" : "items need"}{" "}
              attention
            </span>
            <Button size="sm" variant="ghost" onClick={() => setView("sources")}>
              Manage Sources
            </Button>
          </div>
        ) : null}
        {view === "catalog" && checkedSkills.length > 0 ? (
          <div
            className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-detail"
            data-testid="skills-bulk-bar"
          >
            <span className="flex-1 text-text-secondary">{checkedSkills.length} selected</span>
            <Button
              data-testid="skills-bulk-clear"
              size="sm"
              variant="ghost"
              onClick={() => setChecked(new Set())}
            >
              Clear
            </Button>
            <Button
              data-testid="skills-bulk-delete"
              size="sm"
              variant="destructiveOutline"
              leadingIcon={<Trash2 size={12} />}
              onClick={() => {
                const n = checkedSkills.length;
                if (confirm(`Delete ${n} skill${n === 1 ? "" : "s"}? This removes their files.`)) {
                  void bulkDelete();
                }
              }}
            >
              Delete
            </Button>
          </div>
        ) : null}
        <div
          className={cn("min-h-0 flex-1 overflow-y-auto", view !== "catalog" && "hidden")}
          role="listbox"
          aria-label="Skills"
        >
          <div className="mx-auto w-full max-w-7xl space-y-1 px-4 pb-page-y sm:px-6 lg:px-8">
            {visible.map((skill) => {
              const isSelected = catalogSelected?.filePath === skill.filePath;
              const isAssigned = assignedNames.has(skill.name);
              return (
                <div
                  key={skill.filePath}
                  className={cn(
                    "group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus",
                    isSelected
                      ? "border-selection-stroke bg-selection"
                      : "border-transparent hover:bg-hover",
                    skill.disabled && "opacity-60 saturate-50",
                  )}
                  data-testid="skill-row"
                  data-skill-name={skill.name}
                  data-skill-path={skill.filePath}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onClick={() => selectSkill(skill.filePath, true)}
                  onKeyDown={(event) => {
                    // Ignore keys bubbled from the checkbox (its own Space toggles
                    // it) — only the row's own Enter/Space opens the detail.
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectSkill(skill.filePath, true);
                    }
                  }}
                >
                  {!isReadOnlyScope(skill.scope) ? (
                    <ControlInput
                      type="checkbox"
                      data-testid={`skill-check-${skill.name}`}
                      aria-label={`Select ${skill.name}`}
                      className="shrink-0 accent-[var(--color-brand-accent)]"
                      checked={checked.has(skill.filePath)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleCheck(skill.filePath)}
                    />
                  ) : null}
                  <WandSparkles
                    size={17}
                    className="shrink-0"
                    style={{
                      color: isAssigned ? "var(--color-source-project)" : "var(--color-text-muted)",
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-label font-semibold text-text-primary">
                        {skill.name}
                      </span>
                      <ScopeChip scope={skill.scope} />
                      {skill.disabled ? (
                        <span
                          className="rounded-capsule border px-1.5 text-micro"
                          style={{
                            color: "var(--color-text-muted)",
                            borderColor: "var(--color-border-strong)",
                          }}
                          data-testid="skill-disabled-badge"
                        >
                          disabled
                        </span>
                      ) : null}
                    </div>
                    <div className="line-clamp-2 text-caption text-text-secondary">
                      {skill.description}
                    </div>
                    {isReadOnlyScope(skill.scope) ? (
                      <div
                        className="truncate font-mono text-micro text-text-muted"
                        title={skill.filePath}
                        data-testid={`skill-source-${skill.name}`}
                      >
                        {skill.filePath}
                      </div>
                    ) : null}
                    {(() => {
                      // SKL-12: native's synced-repository binding, inline on the row
                      const repo = collectionFor(skill);
                      if (!repo) return null;
                      return (
                        <div
                          className="flex min-w-0 items-center gap-1.5 truncate text-micro text-text-muted"
                          data-testid={`skill-collection-${skill.name}`}
                          title={repo.remoteUrl}
                        >
                          <span className="truncate">Synced · {repoLabel(repo)}</span>
                          {repo.available !== false && updatable.has(repo.id) ? (
                            <span
                              data-testid={`skill-collection-update-${skill.name}`}
                              className="shrink-0 rounded-capsule px-1.5 text-micro font-medium"
                              style={{
                                background: "var(--color-selection-fill)",
                                color: "var(--color-brand-accent)",
                              }}
                            >
                              Update available
                            </span>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                  {!isReadOnlyScope(skill.scope) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        selectSkill(skill.filePath);
                        setEditing(editDraft(skill));
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {visible.length === 0 ? (
              <AppEmptyState
                heading="No matches"
                body="No skills found in ~/.pi/agent/skills or this project's .pi/skills."
              />
            ) : null}
          </div>
        </div>
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", view !== "detail" && "hidden")}>
        <PageToolbar
          leading={
            <Button
              data-testid="skill-detail-back"
              size="sm"
              variant="ghost"
              leadingIcon={<ArrowLeft size={14} />}
              onClick={returnToCatalog}
            >
              Back to Skills
            </Button>
          }
        />
        {selected ? (
          <div
            className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto px-4 py-page-y sm:px-6 lg:px-8"
            data-testid="skill-detail"
          >
            <div className="flex flex-wrap items-start gap-3">
              <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-source-project-stroke bg-source-project-subtle text-source-project">
                <WandSparkles size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {renameValue !== null ? (
                    <>
                      <ControlInput
                        autoFocus
                        data-testid="skill-rename-input"
                        className="min-w-[min(16rem,100%)] flex-1 basis-[calc(100%_-_6rem)] rounded-lg border border-border-strong bg-surface px-2 py-1 text-title font-semibold tracking-title text-text-primary outline-none focus:border-accent"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void submitRename(selected);
                          if (e.key === "Escape") setRenameValue(null);
                        }}
                      />
                      <IconButton
                        data-testid="skill-rename-confirm"
                        size="sm"
                        aria-label="Rename"
                        title="Rename"
                        icon={<Check />}
                        onClick={() => void submitRename(selected)}
                      />
                      <IconButton
                        data-testid="skill-rename-cancel"
                        size="sm"
                        aria-label="Cancel"
                        title="Cancel"
                        icon={<X />}
                        onClick={() => setRenameValue(null)}
                      />
                    </>
                  ) : (
                    <h2 className="truncate text-title font-semibold tracking-title text-text-primary">
                      {selected.name}
                    </h2>
                  )}
                  <ScopeChip scope={selected.scope} />
                  {selected.disableModelInvocation ? (
                    <span
                      data-testid="skill-manual-only-badge"
                      className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
                      title="disable-model-invocation is set: the model won't auto-invoke this skill. It's only used when invoked explicitly (e.g. via the composer's / menu)."
                    >
                      manual only
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-body text-text-secondary">{selected.description}</p>
                {/* How pi invokes this skill explicitly (agent-session _expandSkillCommand
                  matches `/skill:<name>`, where name is pi's resolved skill name —
                  frontmatter `name` or the directory basename — which is exactly
                  SkillInfo.name). Distinct from prompts' `/name` form. Only shown
                  for a pi-valid name (isValidSkillCommandName) so the displayed
                  command always resolves; pi warns on — but still loads — names
                  it considers invalid, which wouldn't invoke as typed. */}
                {isValidSkillCommandName(selected.name) ? (
                  <code
                    data-testid="skill-invocation"
                    className="mt-1 inline-block font-mono text-code text-text-muted"
                  >
                    /skill:{selected.name}
                  </code>
                ) : null}
              </div>
              <div
                className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:shrink-0 lg:justify-end"
                data-testid="skill-detail-actions"
                aria-label="Skill actions"
              >
                {!isReadOnlyScope(selected.scope) ? (
                  <Button
                    data-testid="skill-edit"
                    size="sm"
                    variant="primary"
                    leadingIcon={<Pencil size={12} />}
                    onClick={() => setEditing(editDraft(selected))}
                  >
                    Edit SKILL.md
                  </Button>
                ) : null}
                <div
                  className="flex flex-wrap items-center gap-2"
                  aria-label="Secondary skill actions"
                >
                  <Button
                    data-testid="skill-disable"
                    size="sm"
                    variant="secondary"
                    leadingIcon={selected.disabled ? <Power size={12} /> : <PowerOff size={12} />}
                    onClick={() => void setSkillDisabled(selected.name, !selected.disabled)}
                  >
                    {selected.disabled ? "Enable" : "Disable"}
                  </Button>
                  {!isReadOnlyScope(selected.scope) ? (
                    <Button
                      data-testid="skill-rename"
                      size="sm"
                      variant="ghost"
                      leadingIcon={<Tag size={12} />}
                      onClick={() => setRenameValue(selected.name)}
                    >
                      Rename
                    </Button>
                  ) : null}
                </div>
                {!isReadOnlyScope(selected.scope) ? (
                  <div
                    className="border-l border-border-subtle pl-2"
                    aria-label="Destructive skill actions"
                  >
                    <Button
                      data-testid="skill-delete"
                      size="sm"
                      variant="destructiveOutline"
                      leadingIcon={<Trash2 size={13} />}
                      onClick={() => {
                        if (
                          confirm(`Delete skill "${selected.name}"? This removes its SKILL.md.`)
                        ) {
                          void deleteSkill(selected.scope, selected.name);
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-5 space-y-4">
              <AssignmentCard skill={selected} />
              {(() => {
                const s = skillSummary[summaryKey(selected)];
                return (
                  <div
                    data-testid="skill-detail-summary"
                    className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
                  >
                    <div className="flex items-center justify-between pb-2">
                      <span className={cn(sectionHeaderClass, "text-text-muted")}>AI summary</span>
                      <Button
                        data-testid="skill-summarize"
                        size="sm"
                        variant="ghost"
                        disabled={s?.busy === true}
                        onClick={() => void doSummarize(selected)}
                      >
                        {s?.busy ? "Summarizing…" : s?.text ? "Regenerate" : "Summarize"}
                      </Button>
                    </div>
                    {s?.text ? (
                      <div className="text-detail text-text-secondary">{s.text}</div>
                    ) : null}
                    {s?.error ? <div className="text-detail text-danger">{s.error}</div> : null}
                    {!s?.text && !s?.error && !s?.busy ? (
                      <div className="text-detail text-text-muted">
                        Ask the configured model what this skill does and when to reach for it.
                      </div>
                    ) : null}
                  </div>
                );
              })()}
              {(() => {
                // SKL-21: same-name copies (native duplicate diagnostic + compare sheet)
                const copies = skillCandidates.filter(
                  (c) => c.name === selected.name && c.filePath !== selected.filePath,
                );
                if (copies.length === 0) return null;
                return (
                  <div
                    data-testid="skill-duplicates"
                    className="rounded-xl border border-warning/55 bg-warning/10 px-4 py-3"
                  >
                    <div className={cn(sectionHeaderClass, "pb-2 text-text-muted")}>
                      Duplicate copies
                    </div>
                    <div className="space-y-1.5">
                      {copies.map((copy, index) => (
                        <div key={copy.filePath} className="flex items-center gap-2 text-detail">
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-text-secondary"
                            title={copy.filePath}
                          >
                            {copy.filePath}
                          </span>
                          <ScopeChip scope={copy.scope} />
                          <Button
                            data-testid={`skill-compare-${index}`}
                            size="sm"
                            variant="ghost"
                            onClick={(event) => {
                              compareTriggerRef.current = event.currentTarget;
                              setCompare({ left: selected, right: copy });
                            }}
                          >
                            Compare
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {(() => {
                // SKL-12: native's "Synced Repository" card — this skill's managed collection,
                // with the update action wired to the same repo endpoint the panel uses.
                const repo = collectionFor(selected);
                if (!repo) return null;
                return (
                  <div
                    data-testid="skill-detail-collection"
                    className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
                  >
                    <div className={cn(sectionHeaderClass, "pb-2 text-text-muted")}>
                      Synced collection
                    </div>
                    <div className="space-y-1 text-detail text-text-secondary">
                      <div className="truncate" title={repo.remoteUrl}>
                        <span className="text-text-muted">Source</span> · {repoLabel(repo)}
                      </div>
                      {repo.ref ? (
                        <div>
                          <span className="text-text-muted">Ref</span> · {repo.ref}
                        </div>
                      ) : null}
                      {repo.subdir ? (
                        <div className="truncate" title={repo.subdir}>
                          <span className="text-text-muted">Subdir</span> · {repo.subdir}
                        </div>
                      ) : null}
                      <div className="truncate" title={repo.skillNames.join(", ")}>
                        <span className="text-text-muted">Selection</span> ·{" "}
                        {repo.skillNames.length} skill{repo.skillNames.length === 1 ? "" : "s"} ·{" "}
                        {repo.skillNames.join(", ")}
                      </div>
                      {repo.storageMode === "collection-v1" ? (
                        <div>
                          <span className="text-text-muted">Storage</span> · Managed collection
                        </div>
                      ) : null}
                    </div>
                    {repo.available !== false && updatable.has(repo.id) ? (
                      <div className="mt-2 flex items-center gap-2">
                        <span
                          className="rounded-capsule px-1.5 py-0.5 text-micro font-medium"
                          style={{
                            background: "var(--color-selection-fill)",
                            color: "var(--color-brand-accent)",
                          }}
                        >
                          Update available
                        </span>
                        <Button
                          data-testid="skill-detail-collection-update"
                          size="sm"
                          variant="secondary"
                          disabled={repoBusy[repo.id] !== undefined}
                          onClick={() => void updateRepo(repo.id)}
                        >
                          {repoBusy[repo.id] === "update" ? "Updating…" : "Update collection"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })()}
              <div className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3">
                <div className={cn(sectionHeaderClass, "pb-2 text-text-muted")}>SKILL.md</div>
                <div className="max-w-3xl">
                  <MarkdownDocument source={selected.body || "_(empty)_"} />
                </div>
              </div>
              <div className="truncate text-detail text-text-muted" title={selected.filePath}>
                {selected.filePath}
              </div>
            </div>
          </div>
        ) : (
          <AppEmptyState
            layout="fill"
            heading="This skill is no longer available."
            body="Return to Skills to choose another resource."
            role="status"
          />
        )}
      </div>
      {compare ? <SkillCompareDialog compare={compare} onClose={closeCompare} /> : null}
      {editing ? <SkillEditSheet draft={editing} onClose={() => setEditing(null)} /> : null}
    </PageShell>
  );
}
