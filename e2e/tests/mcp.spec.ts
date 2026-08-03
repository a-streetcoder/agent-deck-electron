import { mockMcpServerLaunch } from "@agent-deck/testkit";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * MCP screen (the visible half): the configured MCP servers list with live
 * connection status + their tools, and the refresh/remove actions. A stdio
 * server is seeded over REST (pointing at the testkit mock MCP server), then
 * driven through the UI.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "mcp-e2e-project-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });
  const response = await fetch(`${harness.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  if (!response.ok) throw new Error(await response.text());
});

test.afterAll(async () => {
  await harness.close();
});

async function openProjectMcp(page: Parameters<typeof selectProject>[0]) {
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await page.getByTestId("nav-mcp").click();
}

async function assignServer(page: Parameters<typeof selectProject>[0], id: string) {
  const assignment = page.getByTestId(`mcp-assign-${id}`);
  await assignment.check();
  await expect(assignment).toBeChecked();
}

test("the empty state shows when no servers are configured", async ({ page }) => {
  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-mcp").click();
  await expect(page.getByTestId("mcp-empty")).toBeVisible();
});

test("lists a configured MCP server as connected and removes it", async ({ page }) => {
  // Add a stdio MCP server over REST (the mock echo server subprocess).
  const launch = mockMcpServerLaunch("mock");
  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "mock", command: launch.command, args: launch.args }),
  });
  expect(response.ok).toBe(true);

  await openProjectMcp(page);
  await assignServer(page, "mock");

  const row = page.getByTestId("mcp-mock");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-connected", "true");
  await expect(page.getByTestId("mcp-status-mock")).toHaveText("connected");
  // The echo tool the mock server exposes is listed.
  await expect(row).toContainText("mcp__mock__echo");

  // Revoke project trust, then remove the global definition (confirm-gated,
  // native parity) → the row disappears + empty state.
  await page.getByTestId("mcp-assign-mock").uncheck();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId("mcp-remove-mock").click();
  await expect(page.getByTestId("mcp-mock")).toHaveCount(0);
  await expect(page.getByTestId("mcp-empty")).toBeVisible();
});

test("reloads externally edited mcp.json without restarting", async ({ page }) => {
  const launch = mockMcpServerLaunch("external");
  const configPath = path.join(harness.piHome, ".pi", "agent", "mcp.json");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        external: { command: launch.command, args: launch.args },
      },
    }),
  );

  await openProjectMcp(page);
  await page.getByTestId("mcp-reload").click();
  await assignServer(page, "external");

  const row = page.getByTestId("mcp-external");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-connected", "true");
  await expect(row).toContainText("mcp__external__echo");

  // A partial/broken external save fails closed: the useful connection remains
  // active and the user gets an actionable error instead of losing all tools.
  writeFileSync(configPath, "{ not valid JSON");
  await page.getByTestId("mcp-reload").click();
  await expect(row).toHaveAttribute("data-connected", "true");
  await expect(page.getByTestId("error-banner")).toContainText("live connections were preserved");

  // Valid JSON with the wrong catalog shape is equally unsafe and must not be
  // mistaken for an authoritative empty snapshot.
  writeFileSync(configPath, JSON.stringify({ mcpServers: [] }));
  await page.getByTestId("mcp-reload").click();
  await expect(row).toHaveAttribute("data-connected", "true");
  await expect(page.getByTestId("error-banner")).toContainText("live connections were preserved");

  // An external deletion is authoritative too: reload tears down the live
  // client and removes its registered tools without a server restart. The
  // persisted assignment remains visible as a missing definition until revoked.
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  await page.getByTestId("mcp-reload").click();
  await expect(row).toHaveCount(0);
  const missing = page.getByTestId("mcp-missing-external");
  await expect(missing).toBeVisible();
  await expect(missing).not.toContainText("mcp__external__echo");
  await missing.getByRole("checkbox").click();
  await expect(page.getByTestId("mcp-empty")).toBeVisible();
});

test("signs in to an OAuth http server: open link, paste code, becomes authorized", async ({
  page,
}) => {
  // Register the global definition first; selecting a project alone must not
  // authorize it. The network exchange itself is intercepted below.
  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "authsrv", url: "http://127.0.0.1:9/mcp" }),
  });
  expect(response.ok).toBe(true);

  // Script the MCP endpoints so the OAuth flow (needs-auth → login URL → callback
  // → authorized) is exercised hermetically, without a real MCP provider.
  let authorized = false;
  let assignedServerIds: string[] = [];
  let callbackBody: { code?: string; state?: string } | undefined;

  await page.route(/\/projects\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const patch = route.request().postDataJSON() as { assignedMcpServers?: string[] };
    const assignmentResponse = await route.fetch();
    if (assignmentResponse.ok()) assignedServerIds = patch.assignedMcpServers ?? [];
    await route.fulfill({ response: assignmentResponse });
  });
  await page.route(/\/mcp(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      json: {
        assignedServerIds,
        missingAssignedServerIds: [],
        servers: [
          {
            id: "authsrv",
            transport: "http",
            connected: authorized,
            toolNames: authorized ? ["mcp__authsrv__echo"] : [],
            auth: { status: authorized ? "authorized" : "unauthenticated" },
          },
        ],
      },
    });
  });
  await page.route(/\/mcp\/[^/]+\/login(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 200,
      json: {
        auth: {
          status: "authorizing",
          authUrl: "https://auth.test/authorize?client_id=x&state=STATE123",
        },
      },
    });
  });
  await page.route(/\/mcp\/[^/]+\/login\/callback(?:\?.*)?$/, async (route) => {
    callbackBody = route.request().postDataJSON() as { code?: string; state?: string };
    authorized = true;
    await route.fulfill({ status: 200, json: { auth: { status: "authorized" }, server: {} } });
  });

  await openProjectMcp(page);
  await assignServer(page, "authsrv");

  // The http server shows sign-in required, and a Sign in button.
  await expect(page.getByTestId("mcp-auth-authsrv")).toHaveText("sign-in required");
  await page.getByTestId("mcp-login-authsrv").click();

  // The panel shows the authorization link to open.
  await expect(page.getByTestId("mcp-login-url-authsrv")).toHaveAttribute(
    "href",
    /auth\.test\/authorize/,
  );

  // Paste the code and connect → success toast + the badge flips to signed in.
  await page.getByTestId("mcp-login-code-authsrv").fill("browser-code");
  await page.getByTestId("mcp-login-submit-authsrv").click();
  await expect(page.getByTestId("toast")).toContainText(/Signed in to/);
  await expect(page.getByTestId("mcp-auth-authsrv")).toHaveText("signed in");

  // The UI parsed the OAuth state out of the authorization URL and echoed it back
  // with the code (CSRF round-trip).
  expect(callbackBody).toEqual({ code: "browser-code", state: "STATE123" });
});
