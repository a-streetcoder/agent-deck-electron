import { AppSwitch } from "../design-system/components/AppSwitch.tsx";
import { Card } from "../design-system/components/Card.tsx";
import { ControlSelect } from "../design-system/components/NativeControls.tsx";
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
  const agentName = currentAgentName ?? session?.agentName ?? "Orchestrator";
  const projectName = project?.name ?? "All Projects";
  const skills = project?.assignedSkills ?? [];

  return (
    <div className="mt-2 w-full" data-testid="session-startup">
      <Card padding="lg" elevated>
        <div className="text-caption font-medium text-text-muted">New session</div>
        <h2
          className="mt-1 text-title font-semibold tracking-title text-text-primary"
          data-testid="startup-agent"
        >
          {agentName}
        </h2>
        <p className="mt-1 text-body text-text-muted">
          Send a message below to launch. It will run with:
        </p>

        <div className={session?.lifecycle === "draft" ? "mt-5 grid gap-6 lg:grid-cols-2" : "mt-5"}>
          {session?.lifecycle === "draft" ? (
            <div className="space-y-4">
              <label className="block text-caption font-medium text-text-secondary">
                Project
                <ControlSelect
                  aria-label="Draft project"
                  disabled={saving}
                  value={session.projectId ?? ""}
                  className="mt-1"
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
              <AppSwitch
                aria-label="Isolate draft in a worktree"
                disabled={saving || !session.projectId}
                checked={session.draftWorktreeIsolation ?? false}
                onCheckedChange={(checked) => void update({ worktreeIsolation: checked })}
              >
                Use a separate Git worktree
              </AppSwitch>
              <p className="text-caption text-text-muted">
                Drafts are saved automatically on this device. Pi and the worktree start when you
                send your first message.
              </p>
            </div>
          ) : null}

          <dl
            className={
              session?.lifecycle === "draft"
                ? "space-y-3 border-t border-border-subtle pt-5 text-label lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"
                : "space-y-3 text-label"
            }
          >
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
      </Card>
    </div>
  );
}
