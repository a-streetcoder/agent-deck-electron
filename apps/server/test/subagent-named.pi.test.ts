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
const SKILL_SENTINEL = "SKILL_SENTINEL_REVIEW_CHECKLIST";

let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const project = mkdtempSync(path.join(tmpdir(), "pi-named-subagent-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

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
          : "reviewer-bot";
      return { name: "managed_subagent", arguments: { task: "Review the diff.", agent } };
    },
    reply: (_lastUser, body) =>
      isChildRequest(body) ? "CHILD_REVIEW_SENTINEL: looks good." : "Delegated and done.",
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);

  // A global skill the agent will carry into its delegated child. Its
  // description is injected into the base system prompt (pi buildSystemPrompt
  // gets loadedSkills), so a distinctive sentinel proves it reached the child.
  const skillDir = path.join(tmpHome, ".pi", "agent", "skills", "review-checklist");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: review-checklist\ndescription: ${SKILL_SENTINEL} — run each review step in order\n---\n\nWork through the checklist strictly.\n`,
  );

  // A named global agent with a distinctive persona body, a declared model
  // distinct from the session default (proves the child runs on the AGENT's
  // model), an assigned skill, and a thinking level — all of which the child
  // must adopt via the shared named-agent resolver.
  const agentsDir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "reviewer-bot.md"),
    `---\nname: reviewer-bot\ndescription: Meticulous reviewer\nmodel: ${MOCK_NOREASON_MODEL_ID}\nthinking: low\ntools: read, write, edit, bash, mcp:remote-mutate\nskills: review-checklist\ndefaultExpectedOutcome: directProjectWrites\noutput: Concise quoted review summary\n---\n\n${PERSONA_SENTINEL}\n`,
  );
  writeFileSync(
    path.join(agentsDir, "fallback-bot.md"),
    "---\nname: fallback-bot\ntools: read, write\n---\n\nUse the safe default.\n",
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
    expect(childToolNames).toEqual(expect.arrayContaining(["read", "write", "edit", "bash"]));

    // The child inherited the agent's TOOLS + SKILL together: pi only injects the
    // skills section when `read` is in the allowlist, so the skill sentinel in the
    // child's system prompt proves BOTH the agent's `read` tool AND its assigned
    // skill were threaded into the child launch.
    expect(childSystem).toContain(SKILL_SENTINEL);

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
    await server.sessions.get(id)!.prompt("delegate and use-fallback");
    await server.receipts.waitFor("idle", id);

    const childRequest = [...mock.requests].reverse().find(isChildRequest)!;
    const childSystem = systemText(childRequest);
    expect(childSystem).toContain("Configured default outcome: Report only");
    expect(childSystem).toContain("Effective outcome: Report only");
    const tools = JSON.stringify(childRequest.tools);
    expect(tools).toContain('"name":"read"');
    // The default outcome adds nothing, but it also does not revoke the named
    // agent's already-configured capability.
    expect(tools).toContain('"name":"write"');
  });

  it("surfaces a clean error when the named agent does not exist", async () => {
    const id = await startSession();
    await server.sessions.get(id)!.prompt("delegate but use-ghost");
    await server.receipts.waitFor("idle", id);

    // No child ever launched for this session's ghost delegation, and the parent
    // got the failure back as the tool result.
    const followUp = mock.requests[mock.requests.length - 1]!;
    const toolText = JSON.stringify(followUp.messages.filter((m) => m.role === "tool"));
    expect(toolText).toContain("unknown agent: ghost-bot");
  });
});
