import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Tier-3 gate (Issues screen): a project's GitHub issues (via the gh CLI,
 * stubbed here for hermeticity) list, and selecting one starts a new session
 * with the composer seeded from the issue.
 */

// The gh CLI is stubbed with a unix shell script for hermeticity; skip on
// Windows (gh runs natively there). The Linux e2e leg covers this feature.
test.skip(process.platform === "win32", "gh CLI stub is a unix shell script");

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-issues-"));

test.beforeAll(async () => {
  // ISS-08 resolves owner/repo from the project's git origin to build the REST
  // path, so the fixture needs a repo with a GitHub remote; a bare temp dir
  // yields "no GitHub origin" and an empty board whatever the gh stub answers.
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: project, stdio: "ignore" });
  };
  git(["init", "-b", "main"]);
  git(["remote", "add", "origin", "https://github.com/x/y.git"]);
  // Stub gh so the test needs no network or real repo.
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  // Branches on the invocation: `gh api repos/O/R/issues?state=…` backs the
  // board (varying by the state the server forwards, which proves the filter
  // re-queries), `gh issue view <n>` returns one issue's detail.
  writeFileSync(
    stub,
    `#!/bin/sh
# ISS-08 moved the BOARD to the REST transport (\`gh api repos/O/R/issues?...\`),
# while the detail pane still uses \`gh issue view --json\`. Branch on the first
# arg so each half gets the payload shape its parser actually expects: raw REST
# rows (html_url / user / updated_at / lowercase state) for the list, gh's
# --json wrapper for the detail.
verb="$1"
sub="$2"
num="$3"
if [ "$verb" = "api" ]; then
  case "$sub" in
    *"/issues?"*"state=closed"*)
cat <<'JSON'
[{"number":9,"title":"Old flux leak (fixed)","state":"closed","html_url":"https://github.com/x/y/issues/9","labels":[],"updated_at":"2026-02-01T09:30:00Z"}]
JSON
      ;;
    *"/issues?"*"state=all"*)
      # Sentinel fixture: 51 rows let the server prove truncation while exposing 50.
      printf '['
      i=1
      while [ "$i" -le 51 ]; do
        [ "$i" -gt 1 ] && printf ','
        printf '{"number":%s,"title":"Issue %s with a deliberately long title for narrow layouts","state":"open","html_url":"https://github.com/x/y/issues/%s","labels":[],"updated_at":"2026-02-01T09:30:00Z"}' "$i" "$i" "$i"
        i=$((i + 1))
      done
      printf ']'
      ;;
    *"/issues?"*)
cat <<'JSON'
[{"number":7,"title":"Fix the flux capacitor","state":"open","html_url":"https://github.com/x/y/issues/7","labels":[{"name":"bug"}],"user":{"login":"doc"},"updated_at":"2026-02-01T09:30:00Z"}]
JSON
      ;;
    *)
      # Relationship endpoints (sub-issues, dependencies) are best-effort.
      printf '[]'
      ;;
  esac
elif [ "$sub" = "close" ]; then
  exit 0
elif [ "$sub" = "view" ]; then
cat <<JSON
{"number":$num,"title":"Fix the flux capacitor","body":"Steps to reproduce the flux leak.","state":"OPEN","url":"https://github.com/x/y/issues/$num","labels":[{"name":"bug"}],"assignees":[{"login":"marty"}],"author":{"login":"doc"},"comments":[{"author":{"login":"marty"},"body":"Confirmed on my machine too.","createdAt":"2026-02-01T09:30:00Z"}]}
JSON
else
  printf '[]'
fi
`,
  );
  chmodSync(stub, 0o755);
  process.env.AGENT_DECK_GH_BIN = stub;

  harness = await startHarness({ chunkDelayMs: 20 });
  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!response.ok) throw new Error(await response.text());
});

test.afterAll(async () => {
  delete process.env.AGENT_DECK_GH_BIN;
  await harness.close();
});

test("the All Projects workspace prompts to pick a project", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("issues-no-project")).toBeVisible();
});

