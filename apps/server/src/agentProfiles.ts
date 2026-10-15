// A6: capability profiles over the run stores. Routes for the Agents screen and the
// list_agents bridge tool a parent uses to choose an agent on reliability.
import {
  aggregateCapabilityProfiles,
  type AgentInfo,
  type CapabilityProfile,
  type CapabilityStats,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "@agent-deck/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BridgeRegistry } from "./bridge.ts";
import { loopRoleLaunchDefaults } from "./loopEngine.ts";

export const PROFILE_WINDOW_DAYS = 30;
/** Model-facing caps: one description line, and the whole list_agents result. */
const MAX_DESCRIPTION_CHARS = 200;
export const MAX_LIST_AGENTS_CHARS = 12_000;

export interface AgentProfileSources {
  subagentRuns(): PublicSubagentRun[];
  loopRuns(): PublicLoopRun[];
  now?(): number;
}

export function currentProfiles(sources: AgentProfileSources): CapabilityProfile[] {
  return aggregateCapabilityProfiles(sources.subagentRuns(), sources.loopRuns(), {
    now: sources.now?.() ?? Date.now(),
    windowDays: PROFILE_WINDOW_DAYS,
  });
}

/**
 * Profiles are keyed by agent name across projects: on the shared server every run
 * is visible to every co-worker, and a name is what a parent delegates to.
 */
export function registerAgentProfileRoutes(
  fastify: FastifyInstance,
  sources: AgentProfileSources,
): void {
  fastify.get("/agents/profiles", async () => ({
    windowDays: PROFILE_WINDOW_DAYS,
    profiles: currentProfiles(sources),
  }));
  fastify.get("/agents/:name/profile", async (request, reply) => {
    const parsed = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .safeParse((request.params as { name?: unknown }).name);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid agent name." });
    return {
      name: parsed.data,
      windowDays: PROFILE_WINDOW_DAYS,
      profiles: currentProfiles(sources).filter((profile) => profile.agent === parsed.data),
    };
  });
}

const tokensText = (value: number): string =>
  value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;

function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statsText(stats: CapabilityStats): string {
  const parts = [
    `${stats.runs} run${stats.runs === 1 ? "" : "s"}`,
    stats.passRate === null ? "pass rate n/a" : `${Math.round(stats.passRate * 100)}% pass`,
  ];
  if (stats.medianTokens !== undefined)
    parts.push(`median ${tokensText(stats.medianTokens)} tokens`);
  if (stats.medianDurationMs !== undefined)
    parts.push(`median ${durationText(stats.medianDurationMs)}`);
  if (stats.lastRunAt) parts.push(`last ${stats.lastRunAt.slice(0, 10)}`);
  return parts.join(", ");
}

/** What a loop role gives an agent that authors no `tools:` or outcome (D6 defaults). */
function roleDefaultsText(): string {
  return (["maker", "checker", "triage"] as const)
    .map((phase) => {
      const defaults = loopRoleLaunchDefaults(phase, "currentCheckout");
      const tools =
        defaults.defaultTools?.join(" ") ??
        (defaults.toolPolicy === "readOnly"
          ? "read-only"
          : defaults.toolPolicy === "none"
            ? "no tools"
            : "Pi default tools");
      return `${phase}: ${tools}${defaults.checkerShell ? " + checker_shell" : ""}, ${defaults.defaultExpectedOutcome}`;
    })
    .join("; ");
}

/** The list_agents text: one block per agent, numbers rounded, capped as a whole. */
export function renderAgentList(
  agents: readonly AgentInfo[],
  profiles: readonly CapabilityProfile[],
): string {
  if (!agents.length) return "No agents are available in this project.";
  const blocks = agents.map((agent) => {
    const description = (agent.description ?? "").split(/\r?\n/, 1)[0]!.trim();
    const lines = [
      `- ${agent.name}${description ? `: ${description.slice(0, MAX_DESCRIPTION_CHARS)}` : ""}`,
    ];
    if (agent.toolsExplicit || agent.defaultExpectedOutcome) {
      const authored = [
        agent.toolsExplicit ? `tools ${agent.tools?.join(" ") || "(none)"}` : "",
        agent.defaultExpectedOutcome ? `outcome ${agent.defaultExpectedOutcome}` : "",
      ].filter(Boolean);
      lines.push(`  authored: ${authored.join("; ")}`);
    } else {
      lines.push(`  loop role defaults: ${roleDefaultsText()}`);
    }
    const own = profiles.filter((profile) => profile.agent === agent.name);
    if (!own.length) lines.push("  no recorded runs");
    for (const profile of own) {
      const recent = profile.window.runs > 0;
      lines.push(
        `  ${profile.role} (${recent ? `${PROFILE_WINDOW_DAYS}d` : "all time"}): ${statsText(recent ? profile.window : profile.allTime)}`,
      );
    }
    return lines.join("\n");
  });
  let text = "";
  for (const [index, block] of blocks.entries()) {
    if (text.length + block.length + 1 > MAX_LIST_AGENTS_CHARS) {
      return `${text}\n(${blocks.length - index} more agents not shown)`;
    }
    text += `${text ? "\n" : ""}${block}`;
  }
  return text;
}

export interface ListAgentsDeps {
  /** The project's agents (curated as the pickers show them); undefined = unknown project. */
  agents(sessionId: string, project?: string): AgentInfo[] | undefined;
  profiles(): CapabilityProfile[];
}

export function registerListAgentsTool(bridge: BridgeRegistry, deps: ListAgentsDeps): void {
  const params = z.object({ project: z.string().trim().min(1).max(500).optional() }).strict();
  bridge.register(
    {
      name: "list_agents",
      label: "List agents",
      description:
        "List the named agents you can delegate to in this project (or another project, by id or name): each one's description, its loop role defaults or authored tools, and how its recent runs went per role (runs, pass rate, median tokens and duration, last run). Use it to choose an agent before managed_subagent or spawn_subagent.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Optional project id or name; defaults to this session's project.",
          },
        },
        additionalProperties: false,
      },
      promptSnippet:
        "list_agents(project?) — the agents you can delegate to, with their run record.",
    },
    (raw, ctx) => {
      const parsed = params.safeParse(raw);
      if (!parsed.success) {
        return { content: `Invalid list_agents arguments: ${parsed.error.message}`, isError: true };
      }
      const agents = deps.agents(ctx.sessionId, parsed.data.project);
      if (!agents) return { content: `Unknown project: ${parsed.data.project}`, isError: true };
      return { content: renderAgentList(agents, deps.profiles()) };
    },
  );
}
