import type { ProjectMeta } from "@agent-deck/contracts";
import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { Button } from "@/design-system/components/Button";
import { ControlInput } from "@/design-system/components/NativeControls";
import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../state/store.ts";
import { addProject } from "../state/wsBridge.ts";

type ProjectSource = "repo" | "folder";

const inputClass =
  "w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 font-mono text-code text-text-primary outline-none focus:border-accent";

/**
 * SRV-12a: on a shared server a project comes from a GitHub repository the
 * server clones (the default) or from a folder already on the server
 * (`folder`, today's browser). Off a shared server only `folder` renders.
 */
export function ProjectSourcePicker({
  folder,
  onAdded,
  testIdPrefix = "add-project",
}: {
  folder: ReactNode;
  onAdded: (project: ProjectMeta) => void | Promise<void>;
  testIdPrefix?: string;
}) {
  const shared = useAppStore((s) => s.me !== null);
  const [source, setSource] = useState<ProjectSource>("repo");
  if (!shared) return <>{folder}</>;
  return (
    <div className="space-y-1.5">
      <AppSegmentedPicker<ProjectSource>
        size="sm"
        aria-label="Add a project from"
        options={[
          { id: "repo", label: "Repository", "data-testid": `${testIdPrefix}-source-repo` },
          { id: "folder", label: "Server folder", "data-testid": `${testIdPrefix}-source-folder` },
        ]}
        value={source}
        onChange={setSource}
      />
      {source === "repo" ? (
        <RepositoryProjectForm onAdded={onAdded} testIdPrefix={testIdPrefix} />
      ) : (
        folder
      )}
    </div>
  );
}

function RepositoryProjectForm({
  onAdded,
  testIdPrefix,
}: {
  onAdded: (project: ProjectMeta) => void | Promise<void>;
  testIdPrefix: string;
}) {
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/runtime/github")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { configured?: unknown; connection?: unknown } | null) => {
        // No hint when the server has no GitHub app: there is nothing to connect.
        if (!cancelled && body?.configured === true) setGithubConnected(body.connection != null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (): Promise<void> => {
    const value = repo.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await addProject(
        { repo: value, ...(ref.trim() ? { ref: ref.trim() } : {}) },
        { rethrow: true },
      );
      if (project) await onAdded(project);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (event: { key: string }): void => {
    if (event.key === "Enter") void submit();
  };

  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-repo-form`}>
      <ControlInput
        data-testid={`${testIdPrefix}-repo`}
        aria-label="GitHub repository"
        className={inputClass}
        placeholder="owner/name or https://github.com/owner/name"
        value={repo}
        disabled={busy}
        onChange={(event) => setRepo(event.target.value)}
        onKeyDown={onEnter}
      />
      <ControlInput
        data-testid={`${testIdPrefix}-repo-ref`}
        aria-label="Branch or tag (optional)"
        className={inputClass}
        placeholder="Branch or tag (default branch if empty)"
        value={ref}
        disabled={busy}
        onChange={(event) => setRef(event.target.value)}
        onKeyDown={onEnter}
      />
      {githubConnected === false ? (
        <p className="text-detail text-text-muted" data-testid={`${testIdPrefix}-github-hint`}>
          Connect GitHub in Settings to add private repositories.
        </p>
      ) : null}
      {error ? (
        <p className="text-detail text-danger" role="alert" data-testid={`${testIdPrefix}-error`}>
          {error}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="primary"
        fullWidth
        className="rounded-capsule"
        data-testid={`${testIdPrefix}-repo-confirm`}
        disabled={!repo.trim() || busy}
        onClick={() => void submit()}
      >
        {busy ? "Cloning…" : "Clone and add project"}
      </Button>
    </div>
  );
}
