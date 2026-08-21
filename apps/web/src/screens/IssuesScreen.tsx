import {
  ControlButton,
  ControlInput,
  ControlTextArea,
} from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  CircleSlash,
  MessageSquare,
  PenLine,
  RefreshCw,
  Sparkles,
  User,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { SectionHero } from "@/design-system/components/SectionHero";
import { MarkdownDocument } from "@/design-system/markdown/MarkdownDocument";
import { useAppStore } from "../state/store.ts";
import { buildIssueContext, type IssueContextRelationships } from "./issueContext.ts";
import { newChat } from "../state/wsBridge.ts";

/**
 * Issues screen (native Workspace → Issues): the current project's GitHub
 * issues via the gh CLI. Selecting one starts a new session seeded with a
 * prompt referencing the issue (native PiIssuePromptBuilder).
 */
interface Issue {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  author: string | null;
  updatedAt: string | null;
  /** ISS-10 aggregate rows: which repo + registered project owns this row. */
  repository?: string | null;
  projectId?: string | null;
  /** ISS-08: the issue TYPE from the raw REST payload (null when none). */
  type?: string | null;
  /** ISS-09: closed rows carry why ("completed" | "not_planned" | null). */
  stateReason?: string | null;
}

interface IssueComment {
  id?: string | null;
  url?: string | null;
  author: string | null;
  body: string;
  createdAt: string | null;
  updatedAt?: string | null;
}

interface IssueDetail extends Issue {
  body: string;
  stateReason?: string | null;
  type?: string | null;
  createdAt?: string | null;
  closedAt?: string | null;
  comments: IssueComment[];
  relationships?: IssueContextRelationships;
}

/** ISO timestamp → a short local date, or "" if absent/unparseable. */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * ISO timestamp → a relative "N units ago" string, matching native's issue-row
 * updatedAt (RelativeDateTimeFormatter). `numeric: "always"` keeps it uniform
 * ("1 day ago", not "yesterday"). Returns "" if absent/unparseable.
 */
function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const sec = Math.round((then - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const abs = Math.abs(sec);
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.round(sec / 86400), "day");
  if (abs < 31536000) return rtf.format(Math.round(sec / 2592000), "month");
  return rtf.format(Math.round(sec / 31536000), "year");
}

