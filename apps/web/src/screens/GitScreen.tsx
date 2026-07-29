import { ControlButton, ControlTextArea } from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { GitBranch, Sparkles, Tag } from "lucide-react";
import { useAppStore } from "../state/store.ts";
import { mergeWorktreeSession } from "../state/wsBridge.ts";

/**
 * Git screen (native GitRepositoryService): the current project's working-tree
 * status and a commit-all action. Project-scoped — git runs in the project's
 * path. Push/remote is a follow-up; this is see-changes + commit.
 */
interface GitFileChange {
  status: string;
  path: string;
}
interface GitStatus {
  repo: boolean;
  branch?: string;
  files: GitFileChange[];
  clean: boolean;
}
type ReleaseBump = "patch" | "minor" | "major";
type ReleaseSyncCode =
  | "ready"
  | "not_repo"
  | "detached"
  | "missing_upstream"
  | "invalid_upstream"
  | "fetch_failed"
  | "dirty"
  | "ahead"
  | "behind"
  | "diverged";
interface ReleasePreflight {
  state: ReleaseSyncCode;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  ahead: number | null;
  behind: number | null;
  latestTag: string | null;
  nextVersions: Record<ReleaseBump, string>;
  blocker: { code: Exclude<ReleaseSyncCode, "ready">; message: string } | null;
}

