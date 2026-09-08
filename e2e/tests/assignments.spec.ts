import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, selectProject, test } from "../helpers/fixtures.ts";
import type { SessionMeta } from "@agent-deck/domain";
import { startHarness, type E2eHarness } from "../helpers/env.ts";

/**
 * Slice-10 gate: a skill assigned to a project reaches pi as a --skill flag —
 * verified from pi's own get_commands (`/skill:<name>` appears) — and a
 * project's default agent name persists and supports an explicit named launch.
 * This does not prove automatic default application by a UI launcher.
 */

let harness: E2eHarness;
const project = mkdtempSync(path.join(tmpdir(), "proj-assign-"));

test.beforeAll(async () => {
  harness = await startHarness({ chunkDelayMs: 20 });

  // A project skill + a project agent on disk, and the project registered.
  const skillDir = path.join(project, ".pi", "skills", "tidy-commits");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: tidy-commits\ndescription: Write tidy commits\n---\n\nHow to write tidy commits.\n",
  );
  const agentsDir = path.join(project, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "syrup-bot.md"),
    "---\nname: syrup-bot\ndescription: Syrup specialist\n---\n\nYou are syrup-bot.\n",
  );
  writeFileSync(
    path.join(project, ".pi", "mcp.json"),
    `${JSON.stringify({ mcpServers: { "repository-tools-with-a-long-name": { command: "/definitely/missing/mcp" } } }, null, 2)}\n`,
  );
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

async function projectId(): Promise<string> {
  const { projects } = (await (await fetch(`${harness.baseUrl}/projects`)).json()) as {
    projects: Array<{ id: string; path: string }>;
  };
  return projects.find((p) => p.path === project)!.id;
}

