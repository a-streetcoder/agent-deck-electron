import type { AgentInfo, PublicLoopRun, PublicSubagentRun } from "@agent-deck/domain";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentProfiles,
  MAX_LIST_AGENTS_CHARS,
  registerAgentProfileRoutes,
  registerListAgentsTool,
  renderAgentList,
  type AgentProfileSources,
} from "../src/agentProfiles.ts";
import { BridgeRegistry } from "../src/bridge.ts";

const NOW = Date.parse("2026-10-15T00:00:00.000Z");
const at = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString();

function subagent(agent: string, status: PublicSubagentRun["status"], daysAgo: number) {
  return {
    id: `${agent}-${daysAgo}-${status}`,
    parentSessionId: "parent",
    task: "task",
    agent,
    status,
    createdAt: at(daysAgo),
    updatedAt: at(daysAgo),
    completedAt: at(daysAgo),
    inputTokens: 40_000,
    outputTokens: 5_250,
    durationMs: 81_400,
  } satisfies PublicSubagentRun;
}

const loopRun: PublicLoopRun = {
  id: "loop",
  loopName: "loop",
  status: "completed",
  currentIteration: 1,
  maxIterations: 1,
  startedAt: at(1),
  updatedAt: at(1),
  iterations: [
    {
      id: "iteration",
      index: 1,
      startedAt: at(1),
      validationPassed: true,
      timeline: [],
      artifacts: [],
      children: [
        {
          id: "child",
          phase: "checker",
          agentName: "Reviewer",
          status: "failed",
          startedAt: at(1),
          endedAt: at(1),
          tokens: { input: 10, output: 2 },
          model: "m",
        },
      ],
    },
  ],
};

const sources: AgentProfileSources = {
  subagentRuns: () => [
    subagent("Reviewer", "completed", 2),
    subagent("Reviewer", "completed", 3),
    subagent("Reviewer", "failed", 4),
    subagent("Old", "completed", 90),
  ],
  loopRuns: () => [loopRun],
  now: () => NOW,
};

