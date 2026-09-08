import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { Button } from "@/design-system/components/Button";
import { AppInlineNotice } from "@/design-system/components/AppInlineNotice";
import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { AppTextField } from "@/design-system/components/AppTextField";
import { ControlButton, ControlTextArea } from "@/design-system/components/NativeControls";
import { PageShell } from "@/design-system/components/PageShell";
import { PageToolbar } from "@/design-system/components/PageToolbar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  CircleSlash,
  Columns2,
  List,
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
import { sectionHeaderClass } from "@/design-system/styles";

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

function IssueBoardCard({ issue, onSelect }: { issue: Issue; onSelect: () => void }) {
  const reference = issue.repository ? `${issue.repository}#${issue.number}` : `#${issue.number}`;
  const state = issue.state.toLowerCase();
  return (
    <li>
      <ControlButton
        data-testid={`issue-${issue.number}`}
        aria-label={`${reference}: ${issue.title}, ${state}`}
        className="group flex w-full min-w-0 scroll-m-1 flex-col gap-2 rounded-xl border border-border-subtle bg-surface p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        onFocus={(event) =>
          event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })
        }
        onClick={onSelect}
      >
        <span className="font-mono text-code-sm text-text-muted">{reference}</span>
        <span className="line-clamp-2 w-full break-words text-label font-medium leading-snug text-text-primary">
          {issue.title}
        </span>
        {(issue.author || issue.updatedAt) && (
          <span className="flex w-full min-w-0 items-center gap-2 text-detail text-text-muted">
            {issue.author ? (
              <span className="flex min-w-0 items-center gap-1">
                <User size={11} className="shrink-0" aria-hidden />
                <span className="truncate">{issue.author}</span>
              </span>
            ) : null}
            {issue.updatedAt ? (
              <span className="ml-auto shrink-0" title={formatDate(issue.updatedAt)}>
                {formatRelative(issue.updatedAt)}
              </span>
            ) : null}
          </span>
        )}
        {issue.labels.length > 0 ? (
          <span
            className="flex w-full flex-wrap gap-1"
            aria-label={`${issue.labels.length} labels`}
          >
            {issue.labels.slice(0, 3).map((label) => (
              <span
                key={label}
                className="max-w-[12rem] truncate rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
              >
                {label}
              </span>
            ))}
            {issue.labels.length > 3 ? (
              <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
                +{issue.labels.length - 3}
              </span>
            ) : null}
          </span>
        ) : null}
      </ControlButton>
    </li>
  );
}

