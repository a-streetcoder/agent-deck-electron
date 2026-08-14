import { agentConfigurationWarnings } from "../src/resources.ts";
import { describe, expect, it } from "vitest";

describe("agentConfigurationWarnings", () => {
  it("returns the bounded native warning set and separate skill states", () => {
    const warnings = agentConfigurationWarnings(
      {
        skills: ["missing", "disabled", "duplicate"],
        tools: ["web_search", "web_fetch"],
        extensions: ["/tmp/extension.ts"],
      },
      {
        skillCandidateCounts: new Map([
          ["disabled", 1],
          ["duplicate", 2],
        ]),
        disabledSkills: new Set(["disabled"]),
        exaConfigured: true,
        projectSelected: true,
      },
    );
    expect(warnings.map((warning) => warning.id)).toEqual([
      "skill-missing",
      "skill-disabled",
      "skill-ambiguous",
      "web-fetch-with-exa",
    ]);
    expect(warnings[0]!.message).toMatch(/missing skill.*selected project/i);
    expect(warnings[1]!.message).toMatch(/named-agent launch refuses.*ambient.*skip/i);
    expect(warnings[2]!.message).toMatch(/ambiguous.*duplicate/i);
  });

  it("uses Pi's lowercase, case-sensitive tool names", () => {
    const context = {
      skillCandidateCounts: new Map<string, number>(),
      disabledSkills: new Set<string>(),
      exaConfigured: false,
      projectSelected: false,
    };
    expect(agentConfigurationWarnings({ tools: ["web_search"] }, context)[0]?.id).toBe(
      "exa-key-missing",
    );
    expect(agentConfigurationWarnings({ tools: ["WEB_SEARCH"] }, context)).toEqual([]);
  });

  it("warns for Exa tools without a key and extensions without direct tools", () => {
    expect(
      agentConfigurationWarnings(
        { tools: ["fetch_content"], extensions: ["x.ts"] },
        {
          skillCandidateCounts: new Map(),
          disabledSkills: new Set(),
          exaConfigured: false,
          projectSelected: false,
        },
      ).map((warning) => warning.id),
    ).toEqual(["exa-key-missing"]);
    expect(
      agentConfigurationWarnings(
        { extensions: ["x.ts"] },
        {
          skillCandidateCounts: new Map(),
          disabledSkills: new Set(),
          exaConfigured: false,
          projectSelected: false,
        },
      )[0]?.id,
    ).toBe("extensions-without-tools");
  });
});