export function IssuesScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const projects = useAppStore((state) => state.projects);
  const setView = useAppStore((state) => state.setView);
  const setGlobalError = useAppStore((state) => state.setError);
  const setPendingComposerText = useAppStore((state) => state.setPendingComposerText);
  const project = projects.find((p) => p.id === currentProjectId) ?? null;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setLocalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [incompleteResults, setIncompleteResults] = useState(false);
  // Native Issues screen's Open / Closed / All segmented filter.
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">("open");
  // ISS-10 (native aggregate board): search across every registered project's repo.
  const [allProjects, setAllProjects] = useState(false);
  // ISS-11: the aggregate board's scope — issues or pull requests.
  const [searchKind, setSearchKind] = useState<"issues" | "prs">("issues");
  // The project whose routes serve the OPEN detail (a cross-project row's owner).
  const [detailProjectId, setDetailProjectId] = useState<string | null>(null);
  // Native client-side facet filters (AppViewModel.filteredBoardItems): labels
  // are multi-select with OR semantics (an issue passes if it shares ≥1 selected
  // label — native `labels.isDisjoint(with:)`); assignee is single-select. Both
  // filter the already-loaded board, never re-query gh.
  const [labelFilters, setLabelFilters] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  // Native single-select author/creator filter (githubAuthorFilter).
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  // ISS-08: native's single-select issue-type facet (githubTypeFilter).
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  // ISS-12 (native GitHubCLIAuthService): the gh transport's account surface.
  const [connection, setConnection] = useState<{
    connected: boolean;
    login: string | null;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/issues/connection");
        if (!res.ok) return;
        const data = (await res.json()) as {
          connected: boolean;
          login: string | null;
          error?: string;
        };
        if (!cancelled) setConnection(data);
      } catch {
        // informational, but never a permanent "checking…" label (Codex)
        if (!cancelled) {
          setConnection({
            connected: false,
            login: null,
            error: "Couldn't check the GitHub connection.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ISS-09: native's close-reason filter. Native narrows the SEARCH QUERY by
  // reason; we filter the loaded board client-side, which also works for the
  // aggregate view (deviation noted in the slice commit).
  const [reasonFilter, setReasonFilter] = useState<string | null>(null);
  // Native free-text search (IssuesScreen.searchFiltered): a lowercased substring
  // match over each item's searchableHaystack, applied AFTER the facet filters.
  const [searchQuery, setSearchQuery] = useState("");
  // Monotonic request token: a slow fetch for a stale project/filter must not
  // clobber the result of a newer one (the filter buttons stay clickable).
  const reqRef = useRef(0);
  // Update query ownership in the synchronous commit phase, before the load
  // effect for a changed project/state starts. This closes the window where the
  // previous request could otherwise settle after the new query commits but
  // before reqRef bumps, without mutating refs during render.
  const renderedQueryKey = `${currentProjectId ?? ""}\u0000${stateFilter}\u0000${allProjects ? "all" : "one"}\u0000${searchKind}`;
  const queryEpochRef = useRef({ key: renderedQueryKey, epoch: 0 });
  useLayoutEffect(() => {
    if (queryEpochRef.current.key !== renderedQueryKey) {
      queryEpochRef.current = {
        key: renderedQueryKey,
        epoch: queryEpochRef.current.epoch + 1,
      };
    }
  }, [renderedQueryKey]);
  // The open issue detail pane (native GitHubIssueDetailView), or null for the list.
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [detailNumber, setDetailNumber] = useState<number | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailReq = useRef(0);

  const load = useCallback(
    async (projectId: string): Promise<void> => {
      const req = ++reqRef.current;
      const requestQueryKey = `${projectId}\u0000${stateFilter}\u0000${allProjects ? "all" : "one"}\u0000${searchKind}`;
      const requestQueryEpoch = queryEpochRef.current.epoch;
      const ownsCurrentQuery = (): boolean =>
        reqRef.current === req &&
        queryEpochRef.current.key === requestQueryKey &&
        queryEpochRef.current.epoch === requestQueryEpoch;
      setLoading(true);
      setLocalError(null);
      // A previous result's truncation status never describes the request now
      // in flight, so remove it before the loading state can paint.
      setIncompleteResults(false);
      try {
        const response = await fetch(
          allProjects
            ? `/issues/search?state=${stateFilter}&kind=${searchKind}`
            : `/projects/${encodeURIComponent(projectId)}/issues?state=${stateFilter}`,
        );
        const data = (await response.json()) as {
          issues?: Issue[];
          incompleteResults?: boolean;
          error?: string;
        };
        if (!ownsCurrentQuery()) return; // a newer request or rendered query superseded this one
        const nextError = data.error ?? (response.ok ? null : "Couldn't load issues.");
        setIssues(data.issues ?? []);
        setLocalError(nextError);
        setIncompleteResults(nextError === null && data.incompleteResults === true);
      } catch {
        if (!ownsCurrentQuery()) return;
        setIssues([]);
        setLocalError("Couldn't load issues.");
        setIncompleteResults(false);
      } finally {
        if (ownsCurrentQuery()) setLoading(false);
      }
    },
    [stateFilter, allProjects, searchKind],
  );

  useEffect(() => {
    if (currentProjectId) void load(currentProjectId);
  }, [currentProjectId, load]);

  // Switching projects: everything on screen (list rows AND any open detail)
  // belonged to the old repo. Reset in a LAYOUT effect so it lands before the
  // browser paints — no stale-issue flash — and abandon any in-flight fetches
  // so a slow response for the old project can't repopulate the new one.
  useLayoutEffect(() => {
    reqRef.current++;
    detailReq.current++;
    setIssues([]);
    setDetailNumber(null);
    setDetail(null);
    setDetailError(null);
    setLocalError(null);
    setIncompleteResults(false);
    setTypeFilter(null);
    setReasonFilter(null);
    // The old repo's labels/assignees/authors don't apply to the new one.
    setLabelFilters([]);
    setAssigneeFilter(null);
    setAuthorFilter(null);
    setSearchQuery("");
  }, [currentProjectId]);

  const start = async (issue: IssueDetail): Promise<void> => {
    const ownerProject =
      projects.find((p) => p.id === (detailProjectId ?? currentProjectId)) ?? project;
    setView("chat");
    // Wait for the new session to become active before seeding its composer,
    // so the prompt can't land in the previous session's draft.
    const session = await newChat();
    if (!session) return;
    // ISS-03: the visible ask plus native PiIssuePromptBuilder's structured
    // context block — full metadata, body, and comments, not a thin summary.
    const context = buildIssueContext(
      {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        stateReason: issue.stateReason ?? null,
        url: issue.url,
        createdAt: issue.createdAt ?? null,
        updatedAt: issue.updatedAt ?? null,
        closedAt: issue.closedAt ?? null,
        type: issue.type ?? null,
        labels: issue.labels,
        assignees: issue.assignees,
        author: issue.author,
        comments: issue.comments.map((comment) => ({
          id: comment.id ?? null,
          url: comment.url ?? null,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt ?? null,
        })),
        relationships: issue.relationships,
      },
      ownerProject?.name ?? "",
      ownerProject?.path ?? "",
    );
    setPendingComposerText({
      sessionId: session.id,
      text:
        `Work on GitHub issue #${issue.number}: ${issue.title}\n${issue.url}\n\n` +
        `Investigate the issue and propose a fix.\n\n${context}`,
    });
  };

  // Load a single issue's detail (title/state/labels/assignees/author/body).
  const openDetail = async (number: number, projectId?: string): Promise<void> => {
    // ISS-01: a reply draft belongs to ONE selection (Codex: leak across issues)
    setReplyDraft("");
    // ISS-10: an aggregate row opens against ITS project, not the selected one
    const pid = projectId ?? currentProjectId;
    if (!pid) return;
    const req = ++detailReq.current;
    setDetailNumber(number);
    setDetailProjectId(pid);
    setDetail(null);
    setDetailError(null);
    try {
      const res = await fetch(`/projects/${encodeURIComponent(pid)}/issues/${number}`);
      if (detailReq.current !== req) return; // a newer open superseded this one
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        setDetailError(error ?? "Couldn't load the issue.");
        return;
      }
      const { issue } = (await res.json()) as { issue: IssueDetail };
      if (detailReq.current === req) setDetail(issue);
    } catch (err) {
      if (detailReq.current === req) setDetailError(String(err));
    }
  };

  const closeDetail = (): void => {
    detailReq.current++; // abandon any in-flight detail fetch
    setDetailNumber(null);
    setDetail(null);
    setDetailError(null);
  };

  // ONE state-changing gh op (close/reopen) at a time: a rapid double-click or a
  // close racing a reopen must not leave stale local state (Codex, ISS-02 —
  // fixed at the shared root; the close path had the same latent hazard).
  const issueStateOpInFlight = useRef(false);
  // Close the open issue (native 10.9 split-button: completed / not planned).
  const closeIssue = async (reason: "completed" | "not_planned"): Promise<void> => {
    if (!currentProjectId || !detail || issueStateOpInFlight.current) return;
    issueStateOpInFlight.current = true;
    try {
      await closeIssueInner(reason);
    } finally {
      issueStateOpInFlight.current = false;
    }
  };
  const closeIssueInner = async (reason: "completed" | "not_planned"): Promise<void> => {
    if (!currentProjectId || !detail) return;
    // Token identifies the current selection (bumped on project switch AND on
    // opening any issue), so a delayed response can't touch a newer selection —
    // e.g. the SAME issue number in a different project after a switch.
    const req = detailReq.current;
    const res = await fetch(
      `/projects/${encodeURIComponent(detailProjectId ?? currentProjectId)}/issues/${detail.number}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      },
    );
    if (detailReq.current !== req) return; // selection changed — ignore this response
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      // Surface on the GLOBAL banner, NOT the detail-error slot — a failed close
      // must keep the still-open issue (and its close buttons) on screen.
      setGlobalError(error ?? "Couldn't close the issue.");
      return;
    }
    // Reflect the close locally (the list re-filters by the server's state on
    // its next load).
    setDetail((current) => (current ? { ...current, state: "CLOSED" } : current));
  };

  // Reopen a closed issue (ISS-02, native Issues reopen).
  const reopenIssue = async (): Promise<void> => {
    if (!currentProjectId || !detail || issueStateOpInFlight.current) return;
    issueStateOpInFlight.current = true;
    try {
      await reopenIssueInner();
    } finally {
      issueStateOpInFlight.current = false;
    }
  };
  const reopenIssueInner = async (): Promise<void> => {
    if (!currentProjectId || !detail) return;
    const req = detailReq.current;
    const res = await fetch(
      `/projects/${encodeURIComponent(detailProjectId ?? currentProjectId)}/issues/${detail.number}/reopen`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    if (detailReq.current !== req) return; // selection changed — ignore this response
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      setGlobalError(error ?? "Couldn't reopen the issue.");
      return;
    }
    setDetail((current) => (current ? { ...current, state: "OPEN" } : current));
  };

  // ISS-01: reply box state + post (native GitHubIssueDetailView reply). The ref
  // is the SYNCHRONOUS double-submit lock (state commits lag click bursts); busy
  // state only drives the visuals and always clears — the success path itself
  // bumps detailReq via openDetail, so a token-guarded finally would wedge the
  // box disabled forever (Codex).
  const [replyDraft, setReplyDraft] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const replyInFlight = useRef(false);
  const postComment = async (): Promise<void> => {
    const body = replyDraft.trim();
    if (!currentProjectId || !detail || !body || replyInFlight.current) return;
    replyInFlight.current = true;
    const req = detailReq.current;
    setReplyBusy(true);
    try {
      const res = await fetch(
        `/projects/${encodeURIComponent(detailProjectId ?? currentProjectId)}/issues/${detail.number}/comment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (detailReq.current !== req) return; // selection changed — ignore this response
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: string };
        setGlobalError(error ?? "Couldn't post the comment.");
        return;
      }
      setReplyDraft("");
      // Re-fetch the detail so the new comment shows with server-authoritative
      // author/timestamp instead of a fabricated local echo.
      await openDetail(detail.number, detailProjectId ?? undefined);
    } catch (error) {
      // a network-level rejection must surface too, not vanish from a void handler
      if (detailReq.current === req) {
        setGlobalError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      replyInFlight.current = false;
      setReplyBusy(false);
    }
  };

  // Facets derived from the loaded board (native githubAvailableLabels /
  // githubAvailableAssignees): deduped, case-insensitively sorted.
  const sortCI = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { sensitivity: "base" });
  const availableLabels = useMemo(
    () => [...new Set(issues.flatMap((i) => i.labels))].sort(sortCI),
    [issues],
  );
  const availableAssignees = useMemo(
    () => [...new Set(issues.flatMap((i) => i.assignees))].sort(sortCI),
    [issues],
  );
  const availableAuthors = useMemo(
    () => [...new Set(issues.flatMap((i) => (i.author ? [i.author] : [])))].sort(sortCI),
    [issues],
  );
  const availableTypes = useMemo(
    () => [...new Set(issues.flatMap((i) => (i.type ? [i.type] : [])))].sort(sortCI),
    [issues],
  );
  const availableReasons = useMemo(
    () =>
      [
        ...new Set(
          issues.flatMap((i) =>
            i.state.toLowerCase() === "closed" &&
            (i.stateReason === "completed" || i.stateReason === "not_planned")
              ? [i.stateReason]
              : [],
          ),
        ),
      ].sort(sortCI),
    [issues],
  );

  // Client-side filter (native filteredBoardItems + searchFiltered): label OR +
  // assignee contains, then a lowercased substring search over the item's
  // haystack. The list model carries title/number/labels/assignees (body/author
  // are detail-only), so the haystack is that faithful subset of native's.
  const search = searchQuery.trim().toLowerCase();
  const visibleIssues = useMemo(
    () =>
      issues.filter((issue) => {
        if (typeFilter && issue.type !== typeFilter) return false;
        if (reasonFilter && issue.stateReason !== reasonFilter) return false;
        if (authorFilter && issue.author !== authorFilter) return false;
        if (assigneeFilter && !issue.assignees.includes(assigneeFilter)) return false;
        if (labelFilters.length && !labelFilters.some((l) => issue.labels.includes(l)))
          return false;
        if (search) {
          const haystack = [
            issue.title,
            `#${issue.number}`,
            issue.repository ?? "",
            issue.author ?? "",
            ...issue.assignees,
            ...issue.labels,
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      }),
    [issues, typeFilter, reasonFilter, authorFilter, assigneeFilter, labelFilters, search],
  );
  const filtersActive =
    labelFilters.length > 0 ||
    assigneeFilter !== null ||
    authorFilter !== null ||
    typeFilter !== null ||
    reasonFilter !== null;
  const clearFilters = (): void => {
    setLabelFilters([]);
    setAssigneeFilter(null);
    setAuthorFilter(null);
    setTypeFilter(null);
    setReasonFilter(null);
  };

  // Prune selections that no longer exist in the reloaded board (e.g. after a
  // state-filter switch drops the labels/assignees they referenced), so a stale
  // chip can't keep the list mysteriously empty. Mirrors native resetIssueFilters
  // being scoped to what's actually present.
  useEffect(() => {
    setLabelFilters((prev) => {
      const next = prev.filter((l) => availableLabels.includes(l));
      return next.length === prev.length ? prev : next;
    });
    setAssigneeFilter((prev) => (prev && !availableAssignees.includes(prev) ? null : prev));
    setAuthorFilter((prev) => (prev && !availableAuthors.includes(prev) ? null : prev));
    setTypeFilter((prev) => (prev && !availableTypes.includes(prev) ? null : prev));
    setReasonFilter((prev) => (prev && !availableReasons.includes(prev) ? null : prev));
  }, [availableLabels, availableAssignees, availableAuthors, availableTypes, availableReasons]);

  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="issues-screen">
        <SectionHero imageSrc="/screen-art/screen-art-issues.jpg" title="Issues" />
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-5 text-center">
          <div className="max-w-sm text-sm text-text-muted" data-testid="issues-no-project">
            Issues are project-scoped. Select a project with a GitHub remote to see its issues.
          </div>
        </div>
      </div>
    );
  }

  if (detailNumber !== null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-5 sm:px-6" data-testid="issues-screen">
        <div className="mx-auto max-w-3xl">
          <div data-testid="issue-detail">
            <ControlButton
              data-testid="issue-detail-back"
              className="flex items-center gap-1 pb-3 text-xs text-text-muted hover:text-text-primary"
              onClick={closeDetail}
            >
              <ArrowLeft size={13} /> Back to issues
            </ControlButton>
            {detailError ? (
              <div
                className="rounded-2xl border border-border-subtle bg-surface px-4 py-6 text-center text-sm text-text-muted"
                data-testid="issue-detail-error"
              >
                {detailError}
              </div>
            ) : !detail ? (
              <div className="py-8 text-center text-sm text-text-muted">
                Loading issue #{detailNumber}…
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 pb-1">
                  <span
                    data-testid="issue-detail-state"
                    data-state={detail.state.toLowerCase()}
                    className={cn(
                      "rounded-capsule border px-2 py-0.5 text-detail capitalize",
                      detail.state.toLowerCase() === "open"
                        ? "border-success text-success"
                        : "border-border-strong text-text-muted",
                    )}
                  >
                    {detail.state.toLowerCase()}
                  </span>
                  {detail.stateReason ? (
                    <span
                      data-testid="issue-detail-state-reason"
                      className="rounded-capsule border border-border-subtle px-2 py-0.5 text-detail lowercase text-text-muted"
                    >
                      {detail.stateReason.toLowerCase().replaceAll("_", " ")}
                    </span>
                  ) : null}
                  {detail.type ? (
                    <span
                      data-testid="issue-detail-type"
                      className="rounded-capsule border border-border-subtle px-2 py-0.5 text-detail text-text-secondary"
                    >
                      {detail.type}
                    </span>
                  ) : null}
                  <span className="font-mono text-xs text-text-muted">#{detail.number}</span>
                </div>
                <h2
                  className="text-lg font-semibold text-text-primary"
                  style={{ fontStretch: "expanded" }}
                >
                  {detail.title}
                </h2>
                <div className="flex flex-wrap items-center gap-2 pt-1.5 text-detail text-text-muted">
                  {detail.author ? (
                    <span className="flex items-center gap-1">
                      <User size={11} /> {detail.author}
                    </span>
                  ) : null}
                  {detail.assignees.length ? (
                    <span data-testid="issue-detail-assignees">
                      assigned: {detail.assignees.join(", ")}
                    </span>
                  ) : null}
                  {detail.labels.map((label) => (
                    <span
                      key={label}
                      className="rounded-capsule border border-border-subtle px-1.5"
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <ControlButton
                    data-testid="issue-open-in-pi"
                    className="flex items-center gap-1.5 rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule"
                    style={{
                      background:
                        "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                      color: "var(--color-accent-foreground)",
                    }}
                    onClick={() => void start(detail)}
                  >
                    <Sparkles size={13} /> Open in Pi
                  </ControlButton>
                  {detail.state.toLowerCase() === "open" ? (
                    <>
                      <ControlButton
                        data-testid="issue-close-completed"
                        className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                        onClick={() => void closeIssue("completed")}
                      >
                        <CheckCircle2 size={13} /> Close as completed
                      </ControlButton>
                      <ControlButton
                        data-testid="issue-close-not-planned"
                        className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-muted hover:text-text-primary"
                        onClick={() => void closeIssue("not_planned")}
                      >
                        <CircleSlash size={13} /> Not planned
                      </ControlButton>
                    </>
                  ) : (
                    <ControlButton
                      data-testid="issue-reopen"
                      className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary"
                      onClick={() => void reopenIssue()}
                    >
                      <CircleDot size={13} /> Reopen
                    </ControlButton>
                  )}
                </div>
                <div
                  className="mt-4 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
                  data-testid="issue-detail-body"
                >
                  <MarkdownDocument source={detail.body || "_No description provided._"} />
                </div>
                <div
                  data-testid="issue-detail-timestamps"
                  className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 px-1 text-detail text-text-muted"
                >
                  {detail.createdAt ? (
                    <span>Created {formatRelative(detail.createdAt)}</span>
                  ) : null}
                  {detail.updatedAt ? (
                    <span>Updated {formatRelative(detail.updatedAt)}</span>
                  ) : null}
                  {detail.closedAt ? <span>Closed {formatRelative(detail.closedAt)}</span> : null}
                </div>
                {(() => {
                  const rel = detail.relationships;
                  const groups: Array<
                    [
                      string,
                      typeof rel extends undefined ? never : NonNullable<typeof rel>["subIssues"],
                    ]
                  > = [];
                  if (rel?.parent) groups.push(["Parent", [rel.parent]]);
                  if (rel && rel.subIssues.length > 0) groups.push(["Sub-issues", rel.subIssues]);
                  if (rel && rel.blockedBy.length > 0) groups.push(["Blocked by", rel.blockedBy]);
                  if (rel && rel.blocking.length > 0) groups.push(["Blocking", rel.blocking]);
                  if (groups.length === 0) return null;
                  return (
                    <div
                      data-testid="issue-relationships"
                      className="mt-3 rounded-xl border border-border-subtle bg-surface-elevated px-4 py-3"
                    >
                      <div className="pb-2 text-micro font-semibold uppercase tracking-wider text-text-muted">
                        Relationships
                      </div>
                      <div className="space-y-1.5">
                        {groups.map(([title, refs]) => (
                          <div key={title} className="text-xs">
                            <span className="text-text-muted">{title}</span>
                            {refs.map((ref) => (
                              <div
                                key={`${title}-${ref.number}`}
                                className="truncate pl-2 text-text-secondary"
                              >
                                {ref.repository
                                  ? `${ref.repository}#${ref.number}`
                                  : `#${ref.number}`}{" "}
                                {ref.title}{" "}
                                <span className="text-text-muted">{`{${ref.state}}`}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <div className="mt-5" data-testid="issue-comments">
                  <div className="flex items-center gap-1.5 pb-2 text-micro font-semibold uppercase tracking-wider text-text-muted">
                    <MessageSquare size={12} /> Comments
                    <span className="rounded-capsule border border-border-subtle px-1 tabular-nums">
                      {detail.comments.length}
                    </span>
                  </div>
                  {detail.comments.length === 0 ? (
                    <div className="text-xs text-text-muted">No comments yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {detail.comments.map((comment, i) => (
                        <div
                          key={i}
                          data-testid="issue-comment"
                          className="rounded-xl border border-border-subtle bg-surface px-4 py-2.5"
                        >
                          <div className="flex items-center gap-2 pb-1 text-detail text-text-muted">
                            <span className="flex items-center gap-1 font-medium text-text-secondary">
                              <User size={11} />{" "}
                              {comment.author && detail.url.startsWith("https://github.com/") ? (
                                <a
                                  data-testid="issue-comment-author-link"
                                  href={`https://github.com/${comment.author}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:underline"
                                  title={`Open ${comment.author}'s GitHub profile`}
                                >
                                  {comment.author}
                                </a>
                              ) : (
                                (comment.author ?? "unknown")
                              )}
                            </span>
                            {formatDate(comment.createdAt) ? (
                              <span>{formatDate(comment.createdAt)}</span>
                            ) : null}
                            {comment.updatedAt && comment.updatedAt !== comment.createdAt ? (
                              <span data-testid="issue-comment-edited">
                                edited {formatRelative(comment.updatedAt)}
                              </span>
                            ) : null}
                            {comment.url ? (
                              <a
                                data-testid="issue-comment-link"
                                href={comment.url}
                                target="_blank"
                                rel="noreferrer"
                                className="ml-auto text-text-muted underline hover:text-text-primary"
                                title="Open this comment on GitHub"
                              >
                                permalink
                              </a>
                            ) : null}
                          </div>
                          <MarkdownDocument source={comment.body || "_(empty)_"} />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 space-y-1.5" data-testid="issue-reply">
                    <ControlTextArea
                      data-testid="issue-reply-body"
                      className="min-h-20 w-full rounded-xl border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
                      placeholder="Write a reply (Markdown)…"
                      value={replyDraft}
                      disabled={replyBusy}
                      onChange={(e) => setReplyDraft(e.target.value)}
                    />
                    <div className="flex justify-end">
                      <ControlButton
                        data-testid="issue-reply-post"
                        className="rounded-capsule border border-border-strong px-3 py-1 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
                        disabled={replyBusy || replyDraft.trim() === ""}
                        onClick={() => void postComment()}
                      >
                        {replyBusy ? "Posting…" : "Comment"}
                      </ControlButton>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="issues-screen">
      <SectionHero
        imageSrc="/screen-art/screen-art-issues.jpg"
        title={`${project.name} · Issues`}
        actions={
          <div
            className="flex origin-left items-center gap-0.5 rounded-capsule border border-border-subtle p-0.5"
            role="group"
            aria-label="Filter issues by state"
          >
            {(["open", "closed", "all"] as const).map((s) => (
              <ControlButton
                key={s}
                data-testid={`issues-state-${s}`}
                aria-pressed={stateFilter === s}
                className={cn(
                  "rounded-capsule px-2.5 py-0.5 text-xs capitalize transition-colors",
                  stateFilter === s
                    ? "bg-selection text-text-primary"
                    : "text-text-muted hover:text-text-primary",
                )}
                onClick={() => {
                  if (s === stateFilter) return;
                  // Clear synchronously with the query change rather than
                  // leaving the previous state's notice until the effect runs.
                  setIncompleteResults(false);
                  // the close-reason facet is scoped to the closed board
                  setReasonFilter(null);
                  setStateFilter(s);
                }}
              >
                {s}
              </ControlButton>
            ))}
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-5 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="flex flex-col items-start gap-2 pb-1 sm:flex-row sm:items-center sm:justify-end">
            <span
              data-testid="issues-connection"
              role="status"
              aria-live="polite"
              className={cn(
                "rounded-capsule border px-2 py-0.5 text-detail",
                connection && !connection.connected
                  ? "border-warning/55 bg-warning/10 text-warning"
                  : "border-border-subtle text-text-muted",
              )}
              title={
                connection?.connected
                  ? "The gh CLI is signed in — issues use its authentication"
                  : (connection?.error ?? "Checking GitHub connection…")
              }
            >
              {connection === null
                ? "GitHub …"
                : connection.connected
                  ? `GitHub · ${connection.login ?? "signed in"}`
                  : (connection.error ?? "GitHub disconnected")}
            </span>
            <ControlButton
              data-testid="issues-scope-all"
              aria-pressed={allProjects}
              className={cn(
                "rounded-capsule border px-2.5 py-0.5 text-xs transition-colors",
                allProjects
                  ? "border-border-strong bg-selection text-text-primary"
                  : "border-border-subtle text-text-muted hover:text-text-primary",
              )}
              title="Search across every registered project's repository (native aggregate board)"
              onClick={() => {
                setIncompleteResults(false);
                // leaving the aggregate scope drops its PR mode too (Codex)
                setAllProjects((v) => {
                  if (v) setSearchKind("issues");
                  return !v;
                });
              }}
            >
              All projects
            </ControlButton>
            {allProjects ? (
              <ControlButton
                data-testid="issues-kind-toggle"
                aria-pressed={searchKind === "prs"}
                className={cn(
                  "rounded-capsule border px-2.5 py-0.5 text-xs transition-colors",
                  searchKind === "prs"
                    ? "border-border-strong bg-selection text-text-primary"
                    : "border-border-subtle text-text-muted hover:text-text-primary",
                )}
                title="Search pull requests instead of issues (native broader PR search)"
                onClick={() => {
                  setIncompleteResults(false);
                  // issue-only facets have no meaning over PR rows (Codex)
                  setTypeFilter(null);
                  setReasonFilter(null);
                  setSearchKind((k) => (k === "prs" ? "issues" : "prs"));
                }}
              >
                PRs
              </ControlButton>
            ) : null}
            <ControlButton
              data-testid="issues-refresh"
              className="flex items-center gap-1.5 rounded-capsule border border-border-strong px-2.5 py-0.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
              disabled={loading}
              onClick={() => currentProjectId && void load(currentProjectId)}
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : undefined} /> Refresh
            </ControlButton>
          </div>
          <p className="pb-3 text-xs text-text-muted">
            {stateFilter === "all"
              ? "All GitHub issues for this project."
              : `${stateFilter === "open" ? "Open" : "Closed"} GitHub issues for this project.`}{" "}
            Select one to start a session on it.
          </p>

          {/* Native free-text search (searchableHaystack): filters the loaded
                board client-side by title / #number / labels / assignees. */}
          {!error ? (
            <ControlInput
              data-testid="issues-search"
              className="mb-3 w-full rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="Search issues by title, #number, label, assignee, or author…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          ) : null}

          {incompleteResults && !loading && !error ? (
            <div
              className="mb-3 break-words rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2 text-xs text-text-secondary"
              data-testid="issues-incomplete-results"
              role="status"
              aria-live="polite"
            >
              Showing the first 50 issues returned by GitHub. Search and label, assignee, author,
              type, and close-reason filters apply only to these results.
            </div>
          ) : null}

          {/* Native label + assignee + author facet filters (client-side over
                the loaded board). Only shown when the board offers a facet. */}
          {!error &&
          (availableLabels.length > 0 ||
            availableAssignees.length > 0 ||
            availableAuthors.length > 0 ||
            availableTypes.length > 0 ||
            availableReasons.length > 0) ? (
            <div className="flex flex-wrap items-center gap-1.5 pb-3" data-testid="issues-facets">
              {availableTypes.length > 0 ? (
                <div className="flex items-center gap-1" data-testid="issues-type-filter">
                  <CircleDot size={12} className="text-text-muted" aria-hidden />
                  {availableTypes.map((issueType) => {
                    const on = typeFilter === issueType;
                    return (
                      <ControlButton
                        key={issueType}
                        data-testid={`issues-type-${issueType}`}
                        aria-pressed={on}
                        className={cn(
                          "rounded-capsule border px-2 py-0.5 text-detail transition-colors",
                          on
                            ? "border-border-strong bg-selection text-text-primary"
                            : "border-border-subtle text-text-muted hover:text-text-primary",
                        )}
                        onClick={() => setTypeFilter(on ? null : issueType)}
                      >
                        {issueType}
                      </ControlButton>
                    );
                  })}
                </div>
              ) : null}
              {availableReasons.length > 0 ? (
                <div className="flex items-center gap-1" data-testid="issues-reason-filter">
                  <CheckCircle2 size={12} className="text-text-muted" aria-hidden />
                  {availableReasons.map((reason) => {
                    const on = reasonFilter === reason;
                    return (
                      <ControlButton
                        key={reason}
                        data-testid={`issues-reason-${reason}`}
                        aria-pressed={on}
                        className={cn(
                          "rounded-capsule border px-2 py-0.5 text-detail transition-colors",
                          on
                            ? "border-border-strong bg-selection text-text-primary"
                            : "border-border-subtle text-text-muted hover:text-text-primary",
                        )}
                        onClick={() => setReasonFilter(on ? null : reason)}
                      >
                        {reason.toLowerCase().replaceAll("_", " ")}
                      </ControlButton>
                    );
                  })}
                </div>
              ) : null}
              {availableAuthors.length > 0 ? (
                <div className="flex items-center gap-1" data-testid="issues-author-filter">
                  <PenLine size={12} className="text-text-muted" aria-hidden />
                  {availableAuthors.map((author) => {
                    const on = authorFilter === author;
                    return (
                      <ControlButton
                        key={author}
                        data-testid={`issues-author-${author}`}
                        aria-pressed={on}
                        className={cn(
                          "rounded-capsule border px-2 py-0.5 text-detail transition-colors",
                          on
                            ? "border-border-strong bg-selection text-text-primary"
                            : "border-border-subtle text-text-muted hover:text-text-primary",
                        )}
                        onClick={() => setAuthorFilter(on ? null : author)}
                      >
                        {author}
                      </ControlButton>
                    );
                  })}
                </div>
              ) : null}
              {availableAssignees.length > 0 ? (
                <div className="flex items-center gap-1" data-testid="issues-assignee-filter">
                  <User size={12} className="text-text-muted" aria-hidden />
                  {availableAssignees.map((assignee) => {
                    const on = assigneeFilter === assignee;
                    return (
                      <ControlButton
                        key={assignee}
                        data-testid={`issues-assignee-${assignee}`}
                        aria-pressed={on}
                        className={cn(
                          "rounded-capsule border px-2 py-0.5 text-detail transition-colors",
                          on
                            ? "border-border-strong bg-selection text-text-primary"
                            : "border-border-subtle text-text-muted hover:text-text-primary",
                        )}
                        onClick={() => setAssigneeFilter(on ? null : assignee)}
                      >
                        {assignee}
                      </ControlButton>
                    );
                  })}
                </div>
              ) : null}
              {availableLabels.map((label) => {
                const on = labelFilters.includes(label);
                return (
                  <ControlButton
                    key={label}
                    data-testid={`issues-label-${label}`}
                    aria-pressed={on}
                    className={cn(
                      "rounded-capsule border px-2 py-0.5 text-detail transition-colors",
                      on
                        ? "border-border-strong bg-selection text-text-primary"
                        : "border-border-subtle text-text-muted hover:text-text-primary",
                    )}
                    onClick={() =>
                      setLabelFilters((prev) =>
                        prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
                      )
                    }
                  >
                    {label}
                  </ControlButton>
                );
              })}
              {filtersActive ? (
                <ControlButton
                  data-testid="issues-clear-filters"
                  className="rounded-capsule px-2 py-0.5 text-detail text-text-muted underline-offset-2 hover:text-text-primary hover:underline"
                  onClick={clearFilters}
                >
                  Clear filters
                </ControlButton>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div
              className="rounded-2xl border border-border-subtle bg-surface px-4 py-6 text-center text-sm text-text-muted"
              data-testid="issues-error"
            >
              {error}
            </div>
          ) : (
            <div className="space-y-1.5" data-testid="issues-list">
              {visibleIssues.map((issue) => (
                <ControlButton
                  key={`${issue.repository ?? ""}#${issue.number}`}
                  data-testid={`issue-${issue.number}`}
                  className="flex w-full items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5 text-left hover:bg-hover"
                  onClick={() => {
                    // a PR row has no issue detail — open it on GitHub (the
                    // main-window policy routes _blank/window.open externally)
                    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(issue.url)) {
                      window.open(issue.url, "_blank", "noreferrer");
                      return;
                    }
                    void openDetail(issue.number, issue.projectId ?? undefined);
                  }}
                >
                  <span className="font-mono text-xs text-text-muted">
                    {issue.repository ? `${issue.repository}#${issue.number}` : `#${issue.number}`}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary"
                    style={{ fontStretch: "expanded" }}
                  >
                    {issue.title}
                  </span>
                  {/* Native list-row meta leads with the author (GitHubIssuesViews
                        .swift:143-145): who filed the issue. */}
                  {issue.author ? (
                    <span
                      data-testid="issue-author"
                      className="flex shrink-0 items-center gap-1 text-detail text-text-muted"
                    >
                      <User size={11} className="shrink-0" />
                      <span className="max-w-[16ch] truncate">{issue.author}</span>
                    </span>
                  ) : null}
                  {/* Relative last-updated time (native meta row, after author). */}
                  {issue.updatedAt ? (
                    <span
                      data-testid="issue-updated"
                      className="shrink-0 whitespace-nowrap text-detail text-text-muted"
                      title={formatDate(issue.updatedAt)}
                    >
                      {formatRelative(issue.updatedAt)}
                    </span>
                  ) : null}
                  {issue.labels.slice(0, 3).map((label) => (
                    <span
                      key={label}
                      className="shrink-0 rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
                    >
                      {label}
                    </span>
                  ))}
                </ControlButton>
              ))}
              {visibleIssues.length === 0 && !loading ? (
                <div
                  className="py-8 text-center text-sm text-text-muted"
                  data-testid="issues-empty"
                >
                  {/* Native emptyStateMessage priority: search query wins,
                        then active facets, then the plain no-issues copy. */}
                  {search
                    ? `No issues match “${searchQuery.trim()}”.`
                    : filtersActive
                      ? "Try clearing the filters or changing the state."
                      : stateFilter === "all"
                        ? "No issues."
                        : `No ${stateFilter} issues.`}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