export function IssuesScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const projects = useAppStore((state) => state.projects);
  const setView = useAppStore((state) => state.setView);
  const setGlobalError = useAppStore((state) => state.setError);
  const setPendingComposerText = useAppStore((state) => state.setPendingComposerText);
  // Aggregate collection loading needs a registered-project readiness anchor,
  // but that fallback must never become ownership for an issue detail/mutation.
  const collectionProjectId = currentProjectId ?? projects[0]?.id ?? null;

  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setLocalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [incompleteResults, setIncompleteResults] = useState(false);
  // Native Issues screen's Open / Closed / All segmented filter.
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">("open");
  const [presentation, setPresentation] = useState<"list" | "board">("list");
  // ISS-10 (native aggregate board): search across every registered project's repo.
  const [allProjects, setAllProjects] = useState(false);
  // Global navigation has no selected project, so aggregate scope is derived
  // synchronously. This prevents a stale one-project request during transition.
  const effectiveAllProjects = currentProjectId === null || allProjects;
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
  const renderedQueryKey = `${collectionProjectId ?? ""}\u0000${stateFilter}\u0000${effectiveAllProjects ? "all" : "one"}\u0000${searchKind}`;
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
      const requestQueryKey = `${projectId}\u0000${stateFilter}\u0000${effectiveAllProjects ? "all" : "one"}\u0000${searchKind}`;
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
          effectiveAllProjects
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
    [stateFilter, effectiveAllProjects, searchKind],
  );

  useEffect(() => {
    if (collectionProjectId) void load(collectionProjectId);
  }, [collectionProjectId, load]);

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

  const detailOwnerProjectId = detailProjectId ?? currentProjectId;

  const start = async (issue: IssueDetail): Promise<void> => {
    const ownerProject = projects.find((p) => p.id === detailOwnerProjectId) ?? null;
    if (!ownerProject) return;
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
    if (!detailOwnerProjectId || !detail || issueStateOpInFlight.current) return;
    issueStateOpInFlight.current = true;
    try {
      await closeIssueInner(reason);
    } finally {
      issueStateOpInFlight.current = false;
    }
  };
  const closeIssueInner = async (reason: "completed" | "not_planned"): Promise<void> => {
    if (!detailOwnerProjectId || !detail) return;
    // Token identifies the current selection (bumped on project switch AND on
    // opening any issue), so a delayed response can't touch a newer selection —
    // e.g. the SAME issue number in a different project after a switch.
    const req = detailReq.current;
    const res = await fetch(
      `/projects/${encodeURIComponent(detailOwnerProjectId)}/issues/${detail.number}/close`,
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
    if (!detailOwnerProjectId || !detail || issueStateOpInFlight.current) return;
    issueStateOpInFlight.current = true;
    try {
      await reopenIssueInner();
    } finally {
      issueStateOpInFlight.current = false;
    }
  };
  const reopenIssueInner = async (): Promise<void> => {
    if (!detailOwnerProjectId || !detail) return;
    const req = detailReq.current;
    const res = await fetch(
      `/projects/${encodeURIComponent(detailOwnerProjectId)}/issues/${detail.number}/reopen`,
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
    if (!detailOwnerProjectId || !detail || !body || replyInFlight.current) return;
    replyInFlight.current = true;
    const req = detailReq.current;
    setReplyBusy(true);
    try {
      const res = await fetch(
        `/projects/${encodeURIComponent(detailOwnerProjectId)}/issues/${detail.number}/comment`,
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

  if (!collectionProjectId) {
    return (
      <PageShell
        width="page"
        testId="issues-screen"
        hero={
          <SectionHero
            imageSrc="/screen-art/screen-art-issues.jpg"
            title="Issues"
            subtitle="Review and manage GitHub issues for the current project."
          />
        }
      >
        <AppEmptyState
          data-testid="issues-no-project"
          heading="Issues are project-scoped. Select a project with a GitHub remote to see its issues."
        />
      </PageShell>
    );
  }

  if (detailNumber !== null) {
    return (
      <PageShell
        width="page"
        testId="issues-screen"
        hero={
          <SectionHero
            imageSrc="/screen-art/screen-art-issues.jpg"
            title="Issues"
            subtitle="Review and manage GitHub issues for the current project."
          />
        }
        toolbar={
          <PageToolbar
            leading={
              <Button
                data-testid="issue-detail-back"
                size="sm"
                variant="ghost"
                leadingIcon={<ArrowLeft size={13} />}
                onClick={closeDetail}
              >
                Back to issues
              </Button>
            }
          />
        }
      >
        <div data-testid="issue-detail">
          {detailError ? (
            <div data-testid="issue-detail-error">
              <AppInlineNotice tone="danger">{detailError}</AppInlineNotice>
            </div>
          ) : !detail ? (
            <AppEmptyState heading={`Loading issue #${detailNumber}…`} />
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
                <span className="font-mono text-code-sm text-text-muted">#{detail.number}</span>
              </div>
              <h2 className="text-title font-semibold tracking-title text-text-primary">
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
                  <span key={label} className="rounded-capsule border border-border-subtle px-1.5">
                    {label}
                  </span>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  leadingIcon={<Sparkles size={13} />}
                  data-testid="issue-open-in-pi"
                  onClick={() => void start(detail)}
                >
                  Open in Pi
                </Button>
                {detail.state.toLowerCase() === "open" ? (
                  <>
                    <Button
                      data-testid="issue-close-completed"
                      size="sm"
                      variant="secondary"
                      leadingIcon={<CheckCircle2 size={13} />}
                      onClick={() => void closeIssue("completed")}
                    >
                      Close as completed
                    </Button>
                    <Button
                      data-testid="issue-close-not-planned"
                      size="sm"
                      variant="ghost"
                      leadingIcon={<CircleSlash size={13} />}
                      onClick={() => void closeIssue("not_planned")}
                    >
                      Not planned
                    </Button>
                  </>
                ) : (
                  <Button
                    data-testid="issue-reopen"
                    size="sm"
                    variant="secondary"
                    leadingIcon={<CircleDot size={13} />}
                    onClick={() => void reopenIssue()}
                  >
                    Reopen
                  </Button>
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
                {detail.createdAt ? <span>Created {formatRelative(detail.createdAt)}</span> : null}
                {detail.updatedAt ? <span>Updated {formatRelative(detail.updatedAt)}</span> : null}
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
                    <div className={cn(sectionHeaderClass, "pb-2 text-text-muted")}>
                      Relationships
                    </div>
                    <div className="space-y-1.5">
                      {groups.map(([title, refs]) => (
                        <div key={title} className="text-detail">
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
                <div
                  className={cn(
                    sectionHeaderClass,
                    "flex items-center gap-1.5 pb-2 text-text-muted",
                  )}
                >
                  <MessageSquare size={12} /> Comments
                  <span className="rounded-capsule border border-border-subtle px-1 tabular-nums">
                    {detail.comments.length}
                  </span>
                </div>
                {detail.comments.length === 0 ? (
                  <div className="text-detail text-text-muted">No comments yet.</div>
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
                    className="min-h-20 w-full rounded-xl border border-border-subtle bg-surface px-3 py-2 text-body text-text-primary placeholder:text-text-muted"
                    placeholder="Write a reply (Markdown)…"
                    value={replyDraft}
                    disabled={replyBusy}
                    onChange={(e) => setReplyDraft(e.target.value)}
                  />
                  <div className="flex justify-end">
                    <Button
                      data-testid="issue-reply-post"
                      size="md"
                      variant="primary"
                      disabled={replyBusy || replyDraft.trim() === ""}
                      onClick={() => void postComment()}
                    >
                      {replyBusy ? "Posting…" : "Comment"}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      width="page"
      testId="issues-screen"
      hero={
        <SectionHero
          imageSrc="/screen-art/screen-art-issues.jpg"
          title="Issues"
          subtitle="Review and manage GitHub issues for the current project."
        />
      }
      toolbar={
        <PageToolbar
          className="[&>div>div:last-child]:max-w-full"
          leading={
            <>
              <AppSegmentedPicker
                size="sm"
                aria-label="Filter issues by state"
                value={stateFilter}
                onChange={(s) => {
                  if (s === stateFilter) return;
                  setIncompleteResults(false);
                  setReasonFilter(null);
                  setStateFilter(s);
                }}
                options={(
                  [
                    { id: "open", label: "Open" },
                    { id: "closed", label: "Closed" },
                    { id: "all", label: "All" },
                  ] as const
                ).map((opt) => ({
                  ...opt,
                  "data-testid": `issues-state-${opt.id}`,
                }))}
              />
              {!error ? (
                <AppTextField
                  data-testid="issues-search"
                  size="sm"
                  className="max-w-sm"
                  placeholder="Search issues by title, #number, label, assignee, or author…"
                  value={searchQuery}
                  onChange={setSearchQuery}
                />
              ) : null}
            </>
          }
          trailing={
            <>
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
              <AppSegmentedPicker
                size="sm"
                aria-label="Issue presentation"
                value={presentation}
                onChange={setPresentation}
                options={[
                  {
                    id: "list",
                    label: "List",
                    icon: <List aria-hidden />,
                    "data-testid": "issues-presentation-list",
                  },
                  {
                    id: "board",
                    label: "Board",
                    icon: <Columns2 aria-hidden />,
                    "data-testid": "issues-presentation-board",
                  },
                ]}
              />
              <AppSegmentedPicker
                size="sm"
                aria-label="Issue search scope"
                value={effectiveAllProjects ? "all" : "current"}
                onChange={(next) => {
                  setIncompleteResults(false);
                  const nextAll = next === "all";
                  setAllProjects(nextAll);
                  if (!nextAll) setSearchKind("issues");
                }}
                options={[
                  { id: "current", label: "This project", disabled: currentProjectId === null },
                  {
                    id: "all",
                    label: "All projects",
                    "data-testid": "issues-scope-all",
                  },
                ]}
              />
              {effectiveAllProjects ? (
                <AppSegmentedPicker
                  size="sm"
                  aria-label="Search kind"
                  value={searchKind}
                  onChange={(next) => {
                    setIncompleteResults(false);
                    setTypeFilter(null);
                    setReasonFilter(null);
                    setSearchKind(next);
                  }}
                  options={[
                    { id: "issues", label: "Issues" },
                    {
                      id: "prs",
                      label: "PRs",
                      "data-testid": "issues-kind-toggle",
                    },
                  ]}
                />
              ) : null}
              <Button
                data-testid="issues-refresh"
                size="sm"
                variant="ghost"
                leadingIcon={
                  <RefreshCw size={11} className={loading ? "animate-spin" : undefined} />
                }
                disabled={loading}
                onClick={() => collectionProjectId && void load(collectionProjectId)}
              >
                Refresh
              </Button>
            </>
          }
          below={
            !error &&
            (availableLabels.length > 0 ||
              availableAssignees.length > 0 ||
              availableAuthors.length > 0 ||
              availableTypes.length > 0 ||
              availableReasons.length > 0) ? (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="issues-facets">
                {availableTypes.length > 0 ? (
                  <div className="flex items-center gap-1" data-testid="issues-type-filter">
                    <CircleDot size={12} className="text-text-muted" aria-hidden />
                    {availableTypes.map((issueType) => {
                      const on = typeFilter === issueType;
                      return (
                        <Button
                          key={issueType}
                          data-testid={`issues-type-${issueType}`}
                          size="sm"
                          variant="pill"
                          isActive={on}
                          aria-pressed={on}
                          onClick={() => setTypeFilter(on ? null : issueType)}
                        >
                          {issueType}
                        </Button>
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
                        <Button
                          key={reason}
                          data-testid={`issues-reason-${reason}`}
                          size="sm"
                          variant="pill"
                          isActive={on}
                          aria-pressed={on}
                          onClick={() => setReasonFilter(on ? null : reason)}
                        >
                          {reason.toLowerCase().replaceAll("_", " ")}
                        </Button>
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
                        <Button
                          key={author}
                          data-testid={`issues-author-${author}`}
                          size="sm"
                          variant="pill"
                          isActive={on}
                          aria-pressed={on}
                          onClick={() => setAuthorFilter(on ? null : author)}
                        >
                          {author}
                        </Button>
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
                        <Button
                          key={assignee}
                          data-testid={`issues-assignee-${assignee}`}
                          size="sm"
                          variant="pill"
                          isActive={on}
                          aria-pressed={on}
                          onClick={() => setAssigneeFilter(on ? null : assignee)}
                        >
                          {assignee}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
                {availableLabels.map((label) => {
                  const on = labelFilters.includes(label);
                  return (
                    <Button
                      key={label}
                      data-testid={`issues-label-${label}`}
                      size="sm"
                      variant="pill"
                      isActive={on}
                      aria-pressed={on}
                      onClick={() =>
                        setLabelFilters((prev) =>
                          prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
                        )
                      }
                    >
                      {label}
                    </Button>
                  );
                })}
                {filtersActive ? (
                  <Button
                    data-testid="issues-clear-filters"
                    size="sm"
                    variant="ghost"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </Button>
                ) : null}
              </div>
            ) : null
          }
        />
      }
    >
      <p className="pb-3 text-caption text-text-muted">
        {stateFilter === "all"
          ? "All GitHub issues for this project."
          : `${stateFilter === "open" ? "Open" : "Closed"} GitHub issues for this project.`}{" "}
        Select one to start a session on it.
      </p>

      {incompleteResults && !loading && !error ? (
        <div
          data-testid="issues-incomplete-results"
          className="mb-3"
          role="status"
          aria-live="polite"
        >
          <AppInlineNotice tone="neutral">
            Showing the first 50 issues returned by GitHub. Search and label, assignee, author,
            type, and close-reason filters apply only to these results.
          </AppInlineNotice>
        </div>
      ) : null}

      {error ? (
        <div data-testid="issues-error">
          <AppInlineNotice tone="danger">{error}</AppInlineNotice>
        </div>
      ) : visibleIssues.length === 0 && !loading ? (
        <AppEmptyState
          data-testid="issues-empty"
          heading={
            search
              ? `No issues match “${searchQuery.trim()}”.`
              : filtersActive
                ? "Try clearing the filters or changing the state."
                : stateFilter === "all"
                  ? "No issues."
                  : `No ${stateFilter} issues.`
          }
        />
      ) : presentation === "board" ? (
        <section
          data-testid="issues-board"
          aria-label="Issues board"
          className="w-full min-w-0 overflow-x-auto pb-3 pe-4"
        >
          <div className="flex min-w-max items-start gap-4">
            {(stateFilter === "all" ? (["open", "closed"] as const) : [stateFilter]).map(
              (columnState) => {
                const columnIssues = visibleIssues.filter(
                  (issue) => issue.state.toLowerCase() === columnState,
                );
                const headingId = `issues-column-${columnState}`;
                return (
                  <section
                    key={columnState}
                    data-testid={headingId}
                    aria-labelledby={`${headingId}-heading`}
                    className="w-[min(21rem,calc(100vw-3rem))] shrink-0 rounded-xl bg-surface-elevated p-2.5 sm:w-[20rem]"
                  >
                    <header className="flex items-center gap-2 px-1 pb-2.5">
                      {columnState === "open" ? (
                        <CircleDot size={13} className="text-success" aria-hidden />
                      ) : (
                        <CheckCircle2 size={13} className="text-text-muted" aria-hidden />
                      )}
                      <h2
                        id={`${headingId}-heading`}
                        className="text-label font-semibold capitalize text-text-primary"
                      >
                        {columnState}
                      </h2>
                      <span
                        data-testid={`${headingId}-count`}
                        className="ml-auto rounded-capsule border border-border-subtle px-1.5 text-detail tabular-nums text-text-muted"
                      >
                        {columnIssues.length}
                      </span>
                    </header>
                    <ul className="space-y-2" aria-label={`${columnState} issues`}>
                      {columnIssues.map((issue) => (
                        <IssueBoardCard
                          key={`${issue.repository ?? ""}#${issue.number}`}
                          issue={issue}
                          onSelect={() => {
                            if (
                              /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(issue.url)
                            ) {
                              window.open(issue.url, "_blank", "noreferrer");
                              return;
                            }
                            const ownerProjectId = effectiveAllProjects
                              ? issue.projectId
                              : (issue.projectId ?? currentProjectId);
                            if (ownerProjectId) void openDetail(issue.number, ownerProjectId);
                          }}
                        />
                      ))}
                    </ul>
                    {columnIssues.length === 0 ? (
                      <p className="px-1 py-5 text-center text-detail text-text-muted">
                        No {columnState} issues
                      </p>
                    ) : null}
                  </section>
                );
              },
            )}
          </div>
        </section>
      ) : (
        <div className="space-y-1.5" data-testid="issues-list">
          {visibleIssues.map((issue) => (
            <ControlButton
              key={`${issue.repository ?? ""}#${issue.number}`}
              data-testid={`issue-${issue.number}`}
              aria-label={`${issue.repository ? `${issue.repository}#${issue.number}` : `#${issue.number}`}: ${issue.title}, ${issue.state.toLowerCase()}`}
              className="flex w-full items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              onClick={() => {
                if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(issue.url)) {
                  window.open(issue.url, "_blank", "noreferrer");
                  return;
                }
                const ownerProjectId = effectiveAllProjects
                  ? issue.projectId
                  : (issue.projectId ?? currentProjectId);
                if (ownerProjectId) void openDetail(issue.number, ownerProjectId);
              }}
            >
              <span className="font-mono text-code text-text-muted">
                {issue.repository ? `${issue.repository}#${issue.number}` : `#${issue.number}`}
              </span>
              <span className="min-w-0 flex-1 truncate text-label font-medium text-text-primary">
                {issue.title}
              </span>
              {issue.author ? (
                <span
                  data-testid="issue-author"
                  className="flex shrink-0 items-center gap-1 text-detail text-text-muted"
                >
                  <User size={11} className="shrink-0" />
                  <span className="max-w-[16ch] truncate">{issue.author}</span>
                </span>
              ) : null}
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
        </div>
      )}
    </PageShell>
  );
}