test("opens an issue's detail and starts a seeded session from it", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);
  await page.getByTestId("nav-issues").click();

  const issue = page.getByTestId("issue-7");
  await expect(issue).toBeVisible();
  await expect(issue).toContainText("Fix the flux capacitor");
  await expect(issue).toContainText("bug");
  // The list row shows the author and a relative last-updated time (native meta row).
  await expect(issue.getByTestId("issue-author")).toHaveText("doc");
  // A fixed past updatedAt renders as a relative "N units ago" caption. The
  // formatter uses the runtime's default locale (native-faithful), so assert a
  // digit — present in every locale with numeric:"always" ("5 months ago",
  // "il y a 5 mois", …) — rather than the English word "ago".
  await expect(issue.getByTestId("issue-updated")).toHaveText(/\d/);

  // Clicking opens the detail pane (native GitHubIssueDetailView): body,
  // author, and state all rendered from `gh issue view`.
  await issue.click();
  const detail = page.getByTestId("issue-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("issue-detail-body")).toContainText("Steps to reproduce");
  await expect(detail).toContainText("doc"); // author
  await expect(page.getByTestId("issue-detail-state")).toHaveText("open");

  // The comments thread (native GitHubIssueDetailView) renders each comment.
  const comment = page.getByTestId("issue-comment");
  await expect(comment).toHaveCount(1);
  await expect(comment).toContainText("Confirmed on my machine too.");
  await expect(comment).toContainText("marty");

  // Close the open issue (native 10.9): the state pill flips and the close
  // actions disappear.
  await expect(page.getByTestId("issue-close-completed")).toBeVisible();
  await page.getByTestId("issue-close-completed").click();
  await expect(page.getByTestId("issue-detail-state")).toHaveText("closed");
  await expect(page.getByTestId("issue-close-completed")).toHaveCount(0);

  // Back returns to the list; re-open and use "Open in Pi" to seed a session.
  await page.getByTestId("issue-detail-back").click();
  await expect(page.getByTestId("issues-list")).toBeVisible();
  await page.getByTestId("issue-7").click();
  await page.getByTestId("issue-open-in-pi").click();
  await expect(page.getByTestId("composer-input")).toHaveValue(/issue #7: Fix the flux capacitor/);
});

test("discloses a truncated list accessibly without disrupting narrow-layout search", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 760 });
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-issues").click();
  await page.getByTestId("issues-state-all").click();

  const notice = page.getByTestId("issues-incomplete-results");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("role", "status");
  await expect(notice).toContainText("first 50 issues returned by GitHub");
  // ISS-08/ISS-09 added the type and close-reason facets, and the disclosure
  // names every filter the truncated set applies to — so it grew with them.
  await expect(notice).toContainText(
    "Search and label, assignee, author, type, and close-reason filters apply only to these results",
  );
  // Rows only: the prefix selector also matched each row's own `issue-updated`
  // / `issue-author` children once ISS-06 added them, doubling the count.
  await expect(page.getByTestId(/^issue-\d+$/)).toHaveCount(50);
  const noticeBox = await notice.boundingBox();
  expect(noticeBox).not.toBeNull();
  expect(noticeBox!.x).toBeGreaterThanOrEqual(0);
  expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(420);

  const search = page.getByTestId("issues-search");
  await search.focus();
  await search.pressSequentially("Issue 50");
  await expect(search).toBeFocused();
  await expect(page.getByTestId("issue-50")).toBeVisible();
  await expect(page.getByTestId("issue-1")).toHaveCount(0);
});

test("the Open / Closed filter re-queries gh for the chosen state", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-issues").click();

  // Defaults to open: the open issue shows, the closed one doesn't.
  await expect(page.getByTestId("issue-7")).toBeVisible();
  await expect(page.getByTestId("issue-9")).toHaveCount(0);

  // Switching to Closed re-fetches with --state closed.
  await page.getByTestId("issues-state-closed").click();
  await expect(page.getByTestId("issue-9")).toContainText("Old flux leak");
  await expect(page.getByTestId("issue-7")).toHaveCount(0);
});
