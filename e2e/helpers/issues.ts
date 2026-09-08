import type { Page } from "./fixtures.ts";

export const LONG_ISSUE_TITLE =
  "Preserve incremental delivery and cancellation across reconnects with a deliberately long issue title that must wrap without widening the board card";

/** Mock only GitHub HTTP responses; navigation, projects and layout use the real app. */
export async function mockIssues(page: Page, projectIds: string[]) {
  const rows = [
    {
      number: 7,
      title: LONG_ISSUE_TITLE,
      state: "OPEN",
      labels: ["bug", "streaming", "priority", "regression"],
      assignees: ["alice"],
      author: "bob",
      type: "Bug",
      stateReason: null,
      repository: "acme/one",
      projectId: projectIds[0],
    },
    {
      number: 8,
      title: "Improve repository metadata",
      state: "OPEN",
      labels: ["enhancement"],
      assignees: ["bob"],
      author: "alice",
      type: "Feature",
      stateReason: null,
      repository: "acme/two",
      projectId: projectIds[1] ?? projectIds[0],
    },
    {
      number: 9,
      title: "Resolved keyboard navigation",
      state: "CLOSED",
      labels: ["bug"],
      assignees: ["alice"],
      author: "bob",
      type: "Bug",
      stateReason: "completed",
      repository: "acme/two",
      projectId: projectIds[1] ?? projectIds[0],
    },
  ].map((row) => ({
    ...row,
    updatedAt: "2026-01-01T00:00:00.000Z",
    url: `https://github.com/${row.repository}/issues/${row.number}`,
  }));
  const searches: string[] = [];
  const details: string[] = [];
  await page.route("**/issues/connection", (route) =>
    route.fulfill({ json: { connected: true, login: "board-tester" } }),
  );
  await page.route("**/issues/search?*", (route) => {
    searches.push(route.request().url());
    const query = new URL(route.request().url()).searchParams;
    const issues = rows.filter(
      (row) => query.get("state") === "all" || row.state.toLowerCase() === query.get("state"),
    );
    return route.fulfill({
      json: {
        issues:
          query.get("kind") === "prs"
            ? issues.map((row) => ({ ...row, url: row.url.replace("/issues/", "/pull/") }))
            : issues,
        incompleteResults: false,
      },
    });
  });
  await page.route(/\/projects\/[^/]+\/issues\/\d+$/, (route) => {
    details.push(new URL(route.request().url()).pathname);
    const row = rows.find((item) => route.request().url().endsWith(`/${item.number}`));
    return route.fulfill({
      json: { issue: { ...row, body: "Board detail body", comments: [] } },
    });
  });
  return { searches, details };
}