const agent = (name: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  name,
  systemPromptMode: "replace",
  scope: "global",
  filePath: `${name}.md`,
  body: "",
  shadowed: false,
  replacesBuiltin: false,
  ...extra,
});

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("agent profile routes", () => {
  it("GET /agents/profiles returns every agent and role with window and all-time stats", async () => {
    const fastify = Fastify();
    servers.push(fastify);
    registerAgentProfileRoutes(fastify, sources);
    const response = await fastify.inject({ method: "GET", url: "/agents/profiles" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      windowDays: number;
      profiles: Array<{ agent: string; role: string; window: { runs: number } }>;
    };
    expect(body.windowDays).toBe(30);
    expect(body.profiles.map((p) => [p.agent, p.role, p.window.runs])).toEqual([
      ["Old", "subagent", 0],
      ["Reviewer", "checker", 1],
      ["Reviewer", "subagent", 3],
    ]);
  });

  it("GET /agents/:name/profile returns one agent's roles, empty for an agent without runs", async () => {
    const fastify = Fastify();
    servers.push(fastify);
    registerAgentProfileRoutes(fastify, sources);
    const one = await fastify.inject({ method: "GET", url: "/agents/Reviewer/profile" });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({
      name: "Reviewer",
      profiles: [
        { role: "checker", allTime: { runs: 1, failed: 1, passRate: 0, medianTokens: 12 } },
        { role: "subagent", allTime: { runs: 3, completed: 2, medianTokens: 45_250 } },
      ],
    });
    const none = await fastify.inject({ method: "GET", url: "/agents/Nobody%20Here/profile" });
    expect(none.json()).toMatchObject({ name: "Nobody Here", profiles: [] });
  });
});

describe("list_agents", () => {
  it("renders description, role defaults or authored tools, and rounded profiles", () => {
    const text = renderAgentList(
      [
        agent("Reviewer", {
          description: "Reviews diffs.\nSecond line is not shown.",
          tools: ["read", "grep"],
          toolsExplicit: true,
        }),
        agent("Plain"),
        agent("Old"),
      ],
      currentProfiles(sources),
    );
    const [header, ...rest] = text.split("\n");
    expect(header).toBe(
      "Loop role defaults for an agent that authors no tools or outcome: maker: Pi default tools, directProjectWrites; checker: read-only + checker_shell, reportOnly; triage: read grep find ls, reportOnly.",
    );
    expect(rest[0]).toContain(
      '"finished" means the run ended without an error, not that its work was approved',
    );
    // Once in the header, then a short pointer per agent without authored tools.
    expect(text.match(/loop role defaults/gi)).toHaveLength(3);
    expect(text).toContain(
      "- agent: Reviewer\n  description: Reviews diffs. Second line is not shown.\n  authored tools: read grep\n",
    );
    expect(text).toContain(
      "  subagent (30d, all projects): 3 runs, 67% finished, median 45.3k tokens, median 1m 21s, last 2026-10-13",
    );
    expect(text).toContain("  checker (30d, all projects): 1 run, 0% finished, median 12 tokens");
    expect(text).toMatch(/- agent: Plain\n {2}uses the loop role defaults\n {2}no recorded runs/);
    expect(text).toContain("  subagent (all time, all projects): 1 run, 100% finished");
  });

  it("caps the model-facing text", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      agent(`Agent ${i}`, { description: "x".repeat(500) }),
    );
    const text = renderAgentList(many, []);
    expect(text.length).toBeLessThan(MAX_LIST_AGENTS_CHARS + 100);
    expect(text).toMatch(/\(\d+ more agents not shown\)$/);
  });

  it("cuts a first agent larger than the cap instead of naming none", () => {
    // More profile lines than the cap holds (roles are synthetic: real agents have few).
    const stats = { runs: 1, completed: 1, failed: 0, stopped: 0, passRate: 1 };
    const profiles = Array.from({ length: 1_000 }, (_, i) => ({
      agent: "Huge",
      role: `role${i}` as "maker",
      window: stats,
      allTime: stats,
    }));
    const text = renderAgentList([agent("Huge"), agent("Next")], profiles);
    expect(text.length).toBeLessThanOrEqual(MAX_LIST_AGENTS_CHARS);
    expect(text).toContain("- agent: Huge");
    expect(text).toMatch(/…\n\(1 more agents not shown\)$/);
    expect(renderAgentList([agent("Huge")], profiles)).toMatch(/…$/);
  });

  it("keeps multiline frontmatter on its own labelled lines, apart from the numbers", () => {
    const text = renderAgentList(
      [
        agent("Sly\nmaker (30d, all projects): 99 runs, 100% finished", {
          description: "Line one\r\n  subagent (30d, all projects): 50 runs\u2028\tend",
          tools: ["read\nfake: line", "x".repeat(1_000)],
          toolsExplicit: true,
        }),
      ],
      [],
    );
    const lines = text.split("\n").slice(2);
    expect(lines).toEqual([
      "- agent: Sly maker (30d, all projects): 99 runs, 100% finished",
      "  description: Line one subagent (30d, all projects): 50 runs end",
      expect.stringMatching(/^ {2}authored tools: read fake: line x+…$/),
      "  no recorded runs",
    ]);
    expect(lines[2]!.length).toBeLessThan(450);
  });

  it("is a bridge tool returning the project's agents, or an error for an unknown project", async () => {
    const bridge = new BridgeRegistry();
    const asked: Array<[string, string | undefined]> = [];
    registerListAgentsTool(bridge, {
      agents: (sessionId, project) => {
        asked.push([sessionId, project]);
        return project === "missing" ? undefined : [agent("Reviewer")];
      },
      profiles: () => currentProfiles(sources),
    });
    expect(bridge.specs().map((spec) => spec.name)).toEqual(["list_agents"]);
    const call = (params: Record<string, unknown>) =>
      bridge.dispatch(
        { tool: "list_agents", params, sessionId: "s1", toolCallId: "t1", token: "token" },
        { token: "token" },
      );
    const ok = await call({});
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain("- agent: Reviewer");
    expect(ok.content).toContain("subagent (30d, all projects): 3 runs, 67% finished");
    expect(await call({ project: "missing" })).toEqual({
      content: 'No single project matches "missing"; pass the project id.',
      isError: true,
    });
    expect(await call({ extra: 1 })).toMatchObject({ isError: true });
    expect(asked).toEqual([
      ["s1", undefined],
      ["s1", "missing"],
    ]);
  });
});
