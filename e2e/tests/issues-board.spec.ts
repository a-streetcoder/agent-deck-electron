import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";
import { LONG_ISSUE_TITLE, mockIssues } from "../helpers/issues.ts";

let harness: E2eHarness;
const projectIds: string[] = [];

test.beforeAll(async () => {
  harness = await startHarness();
  for (const name of ["one", "two"]) {
    const response = await fetch(`${harness.baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: mkdtempSync(path.join(tmpdir(), `issues-board-${name}-`)) }),
    });
    if (!response.ok) throw new Error(await response.text());
    projectIds.push(((await response.json()) as { project: { id: string } }).project.id);
  }
});

test.afterAll(async () => {
  await harness.close();
});

test("List defaults, board groups, owner detail/back and PR external navigation", async ({
  page,
}) => {
  const requests = await mockIssues(page, projectIds);
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-issues").click();
  await expect(page.getByTestId("issues-list")).toBeVisible();
  await expect(page.getByTestId("issue-7")).toBeVisible();
  await expect(page.getByTestId("issues-presentation-list")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByTestId("issues-state-all").click();
  await expect(page.getByTestId("issue-9")).toBeVisible();
  const count = requests.searches.length;
  await page.getByTestId("issues-presentation-board").click();
  await expect(page.getByTestId("issues-list")).toHaveCount(0);
  await expect(page.getByTestId("issues-column-open-count")).toHaveText("2");
  await expect(page.getByTestId("issues-column-closed-count")).toHaveText("1");
  expect(requests.searches).toHaveLength(count);
  const card = page.getByTestId("issue-7");
  await expect(card).toContainText(LONG_ISSUE_TITLE);
  await expect(card).toContainText("acme/one#7");
  await expect(card.getByLabel("4 labels")).toContainText("+1");
  await expect(card.getByLabel("4 labels")).not.toContainText("regression");
  await page.getByTestId("issue-9").click();
  await expect(page.getByTestId("issue-detail-body")).toContainText("Board detail body");
  expect(requests.details).toEqual([`/projects/${projectIds[1]}/issues/9`]);
  await page.getByTestId("issue-detail-back").click();
  await expect(page.getByTestId("issues-board")).toBeVisible();
  await expect(page.getByTestId("issues-presentation-board")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByTestId("issues-state-closed").click();
  await expect(page.getByTestId("issues-column-open")).toHaveCount(0);
  await expect(page.getByTestId("issues-column-closed-count")).toHaveText("1");
  const response = page.waitForResponse((res) => res.url().includes("kind=prs"));
  await page.getByTestId("issues-kind-toggle").click();
  await response;
  // Intercept only the external destination, not window.open: exercise a real popup.
  await page
    .context()
    .route("https://github.com/**", (route) => route.fulfill({ body: "GitHub fixture" }));
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("issue-9").click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://github.com/acme/two/pull/9");
  await popup.close();
  await expect(page.getByTestId("issue-detail")).toHaveCount(0);
});

for (const width of [1440, 940]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`board geometry ${width}px ${colorScheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await mockIssues(page, projectIds);
      await page.goto(harness.baseUrl);
      await page.getByTestId("nav-issues").click();
      await expect(page.getByTestId("issue-7")).toBeVisible();
      await page.getByTestId("issues-state-all").click();
      await expect(page.getByTestId("issue-9")).toBeVisible();
      await page.getByTestId("issues-presentation-board").click();
      const board = page.getByTestId("issues-board");
      await expect(board).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await page
        .locator("html")
        .evaluate((el) => el.ownerDocument.fonts.ready.then(() => undefined));
      const geometry = await board.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          documentWidth: element.ownerDocument.documentElement.scrollWidth,
          overflow: element.ownerDocument.defaultView!.getComputedStyle(element).overflowX,
        };
      });
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      expect(geometry.overflow).toBe("auto");
      if (width === 940) expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
      const title = page.getByTestId("issue-7").getByText(LONG_ISSUE_TITLE);
      expect(
        await title.evaluate(
          (el) =>
            el.clientHeight /
            parseFloat(el.ownerDocument.defaultView!.getComputedStyle(el).lineHeight),
        ),
      ).toBeLessThanOrEqual(2.1);
      // Toolbar controls must wrap within the viewport, never extend behind its edge.
      for (const id of [
        "issues-search",
        "issues-presentation-board",
        "issues-kind-toggle",
        "issues-refresh",
      ]) {
        const rect = await page.getByTestId(id).boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({
        path: testInfo.outputPath(`board-${width}-${colorScheme}-start.png`),
      });
      // Keyboard traversal must scroll the last column into view with room for its focus ring.
      await page.getByTestId("issue-8").focus();
      await page.keyboard.press("Tab");
      const last = page.getByTestId("issue-9");
      await expect(last).toBeFocused();
      await expect
        .poll(async () => {
          const card = await last.boundingBox();
          const container = await board.boundingBox();
          return card!.x + card!.width + 2 - (container!.x + container!.width);
        })
        .toBeLessThanOrEqual(0);
      const cardRect = await last.boundingBox();
      const boardRect = await board.boundingBox();
      expect(cardRect!.x).toBeGreaterThanOrEqual(boardRect!.x + 2);
      expect(cardRect!.x + cardRect!.width + 2).toBeLessThanOrEqual(
        boardRect!.x + boardRect!.width,
      );
      expect(
        await last.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow),
      ).not.toBe("none");
      await board.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      const columnRect = await page.getByTestId("issues-column-closed").boundingBox();
      expect(columnRect!.x + columnRect!.width).toBeLessThanOrEqual(
        boardRect!.x + boardRect!.width,
      );
      await page.screenshot({
        path: testInfo.outputPath(`board-${width}-${colorScheme}-end-focus.png`),
      });
      await testInfo.attach("board-geometry", {
        body: JSON.stringify(geometry),
        contentType: "application/json",
      });
    });
  }
}
