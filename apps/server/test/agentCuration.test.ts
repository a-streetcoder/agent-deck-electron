import type { ProjectMeta } from "@agent-deck/contracts";
import type { AgentInfo } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { curateProjectAgents, projectAllowsAgent } from "../src/agentCuration.ts";

const project = (assignedAgentNames?: string[]): ProjectMeta => ({
  id: "project",
  path: "/tmp/project",
  name: "Project",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(assignedAgentNames === undefined ? {} : { assignedAgentNames }),
});
const agent = (name: string, scope: AgentInfo["scope"]): AgentInfo => ({
  name,
  scope,
  filePath: `/tmp/${name}.md`,
  body: name,
  systemPromptMode: "replace",
  shadowed: false,
  replacesBuiltin: false,
});

describe("project agent curation", () => {
  const builtin = agent("Explore", "builtin");
  const assigned = agent("Reviewer", "global");
  const unassigned = agent("Writer", "library");

  it("preserves the legacy open catalog when the durable field is absent", () => {
    expect(curateProjectAgents(project(), [builtin, assigned, unassigned])).toEqual([
      builtin,
      assigned,
      unassigned,
    ]);
  });

  it("keeps builtins and only assigned custom agents after explicit curation", () => {
    expect(
      curateProjectAgents(project(["Reviewer", "Reviewer"]), [builtin, assigned, unassigned]),
    ).toEqual([builtin, assigned]);
    expect(projectAllowsAgent(project([]), builtin)).toBe(true);
    expect(projectAllowsAgent(project([]), assigned)).toBe(false);
  });
});