test("project MCP assignments persist independently of accessible All Projects toggles", async ({
  page,
  request,
}) => {
  const id = await projectId();
  const name = "repository-tools-with-a-long-name";
  // Global management cannot see project-only definitions. Use a global entry
  // for its toggle and inspect the project definition through the scoped API.
  mkdirSync(path.join(harness.piHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(harness.piHome, ".pi", "agent", "mcp.json"),
    JSON.stringify({ mcpServers: { [name]: { command: "/definitely/missing/mcp" } } }),
  );
  const scoped = async () => {
    const response = await request.get(`${harness.baseUrl}/mcp`, { params: { projectId: id } });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  expect(await scoped()).toMatchObject({
    assignedServerIds: [],
    defaultAssignedServerIds: [],
    servers: [expect.objectContaining({ id: name, source: "project", editable: false })],
  });
  const assign = async (names: string[]) => {
    const response = await request.patch(`${harness.baseUrl}/projects/${id}`, {
      data: { assignedMcpServers: names },
    });
    expect(response.ok()).toBe(true);
  };
  await assign([name]);
  expect(await scoped()).toMatchObject({ assignedServerIds: [name] });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-mcp").click();
  await expect(page.getByTestId("mcp-trust-copy")).toContainText(
    "no-project chats receive no MCP servers",
  );
  const allProjects = page.getByRole("checkbox", {
    name: `All Projects MCP assignment for ${name}`,
  });
  await expect(allProjects).not.toBeChecked();
  await allProjects.focus();
  await allProjects.press("Space");
  await expect(allProjects).toBeChecked();
  await expect.poll(scoped).toMatchObject({
    assignedServerIds: [name],
    defaultAssignedServerIds: [name],
  });
  await expect(allProjects).toBeEnabled();
  await expect(allProjects).toBeFocused();
  await allProjects.press("Space");
  await expect(allProjects).not.toBeChecked();
  await expect.poll(scoped).toMatchObject({
    assignedServerIds: [name],
    defaultAssignedServerIds: [],
  });
  await assign([]);
  expect(await scoped()).toMatchObject({ assignedServerIds: [], defaultAssignedServerIds: [] });
  const projectsResponse = await request.get(`${harness.baseUrl}/projects`);
  const { projects } = await projectsResponse.json();
  expect(projects.find((item: { id: string }) => item.id === id).assignedMcpServers).toEqual([]);
});

test("assigning a project skill injects /skill:<name> into new real sessions", async ({ page }) => {
  const id = await projectId();
  const patched = await fetch(`${harness.baseUrl}/projects/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignedSkills: ["tidy-commits"] }),
  });
  expect(patched.status).toBe(200);
  await page.goto(harness.baseUrl);
  await selectProject(page, path.basename(project));
  await expect(page.getByTestId("session-cwd")).toHaveText(project);
  // Management remains global even while the project session is active.
  await page.getByTestId("nav-skills").click();
  await expect(page.locator('[data-skill-name="tidy-commits"]')).toHaveCount(0);

  const created = await fetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: id }),
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as { session: SessionMeta };
  await expect
    .poll(
      async () => {
        const response = await fetch(`${harness.baseUrl}/sessions/${session.id}/commands`);
        if (!response.ok) return [];
        const { commands } = (await response.json()) as {
          commands: Array<{ name: string; source: string }>;
        };
        return commands.filter((c) => c.source === "skill").map((c) => c.name);
      },
      { timeout: 30_000 },
    )
    .toContain("skill:tidy-commits");
});

test("an All-Projects (default) skill reaches sessions of every project", async ({ page }) => {
  // A GLOBAL skill in the hermetic pi home.
  const globalSkillDir = path.join(harness.piHome, ".pi", "agent", "skills", "sign-offs");
  mkdirSync(globalSkillDir, { recursive: true });
  writeFileSync(
    path.join(globalSkillDir, "SKILL.md"),
    "---\nname: sign-offs\ndescription: Sign every message\n---\n\nHow to sign off.\n",
  );

  await page.goto(harness.baseUrl);
  // Enable it for All Projects from the Skills detail pane (Default context).
  await page.getByTestId("nav-skills").click();
  await page.locator('[data-skill-name="sign-offs"]').click();
  const allProjects = page.getByTestId("assign-skill-all-sign-offs");
  await allProjects.check();
  await expect(allProjects).toBeChecked();

  // A fresh session for the registered project (NOT the default context)
  // must load it: pi's get_commands shows /skill:sign-offs.
  const id = await projectId();
  const created = await fetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: id }),
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as { session: SessionMeta };
  await expect
    .poll(
      async () => {
        const response = await fetch(`${harness.baseUrl}/sessions/${session.id}/commands`);
        if (!response.ok) return [];
        const { commands } = (await response.json()) as {
          commands: Array<{ name: string; source: string }>;
        };
        return commands.filter((c) => c.source === "skill").map((c) => c.name);
      },
      { timeout: 30_000 },
    )
    .toContain("skill:sign-offs");
});

test("the Skills All Projects toggle rolls back, reloads, and reports failures", async ({
  page,
}) => {
  const name = "failed-default";
  const skillDir = path.join(harness.piHome, ".pi", "agent", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Exercise failed assignment\n---\n\nFailure fixture.\n`,
  );

  let patchCount = 0;
  let releasePatch!: () => void;
  const patchPending = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    patchCount += 1;
    await patchPending;
    await route.fulfill({
      status: 409,
      json: { error: "Default skill update was refused." },
    });
  });

  await page.goto(harness.baseUrl);
  await page.getByTestId("nav-skills").click();
  await page.locator(`[data-skill-name="${name}"]`).click();
  const toggle = page.getByTestId(`assign-skill-all-${name}`);
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect.poll(() => patchCount).toBe(1);
  await toggle.evaluate((input: { dispatchEvent(event: Event): boolean }) => {
    input.dispatchEvent(new Event("click", { bubbles: true }));
  });
  expect(patchCount).toBe(1);

  releasePatch();
  await expect(page.getByTestId("error-banner")).toHaveText(
    "Error: Default skill update was refused.",
  );
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(patchCount).toBe(1);

  const { settings } = (await (await fetch(`${harness.baseUrl}/settings`)).json()) as {
    settings: { defaultSkills: string[] };
  };
  expect(settings.defaultSkills).not.toContain(name);
});

