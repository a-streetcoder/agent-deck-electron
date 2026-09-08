import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { mockIssues } from "../helpers/issues.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

let harness: E2eHarness;
let projectId: string;
const project = mkdtempSync(path.join(tmpdir(), "proj-issues-"));

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

test("the All Projects workspace loads aggregate issues without a selected project", async ({
  page,
}) => {
  const requests = await mockIssues(page, [projectId]);
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("issue-7")).toBeVisible();
  await expect(page.getByRole("radio", { name: "This project", exact: true })).toBeDisabled();
  expect(requests.searches[0]).toContain("/issues/search?state=open&kind=issues");
});

test("opening a project session does not select Issues onto that project", async ({ page }) => {
  const requests = await mockIssues(page, [projectId]);
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("app-view-title")).toHaveText("Issues");
  await expect(page.getByTestId("issue-7")).toBeVisible();
  await expect(page.getByRole("radio", { name: "This project", exact: true })).toBeDisabled();
  expect(requests.searches[0]).toContain("/issues/search?state=open&kind=issues");
  await expect(page.getByTestId("issues-list")).toBeVisible();
});
