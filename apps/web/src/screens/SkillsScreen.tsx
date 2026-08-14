import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  FolderInput,
  FolderSearch,
  GitBranch,
  Grid3x3,
  Pencil,
  Power,
  PowerOff,
  Plus,
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

interface SkillRepo {
  id: string;
  remoteUrl: string;
  ref?: string;
  storageMode?: "collection-v1";
  skillNames: string[];
  lastSyncedCommit: string;
  importedAt: string;
  available: boolean;
  unavailable?: { code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE"; message: string };
  pendingMerges?: SkillMergeConflict[];
}
import { MarkdownDocument } from "@/design-system/markdown/MarkdownDocument";
import { useAppStore } from "../state/store.ts";
import { deleteSkill, renameSkill, setSkillDisabled, updateProject } from "../state/wsBridge.ts";
import { ScopeChip } from "../components/ScopeChip.tsx";
import { chooseDirectory, trashSkillRecovery } from "../lib/native.ts";

/**
 * Native SkillsScreen: master-detail split; rows with the wand glyph
 * (source-green when assigned), detail rendering SKILL.md as markdown, and
 * the assignment card — an "All Projects" row followed by per-project
 * checkbox rows that dim while All Projects is on
 * (SkillManagementViews.swift projectAssignmentList).
 */

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent";

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
          <div
            className="flex-1 truncate text-sm font-semibold text-text-primary"
            style={{ fontStretch: "expanded" }}
          >
            {draft.isNew ? "New Skill" : `Edit ${draft.name}`}
          </div>
          <ControlButton
            className="rounded-capsule p-1.5 text-text-muted hover:bg-hover hover:text-text-primary"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={15} />
          </ControlButton>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {draft.isNew ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-text-muted">
                Name
                <ControlInput
                  data-testid="skill-editor-name"
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="text-xs text-text-muted">
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
          <label className="block text-xs text-text-muted">
            Description
            <ControlInput
              data-testid="skill-editor-description"
              className={inputClass}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
          <label className="block text-xs text-text-muted">
            SKILL.md body
            <ControlTextArea
              data-testid="skill-editor-body"
              className={cn(inputClass, "min-h-[220px] font-mono text-caption")}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </label>
          {error ? (
            <div className="text-sm" style={{ color: "var(--color-role-error)" }}>
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <ControlButton
            className="rounded-capsule border border-border-strong px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary"
            onClick={onClose}
          >
            Cancel
          </ControlButton>
          <ControlButton
            data-testid="skill-editor-save"
            className="rounded-capsule px-4 py-1.5 text-sm font-medium shadow-capsule disabled:opacity-40"
            style={{
              background:
                "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
              color: "var(--color-accent-foreground)",
            }}
            disabled={!form.name.trim()}
            onClick={() => void save()}
          >
            Save
          </ControlButton>
        </div>
      </div>
    </div>
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
      <div className="pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
        Project assignment
      </div>
      <p className="pb-2 text-xs text-text-muted">
        Assigned skills are passed to new sessions as explicit --skill paths (no ambient discovery).
        Changes apply to the next session.
      </p>
      {skill.disabled ? (
        <p className="pb-2 text-xs" style={{ color: "var(--color-warning)" }}>
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
        <span className="text-sm text-text-primary">All Projects</span>
        <span className="text-xs text-text-muted">enable this skill for every project</span>
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
              <span className="text-sm text-text-primary">{project.name}</span>
              <span className="truncate font-mono text-xs text-text-muted">{project.path}</span>
            </label>
          );
        })}
        {projects.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-text-muted">No projects registered.</div>
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
  const [packageWarnings, setPackageWarnings] = useState<string[]>([]);

  useEffect(() => {
    const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
    setSkills([]);
    setPackageWarnings([]);
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
        };
        if (!cancelled) {
          setSkills(data.skills);
          setPackageWarnings(data.packageWarnings ?? []);
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
  const [gitPreview, setGitPreview] = useState<{
    repoId: string;
    url: string;
    skills: SkillPreviewItem[];
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

  const doGitInspect = async (): Promise<void> => {
    const url = (gitUrl ?? "").trim();
    if (!url || inspectLock.current || localPreview || knownPreview) return;
    inspectLock.current = true;
    const seq = ++inspectSeq.current;
    setGitImporting(true);
    try {
      const res = await fetch("/resources/skills/inspect-git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok)
        throw new Error(await responseErrorMessage(res, "Couldn't read that repository."));
      const data = (await res.json()) as { repoId: string; skills: SkillPreviewItem[] };
      if (seq !== inspectSeq.current) {
        // the user dismissed or superseded this request while it was in flight
        discardPreview(data.repoId);
        return;
      }
      if (data.skills.length === 0) {
        // the engine already cleaned the empty preview up — nothing importable to show
        throw new Error("No skills with a SKILL.md were found in that repository.");
      }
      setGitPreview((prev) => {
        if (prev && prev.repoId !== data.repoId) discardPreview(prev.repoId); // no leaked replacement
        return { repoId: data.repoId, url, skills: data.skills };
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
      body: JSON.stringify({ scope: "global", url: gitPreview.url, selected }),
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
      setLocalPreview({ path: folder, skills: data.skills });
    } catch (err) {
      if (seq === inspectSeq.current) setGlobalError(String(err));
    } finally {
      inspectLock.current = false;
    }
  };

  // SKL-07/10: scan the KNOWN external skill folders (Claude/Codex, global + per-project) and
  // feed every discovered skill into the same preview dialog, labeled by source. Copy-on-import
  // like every engine import; per-root scan failures degrade to a note instead of killing the scan.
  const [knownPreview, setKnownPreview] = useState<{
    items: (SkillPreviewItem & { sourcePath: string })[];
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
      const items: (SkillPreviewItem & { sourcePath: string })[] = [];
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
            });
          }
        } catch {
          // ANY per-root failure (HTTP, network, malformed JSON) degrades to a note — one bad
          // root must not kill the whole scan or masquerade as "no skills" (review, Codex)
          failures.push(src.label);
        }
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
    // group the selection back into per-root imports (ids are path-qualified)
    const byRoot = new Map<string, { label: string; selected: string[] }>();
    for (const id of selectedIds) {
      const item = knownPreview.items.find((i) => i.id === id);
      if (!item) continue;
      const entry = byRoot.get(item.sourcePath) ?? {
        label: item.sourceLabel ?? item.sourcePath,
        selected: [],
      };
      entry.selected.push(item.name);
      byRoot.set(item.sourcePath, entry);
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
  const selectSkill = useCallback((filePath: string): void => {
    setPendingSelectPath(null);
    setSelectedKey(filePath);
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

  const selected = visible.find((s) => s.filePath === selectedKey) ?? visible[0] ?? null;

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
    <div className="flex min-h-0 flex-1" data-testid="skills-screen">
      {/* List pane */}
      <div className="flex w-[42%] min-w-[320px] flex-col border-r border-border-subtle">
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <ControlInput
            data-testid="skill-search"
            className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
            placeholder="Search skills"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ControlButton
            data-testid="new-skill"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full shadow-capsule"
            style={{
              background:
                "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
              color: "var(--color-accent-foreground)",
            }}
            title="New skill"
            onClick={() =>
              setEditing({ name: "", scope: "global", description: "", body: "", isNew: true })
            }
          >
            <Plus size={15} />
          </ControlButton>
          <ControlButton
            data-testid="skill-import"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-strong text-text-secondary hover:text-text-primary"
            title="Import skills from a local folder or .md file"
            onClick={() => void doLocalFolderImport()}
          >
            <FolderInput size={15} />
          </ControlButton>
          <ControlButton
            data-testid="skill-scan-known"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-strong text-text-secondary hover:text-text-primary"
            title="Scan Claude and Codex skill folders"
            onClick={() => void doKnownScan()}
          >
            <FolderSearch size={15} />
          </ControlButton>
          <ControlButton
            data-testid="skill-import-git"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-strong text-text-secondary hover:text-text-primary"
            title="Import skills from a git repository"
            onClick={() => setGitUrl((v) => (v === null ? "" : null))}
          >
            <GitBranch size={15} />
          </ControlButton>
        </div>
        {importPath !== null ? (
          <div className="mx-3 mb-2 flex gap-2">
            <ControlInput
              autoFocus
              data-testid="skill-import-path"
              className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
              placeholder="/path/to/skill.md"
              value={importPath}
              onChange={(event) => setImportPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void doImport();
                if (event.key === "Escape") setImportPath(null);
              }}
            />
            <ControlButton
              data-testid="skill-import-confirm"
              className="rounded-capsule border border-border-strong px-2.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
              disabled={!importPath.trim()}
              onClick={() => void doImport()}
            >
              Import
            </ControlButton>
          </div>
        ) : null}
        {gitUrl !== null ? (
          <div className="mx-3 mb-2 flex gap-2">
            <ControlInput
              autoFocus
              data-testid="skill-import-git-url"
              className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
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
            <ControlButton
              data-testid="skill-import-git-confirm"
              className="rounded-capsule border border-border-strong px-2.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
              disabled={!gitUrl.trim() || gitImporting}
              onClick={() => void doGitInspect()}
            >
              {gitImporting ? "Fetching…" : "Preview"}
            </ControlButton>
          </div>
        ) : null}
        {gitPreview ? (
          <SkillImportPreviewDialog
            sourceLabel={gitPreview.url}
            sourceKind="git"
            skills={gitPreview.skills}
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
        {packageWarnings.length > 0 ? (
          <div
            data-testid="skill-package-warnings"
            className="mx-3 mb-2 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary"
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
          <div
            data-testid="skill-management-panels"
            className="mx-3 mb-2 max-h-[min(36vh,20rem)] min-h-0 shrink-0 space-y-2 overflow-y-auto overscroll-contain"
          >
            {recoveries.length > 0 ? (
              <div className="space-y-1" data-testid="skill-recoveries">
                <div className="px-0.5 text-micro font-semibold uppercase tracking-wide text-text-muted">
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
                      <p className="text-micro text-text-muted">
                        {busy === "trash"
                          ? "This completed-update backup is being moved to OS Trash automatically."
                          : "A displaced or interrupted tree was retained safely. Restore is available only while the active skill is absent, or move this retained tree to OS Trash."}
                      </p>
                      {busy === "trash" ? null : (
                        <div className="mt-1 flex gap-1">
                          <ControlButton
                            ref={(element) => {
                              if (element) recoveryActionRefs.current.set(recovery.token, element);
                              else recoveryActionRefs.current.delete(recovery.token);
                            }}
                            disabled={busy !== undefined}
                            onClick={() => void moveRecoveryToTrash(recovery)}
                            data-testid={`skill-recovery-trash-${recovery.skillName}`}
                          >
                            Move to Trash
                          </ControlButton>
                          <ControlButton
                            ref={(element) => {
                              const key = `${recovery.token}:restore`;
                              if (element) recoveryActionRefs.current.set(key, element);
                              else recoveryActionRefs.current.delete(key);
                            }}
                            disabled={busy !== undefined}
                            onClick={() => void restoreRecovery(recovery)}
                            data-testid={`skill-recovery-restore-${recovery.skillName}`}
                          >
                            {busy === "restore" ? "Restoring…" : "Restore"}
                          </ControlButton>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {repos.length > 0 ? (
              <div className="space-y-1" data-testid="skill-repos">
                <div className="px-0.5 text-micro font-semibold uppercase tracking-wide text-text-muted">
                  Imported repositories
                </div>
                {repos.map((repo) => (
                  <div key={repo.id}>
                    <div
                      data-testid={`skill-repo-${repo.id}`}
                      className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5"
                      aria-busy={repoBusy[repo.id] !== undefined}
                    >
                      <GitBranch size={12} className="shrink-0 text-text-secondary" />
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-detail text-text-primary"
                        title={repo.remoteUrl}
                      >
                        {repo.remoteUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")}
                      </span>
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
                      <ControlButton
                        ref={(element) => {
                          if (element) repoUpdateRefs.current.set(repo.id, element);
                          else repoUpdateRefs.current.delete(repo.id);
                        }}
                        data-testid={`skill-repo-update-${repo.id}`}
                        className="rounded-capsule border border-border-strong px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary disabled:opacity-40"
                        disabled={repo.available === false || repoBusy[repo.id] !== undefined}
                        onClick={() => void updateRepo(repo.id)}
                      >
                        {repoBusy[repo.id] === "update" ? "Updating…" : "Update"}
                      </ControlButton>
                      <ControlButton
                        data-testid={`skill-repo-forget-${repo.id}`}
                        className="rounded-capsule p-1 text-text-muted hover:text-danger disabled:opacity-40"
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
                      >
                        <X size={12} />
                      </ControlButton>
                      {repo.available === false ? (
                        <ControlButton
                          ref={(element) => {
                            if (element) repoRemoveRecordRefs.current.set(repo.id, element);
                            else repoRemoveRecordRefs.current.delete(repo.id);
                          }}
                          data-testid={`skill-repo-remove-record-${repo.id}`}
                          className="rounded-capsule border border-danger px-2 py-0.5 text-micro text-danger hover:bg-danger hover:text-surface disabled:opacity-40"
                          disabled={repoBusy[repo.id] !== undefined}
                          onClick={() => void removeUnavailableRecord(repo)}
                        >
                          {repoBusy[repo.id] === "remove-record"
                            ? "Removing…"
                            : "Remove record only"}
                        </ControlButton>
                      ) : null}
                    </div>
                    {repo.available === false ? (
                      <div
                        data-testid={`skill-repo-unavailable-guidance-${repo.id}`}
                        className="px-2.5 py-1 text-micro text-text-muted"
                        role="status"
                      >
                        Restore the original managed repository folder, then restart Agent Deck to
                        recover it. “Remove record only” leaves all clone files untouched.
                      </div>
                    ) : null}
                    {(conflicts[repo.id] ?? []).length > 0 ? (
                      <div
                        data-testid={`skill-repo-conflicts-${repo.id}`}
                        className="mt-1 space-y-1 rounded-lg border border-warning bg-surface px-2.5 py-1.5"
                      >
                        <div className="text-micro text-text-muted" role="status">
                          Non-overlapping changes were merged. Review overlapping paths; Keep Mine
                          is the default.
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
                                <ControlButton
                                  data-testid={`skill-conflict-refresh-${repo.id}-${conflict.name}`}
                                  disabled={conflictBusy}
                                  onClick={() => void refreshConflict(repo.id, conflict)}
                                >
                                  {resolvingConflicts[key] === "refresh"
                                    ? "Refreshing…"
                                    : "Refresh review"}
                                </ControlButton>
                              ) : null}
                              <ControlButton
                                ref={(element) => {
                                  if (element) conflictActionRefs.current.set(key, element);
                                  else conflictActionRefs.current.delete(key);
                                }}
                                data-conflict-primary="true"
                                data-testid={`skill-conflict-apply-${repo.id}-${conflict.name}`}
                                className="sticky bottom-0 rounded-capsule border border-border-strong bg-surface px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary"
                                disabled={conflictBusy}
                                onClick={() => void resolveConflict(repo.id, conflict)}
                              >
                                {conflictBusy ? "Applying…" : "Apply choices"}
                              </ControlButton>
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
        <div className="sr-only" role="status" aria-live="polite" data-testid="skill-merge-status">
          {mergeAnnouncement}
        </div>
        {checkedSkills.length > 0 ? (
          <div
            className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border-strong bg-surface-elevated px-2.5 py-1.5 text-xs"
            data-testid="skills-bulk-bar"
          >
            <span className="flex-1 text-text-secondary">{checkedSkills.length} selected</span>
            <ControlButton
              data-testid="skills-bulk-clear"
              className="rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
              onClick={() => setChecked(new Set())}
            >
              Clear
            </ControlButton>
            <ControlButton
              data-testid="skills-bulk-delete"
              className="flex items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 text-text-muted hover:text-danger"
              onClick={() => {
                const n = checkedSkills.length;
                if (confirm(`Delete ${n} skill${n === 1 ? "" : "s"}? This removes their files.`)) {
                  void bulkDelete();
                }
              }}
            >
              <Trash2 size={12} /> Delete
            </ControlButton>
          </div>
        ) : null}
        <div
          className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4"
          role="listbox"
          aria-label="Skills"
        >
          {visible.map((skill) => {
            const isSelected = selected?.filePath === skill.filePath;
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
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={() => selectSkill(skill.filePath)}
                onKeyDown={(event) => {
                  // Ignore keys bubbled from the checkbox (its own Space toggles
                  // it) — only the row's own Enter/Space opens the detail.
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectSkill(skill.filePath);
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
                    <span
                      className="truncate text-sm font-semibold text-text-primary"
                      style={{ fontStretch: "expanded" }}
                    >
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
                  <div className="truncate text-xs text-text-secondary">{skill.description}</div>
                  {isReadOnlyScope(skill.scope) ? (
                    <div
                      className="truncate font-mono text-micro text-text-muted"
                      title={skill.filePath}
                      data-testid={`skill-source-${skill.name}`}
                    >
                      {skill.filePath}
                    </div>
                  ) : null}
                </div>
                {!isReadOnlyScope(skill.scope) ? (
                  <ControlButton
                    className="rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary opacity-0 transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      selectSkill(skill.filePath);
                      setEditing(editDraft(skill));
                    }}
                  >
                    Edit
                  </ControlButton>
                ) : null}
              </div>
            );
          })}
          {visible.length === 0 ? (
            <div className="mt-8 text-center text-sm text-text-muted">
              No skills found in ~/.pi/agent/skills or this project's .pi/skills.
            </div>
          ) : null}
        </div>
      </div>

      {/* Detail pane */}
      {selected ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="skill-detail">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-source-project-stroke bg-source-project-subtle text-source-project">
              <WandSparkles size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {renameValue !== null ? (
                  <>
                    <ControlInput
                      autoFocus
                      data-testid="skill-rename-input"
                      className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2 py-1 text-lg font-bold text-text-primary outline-none focus:border-accent"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitRename(selected);
                        if (e.key === "Escape") setRenameValue(null);
                      }}
                    />
                    <ControlButton
                      data-testid="skill-rename-confirm"
                      className="rounded p-1 text-text-muted hover:text-accent"
                      title="Rename"
                      onClick={() => void submitRename(selected)}
                    >
                      <Check size={16} />
                    </ControlButton>
                    <ControlButton
                      data-testid="skill-rename-cancel"
                      className="rounded p-1 text-text-muted hover:text-text-primary"
                      title="Cancel"
                      onClick={() => setRenameValue(null)}
                    >
                      <X size={16} />
                    </ControlButton>
                  </>
                ) : (
                  <h2
                    className="truncate text-xl font-bold text-text-primary"
                    style={{ fontStretch: "expanded" }}
                  >
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
              <p className="mt-0.5 text-sm text-text-secondary">{selected.description}</p>
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
                  className="mt-1 inline-block font-mono text-xs text-text-muted"
                >
                  /skill:{selected.name}
                </code>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!isReadOnlyScope(selected.scope) ? (
                <ControlButton
                  data-testid="skill-rename"
                  className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                  onClick={() => setRenameValue(selected.name)}
                >
                  <Tag size={12} />
                  Rename
                </ControlButton>
              ) : null}
              <ControlButton
                data-testid="skill-disable"
                className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                onClick={() => void setSkillDisabled(selected.name, !selected.disabled)}
              >
                {selected.disabled ? <Power size={12} /> : <PowerOff size={12} />}
                {selected.disabled ? "Enable" : "Disable"}
              </ControlButton>
              {!isReadOnlyScope(selected.scope) ? (
                <>
                  <ControlButton
                    data-testid="skill-edit"
                    className="flex items-center gap-1.5 rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule"
                    style={{
                      background:
                        "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                      color: "var(--color-accent-foreground)",
                    }}
                    onClick={() => setEditing(editDraft(selected))}
                  >
                    <Pencil size={12} />
                    Edit SKILL.md
                  </ControlButton>
                  <ControlButton
                    data-testid="skill-delete"
                    className="rounded-capsule border border-border-strong p-1.5 text-text-muted hover:text-danger"
                    title="Delete skill"
                    onClick={() => {
                      if (confirm(`Delete skill "${selected.name}"? This removes its SKILL.md.`)) {
                        void deleteSkill(selected.scope, selected.name);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </ControlButton>
                </>
              ) : null}
            </div>
          </div>

          <div className="mt-5 space-y-4">
            <AssignmentCard skill={selected} />
            <div className="rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3">
              <div className="pb-2 text-micro font-semibold uppercase tracking-wider text-text-muted">
                SKILL.md
              </div>
              <MarkdownDocument source={selected.body || "_(empty)_"} />
            </div>
            <div className="truncate text-xs text-text-muted" title={selected.filePath}>
              {selected.filePath}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
          Select a skill.
        </div>
      )}

      {editing ? <SkillEditSheet draft={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
