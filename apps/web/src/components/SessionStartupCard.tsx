import { ControlInput, ControlSelect } from "../design-system/components/NativeControls.tsx";
import { useState } from "react";
import { updateSessionDraft } from "../state/wsBridge.ts";
import { Folder, WandSparkles } from "lucide-react";
import { useAppStore } from "../state/store.ts";

/**
 * Pre-launch surface shown in an empty session (native PiAgentStartupViews):
 * instead of a blank transcript, preview what this draft will run with — the
 * agent, the project cwd, and the skills assigned to that project. The
 * interactive launch controls (model / thinking / agent) live in the composer
 * below.
 */
export function SessionStartupCard() {
  const [saving, setSaving] = useState(false);
  const currentAgentName = useAppStore((state) => state.currentAgentName);
  const projects = useAppStore((state) => state.projects);
  const session = useAppStore((state) => state.session);

  const update = async (patch: Parameters<typeof updateSessionDraft>[0]) => {
    setSaving(true);
    try {
      await updateSessionDraft(patch);
    } finally {
      setSaving(false);
    }
  };
  const project = projects.find((p) => p.id === session?.projectId) ?? null;
  const agentName = currentAgentName ?? session?.agentName ?? "Pi Agent";
  const projectName = project?.name ?? "All Projects";
  const skills = project?.assignedSkills ?? [];

  return (
    <div className="mx-auto mt-12 w-full max-w-md" data-testid="session-startup">
      <div className="rounded-2xl border border-border-subtle bg-surface-elevated p-5 shadow-card">
        <div className="text-micro font-medium text-text-muted">New session</div>
        <h2
          className="mt-1 text-title font-semibold tracking-title text-text-primary"
          data-testid="startup-agent"
        >
          {agentName}
        </h2>
        <p className="mt-1 text-body text-text-muted">
          Send a message below to launch. It will run with:
        </p>

        {session?.lifecycle === "draft" ? (
          <div className="mt-4 space-y-3 text-label">
            <label className="block text-text-muted">
              Project
              <ControlSelect
                aria-label="Draft project"
                disabled={saving}
                value={session.projectId ?? ""}
                className="mt-1 block w-full rounded border border-border-subtle bg-surface p-2 text-text-primary"
                onChange={(event) =>
                  void update({
                    projectId: event.target.value || null,
                    agentName:
                      projects.find((item) => item.id === event.target.value)?.defaultAgentName ??
                      null,
                  })
                }
              >
                <option value="">No project</option>
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </ControlSelect>
            </label>
            <label className="flex items-center gap-2 text-text-secondary">
              <ControlInput
                type="checkbox"
                aria-label="Isolate draft in a worktree"
                disabled={saving || !session.projectId}
                checked={session.draftWorktreeIsolation ?? false}
                onChange={(event) => void update({ worktreeIsolation: event.target.checked })}
              />
              Use a separate Git worktree
            </label>
            <p className="text-detail text-text-muted">
              Drafts are saved automatically on this device. Pi and the worktree start when you send
              your first message.
            </p>
          </div>
        ) : null}

        <dl className="mt-4 space-y-3 text-label">
          <div className="flex items-start justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-text-muted">
              <Folder size={13} aria-hidden /> Project
            </dt>
            <dd className="min-w-0 text-right">
              <div className="truncate font-medium text-text-primary">{projectName}</div>
              {session?.cwd ? (
                <div
                  className="truncate font-mono text-detail text-text-muted"
                  data-testid="startup-cwd"
                >
                  {session.cwd}
                </div>
              ) : null}
            </dd>
          </div>

          <div className="flex items-start justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-text-muted">
              <WandSparkles size={13} aria-hidden /> Skills
            </dt>
            <dd
              className="flex max-w-[70%] flex-wrap justify-end gap-1.5"
              data-testid="startup-skills"
            >
              {skills.length > 0 ? (
                skills.map((skill) => (
                  <span
                    key={skill}
                    className="rounded-capsule border border-border-subtle bg-surface px-2 py-0.5 text-detail text-text-secondary"
                  >
                    {skill}
                  </span>
                ))
              ) : (
                <span className="text-text-muted">None assigned</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
