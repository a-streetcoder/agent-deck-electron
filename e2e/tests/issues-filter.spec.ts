import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { mockIssues } from "../helpers/issues.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
let projectId: string;
const project = mkdtempSync(path.join(tmpdir(), "proj-issues-filter-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!response.ok) throw new Error(await response.text());
  projectId = ((await response.json()) as { project: { id: string } }).project.id;
});

test.afterAll(async () => {
  await harness.close();
});

test("aggregate facets and search remain active when switching List and Board", async ({
  page,
}) => {
  const requests = await mockIssues(page, [projectId]);
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("issue-7")).toBeVisible();
  await page.getByTestId("issues-state-all").click();
  await expect(page.getByTestId("issue-9")).toBeVisible();
  const count = requests.searches.length;
  await page.getByTestId("issues-label-bug").click();
  await page.getByTestId("issues-assignee-alice").click();
  await page.getByTestId("issues-author-bob").click();
  await page.getByTestId("issues-type-Bug").click();
  await page.getByTestId("issues-presentation-board").click();
  await expect(page.getByTestId("issues-column-open-count")).toHaveText("1");
  await expect(page.getByTestId("issues-column-closed-count")).toHaveText("1");
  await expect(page.getByTestId("issue-8")).toHaveCount(0);
  await page.getByTestId("issues-reason-completed").click();
  await expect(page.getByTestId("issues-column-open-count")).toHaveText("0");
  await expect(page.getByText("No open issues", { exact: true })).toBeVisible();
  await page.getByTestId("issues-search").fill("keyboard");
  await expect(page.getByTestId("issue-9")).toBeVisible();
  await page.getByTestId("issues-presentation-list").click();
  await expect(page.getByTestId("issues-list").getByRole("button")).toHaveCount(1);
  await page.getByTestId("issues-presentation-board").click();
  await expect(page.getByTestId("issues-reason-completed")).toHaveAttribute("aria-pressed", "true");
  expect(requests.searches).toHaveLength(count);
  await page.getByTestId("issues-search").fill("no matching issue");
  await expect(page.getByTestId("issues-empty")).toContainText("No issues match");
});
