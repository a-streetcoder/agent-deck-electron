import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { AppSwitch } from "@/design-system/components/AppSwitch";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { IconButton } from "@/design-system/components/IconButton";
import { PageShell } from "@/design-system/components/PageShell";
import { PageToolbar } from "@/design-system/components/PageToolbar";
import { SectionHero } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useState } from "react";
import {
  EyeOff,
  Github,
  Plus,
  RefreshCw,
  Search,
  Send,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import type { DiscoveredProject, ProjectMeta } from "@agent-deck/contracts";
import { cn } from "@/lib/cn";
import { chooseDirectory, isElectron } from "@/lib/native";
import { ProjectTypeIcon } from "../components/ProjectTypeIcon.tsx";
import { useAppStore } from "../state/store.ts";
import { addProject, refreshProjects, updateProject } from "../state/wsBridge.ts";

/**
 * Native ProjectsScreen (ProjectViews.swift): a scrollable page with one
 * "Library" card — segmented All/Enabled/Disabled filter, helper caption,
 * then radius-14 project rows: icon, expanded-width name, "Active" accent
 * tag, mono middle-truncated path, Enabled switch, recap glyph buttons,
 * and a destructive hide button. Disabled rows dim.
 */

type Filter = "all" | "enabled" | "disabled";

function isEnabled(project: ProjectMeta): boolean {
  return project.enabled !== false;
}

function RecapButton({
  icon: Icon,
  title,
  count,
}: {
  icon: typeof Send;
  title: string;
  count: number;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-capsule border border-border-subtle px-2 py-0.5 text-detail",
        count > 0 ? "text-text-secondary" : "text-text-muted opacity-50",
      )}
      title={`${title}: ${count}`}
    >
      <Icon size={11} />
      {count}
    </span>
  );
}

function DiscoveryPanel() {
  const setError = useAppStore((state) => state.setError);
  const [roots, setRoots] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredProject[]>([]);
  const [rootDraft, setRootDraft] = useState("");
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      const response = await fetch("/projects/discovery");
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { roots: string[]; discovered: DiscoveredProject[] };
      setRoots(data.roots);
      setDiscovered(data.discovered);
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }, [setError]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const postRoot = async (root: string): Promise<boolean> => {
    const response = await fetch("/projects/discovery/roots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
    if (!response.ok) {
      setError(await response.text());
      return false;
    }
    return true;
  };

  const addRoot = async (): Promise<void> => {
    const root = rootDraft.trim();
    if (!root) return;
    if (await postRoot(root)) {
      setRootDraft("");
      await scan();
    }
  };

  // Desktop: pick one or more parent folders with the native chooser.
  const browseRoots = async (): Promise<void> => {
    const picked = await chooseDirectory({
      title: "Choose Projects Folder",
      message: "Choose one or more parent folders that contain your projects",
      multiple: true,
    });
    let any = false;
    for (const root of picked) any = (await postRoot(root)) || any;
    if (any) await scan();
  };

  const removeRoot = async (root: string): Promise<void> => {
    await fetch("/projects/discovery/roots", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    }).catch(() => {});
    await scan();
  };

  const unregistered = discovered.filter((d) => !d.registered);

  return (
    <Card className="mb-4 rounded-2xl" padding="md">
      <div className="flex items-center justify-between pb-1">
        <div className="flex items-center gap-2">
          <Search size={15} className="text-text-secondary" />
          <h3 className="text-label font-semibold text-text-primary">Discover</h3>
        </div>
        <ControlButton
          data-testid="discovery-rescan"
          className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-0.5 text-detail text-text-secondary hover:text-text-primary disabled:opacity-40"
          disabled={scanning}
          onClick={() => void scan()}
        >
          <RefreshCw size={11} className={scanning ? "animate-spin" : undefined} />
          Rescan
        </ControlButton>
      </div>
      <p className="pb-2 text-caption text-text-muted">
        Scan folders for git repos and known project types, then add them with one click.
      </p>

      <div className="flex gap-2 pb-2">
        {isElectron() ? (
          <ControlButton
            data-testid="discovery-root-browse"
            className="rounded-capsule border border-border-strong px-3 py-1.5 text-detail text-text-secondary hover:text-text-primary"
            onClick={() => void browseRoots()}
          >
            Choose folder…
          </ControlButton>
        ) : (
          <>
            <ControlInput
              data-testid="discovery-root-input"
              className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
              placeholder="/path/to/dev/folder"
              value={rootDraft}
              onChange={(e) => setRootDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addRoot();
              }}
            />
            <ControlButton
              data-testid="discovery-root-add"
              className="rounded-capsule border border-border-strong px-3 py-1.5 text-detail text-text-secondary hover:text-text-primary disabled:opacity-40"
              disabled={!rootDraft.trim()}
              onClick={() => void addRoot()}
            >
              Add root
            </ControlButton>
          </>
        )}
      </div>

      {roots.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {roots.map((root) => (
            <span
              key={root}
              data-testid="discovery-root-chip"
              className="flex items-center gap-1 rounded-capsule border border-border-subtle bg-surface px-2 py-0.5 font-mono text-detail text-text-secondary"
            >
              {root}
              <ControlButton
                className="text-text-muted hover:text-danger"
                title="Remove root"
                onClick={() => void removeRoot(root)}
              >
                <X size={11} />
              </ControlButton>
            </span>
          ))}
        </div>
      ) : null}

      <div className="space-y-1" data-testid="discovery-results">
        {unregistered.map((candidate) => (
          <div
            key={candidate.path}
            className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-1.5"
            data-testid="discovery-candidate"
            data-candidate-name={candidate.name}
          >
            <ProjectTypeIcon
              type={candidate.type}
              size={15}
              className="shrink-0 text-text-secondary"
            />
            <span className="text-label font-medium text-text-primary">{candidate.name}</span>
            <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
              {candidate.type}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-detail text-text-muted">
              {candidate.path}
            </span>
            <ControlButton
              data-testid={`discovery-add-${candidate.name}`}
              className="rounded-capsule bg-primary px-2.5 py-0.5 text-detail font-medium text-on-accent shadow-capsule hover:bg-primary-hover"
              onClick={() => void addProject(candidate.path).then(() => void scan())}
            >
              Add
            </ControlButton>
          </div>
        ))}
        {roots.length > 0 && unregistered.length === 0 ? (
          <div className="py-2 text-center text-detail text-text-muted">
            No new projects found under the configured roots.
          </div>
        ) : null}
        {roots.length === 0 ? (
          <div className="py-2 text-center text-detail text-text-muted">
            Add a root folder above to discover projects.
          </div>
        ) : null}
      </div>
    </Card>
  );
}

