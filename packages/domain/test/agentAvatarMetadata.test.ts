import { describe, expect, it } from "vitest";
import { applyShadowing, type AgentInfo } from "../src/resources.ts";

const agent = (
  scope: AgentInfo["scope"],
  filePath: string,
  avatarUrl: string,
): Omit<AgentInfo, "shadowed" | "replacesBuiltin"> => ({
  name: "writer",
  scope,
  filePath,
  avatarUrl,
  systemPromptMode: "replace",
  body: "Write.",
});

describe("AgentInfo avatar metadata", () => {
  it("preserves each scoped resource's opaque avatar URL through catalog shadowing", () => {
    const agents = applyShadowing([
      agent("builtin", "/bundled/writer.md", "/agent-avatars/builtin?v=one"),
      agent("global", "/home/writer.md", "/agent-avatars/global?v=two"),
    ]);
    expect(agents[0]).toMatchObject({
      scope: "builtin",
      avatarUrl: "/agent-avatars/builtin?v=one",
      shadowed: true,
    });
    expect(agents[1]).toMatchObject({
      scope: "global",
      avatarUrl: "/agent-avatars/global?v=two",
      shadowed: false,
    });
  });
});
