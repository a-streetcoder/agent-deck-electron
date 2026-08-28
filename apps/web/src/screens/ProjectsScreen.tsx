import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscoveredProject, ProjectMeta } from "@agent-deck/contracts";
import {
  EyeOff,
  ImagePlus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { AppSwitch } from "@/design-system/components/AppSwitch";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { IconButton } from "@/design-system/components/IconButton";
import { PageShell } from "@/design-system/components/PageShell";
import { PageToolbar } from "@/design-system/components/PageToolbar";
import { SectionHero, SectionHeroButton } from "@/design-system/components/SectionHero";
import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { chooseDirectory, isElectron } from "@/lib/native";
import { ProjectImage } from "../components/ProjectImage.tsx";
import { ProjectTypeIcon } from "../components/ProjectTypeIcon.tsx";
import { useAppStore } from "../state/store.ts";
import { addProject, refreshProjects, updateProject } from "../state/wsBridge.ts";

type Filter = "all" | "available" | "unavailable";

const PROJECT_FILTERS = [
  { id: "all" as const, label: "All", "data-testid": "project-filter-all" },
  { id: "available" as const, label: "Available", "data-testid": "project-filter-enabled" },
  {
    id: "unavailable" as const,
    label: "Unavailable",
    "data-testid": "project-filter-disabled",
  },
];

function isAvailable(project: ProjectMeta): boolean {
  return project.enabled !== false;
}

function assignmentSummary(project: ProjectMeta): string {
  const parts: string[] = [];
  if (project.defaultAgentName) parts.push(`Default: ${project.defaultAgentName}`);
  const agents = project.assignedAgentNames?.length ?? 0;
  const skills = project.assignedSkills?.length ?? 0;
  const prompts = project.assignedPrompts?.length ?? 0;
  if (agents) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (skills) parts.push(`${skills} skill${skills === 1 ? "" : "s"}`);
  if (prompts) parts.push(`${prompts} prompt${prompts === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "No custom assignments";
}

function AddProjectsDialog({ onClose }: { onClose: () => void }) {
  const setError = useAppStore((state) => state.setError);
  const [roots, setRoots] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredProject[]>([]);
  const [rootDraft, setRootDraft] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [scanning, setScanning] = useState(true);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const response = await fetch("/projects/discovery");
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { roots: string[]; discovered: DiscoveredProject[] };
      setRoots(data.roots);
      setDiscovered(data.discovered);
    } catch (error) {
      setError(String(error));
    } finally {
      setScanning(false);
    }
  }, [setError]);

  useEffect(() => {
    void scan();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, scan]);

  const postRoot = async (root: string) => {
    const response = await fetch("/projects/discovery/roots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
    if (!response.ok) throw new Error(await response.text());
  };

  const addRoot = async (root: string) => {
    try {
      await postRoot(root);
      setRootDraft("");
      await scan();
    } catch (error) {
      setError(String(error));
    }
  };

  const browseRoots = async () => {
    const picked = await chooseDirectory({
      title: "Choose Projects Folder",
      message: "Choose one or more parent folders that contain your projects",
      multiple: true,
    });
    try {
      for (const root of picked) await postRoot(root);
      if (picked.length) await scan();
    } catch (error) {
      setError(String(error));
    }
  };

  const chooseProject = async () => {
    if (isElectron()) {
      const [picked] = await chooseDirectory({
        title: "Choose Project Folder",
        message: "Choose a repo or project root to add",
      });
      if (picked) await addProject(picked);
    } else if (projectDraft.trim()) {
      await addProject(projectDraft.trim());
      setProjectDraft("");
    }
    await scan();
  };

  const removeRoot = async (root: string) => {
    const response = await fetch("/projects/discovery/roots", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root }),
    });
    if (!response.ok) setError(await response.text());
    await scan();
  };

  const candidates = discovered.filter((project) => !project.registered);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-3 py-4 sm:px-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-projects-title"
        data-testid="add-projects-dialog"
        className="flex max-h-[min(88vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-elevated"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-4 py-3 sm:px-5">
          <div>
            <h2 id="add-projects-title" className="text-title font-semibold text-text-primary">
              Add Projects
            </h2>
            <p className="mt-0.5 text-caption text-text-muted">
              Choose a folder directly or add projects found in monitored folders.
            </p>
          </div>
          <IconButton
            autoFocus
            aria-label="Close Add Projects"
            size="md"
            icon={<X />}
            onClick={onClose}
          />
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">
          <section>
            <h3 className="text-label font-semibold text-text-primary">Choose a project</h3>
            <div className="mt-2 flex min-w-0 gap-2">
              {!isElectron() ? (
                <AppTextField
                  data-testid="projects-add-path"
                  size="sm"
                  className="min-w-0 flex-1 font-mono text-code"
                  placeholder="/path/to/project"
                  value={projectDraft}
                  onChange={setProjectDraft}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void chooseProject();
                  }}
                />
              ) : null}
              <Button
                data-testid={isElectron() ? "choose-project-folder" : "projects-add-confirm"}
                size="sm"
                variant="primary"
                disabled={!isElectron() && !projectDraft.trim()}
                onClick={() => void chooseProject()}
              >
                <Plus size={14} /> Choose Project Folder…
              </Button>
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-label font-semibold text-text-primary">Discovered projects</h3>
                <p className="text-caption text-text-muted">From your monitored folders</p>
              </div>
              <Button
                data-testid="discovery-rescan"
                size="sm"
                variant="ghost"
                leadingIcon={
                  <RefreshCw size={12} className={scanning ? "animate-spin" : undefined} />
                }
                disabled={scanning}
                onClick={() => void scan()}
              >
                Rescan
              </Button>
            </div>

            <div
              className="mt-2 overflow-hidden rounded-xl border border-border-subtle"
              data-testid="discovery-results"
            >
              {scanning ? (
                <div className="px-3 py-6 text-center text-detail text-text-muted">Scanning…</div>
              ) : candidates.length ? (
                <div className="divide-y divide-border-subtle">
                  {candidates.map((candidate) => (
                    <div
                      key={candidate.path}
                      data-testid="discovery-candidate"
                      data-candidate-name={candidate.name}
                      className="flex min-h-14 items-center gap-3 px-3 py-2"
                    >
                      <ProjectTypeIcon
                        type={candidate.type}
                        size={17}
                        className="shrink-0 text-text-secondary"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-label font-medium text-text-primary">
                            {candidate.name}
                          </span>
                          <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
                            {candidate.type}
                          </span>
                        </div>
                        <div
                          className="truncate font-mono text-detail text-text-muted"
                          title={candidate.path}
                        >
                          {candidate.path}
                        </div>
                      </div>
                      <Button
                        data-testid={`discovery-add-${candidate.name}`}
                        size="sm"
                        onClick={() => void addProject(candidate.path).then(scan)}
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-3 py-6 text-center text-detail text-text-muted">
                  {roots.length
                    ? "No new projects found."
                    : "Add a monitored folder to discover projects."}
                </div>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-label font-semibold text-text-primary">Monitored folders</h3>
            <div className="mt-2 flex gap-2">
              {isElectron() ? (
                <Button
                  data-testid="discovery-root-browse"
                  size="sm"
                  onClick={() => void browseRoots()}
                >
                  Choose Folder…
                </Button>
              ) : (
                <>
                  <ControlInput
                    data-testid="discovery-root-input"
                    className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent"
                    placeholder="/path/to/dev/folder"
                    value={rootDraft}
                    onChange={(event) => setRootDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && rootDraft.trim()) void addRoot(rootDraft.trim());
                    }}
                  />
                  <Button
                    data-testid="discovery-root-add"
                    size="sm"
                    disabled={!rootDraft.trim()}
                    onClick={() => void addRoot(rootDraft.trim())}
                  >
                    Add folder
                  </Button>
                </>
              )}
            </div>
            {roots.length ? (
              <div className="mt-2 space-y-1.5">
                {roots.map((root) => (
                  <div
                    key={root}
                    data-testid="discovery-root-chip"
                    className="flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-detail text-text-secondary"
                      title={root}
                    >
                      {root}
                    </span>
                    <IconButton
                      aria-label={`Stop monitoring ${root}`}
                      size="sm"
                      variant="destructive"
                      icon={<Trash2 />}
                      onClick={() => void removeRoot(root)}
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

export function ProjectsScreen() {
  const projects = useAppStore((state) => state.projects);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const setError = useAppStore((state) => state.setError);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [imageProject, setImageProject] = useState<ProjectMeta | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visible = projects.filter((project) => {
    const available = isAvailable(project);
    const matchesFilter = filter === "all" || (filter === "available" ? available : !available);
    const matchesSearch =
      !normalizedSearch ||
      project.name.toLocaleLowerCase().includes(normalizedSearch) ||
      project.path.toLocaleLowerCase().includes(normalizedSearch);
    return matchesFilter && matchesSearch;
  });

  const hide = async (project: ProjectMeta) => {
    const response = await fetch(`/projects/${encodeURIComponent(project.id)}`, {
      method: "DELETE",
    });
    if (!response.ok) setError(await response.text());
    await refreshProjects();
  };

  const chooseImage = (project: ProjectMeta) => {
    setImageProject(project);
    setMenuProjectId(null);
    imageInput.current?.click();
  };

  const uploadImage = async (file: File) => {
    if (!imageProject) return;
    try {
      if (file.size > 15_000_000) throw new Error("Choose an image no larger than 15 MB.");
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
        throw new Error("Choose a PNG, JPEG, or WebP image.");
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("The image could not be read."));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const response = await fetch(`/projects/${encodeURIComponent(imageProject.id)}/image`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimeType: file.type, data: url.slice(url.indexOf(",") + 1) }),
      });
      if (!response.ok) throw new Error(await response.text());
      await refreshProjects();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageProject(null);
      if (imageInput.current) imageInput.current.value = "";
    }
  };

  const removeImage = async (project: ProjectMeta) => {
    setMenuProjectId(null);
    const response = await fetch(`/projects/${encodeURIComponent(project.id)}/image`, {
      method: "DELETE",
    });
    if (!response.ok) setError(await response.text());
    await refreshProjects();
  };

  return (
    <PageShell
      width="page"
      testId="projects-screen"
      hero={
        <SectionHero
          imageSrc="/screen-art/screen-art-projects.jpg"
          title="Projects"
          subtitle="Manage the folders Agent Deck can use"
          actions={
            <SectionHeroButton
              data-testid="projects-add"
              variant="primary"
              onClick={() => setAddOpen(true)}
            >
              <Plus size={13} /> Add Projects…
            </SectionHeroButton>
          }
        />
      }
      toolbar={
        <PageToolbar
          className="sticky top-0"
          leading={
            <>
              <AppTextField
                data-testid="projects-search"
                size="sm"
                className="min-w-48 flex-1 sm:max-w-sm"
                leadingIcon={<Search aria-hidden />}
                aria-label="Search projects"
                placeholder="Search projects"
                value={search}
                onChange={setSearch}
                showClear
                clearLabel="Clear project search"
              />
              <AppSegmentedPicker
                size="sm"
                aria-label="Filter projects"
                options={PROJECT_FILTERS}
                value={filter}
                onChange={setFilter}
              />
            </>
          }
        />
      }
    >
      <ControlInput
        ref={imageInput}
        type="file"
        className="sr-only"
        accept="image/png,image/jpeg,image/webp"
        aria-label="Choose project image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void uploadImage(file);
        }}
      />

      {visible.length ? (
        <div
          className="overflow-visible rounded-xl border border-border-subtle bg-surface"
          data-testid="projects-list"
        >
          <div className="divide-y divide-border-subtle">
            {visible.map((project) => {
              const available = isAvailable(project);
              const current = project.id === currentProjectId;
              const menuOpen = menuProjectId === project.id;
              return (
                <div
                  key={project.id}
                  data-testid="project-row"
                  data-project-name={project.name}
                  className="relative flex min-h-16 items-center gap-3 px-3 py-2 sm:px-4"
                >
                  <ProjectImage project={project} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-label font-semibold text-text-primary">
                        {project.name}
                      </span>
                      {current ? (
                        <span
                          data-testid="project-active-tag"
                          className="shrink-0 rounded-capsule border border-accent px-1.5 text-micro font-medium text-accent"
                        >
                          Current
                        </span>
                      ) : null}
                      {project.type && project.type !== "unknown" && project.type !== "git" ? (
                        <span
                          data-testid="project-type-badge"
                          className="hidden shrink-0 rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted sm:inline"
                        >
                          {project.type}
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
                  <div
                    className="hidden min-w-0 max-w-[32%] flex-1 truncate text-right text-detail text-text-secondary lg:block"
                    title={assignmentSummary(project)}
                  >
                    {assignmentSummary(project)}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-detail text-text-secondary md:inline">
                      {available ? "Available" : "Unavailable"}
                    </span>
                    <span title={current ? "Can't change the current project" : undefined}>
                      <AppSwitch
                        checked={available}
                        disabled={current}
                        data-testid={`project-enabled-${project.name}`}
                        aria-label={`Make ${project.name} available for new sessions`}
                        onCheckedChange={(next) =>
                          void updateProject(project.id, { enabled: next })
                        }
                      />
                    </span>
                  </div>
                  <div className="relative shrink-0">
                    <IconButton
                      data-testid={`project-actions-${project.name}`}
                      aria-label={`Actions for ${project.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      size="sm"
                      icon={<MoreHorizontal />}
                      onClick={() => setMenuProjectId(menuOpen ? null : project.id)}
                    />
                    {menuOpen ? (
                      <div
                        role="menu"
                        className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-border-strong bg-surface-elevated p-1 shadow-elevated"
                      >
                        <ControlButton
                          role="menuitem"
                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-label text-text-secondary hover:bg-hover hover:text-text-primary"
                          onClick={() => chooseImage(project)}
                        >
                          <ImagePlus size={14} />{" "}
                          {project.imageUrl ? "Replace Image" : "Choose Image"}
                        </ControlButton>
                        {project.imageUrl ? (
                          <ControlButton
                            role="menuitem"
                            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-label text-text-secondary hover:bg-hover hover:text-danger"
                            onClick={() => void removeImage(project)}
                          >
                            <Trash2 size={14} /> Remove Image
                          </ControlButton>
                        ) : null}
                        <ControlButton
                          role="menuitem"
                          data-testid={`project-hide-${project.name}`}
                          disabled={current}
                          title={current ? "Can't hide the current project" : undefined}
                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-label text-text-secondary hover:bg-hover hover:text-danger disabled:opacity-40"
                          onClick={() => void hide(project)}
                        >
                          <EyeOff size={14} /> Hide
                        </ControlButton>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <AppEmptyState
          heading={projects.length === 0 ? "No projects yet" : "No matching projects"}
          body={
            projects.length === 0
              ? "Add a project folder to get started."
              : "Try another search or availability filter."
          }
        />
      )}

      {addOpen ? <AddProjectsDialog onClose={() => setAddOpen(false)} /> : null}
    </PageShell>
  );
}
