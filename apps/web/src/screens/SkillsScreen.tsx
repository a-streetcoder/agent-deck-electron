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

/** A git-imported skill repo (native ImportedSkillRepository), for re-sync. */
interface SkillRepo {
  id: string;
  remoteUrl: string;
  ref?: string;
  storageMode?: "collection-v1";
  skillNames: string[];
  lastSyncedCommit: string;
  importedAt: string;
}
import { MarkdownDocument } from "@/design-system/markdown/MarkdownDocument";
import { useAppStore } from "../state/store.ts";
import { deleteSkill, renameSkill, setSkillDisabled, updateProject } from "../state/wsBridge.ts";
import { ScopeChip } from "../components/ScopeChip.tsx";

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
  const [repoBusy, setRepoBusy] = useState<Record<string, "update" | "forget">>({});
  const repoBusyRef = useRef(new Map<string, "update" | "forget">());
  // Per-repo unresolved conflicts (skills the user edited locally that an update
  // held back rather than overwriting) — native Keep Mine / Take Remote.
  const [conflicts, setConflicts] = useState<Record<string, string[]>>({});
  const [resolvingConflicts, setResolvingConflicts] = useState<Record<string, "mine" | "remote">>(
    {},
  );
  const resolvingConflictsRef = useRef(new Set<string>());
  const conflictActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const repoUpdateRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
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
        const data = (await response.json()) as { skills: SkillInfo[] };
        if (!cancelled) setSkills(data.skills);
      } catch (error) {
        if (!cancelled) setGlobalError(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentProjectId, resourcesVersion, setGlobalError]);

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

  const doGitImport = async (): Promise<void> => {
    const url = (gitUrl ?? "").trim();
    if (!url) return;
    setGitImporting(true);
    try {
      const res = await fetch("/resources/skills/import-git", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "global", url }),
      });
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? "Couldn't import from that repository.");
      }
      setGitUrl(null); // the imported skills arrive via the resources_changed refetch
    } catch (err) {
      setGlobalError(String(err));
    } finally {
      setGitImporting(false);
    }
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
        for (const repo of data.repos) {
          void (async () => {
            try {
              const checkResponse = await fetch(`/resources/skill-repos/${repo.id}/check`, {
                method: "POST",
              });
              if (!checkResponse.ok) {
                throw new Error(
                  await responseErrorMessage(
                    checkResponse,
                    `Couldn't check ${repo.remoteUrl} for updates (${checkResponse.status}). Retry by reloading.`,
                  ),
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

  const updateRepo = async (id: string): Promise<void> => {
    if (repoBusyRef.current.has(id)) return;
    repoBusyRef.current.set(id, "update");
    setRepoBusy((current) => ({ ...current, [id]: "update" }));
    try {
      const res = await fetch(`/resources/skill-repos/${id}/update`, { method: "POST" });
      if (!res.ok) throw new Error(await responseErrorMessage(res));
      const data = (await res.json()) as { conflicts?: string[] };
      // Clear the badge; the resources_changed broadcast refetches the skills.
      setUpdatable((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Surface any locally-edited skills the update held back.
      setConflicts((prev) => {
        const next = { ...prev };
        if (data.conflicts && data.conflicts.length > 0) next[id] = data.conflicts;
        else delete next[id];
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

  const resolveConflict = async (
    id: string,
    name: string,
    resolution: "mine" | "remote",
  ): Promise<void> => {
    const key = `${id}\0${name}`;
    if (resolvingConflictsRef.current.has(key)) return;
    const actionKey = `${key}\0${resolution}`;
    const invokedAction = conflictActionRefs.current.get(actionKey);
    const ownedFocus = invokedAction !== undefined && document.activeElement === invokedAction;
    const focusStillOnAction = (): boolean =>
      ownedFocus && document.activeElement === invokedAction;
    const focusMayBeRestored = (): boolean =>
      focusStillOnAction() || (ownedFocus && document.activeElement === document.body);
    resolvingConflictsRef.current.add(key);
    setResolvingConflicts((current) => ({ ...current, [key]: resolution }));
    try {
      const res = await fetch(`/resources/skill-repos/${id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, resolution }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res));
      let nextName: string | undefined;
      setConflicts((previous) => {
        const currentNames = previous[id] ?? [];
        const removedIndex = currentNames.indexOf(name);
        const remaining = currentNames.filter((candidate) => candidate !== name);
        nextName =
          removedIndex >= 0
            ? (remaining[removedIndex] ?? remaining[Math.max(0, removedIndex - 1)])
            : remaining[0];
        const next = { ...previous };
        if (remaining.length > 0) next[id] = remaining;
        else delete next[id];
        return next;
      });
      requestAnimationFrame(() => {
        if (!focusMayBeRestored()) return;
        const primary = nextName
          ? conflictActionRefs.current.get(`${id}\0${nextName}\0mine`)
          : undefined;
        if (primary && !primary.disabled) primary.focus();
        else repoUpdateRefs.current.get(id)?.focus();
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setGlobalError(`Couldn't resolve ${name}. ${detail} Try again.`);
      requestAnimationFrame(() => {
        if (!focusMayBeRestored()) return;
        conflictActionRefs.current.get(actionKey)?.focus();
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
            title="Import a local .md file as a skill"
            onClick={() => setImportPath((v) => (v === null ? "" : null))}
          >
            <FolderInput size={15} />
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
                if (event.key === "Enter") void doGitImport();
                if (event.key === "Escape") setGitUrl(null);
              }}
            />
            <ControlButton
              data-testid="skill-import-git-confirm"
              className="rounded-capsule border border-border-strong px-2.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
              disabled={!gitUrl.trim() || gitImporting}
              onClick={() => void doGitImport()}
            >
              {gitImporting ? "Importing…" : "Import"}
            </ControlButton>
          </div>
        ) : null}
        {repos.length > 0 ? (
          <div className="mx-3 mb-2 space-y-1" data-testid="skill-repos">
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
                  {updatable.has(repo.id) ? (
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
                    disabled={repoBusy[repo.id] !== undefined}
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
                    disabled={repoBusy[repo.id] !== undefined}
                    onClick={() => void forgetRepo(repo.id)}
                  >
                    <X size={12} />
                  </ControlButton>
                </div>
                {(conflicts[repo.id] ?? []).length > 0 ? (
                  <div
                    data-testid={`skill-repo-conflicts-${repo.id}`}
                    className="mt-1 space-y-1 rounded-lg border border-warning bg-surface px-2.5 py-1.5"
                  >
                    <div className="text-micro text-text-muted">
                      Local folder changes were kept. Taking remote replaces or deletes the entire
                      skill folder, including assets.
                    </div>
                    {conflicts[repo.id]!.map((name) => {
                      const resolution = resolvingConflicts[`${repo.id}\0${name}`];
                      const conflictBusy = resolution !== undefined;
                      return (
                        <div
                          key={name}
                          className="flex items-center gap-2"
                          aria-busy={conflictBusy}
                        >
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-detail text-text-primary"
                            title={name}
                          >
                            {name}
                          </span>
                          <ControlButton
                            ref={(element) => {
                              const actionKey = `${repo.id}\0${name}\0mine`;
                              if (element) conflictActionRefs.current.set(actionKey, element);
                              else conflictActionRefs.current.delete(actionKey);
                            }}
                            data-conflict-primary="true"
                            data-testid={`skill-conflict-mine-${repo.id}-${name}`}
                            className="rounded-capsule border border-border-strong px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary"
                            aria-label={
                              resolution === "mine"
                                ? `Keeping mine for ${name}…`
                                : `Keep mine for ${name}`
                            }
                            disabled={conflictBusy}
                            onClick={() => void resolveConflict(repo.id, name, "mine")}
                          >
                            {resolution === "mine" ? "Keeping mine…" : "Keep mine"}
                          </ControlButton>
                          <ControlButton
                            ref={(element) => {
                              const actionKey = `${repo.id}\0${name}\0remote`;
                              if (element) conflictActionRefs.current.set(actionKey, element);
                              else conflictActionRefs.current.delete(actionKey);
                            }}
                            data-testid={`skill-conflict-remote-${repo.id}-${name}`}
                            className="rounded-capsule border border-border-strong px-2 py-0.5 text-micro text-text-secondary hover:text-text-primary"
                            title="Replace or delete the entire local skill folder and all assets with the remote version"
                            aria-label={
                              resolution === "remote"
                                ? `Taking remote folder for ${name}…`
                                : `Take remote folder for ${name}; replaces or deletes the entire folder and all assets`
                            }
                            disabled={conflictBusy}
                            onClick={() => void resolveConflict(repo.id, name, "remote")}
                          >
                            {resolution === "remote" ? "Taking remote…" : "Take remote folder"}
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
                {skill.scope !== "library" ? (
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
                </div>
                {skill.scope !== "library" ? (
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
              {selected.scope !== "library" ? (
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
              {selected.scope !== "library" ? (
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
