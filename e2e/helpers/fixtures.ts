import { expect, test as base, type Page } from "@playwright/test";

/**
 * Shared e2e test with the first-run onboarding pre-dismissed. The onboarding is
 * a full-screen modal that shows while a user has no projects — which is the
 * default harness state — so without this it would cover the app and intercept
 * every click. The onboarding suite itself imports `test` from @playwright/test
 * directly so it still sees the modal.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("agentdeck-onboarding-dismissed", "1");
      } catch {
        // Storage disabled — the test just sees the onboarding; harmless here.
      }
    });
    await use(page);
  },
});

export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";

/**
 * UI-01: the nav lives in the Orchestrate pull-up. Open it, pick the screen,
 * then fold it back so the sessions list (and new-chat) stay reachable. Works
 * whether the pull-up starts open or closed; it always ends collapsed.
 */
export async function openNav(
  page: Page,
  id: string,
  options?: { timeout?: number },
): Promise<void> {
  const pullUp = page.getByTestId("orchestrate-expanded");
  // Already open (a spec expanded it, or the persisted state reopened it).
  if ((await pullUp.getAttribute("aria-hidden", options)) !== "false") {
    await page.getByTestId("orchestrate-expand").click(options);
  }
  await expect(pullUp).toHaveAttribute("aria-hidden", "false");
  await page.getByTestId(`nav-${id}`).click();
  await page.getByTestId("orchestrate-collapse").click();
}

/**
 * Start a chat in the named project without selecting a global project.
 * Creates a session via HTTP, then activates it from the complete sessions list.
 * Resource management remains global: session activation does not scope catalogs.
 */
export async function selectProject(page: Page, name: string): Promise<string> {
  const sessionId = await page.evaluate(async (projectName) => {
    const projectsResponse = await fetch("/projects");
    if (!projectsResponse.ok) throw new Error(await projectsResponse.text());
    const { projects } = (await projectsResponse.json()) as {
      projects: Array<{ id: string; name: string }>;
    };
    const project = projects.find((item) => item.name === projectName);
    if (!project) throw new Error(`Unknown project: ${projectName}`);
    const createResponse = await fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startImmediately: true, projectId: project.id }),
    });
    if (!createResponse.ok) throw new Error(await createResponse.text());
    const { session } = (await createResponse.json()) as { session: { id: string } };
    return session.id;
  }, name);
  // UI-01: the full sessions list is the main sidebar layer, always in view.
  const panel = page.getByTestId("sessions-panel");
  const search = panel.getByTestId("sessions-search");
  await expect(search).toBeVisible();
  await expect(search).toBeEditable();
  if ((await search.inputValue()) !== "") await search.fill("");
  // session_meta arrives asynchronously after the HTTP creation response.
  const row = panel.getByTestId(`chat-${sessionId}`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  return sessionId;
}

/** Enter runtime-owned workspace actions through the real first-send lifecycle. */
export async function startDraftWithMessage(page: Page): Promise<void> {
  await page.getByTestId("composer-input").fill("Prepare the workspace");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text").last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
}
