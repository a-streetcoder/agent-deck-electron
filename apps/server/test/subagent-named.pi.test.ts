import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_NOREASON_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import type { SubagentCell } from "@agent-deck/domain";
import { graphemeCount } from "@agent-deck/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Named subagents: `managed_subagent{task, agent}` delegates to one of the
 * globally installed agents. The child adopts that agent's persona (its body is
 * COMPOSED into the subagent operating prompt, never replacing it), and the
 * Subagent cell records the agent name. An unknown agent fails cleanly.
 */

process.env.AGENT_DECK_TEST = "1";

const PERSONA_SENTINEL = "PERSONA_SENTINEL: You are Reviewer Bot, a meticulous code reviewer.";
const SKILL_SENTINEL = "PROJECT_MODERN_SKILL_SENTINEL_REVIEW_CHECKLIST";
const EXTENSION_SENTINEL = "NAMED_AGENT_EXTENSION_SENTINEL";

let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const project = mkdtempSync(path.join(tmpdir(), "pi-named-subagent-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const namedExtensionPath = path.join(tmpHome, ".pi", "agent", "extensions", "named-agent.ts");

function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((m) => m.role === "developer" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** The child is identifiable by its subagent operating prompt. */
function isChildRequest(body: ChatCompletionRequest): boolean {
  return systemText(body).includes("focused subagent launched by Agent Deck");
}

beforeAll(async () => {
  mock = await startMockProvider({
    // The PARENT delegates (never the child, never after the tool result lands).
    // "use-ghost" in the prompt exercises the unknown-agent path.
    toolCall: (lastUser, body) => {
      if (isChildRequest(body)) return null;
      if (lastUser.includes("continue-review")) {
        const history = JSON.stringify(body.messages);
        const runId = /Deck subagent ID: ([0-9a-f-]{36})/i.exec(history)?.[1];
        return runId
          ? {
              name: "managed_subagent",
              arguments: {
                task: "Continue the review.",
                agent: "reviewer-bot",
                continueSubagentID: runId,
              },
            }
          : null;
      }
      if (body.messages.some((m) => m.role === "tool")) return null;
      const agent = lastUser.includes("use-ghost")
        ? "ghost-bot"
        : lastUser.includes("use-fallback")
          ? "fallback-bot"
          : lastUser.includes("use-missing-skill")
            ? "missing-skill-bot"
            : lastUser.includes("use-no-read")
              ? "no-read-bot"
              : "reviewer-bot";
      return { name: "managed_subagent", arguments: { task: "Review the diff.", agent } };
    },
    reply: (_lastUser, body) =>
      isChildRequest(body) ? "CHILD_REVIEW_SENTINEL: looks good." : "Delegated and done.",
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);

  // All ordered standard catalogs contain this name. The selected project's
  // canonical .agents entry must be the sole launch winner (not ambiguity).
  for (const [skillDir, sentinel] of [
    [path.join(tmpHome, ".pi", "agent", "skills", "review-checklist"), "GLOBAL_MODERN"],
    [path.join(tmpHome, ".agents", "skills", "review-checklist"), "GLOBAL_LEGACY"],
    [path.join(project, ".pi", "skills", "review-checklist"), "PROJECT_PI"],
    [path.join(project, ".agents", "skills", "review-checklist"), SKILL_SENTINEL],
  ] as const) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nname: review-checklist\ndescription: ${sentinel} — run each review step in order\n---\n\nWork through the checklist strictly.\n`,
    );
  }

  mkdirSync(path.dirname(namedExtensionPath), { recursive: true });
  writeFileSync(
    namedExtensionPath,
    `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n\\n${EXTENSION_SENTINEL}" }));
}
`,
  );

  // A named global agent with a distinctive persona body, a declared model
  // distinct from the session default (proves the child runs on the AGENT's
  // model), an assigned skill, and a thinking level — all of which the child
  // must adopt via the shared named-agent resolver.
  const agentsDir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "reviewer-bot.md"),
    `---\nname: reviewer-bot\ndescription: Meticulous reviewer\nmodel: ${MOCK_NOREASON_MODEL_ID}\nthinking: low\ntools: read, write, edit, bash, mcp:remote-mutate\nskills: review-checklist\nextensions:\n  - ${namedExtensionPath}\ndefaultExpectedOutcome: directProjectWrites\noutput: Concise quoted review summary\n---\n\n${PERSONA_SENTINEL}\n`,
  );
  writeFileSync(
    path.join(agentsDir, "fallback-bot.md"),
    "---\nname: fallback-bot\ntools: read, write\n---\n\nUse the safe default.\n",
  );
  writeFileSync(
    path.join(agentsDir, "no-tools-bot.md"),
    "---\nname: no-tools-bot\ntools: []\n---\n\nNo tools.\n",
  );
  writeFileSync(
    path.join(agentsDir, "default-tools-bot.md"),
    "---\nname: default-tools-bot\n---\n\nPi defaults.\n",
  );
  writeFileSync(
    path.join(agentsDir, "missing-skill-bot.md"),
    "---\nname: missing-skill-bot\ntools: read\nskills: absent-private-skill\n---\n\nMissing skill test.\n",
  );
  writeFileSync(
    path.join(agentsDir, "no-read-bot.md"),
    "---\nname: no-read-bot\ntools: grep\nskills: review-checklist\n---\n\nNo read test.\n",
  );

  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: tmpHome });
  server = await startServer({ dataDir });
  const created = (await (
    await fetch(`http://127.0.0.1:${server.port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })
  ).json()) as { project: { id: string } };
  projectId = created.project.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_PI_ENV;
});

/** The mock provider's request log is shared by every session this file
 * starts, and a real-Pi turn can land its request well after the test that
 * triggered it returned. Any assertion of the form "this call added no
 * request" must therefore baseline against a SETTLED counter, not a live one.
 * Returns the count once it has held steady for 250ms (5s cap). */
async function quiescedRequestCount(): Promise<number> {
  let last = mock.requests.length;
  let steadyTicks = 0;
  const deadline = Date.now() + 5_000;
  while (steadyTicks < 10 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (mock.requests.length === last) {
      steadyTicks += 1;
    } else {
      last = mock.requests.length;
      steadyTicks = 0;
    }
  }
  return last;
}

async function startSession(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: project,
      projectId,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
      env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
    }),
  });
  expect(response.status).toBe(201);
  const { session } = (await response.json()) as { session: { id: string } };
  return session.id;
}