const PROJECT_FILTERS = [
  { id: "all" as const, label: "All", "data-testid": "project-filter-all" },
  { id: "enabled" as const, label: "Enabled", "data-testid": "project-filter-enabled" },
  { id: "disabled" as const, label: "Disabled", "data-testid": "project-filter-disabled" },
];

export function ProjectsScreen() {
  const projects = useAppStore((state) => state.projects);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const [filter, setFilter] = useState<Filter>("enabled");
  const [draftPath, setDraftPath] = useState("");
  const [adding, setAdding] = useState(false);

  const visible = projects.filter((project) =>
    filter === "all" ? true : filter === "enabled" ? isEnabled(project) : !isEnabled(project),
  );

  const hide = async (project: ProjectMeta): Promise<void> => {
    await fetch(`/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" }).catch(
      () => {},
    );
    await refreshProjects();
  };

  // Desktop uses the native folder chooser; browser toggles the path input.
  const startAdd = async (): Promise<void> => {
    if (isElectron()) {
      const [picked] = await chooseDirectory({
        title: "Add Project",
        message: "Choose a repo or project root to add",
      });
      if (picked) await addProject(picked);
      return;
    }
    setAdding((v) => !v);
  };

  return (
    <PageShell
      width="page"
      testId="projects-screen"
      hero={
        <SectionHero
          imageSrc="/screen-art/screen-art-projects.jpg"
          title="Projects"
          actions={
            <IconButton
              data-testid="projects-add"
              aria-label="Add project"
              title="Add project"
              icon={<Plus />}
              variant="primary"
              size="sm"
              shape="circle"
              onClick={() => void startAdd()}
            />
          }
        />
      }
      toolbar={
        <PageToolbar
          leading={
            <AppSegmentedPicker
              size="sm"
              aria-label="Filter projects"
              options={PROJECT_FILTERS}
              value={filter}
              onChange={setFilter}
            />
          }
          below={
            <p className="text-caption text-text-muted">
              Registered project folders. Disabled projects are hidden from the sidebar and can't
              host new sessions; hiding removes the entry without touching files.
            </p>
          }
        />
      }
    >
        <DiscoveryPanel />

          {adding ? (
            <div className="mb-3 flex gap-2">
              <AppTextField
                autoFocus
                data-testid="projects-add-path"
                size="sm"
                className="font-mono text-code"
                placeholder="/path/to/project"
                value={draftPath}
                onChange={setDraftPath}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && draftPath.trim()) {
                    void addProject(draftPath.trim()).then(() => {
                      setDraftPath("");
                      setAdding(false);
                    });
                  }
                  if (event.key === "Escape") setAdding(false);
                }}
              />
              <Button
                data-testid="projects-add-confirm"
                size="sm"
                variant="primary"
                disabled={!draftPath.trim()}
                onClick={() =>
                  void addProject(draftPath.trim()).then(() => {
                    setDraftPath("");
                    setAdding(false);
                  })
                }
              >
                Add
              </Button>
            </div>
          ) : null}

          <div className="space-y-2">
            {visible.map((project) => {
              const enabled = isEnabled(project);
              const active = project.id === currentProjectId;
              return (
                <div
                  key={project.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5",
                    !enabled && "opacity-60 saturate-50",
                  )}
                  data-testid="project-row"
                  data-project-name={project.name}
                >
                  <ProjectTypeIcon
                    type={project.type}
                    size={20}
                    className="shrink-0 text-text-secondary"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-label font-semibold text-text-primary">
                        {project.name}
                      </span>
                      {project.type && project.type !== "unknown" && project.type !== "git" ? (
                        <span
                          className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
                          data-testid="project-type-badge"
                        >
                          {project.type}
                        </span>
                      ) : null}
                      {project.path.includes("github") ? <Github size={12} /> : null}
                      {active ? (
                        <span
                          className="rounded-capsule border px-1.5 py-0 text-micro font-medium"
                          style={{
                            color: "var(--color-brand-accent)",
                            borderColor: "var(--color-brand-accent)",
                          }}
                          data-testid="project-active-tag"
                        >
                          Active
                        </span>
                      ) : null}
                    </div>
                    <div
                      className="truncate font-mono text-detail text-text-muted"
                      style={{ direction: "rtl", textAlign: "left" }}
                      title={project.path}
                    >
                      {project.path}
                    </div>
                  </div>
                  <RecapButton
                    icon={Send}
                    title="Active-session default agent"
                    count={project.defaultAgentName ? 1 : 0}
                  />
                  <RecapButton
                    icon={Users}
                    title={
                      project.assignedAgentNames === undefined
                        ? "Assigned agents (legacy open catalog)"
                        : "Assigned custom agents"
                    }
                    count={project.assignedAgentNames?.length ?? 0}
                  />
                  <RecapButton
                    icon={WandSparkles}
                    title="Assigned skills"
                    count={project.assignedSkills?.length ?? 0}
                  />
                  {/* The active session's project can't be disabled or hidden. */}
                  <span title={active ? "Can't change the active project" : undefined}>
                    <AppSwitch
                      checked={enabled}
                      disabled={active}
                      data-testid={`project-enabled-${project.name}`}
                      aria-label={`Enable ${project.name}`}
                      onCheckedChange={(next) => void updateProject(project.id, { enabled: next })}
                    />
                  </span>
                  <ControlButton
                    data-testid={`project-hide-${project.name}`}
                    className="rounded-capsule p-1.5 text-text-muted hover:text-danger disabled:opacity-30 disabled:hover:text-text-muted"
                    title={active ? "Can't hide the active project" : "Hide from list"}
                    disabled={active}
                    onClick={() => void hide(project)}
                  >
                    <EyeOff size={14} />
                  </ControlButton>
                </div>
              );
            })}
            {visible.length === 0 ? (
              <AppEmptyState
                heading={filter === "all" ? "No projects" : "No matches"}
                body={filter === "all" ? "Add one with +." : `No ${filter} projects.`}
              />
            ) : null}
          </div>
    </PageShell>
  );
}