async function apiError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export function GitScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const session = useAppStore((state) => state.session);
  // Merging auto-commits ALL uncommitted worktree work before merging, so a
  // mid-turn merge would push a half-written tree onto the source branch. Gate
  // the merge on the agent being idle — same guard the diff-panel merge toolbar
  // and the CheckpointsPanel Restore use.
  const agentRunning = useAppStore((state) => state.transcript.agentStatus === "running");
  const pushToast = useAppStore((state) => state.pushToast);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const gitActionRequest = useAppStore((state) => state.gitActionRequest);
  const clearGitActionRequest = useAppStore((state) => state.clearGitActionRequest);
  const setError = useAppStore((state) => state.setError);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusProjectId, setStatusProjectId] = useState<string | null>(null);
  const [statusLoadFailedProjectId, setStatusLoadFailedProjectId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [merging, setMerging] = useState(false);
  // Native piAgentGitAutomationEnabled: gates the Commit/Push/Merge actions
  // (default on). Off → the screen stays a read-only status view. `null` until
  // the setting loads, so neither the actions nor the "off" note flashes first
  // (a flash of enabled actions could let a quick click fire while off).
  const [gitActions, setGitActions] = useState<boolean | null>(null);
  const [worktreeIsolation, setWorktreeIsolation] = useState<boolean | null>(null);
  const [keepWorktreeAfterMerge, setKeepWorktreeAfterMerge] = useState<boolean | null>(null);
  const [savingWorktreePreference, setSavingWorktreePreference] = useState(false);
  const [settingsSettled, setSettingsSettled] = useState(false);
  const [settingsLoadFailed, setSettingsLoadFailed] = useState(false);
  // Native ReleaseService (generalized to any repo): tag a version + AI notes.
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [preflight, setPreflight] = useState<ReleasePreflight | null>(null);
  const [bump, setBump] = useState<ReleaseBump>("patch");
  const [notes, setNotes] = useState("");
  const [preflighting, setPreflighting] = useState(false);
  const [draftingNotes, setDraftingNotes] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const commitMessageRef = useRef<HTMLTextAreaElement>(null);
  const releaseTriggerRef = useRef<HTMLButtonElement>(null);
  const releaseCancelRef = useRef<HTMLButtonElement>(null);
  const bumpButtonRefs = useRef<Record<ReleaseBump, HTMLButtonElement | null>>({
    patch: null,
    minor: null,
    major: null,
  });
  const releaseRequestRef = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  });
  const statusRequestGeneration = useRef(0);
  const statusReady = statusProjectId === currentProjectId && status !== null;
  const statusFailed = statusLoadFailedProjectId === currentProjectId;

  const load = useCallback(async (): Promise<void> => {
    const projectId = currentProjectId;
    // An async handler can retain an older callback after project activation.
    // Do not let that stale callback clear/supersede the current project's load.
    if (useAppStore.getState().currentProjectId !== projectId) return;
    const generation = ++statusRequestGeneration.current;
    setStatus(null);
    setStatusProjectId(null);
    setStatusLoadFailedProjectId(null);
    if (!projectId) return;
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/git/status`);
      if (!response.ok) throw new Error(await response.text());
      const nextStatus = (await response.json()) as GitStatus;
      if (
        statusRequestGeneration.current !== generation ||
        useAppStore.getState().currentProjectId !== projectId
      )
        return;
      setStatus(nextStatus);
      setStatusProjectId(projectId);
    } catch (err) {
      if (
        statusRequestGeneration.current !== generation ||
        useAppStore.getState().currentProjectId !== projectId
      )
        return;
      setStatusLoadFailedProjectId(projectId);
      setError(String(err));
    }
  }, [currentProjectId, setError]);

  useEffect(() => {
    setMessage("");
  }, [currentProjectId]);

  useEffect(() => {
    void load();
  }, [load, resourcesVersion]);

  // Whether the git ACTIONS are enabled (native git-automation setting). Read on
  // mount — the screen mounts on nav, so a toggle in onboarding is picked up next
  // time you open Git.
  useEffect(() => {
    void fetch("/settings")
      .then((response) => {
        if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
        return response.json();
      })
      .then(
        (data: {
          settings: {
            gitAutomation: boolean;
            worktreeIsolation: boolean;
            keepWorktreeAfterMerge: boolean;
          };
        }) => {
          setGitActions(data.settings.gitAutomation);
          setWorktreeIsolation(data.settings.worktreeIsolation);
          setKeepWorktreeAfterMerge(data.settings.keepWorktreeAfterMerge);
        },
      )
      .catch(() => setSettingsLoadFailed(true))
      .finally(() => setSettingsSettled(true));
  }, []);

  const saveWorktreePreference = async (
    patch: { worktreeIsolation: boolean } | { keepWorktreeAfterMerge: boolean },
  ): Promise<void> => {
    if (savingWorktreePreference) return;
    const previousIsolation = worktreeIsolation;
    const previousKeep = keepWorktreeAfterMerge;
    if ("worktreeIsolation" in patch) setWorktreeIsolation(patch.worktreeIsolation);
    else setKeepWorktreeAfterMerge(patch.keepWorktreeAfterMerge);
    setSavingWorktreePreference(true);
    setError(null);
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(await apiError(response));
    } catch (error) {
      setWorktreeIsolation(previousIsolation);
      setKeepWorktreeAfterMerge(previousKeep);
      setError(
        `Worktree preference was not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSavingWorktreePreference(false);
    }
  };

  const commit = async (push: boolean): Promise<void> => {
    if (
      !currentProjectId ||
      useAppStore.getState().currentProjectId !== currentProjectId ||
      statusProjectId !== currentProjectId ||
      !status?.repo ||
      status.clean ||
      committing ||
      !message.trim()
    )
      return;
    const projectId = currentProjectId;
    setCommitting(true);
    setError(null);
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/git/commit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: message.trim(), push }),
      });
      if (!response.ok) throw new Error(await response.text());
      if (useAppStore.getState().currentProjectId !== projectId) return;
      setMessage("");
      pushToast({ kind: "success", message: push ? "Committed & pushed" : "Committed" });
      await load();
    } catch (err) {
      if (useAppStore.getState().currentProjectId === projectId) setError(String(err));
    } finally {
      setCommitting(false);
    }
  };

  const generateMessage = async (): Promise<void> => {
    if (
      !currentProjectId ||
      useAppStore.getState().currentProjectId !== currentProjectId ||
      statusProjectId !== currentProjectId ||
      !status?.repo ||
      status.clean ||
      generating ||
      committing
    )
      return;
    const projectId = currentProjectId;
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch(
        `/projects/${encodeURIComponent(projectId)}/git/generate-message`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await response.text());
      const { message: generated } = (await response.json()) as { message: string };
      if (useAppStore.getState().currentProjectId === projectId) setMessage(generated);
    } catch (err) {
      if (useAppStore.getState().currentProjectId === projectId) setError(String(err));
    } finally {
      setGenerating(false);
    }
  };

  const push = async (): Promise<void> => {
    if (
      !currentProjectId ||
      useAppStore.getState().currentProjectId !== currentProjectId ||
      statusProjectId !== currentProjectId ||
      !status?.repo ||
      committing ||
      pushing
    )
      return;
    const projectId = currentProjectId;
    setPushing(true);
    setError(null);
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/git/push`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await response.text());
    } catch (err) {
      if (useAppStore.getState().currentProjectId === projectId) setError(String(err));
    } finally {
      setPushing(false);
    }
  };

  // Merge the current session's isolated worktree back into its source branch
  // (native Merge). Only shown when the session runs in a worktree.
  const merge = async (): Promise<void> => {
    if (
      !statusReady ||
      useAppStore.getState().currentProjectId !== currentProjectId ||
      gitActions !== true ||
      !session?.id ||
      useAppStore.getState().session?.id !== session.id ||
      session.loopReviewRunId ||
      !session.worktreeBranch ||
      !session.worktreeSourceBranch ||
      agentRunning ||
      merging
    )
      return;
    setMerging(true);
    setError(null);
    try {
      const { sourceBranch, commits, cleanup } = await mergeWorktreeSession(session.id);
      if (cleanup.status === "failed") {
        // Recovery can require stopping Pi or deleting the session; keep the
        // one coherent merge+cleanup message in the persistent alert banner.
        setError(cleanup.error);
      } else {
        pushToast({
          kind: "success",
          message: `Merged ${commits} commit${commits === 1 ? "" : "s"} into ${sourceBranch}${cleanup.status === "removed" ? " and removed the worktree" : ""}`,
        });
      }
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  };

  const invalidateReleasePreflight = useCallback((): void => {
    releaseRequestRef.current.generation += 1;
    releaseRequestRef.current.controller?.abort();
    releaseRequestRef.current.controller = null;
  }, []);

  const loadReleasePreflight = useCallback(async (): Promise<"loaded" | "stale"> => {
    if (!currentProjectId) return "stale";
    invalidateReleasePreflight();
    const generation = releaseRequestRef.current.generation;
    const controller = new AbortController();
    releaseRequestRef.current.controller = controller;
    setPreflight(null);
    setPreflighting(true);
    try {
      const response = await fetch(
        `/projects/${encodeURIComponent(currentProjectId)}/release/preflight`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(await apiError(response));
      const nextPreflight = (await response.json()) as ReleasePreflight;
      if (releaseRequestRef.current.generation !== generation) return "stale";
      setPreflight(nextPreflight);
      return "loaded";
    } catch (error) {
      if (controller.signal.aborted || releaseRequestRef.current.generation !== generation) {
        return "stale";
      }
      throw error;
    } finally {
      if (releaseRequestRef.current.generation === generation) {
        releaseRequestRef.current.controller = null;
        setPreflighting(false);
      }
    }
  }, [currentProjectId, invalidateReleasePreflight]);

  useEffect(() => {
    setReleaseOpen(false);
    setPreflight(null);
    setPreflighting(false);
    return () => invalidateReleasePreflight();
  }, [currentProjectId, invalidateReleasePreflight]);

  useEffect(() => {
    if (releaseOpen) releaseCancelRef.current?.focus();
  }, [releaseOpen]);

  useEffect(() => {
    if (
      releaseOpen &&
      !preflighting &&
      preflight &&
      document.activeElement === releaseCancelRef.current
    ) {
      bumpButtonRefs.current[bump]?.focus();
    }
  }, [bump, preflight, preflighting, releaseOpen]);

  const closeRelease = (restoreTriggerFocus: boolean): void => {
    invalidateReleasePreflight();
    // The trigger is conditionally rendered in place of the panel. Commit that
    // transition synchronously so focus targets the newly mounted button, rather
    // than an effect racing later releasing/toast renders.
    flushSync(() => {
      setReleaseOpen(false);
      setPreflight(null);
      setPreflighting(false);
    });
    if (restoreTriggerFocus) releaseTriggerRef.current?.focus();
  };

  // Open the release panel and load the fetched upstream synchronization state.
  const openRelease = async (): Promise<void> => {
    if (
      !currentProjectId ||
      useAppStore.getState().currentProjectId !== currentProjectId ||
      !statusReady ||
      !status?.repo ||
      gitActions !== true ||
      preflighting ||
      releaseOpen
    )
      return;
    setReleaseOpen(true);
    setError(null);
    try {
      await loadReleasePreflight();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      releaseCancelRef.current?.focus();
    }
  };

  const draftNotes = async (): Promise<void> => {
    if (!currentProjectId || !preflight) return;
    setDraftingNotes(true);
    setError(null);
    try {
      const response = await fetch(
        `/projects/${encodeURIComponent(currentProjectId)}/release/notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: preflight.nextVersions[bump] }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
      const { notes: drafted } = (await response.json()) as { notes: string };
      setNotes(drafted);
    } catch (err) {
      setError(String(err));
    } finally {
      setDraftingNotes(false);
    }
  };

  const release = async (): Promise<void> => {
    if (!currentProjectId || !preflight) return;
    const tag = preflight.nextVersions[bump];
    setReleasing(true);
    setError(null);
    try {
      const response = await fetch(`/projects/${encodeURIComponent(currentProjectId)}/release`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, notes: notes.trim() || undefined }),
      });
      if (!response.ok) {
        const message = await apiError(response);
        // The POST performs a fresh synchronization check. Reflect that newest
        // state in the still-open panel after every rejected release attempt.
        try {
          await loadReleasePreflight();
        } catch {
          // Preserve the more specific POST failure and leave focus on a usable
          // panel control rather than a now-disabled confirmation button.
          releaseCancelRef.current?.focus();
        }
        throw new Error(message);
      }
      pushToast({ kind: "success", message: `Released ${tag}` });
      closeRelease(true);
      setNotes("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReleasing(false);
    }
  };

  // Palette, shortcut, and native-menu requests all stop here. Wait for the
  // project status and automation setting, re-check the captured identities,
  // then clear before invoking an existing guarded handler (at-most-once).
  useEffect(() => {
    if (!gitActionRequest) return;
    const reject = (message: string): void => {
      clearGitActionRequest(gitActionRequest.token);
      pushToast({ kind: "info", message });
    };

    if (!gitActionRequest.projectId) {
      reject("Open a project before running a Git command.");
      return;
    }
    if (gitActionRequest.projectId !== currentProjectId) {
      reject("The selected project changed; the Git command was not run.");
      return;
    }
    if (
      gitActionRequest.action === "mergeWorktree" &&
      gitActionRequest.sessionId !== (session?.id ?? null)
    ) {
      reject("The selected session changed; the Git command was not run.");
      return;
    }
    if (!settingsSettled || (!statusReady && !statusFailed)) return;
    if (settingsLoadFailed) {
      reject("Git settings could not be loaded; the command was not run.");
      return;
    }
    if (statusFailed || !statusReady) {
      reject("Git status could not be loaded; the command was not run.");
      return;
    }

    clearGitActionRequest(gitActionRequest.token);
    if (gitActions !== true) {
      pushToast({ kind: "info", message: "Git actions are turned off in Preferences." });
      return;
    }

    switch (gitActionRequest.action) {
      case "commit":
        if (!status?.repo) {
          pushToast({ kind: "info", message: "This project is not a Git repository." });
        } else if (committing || status.clean) {
          pushToast({
            kind: "info",
            message: committing
              ? "A commit is already running."
              : "There are no changes to commit.",
          });
        } else if (!message.trim()) {
          commitMessageRef.current?.focus();
          pushToast({ kind: "info", message: "Enter a commit message to commit all changes." });
        } else {
          void commit(false);
        }
        break;
      case "push":
        if (!status?.repo) {
          pushToast({ kind: "info", message: "This project is not a Git repository." });
        } else if (committing || pushing) {
          pushToast({ kind: "info", message: "A Git operation is already running." });
        } else {
          void push();
        }
        break;
      case "mergeWorktree":
        if (session?.loopReviewRunId) {
          pushToast({
            kind: "info",
            message: "Loop review sessions are read-only and cannot be merged.",
          });
        } else if (!session?.worktreeBranch || !session.worktreeSourceBranch) {
          pushToast({
            kind: "info",
            message: "The current session is not using an isolated worktree.",
          });
        } else if (agentRunning) {
          pushToast({
            kind: "info",
            message: "Wait for the current turn to finish before merging.",
          });
        } else if (merging) {
          pushToast({ kind: "info", message: "A worktree merge is already running." });
        } else {
          void merge();
        }
        break;
      case "release":
        if (!status?.repo) {
          pushToast({ kind: "info", message: "This project is not a Git repository." });
        } else if (preflighting || releaseOpen) {
          pushToast({ kind: "info", message: "The release preflight is already open." });
        } else {
          void openRelease();
        }
        break;
    }
  }, [
    agentRunning,
    clearGitActionRequest,
    commit,
    committing,
    currentProjectId,
    gitActionRequest,
    gitActions,
    merge,
    merging,
    message,
    openRelease,
    preflighting,
    push,
    pushToast,
    pushing,
    releaseOpen,
    session,
    settingsLoadFailed,
    settingsSettled,
    status,
    statusFailed,
    statusReady,
  ]);

  if (!currentProjectId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="git-screen">
        <div
          className="mx-auto max-w-3xl py-10 text-center text-sm text-text-muted"
          data-testid="git-no-project"
        >
          Git is project-scoped. Open a project to see its changes and commit.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="git-screen">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 pb-1">
          <GitBranch size={16} className="text-text-secondary" aria-hidden />
          <h2
            className="text-base font-semibold text-text-primary"
            style={{ fontStretch: "expanded" }}
          >
            Git
          </h2>
          {statusReady && status?.repo && status.branch ? (
            <span
              data-testid="git-branch"
              className="rounded-capsule border border-border-strong px-2 py-0.5 font-mono text-detail text-text-secondary"
            >
              {status.branch}
            </span>
          ) : null}
          {gitActions === true && statusReady && status?.repo && !releaseOpen ? (
            <ControlButton
              ref={releaseTriggerRef}
              data-testid="git-release"
              className="ml-auto flex items-center gap-1 rounded-capsule border border-border-strong px-3 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
              disabled={preflighting}
              onClick={() => void openRelease()}
              title="Tag a version and generate release notes"
            >
              <Tag size={12} /> {preflighting ? "Preparing…" : "Release"}
            </ControlButton>
          ) : null}
        </div>

        {releaseOpen ? (
          <div
            data-testid="git-release-panel"
            aria-busy={preflighting}
            className="mb-3 mt-2 flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface px-3.5 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-text-secondary">
                {preflighting ? (
                  "Checking release history…"
                ) : preflight?.latestTag ? (
                  <>
                    Latest release{" "}
                    <span className="font-mono text-text-primary">{preflight.latestTag}</span>
                  </>
                ) : preflight ? (
                  "No releases yet — this will be the first."
                ) : (
                  "Release synchronization unavailable."
                )}
              </div>
              <ControlButton
                ref={releaseCancelRef}
                data-testid="git-release-close"
                className="text-xs text-text-muted hover:text-text-primary"
                onClick={() => closeRelease(true)}
              >
                Cancel
              </ControlButton>
            </div>

            {preflighting ? (
              <div
                data-testid="git-release-sync-loading"
                role="status"
                aria-live="polite"
                className="rounded-md border border-border-subtle bg-surface-subtle px-2.5 py-2 text-xs text-text-muted"
              >
                Checking branch and remote synchronization…
              </div>
            ) : preflight ? (
              <div
                data-testid="git-release-sync"
                role="status"
                aria-live="polite"
                className="break-words rounded-md border border-border-subtle bg-surface-subtle px-2.5 py-2 text-xs text-text-muted"
              >
                {preflight.branch ? (
                  <>
                    <span className="font-mono text-text-primary">{preflight.branch}</span>
                    {preflight.upstream ? (
                      <>
                        {" "}
                        tracks{" "}
                        <span className="font-mono text-text-primary">{preflight.upstream}</span>
                        {preflight.remote ? ` on ${preflight.remote}` : ""}.{" "}
                        {preflight.ahead ?? "–"} ahead, {preflight.behind ?? "–"} behind.
                      </>
                    ) : null}
                  </>
                ) : (
                  "No attached release branch."
                )}
              </div>
            ) : null}

            {preflight?.blocker ? (
              <div
                data-testid="git-release-blocker"
                role="alert"
                className="break-words rounded-md border border-border-subtle bg-surface-subtle px-2.5 py-2 text-xs text-text-muted"
              >
                {preflight.blocker.message}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2" role="group" aria-label="Version bump">
              {(["patch", "minor", "major"] as const).map((kind) => (
                <ControlButton
                  key={kind}
                  ref={(element) => {
                    bumpButtonRefs.current[kind] = element;
                  }}
                  data-testid={`git-release-version-${kind}`}
                  aria-pressed={bump === kind}
                  className={`flex-1 rounded-md border px-2.5 py-1.5 text-left text-xs ${
                    bump === kind
                      ? "border-accent text-text-primary"
                      : "border-border-subtle text-text-secondary hover:text-text-primary"
                  }`}
                  onClick={() => setBump(kind)}
                >
                  <div className="capitalize">{kind}</div>
                  <div className="font-mono text-detail text-text-muted">
                    {preflight?.nextVersions[kind] ?? "…"}
                  </div>
                </ControlButton>
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <label
                htmlFor="git-release-notes"
                className="text-xs font-medium text-text-secondary"
              >
                Release notes
              </label>
              <ControlTextArea
                id="git-release-notes"
                data-testid="git-release-notes"
                className="min-h-[112px] w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
                placeholder="Release notes (optional — Generate drafts them from your commits)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="flex items-center justify-end gap-2">
                <ControlButton
                  data-testid="git-release-generate"
                  className="mr-auto flex items-center gap-1 rounded-capsule border border-border-strong px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                  disabled={draftingNotes || releasing || preflighting || !preflight}
                  onClick={() => void draftNotes()}
                  title="Draft release notes from commits since the last tag"
                >
                  <Sparkles size={12} /> {draftingNotes ? "Drafting…" : "Generate notes"}
                </ControlButton>
                <ControlButton
                  data-testid="git-release-confirm"
                  className="rounded-capsule px-4 py-1.5 text-xs font-medium shadow-capsule disabled:opacity-40"
                  style={{
                    background:
                      "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                    color: "var(--color-accent-foreground)",
                  }}
                  disabled={releasing || preflighting || preflight?.state !== "ready"}
                  onClick={() => void release()}
                >
                  {releasing ? "Releasing…" : `Release ${preflight?.nextVersions[bump] ?? ""}`}
                </ControlButton>
              </div>
            </div>
          </div>
        ) : null}

        <section
          data-testid="git-worktree-preferences"
          aria-busy={savingWorktreePreference}
          className="mb-3 mt-2 rounded-lg border border-border-subtle bg-surface px-3 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-text-primary">Session worktrees</h3>
            {savingWorktreePreference ? (
              <span
                data-testid="git-worktree-preferences-saving"
                className="text-detail text-text-muted"
                role="status"
                aria-live="polite"
              >
                Saving…
              </span>
            ) : null}
          </div>
          {settingsLoadFailed ? (
            <p className="mt-1 text-xs text-text-muted" role="alert">
              Worktree preferences could not be loaded. Reload the Git screen to try again.
            </p>
          ) : worktreeIsolation === null || keepWorktreeAfterMerge === null ? (
            <p className="mt-1 text-xs text-text-muted" role="status">
              Loading worktree preferences…
            </p>
          ) : (
            <div className="mt-2 space-y-3">
              <WorktreePreferenceSwitch
                testId="git-pref-worktree-isolation"
                label="Isolate new sessions in a worktree"
                help="New project sessions use a separate checkout. Existing sessions are unchanged."
                checked={worktreeIsolation}
                disabled={savingWorktreePreference}
                onChange={(checked) => void saveWorktreePreference({ worktreeIsolation: checked })}
              />
              <WorktreePreferenceSwitch
                testId="git-pref-keep-worktree"
                label="Keep worktree and branch after a successful merge"
                help="Applies only when isolation is on. On by default so you can keep iterating and merge again. Turn off to remove the proven worktree and its Agent Deck branch only after a successful merge. Deleting a session removes its worktree regardless of this setting."
                checked={keepWorktreeAfterMerge}
                disabled={!worktreeIsolation || savingWorktreePreference}
                onChange={(checked) =>
                  void saveWorktreePreference({ keepWorktreeAfterMerge: checked })
                }
              />
            </div>
          )}
        </section>

        {session?.loopReviewRunId ? (
          <div
            data-testid="git-loop-review-banner"
            className="mb-3 mt-1 rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-xs text-text-secondary"
            role="status"
          >
            Read-only Loop review. Merge, apply, and discard actions are unavailable here.
          </div>
        ) : null}

        {gitActions === true &&
        statusReady &&
        !session?.loopReviewRunId &&
        session?.worktreeBranch &&
        session.worktreeSourceBranch ? (
          <div
            data-testid="git-worktree-banner"
            className="mb-3 mt-1 flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-2.5"
          >
            <div className="min-w-0 text-xs text-text-secondary">
              This session is isolated on{" "}
              <span className="font-mono text-text-primary">{session.worktreeBranch}</span>. Merge
              brings its commits back into{" "}
              <span className="font-mono text-text-primary">{session.worktreeSourceBranch}</span>.
            </div>
            <ControlButton
              data-testid="git-merge"
              className="shrink-0 rounded-capsule px-3 py-1.5 text-xs font-medium shadow-capsule disabled:opacity-40"
              style={{
                background:
                  "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                color: "var(--color-accent-foreground)",
              }}
              disabled={merging || agentRunning}
              title={agentRunning ? "Wait for the current turn to finish" : undefined}
              onClick={() => void merge()}
            >
              {merging ? "Merging…" : `Merge to ${session.worktreeSourceBranch}`}
            </ControlButton>
          </div>
        ) : null}

        {statusFailed ? (
          <div
            className="py-10 text-center text-sm text-text-muted"
            data-testid="git-status-error"
            role="alert"
          >
            Git status could not be loaded. Mutation actions are unavailable.
          </div>
        ) : !statusReady || !status ? (
          <div
            className="py-10 text-center text-sm text-text-muted"
            data-testid="git-status-loading"
            role="status"
          >
            Loading Git status…
          </div>
        ) : !status.repo ? (
          <div className="py-10 text-center text-sm text-text-muted" data-testid="git-not-repo">
            This project isn&apos;t a git repository.
          </div>
        ) : (
          <>
            <p className="pb-3 text-xs text-text-muted">
              Uncommitted changes in the project working tree. Commit stages everything (git add -A)
              and commits with your message.
            </p>

            <div className="space-y-1" data-testid="git-file-list">
              {status.files.map((file) => (
                <div
                  key={file.path}
                  data-git-path={file.path}
                  className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-1.5"
                >
                  <span className="w-6 shrink-0 font-mono text-detail text-accent">
                    {file.status.trim() || "•"}
                  </span>
                  <span className="truncate font-mono text-caption text-text-primary">
                    {file.path}
                  </span>
                </div>
              ))}
              {status.clean ? (
                <div className="py-8 text-center text-sm text-text-muted" data-testid="git-clean">
                  Working tree clean — nothing to commit.
                </div>
              ) : null}
            </div>

            {gitActions === false ? (
              <div
                data-testid="git-actions-off"
                className="mt-4 rounded-lg border border-border-subtle bg-surface px-3 py-2.5 text-xs text-text-muted"
              >
                Git actions are turned off. Enable Commit / Push actions in the welcome flow&apos;s
                Preferences to commit from here.
              </div>
            ) : gitActions === null ? null : (
              <div className="mt-4 flex flex-col gap-2">
                <ControlTextArea
                  ref={commitMessageRef}
                  data-testid="git-commit-message"
                  className="min-h-[64px] w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                  placeholder="Commit message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <div className="flex items-center justify-end gap-2">
                  <ControlButton
                    data-testid="git-generate-message"
                    className="mr-auto flex items-center gap-1 rounded-capsule border border-border-strong px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
                    disabled={generating || committing || status.clean}
                    onClick={() => void generateMessage()}
                    title="Draft a commit message from your changes"
                  >
                    <Sparkles size={12} /> {generating ? "Generating…" : "Generate"}
                  </ControlButton>
                  <ControlButton
                    data-testid="git-push"
                    className="rounded-capsule border border-border-strong px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
                    disabled={committing || pushing}
                    onClick={() => void push()}
                    title="Push the current branch's commits"
                  >
                    {pushing ? "Pushing…" : "Push"}
                  </ControlButton>
                  <ControlButton
                    data-testid="git-commit"
                    className="rounded-capsule border border-border-strong px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
                    disabled={committing || status.clean || !message.trim()}
                    onClick={() => void commit(false)}
                  >
                    {committing ? "Committing…" : "Commit all"}
                  </ControlButton>
                  <ControlButton
                    data-testid="git-commit-push"
                    className="rounded-capsule px-4 py-1.5 text-sm font-medium shadow-capsule disabled:opacity-40"
                    style={{
                      background:
                        "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                      color: "var(--color-accent-foreground)",
                    }}
                    disabled={committing || status.clean || !message.trim()}
                    onClick={() => void commit(true)}
                  >
                    Commit &amp; Push
                  </ControlButton>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WorktreePreferenceSwitch({
  testId,
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  testId: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const helpId = `${testId}-help`;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-text-primary">{label}</div>
        <p id={helpId} className="mt-0.5 text-detail leading-relaxed text-text-muted">
          {help}
        </p>
      </div>
      <ControlButton
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={helpId}
        aria-label={label}
        data-testid={testId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-capsule transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${checked ? "bg-accent" : "bg-border-strong"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </ControlButton>
    </div>
  );
}