describe("managed_subagent{agent}: named delegation", () => {
  it("composes the named agent's persona into the child and records the name on the cell", async () => {
    const id = await startSession();
    const deltas: Array<{ seq: number; delta: string }> = [];
    const unsubscribe = server.sessions.get(id)!.bus.subscribe((event) => {
      if (event.event.type === "subagent_delta") {
        deltas.push({ seq: event.seq, delta: event.event.delta });
      }
    });
    await server.sessions.get(id)!.prompt("delegate a code review");
    await server.receipts.waitFor("idle", id);

    // The child ran with the agent's persona COMPOSED IN — its system prompt has
    // both the agent body AND the subagent operating prompt (not replaced).
    const childRequest = mock.requests.find(isChildRequest);
    expect(childRequest).toBeDefined();
    const childSystem = systemText(childRequest!);
    expect(childSystem).toContain(PERSONA_SENTINEL);
    expect(childSystem).toContain("focused subagent launched by Agent Deck");
    expect(childSystem).toContain("Configured default outcome: Direct project writes");
    expect(childSystem).toContain(
      "Effective outcome: Direct project work in the current child working directory",
    );
    expect(childSystem).toContain("actual project checkout");
    expect(childSystem).toContain("does not grant any additional tool");
    expect(childSystem).toContain("# Named agent output advisory");
    expect(childSystem).toContain('Configured output: "Concise quoted review summary"');
    expect(childSystem).toContain("does not grant tools");
    expect(childSystem).toContain("select Agent Deck artifact output.md");
    expect(childSystem).toContain("validate or authorize a project path");
    expect(childSystem).toContain("create a worktree");

    const childToolNames = (Array.isArray(childRequest!.tools) ? childRequest!.tools : []).flatMap(
      (tool) => {
        const fn =
          tool && typeof tool === "object"
            ? (tool as { function?: { name?: unknown } }).function
            : undefined;
        return typeof fn?.name === "string" ? [fn.name] : [];
      },
    );
    expect(childToolNames).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "contact_supervisor",
        "agent_deck_memory_write",
        "agent_deck_memory_search",
        "agent_deck_memory_mark_stale",
      ]),
    );
    // Native defaults automatic named-child memory context on. With an empty
    // project library the policy is present and no recall body is fabricated.
    expect(childSystem).toContain("Agent Deck memory policy:");
    expect(childSystem).not.toContain('<memory-context source="Agent Deck"');

    // The child inherited the agent's TOOLS + SKILL together: pi only injects the
    // skills section when `read` is in the allowlist, so the skill sentinel in the
    // child's system prompt proves BOTH the agent's `read` tool AND its assigned
    // skill were threaded into the child launch.
    expect(childSystem).toContain(SKILL_SENTINEL);
    // The named agent's explicit catalog allowlist reaches the real child Pi.
    expect(childSystem).toContain(EXTENSION_SENTINEL);

    // The child ran on the AGENT's declared model, not the session default.
    expect(childRequest!.model).toBe(MOCK_NOREASON_MODEL_ID);
    expect(MOCK_NOREASON_MODEL_ID).not.toBe(MOCK_MODEL_ID);

    // The Subagent cell in the parent transcript records which agent it used.
    const cells = server.sessions
      .get(id)!
      .snapshot()
      .state.cells.filter((c): c is SubagentCell => c.kind === "subagent");
    expect(cells).toHaveLength(1);
    expect(cells[0]!.agentName).toBe("reviewer-bot");

    unsubscribe();
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map(({ seq }) => seq)).toEqual(
      deltas.map(({ seq }) => seq).sort((a, b) => a - b),
    );
    expect(deltas.map(({ delta }) => delta).join("")).toBe("CHILD_REVIEW_SENTINEL: looks good.");
  });

  it("opts a real managed child into bounded policy, index, and task recall", async () => {
    const title = `Child OAuth memory ${Date.now()}`;
    const body = "CHILD_OPT_IN_RELEVANT_BODY " + "👨‍👩‍👧‍👦".repeat(1500);
    const created = await fetch(`http://127.0.0.1:${server.port}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        type: "decision",
        title,
        summary: "oauth callback review delegated child",
        body,
      }),
    });
    expect(created.status).toBe(201);
    const changed = await fetch(`http://127.0.0.1:${server.port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentMemorySubagentsEnabled: true,
        agentMemoryInjectionCharacterBudget: 1000,
      }),
    });
    expect(changed.status).toBe(200);
    try {
      const before = mock.requests.length;
      const id = await startSession();
      await server.sessions.get(id)!.prompt("delegate a code review");
      await server.receipts.waitFor("idle", id);
      const child = mock.requests.slice(before).find(isChildRequest);
      expect(child).toBeDefined();
      const system = systemText(child!);
      expect(system).toContain("Agent Deck memory policy:");
      expect(system).toContain(title);
      expect(system).toContain("CHILD_OPT_IN_RELEVANT_BODY");
      const recall = system.match(/<memory-context[\s\S]*?<\/memory-context>/)?.[0];
      expect(recall).toBeDefined();
      expect(graphemeCount(recall!)).toBeLessThanOrEqual(1000);
      const names = (Array.isArray(child!.tools) ? child!.tools : []).flatMap((tool) => {
        const fn =
          tool && typeof tool === "object"
            ? (tool as { function?: { name?: unknown } }).function
            : undefined;
        return typeof fn?.name === "string" ? [fn.name] : [];
      });
      expect(names).toEqual(
        expect.arrayContaining([
          "agent_deck_memory_write",
          "agent_deck_memory_search",
          "agent_deck_memory_mark_stale",
        ]),
      );
    } finally {
      await fetch(`http://127.0.0.1:${server.port}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentMemorySubagentsEnabled: true,
          agentMemoryInjectionCharacterBudget: 6000,
        }),
      });
    }
  });

  it("keeps child memory tools but omits automatic context when child context is off", async () => {
    const changed = await fetch(`http://127.0.0.1:${server.port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentMemorySubagentsEnabled: false }),
    });
    expect(changed.status).toBe(200);
    try {
      const before = mock.requests.length;
      const id = await startSession();
      await server.sessions.get(id)!.prompt("delegate without automatic memory context");
      await server.receipts.waitFor("idle", id);
      const child = mock.requests.slice(before).find(isChildRequest);
      expect(child).toBeDefined();
      const system = systemText(child!);
      expect(system).not.toContain("Agent Deck memory policy:");
      expect(system).not.toContain('<memory-context source="Agent Deck"');
      const tools = JSON.stringify(child!.tools ?? []);
      expect(tools).toContain("agent_deck_memory_write");
      expect(tools).toContain("agent_deck_memory_search");
      expect(tools).toContain("agent_deck_memory_mark_stale");
    } finally {
      await fetch(`http://127.0.0.1:${server.port}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentMemorySubagentsEnabled: true }),
      });
    }
  });

  it("omits both child context and memory tools when master memory is paused", async () => {
    const paused = await fetch(`http://127.0.0.1:${server.port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentMemoryEnabled: false, agentMemorySubagentsEnabled: true }),
    });
    expect(paused.status).toBe(200);
    try {
      const before = mock.requests.length;
      const id = await startSession();
      await server.sessions.get(id)!.prompt("delegate a code review");
      await server.receipts.waitFor("idle", id);
      const child = mock.requests.slice(before).find(isChildRequest);
      expect(child).toBeDefined();
      const system = systemText(child!);
      expect(system).not.toContain('<memory-context source="Agent Deck"');
      expect(system).not.toContain('<memory-recall source="Agent Deck"');
      const tools = JSON.stringify(child!.tools ?? []);
      expect(tools).not.toContain("agent_deck_memory_");
      expect(tools).toContain("contact_supervisor");
    } finally {
      await fetch(`http://127.0.0.1:${server.port}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentMemoryEnabled: true, agentMemorySubagentsEnabled: true }),
      });
    }
  });

  it("reapplies the named output advisory to a continuation prompt", async () => {
    const id = await startSession();
    await server.sessions.get(id)!.prompt("delegate a code review");
    await server.receipts.waitFor("idle", id);
    const beforeContinuation = mock.requests.length;

    await server.sessions.get(id)!.prompt("continue-review");
    let continuedChild: ChatCompletionRequest | undefined;
    const deadline = Date.now() + 30_000;
    while (!continuedChild && Date.now() < deadline) {
      continuedChild = mock.requests.slice(beforeContinuation).find(isChildRequest);
      if (!continuedChild) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(continuedChild).toBeDefined();
    const continuedSystem = systemText(continuedChild!);
    expect(continuedSystem).toContain("This is a continuation of your own child session");
    expect(continuedSystem).toContain("# Named agent output advisory");
    expect(continuedSystem).toContain('Configured output: "Concise quoted review summary"');
    expect(continuedSystem).toContain("does not grant tools");
  });

  it("falls back an unspecified named outcome to an enforced report-only contract", async () => {
    const id = await startSession();
    const before = mock.requests.length;
    await server.sessions.get(id)!.prompt("delegate and use-fallback");
    await server.receipts.waitFor("idle", id);

    const childRequest = mock.requests
      .slice(before)
      .findLast(
        (request) =>
          isChildRequest(request) && systemText(request).includes("# Agent: fallback-bot"),
      )!;
    const childSystem = systemText(childRequest);
    expect(childSystem).toContain("Configured default outcome: Report only");
    expect(childSystem).toContain("Effective outcome: Report only");
    const tools = JSON.stringify(childRequest.tools);
    expect(tools).toContain('"name":"read"');
    // The default outcome adds nothing, but it also does not revoke the named
    // agent's already-configured capability.
    expect(tools).toContain('"name":"write"');
  });

  it("refuses a named extension after it is globally disabled", async () => {
    const disabled = await fetch(`http://127.0.0.1:${server.port}/resources/extensions/disabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: namedExtensionPath, disabled: true }),
    });
    expect(disabled.status).toBe(200);

    const before = mock.requests.length;
    const id = await startSession();
    await server.sessions.get(id)!.prompt("delegate a code review");
    await server.receipts.waitFor("idle", id);
    const childRequest = mock.requests.slice(before).findLast(isChildRequest);
    expect(childRequest).toBeDefined();
    expect(systemText(childRequest!)).not.toContain(EXTENSION_SENTINEL);
  });

  it.each([
    ["no-tools-bot", false],
    ["default-tools-bot", true],
  ])(
    "preserves explicit-empty versus absent tools for named parent Pi (%s)",
    async (agentName, hasDefaults) => {
      const start = mock.requests.length;
      const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          agentName,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
          env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
        }),
      });
      expect(response.status).toBe(201);
      const { session } = (await response.json()) as { session: { id: string } };
      await server.sessions.get(session.id)!.prompt("respond briefly");
      await server.receipts.waitFor("idle", session.id);
      const expectedPersona = agentName === "no-tools-bot" ? "No tools." : "Pi defaults.";
      const request = mock.requests
        .slice(start)
        .find((item) => !isChildRequest(item) && systemText(item).includes(expectedPersona))!;
      expect(request).toBeDefined();
      const names = (Array.isArray(request.tools) ? request.tools : []).flatMap((tool) => {
        const name =
          tool && typeof tool === "object"
            ? (tool as { function?: { name?: unknown } }).function?.name
            : undefined;
        return typeof name === "string" ? [name] : [];
      });
      expect(names.includes("read")).toBe(hasDefaults);
    },
  );

  it.each([
    ["missing-skill-bot", "absent-private-skill"],
    ["no-read-bot", "does not include `read`"],
  ])("fails named parent preflight before Pi spawn (%s)", async (agentName, expected) => {
    // The provider counter is shared with every other session in this file, so
    // a turn started by an EARLIER test can still land its request after this
    // baseline is taken — the assertion below then blames this preflight for
    // someone else's request (Linux CI: "expected 57, got 58"). Take the
    // baseline only once the counter has stopped moving; what this test claims
    // is that a REJECTED preflight spawns no Pi of its own.
    const requestsBefore = await quiescedRequestCount();
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, agentName }),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain(expected);
    expect(mock.requests).toHaveLength(requestsBefore);
  });

  it("fails disabled named skills before parent or child Pi spawn", async () => {
    const disabled = await fetch(`http://127.0.0.1:${server.port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setDisabledSkill: { name: "review-checklist", disabled: true } }),
    });
    expect(disabled.status).toBe(200);
    try {
      const parentRequestsBefore = mock.requests.length;
      const parent = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, agentName: "reviewer-bot" }),
      });
      expect(parent.status).toBe(409);
      expect(await parent.text()).toContain("review-checklist");
      expect(mock.requests).toHaveLength(parentRequestsBefore);

      const id = await startSession();
      const childRequestsBefore = mock.requests.filter(isChildRequest).length;
      await expect(
        server.sessions.get(id)!.runChildAgent("Review the diff.", "reviewer-bot"),
      ).rejects.toThrow(/review-checklist.*disabled/i);
      expect(mock.requests.filter(isChildRequest)).toHaveLength(childRequestsBefore);
    } finally {
      await fetch(`http://127.0.0.1:${server.port}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setDisabledSkill: { name: "review-checklist", disabled: false } }),
      });
    }
  });

  it.each([
    ["missing-skill-bot", /absent-private-skill.*missing/i],
    ["no-read-bot", /does not include `read`/i],
  ])("fails named skill preflight before child Pi spawn (%s)", async (agentName, expected) => {
    const id = await startSession();
    const childRequestsBefore = mock.requests.filter(isChildRequest).length;
    await expect(
      server.sessions.get(id)!.runChildAgent("Review the diff.", agentName),
    ).rejects.toThrow(expected);
    expect(mock.requests.filter(isChildRequest)).toHaveLength(childRequestsBefore);
  });

  it("surfaces a clean error when the named agent does not exist", async () => {
    const id = await startSession();
    await server.sessions.get(id)!.prompt("delegate but use-ghost");
    await server.receipts.waitFor("idle", id);

    // No child ever launched for this session's ghost delegation, and the parent
    // got the failure back as the tool result.
    //
    // Search for THIS session's follow-up rather than assuming it is the last
    // request the mock saw. `mock` and `server` are shared by all 16 tests in
    // this file, so a neighbouring test's request can land last and leave the
    // filter empty — that produced `expected '[]' to contain 'unknown agent:
    // ghost-bot'` on macos at c4e92e6 and again on windows at af96448, at two
    // commits that touched nothing near this path.
    const toolTexts = mock.requests
      .filter((request) => !isChildRequest(request))
      .map((request) => JSON.stringify(request.messages.filter((m) => m.role === "tool")));
    expect(toolTexts.some((text) => text.includes("unknown agent: ghost-bot"))).toBe(true);
  });

  it("fails unassigned custom launch and delegation like an unknown name", async () => {
    const patch = await fetch(`http://127.0.0.1:${server.port}/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignedAgentNames: [] }),
    });
    expect(patch.status).toBe(200);

    const catalog = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/resources/agents?projectId=${encodeURIComponent(projectId)}`,
      )
    ).json()) as { agents: Array<{ name: string; scope: string }> };
    expect(catalog.agents.some((agent) => agent.name === "reviewer-bot")).toBe(false);
    expect(catalog.agents.some((agent) => agent.scope === "builtin")).toBe(true);

    const launch = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, agentName: "reviewer-bot" }),
    });
    expect(launch.status).toBe(404);
    expect(await launch.text()).toContain("unknown agent: reviewer-bot");

    const id = await startSession();
    expect(server.sessions.get(id)!.meta.projectId).toBe(projectId);
    await server.sessions.get(id)!.prompt("delegate a code review");
    await server.receipts.waitFor("idle", id);
    const followUp = mock.requests[mock.requests.length - 1]!;
    expect(
      JSON.stringify(followUp.messages.filter((message) => message.role === "tool")),
    ).toContain("unknown agent: reviewer-bot");
  });
});