test("an All-Projects (default) prompt template reaches sessions as a /<name> command", async () => {
  // A GLOBAL prompt template in the hermetic pi home (native
  // defaultPromptTemplateNames → --prompt-template launch flags).
  const promptsDir = path.join(harness.piHome, ".pi", "agent", "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(
    path.join(promptsDir, "standup.md"),
    "---\ndescription: Draft a standup update\n---\n\nWrite today's standup.\n",
  );

  // Enable it for All Projects (no UI yet — drive the setting over REST).
  const patched = await fetch(`${harness.baseUrl}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setDefaultPromptTemplate: { name: "standup", enabled: true } }),
  });
  expect(patched.status).toBe(200);

  // A fresh session for the registered project must load it: pi's get_commands
  // shows the /standup prompt command (source "prompt", bare name — no prefix).
  const id = await projectId();
  const created = await fetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: id }),
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as { session: SessionMeta };
  await expect
    .poll(
      async () => {
        const response = await fetch(`${harness.baseUrl}/sessions/${session.id}/commands`);
        if (!response.ok) return [];
        const { commands } = (await response.json()) as {
          commands: Array<{ name: string; source: string }>;
        };
        return commands.filter((c) => c.source === "prompt").map((c) => c.name);
      },
      { timeout: 30_000 },
    )
    .toContain("standup");
});

test("a per-project assigned prompt template reaches only that project's sessions", async () => {
  // A GLOBAL prompt in the hermetic pi home, assigned to THIS project (native
  // assignedPromptTemplateNames — unioned with the all-projects defaults).
  const promptsDir = path.join(harness.piHome, ".pi", "agent", "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(
    path.join(promptsDir, "handoff.md"),
    "---\ndescription: Write a handoff note\n---\n\nWrite a handoff note.\n",
  );

  const id = await projectId();
  const patched = await fetch(`${harness.baseUrl}/projects/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignedPrompts: ["handoff"] }),
  });
  expect(patched.status).toBe(200);

  // Guard: "handoff" is purely a PER-PROJECT assignment, not an app-level default,
  // so its presence proves the assignedPrompts path (not defaultPromptTemplates).
  const { settings } = (await (await fetch(`${harness.baseUrl}/settings`)).json()) as {
    settings: { defaultPromptTemplates?: string[] };
  };
  expect(settings.defaultPromptTemplates ?? []).not.toContain("handoff");

  // A fresh session for this project loads it (pi's real get_commands).
  const created = await fetch(`${harness.baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: id }),
  });
  expect(created.status).toBe(201);
  const { session } = (await created.json()) as { session: SessionMeta };
  await expect
    .poll(
      async () => {
        const response = await fetch(`${harness.baseUrl}/sessions/${session.id}/commands`);
        if (!response.ok) return [];
        const { commands } = (await response.json()) as {
          commands: Array<{ name: string; source: string }>;
        };
        return commands.filter((c) => c.source === "prompt").map((c) => c.name);
      },
      { timeout: 30_000 },
    )
    .toContain("handoff");
});

test("project default-agent persistence and explicit named launch retain the project prompt", async ({
  page,
  request,
}) => {
  const id = await projectId();
  const patched = await request.patch(`${harness.baseUrl}/projects/${id}`, {
    data: { defaultAgentName: "syrup-bot" },
  });
  expect(patched.status()).toBe(200);
  const response = await request.get(`${harness.baseUrl}/projects`);
  const { projects } = await response.json();
  const saved = projects.find((item: { id: string }) => item.id === id);
  expect(saved.defaultAgentName).toBe("syrup-bot");
  // No global project switch/default-star UI remains. Resolve the persisted
  // default explicitly through the supported named-session creation contract.
  // Normal New chat inherits the active session's agent; it does not apply the
  // project's saved default. Automatic default application is not covered here.
  const created = await request.post(`${harness.baseUrl}/sessions`, {
    data: { projectId: id, agentName: saved.defaultAgentName },
  });
  expect(created.status()).toBe(201);
  const { session } = await created.json();
  await page.goto(harness.baseUrl);
  await page.getByTestId("chat-list").getByTestId(`chat-${session.id}`).click();
  await expect(page.getByTestId("session-cwd")).toHaveText(project);
  expect(session.agentName).toBe("syrup-bot");
  await expect(page.getByTestId("status-indicator")).toHaveAttribute("data-status", "idle");
  const start = harness.mock.requests.length;
  await page.getByTestId("composer-input").fill("project default proof");
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("assistant-text")).toContainText("project default proof");
  const captured = harness.mock.requests
    .slice(start)
    .find((item) => JSON.stringify(item.messages).includes("project default proof"));
  expect(captured).toBeDefined();
  expect(
    JSON.stringify(
      captured!.messages.filter((item) => item.role === "system" || item.role === "developer"),
    ),
  ).toContain("You are syrup-bot.");
  await page.getByTestId("nav-agents").click();
  await expect(page.locator('[data-agent-name="syrup-bot"]')).toHaveCount(0);
});
