import type { AgentInfo, AgentWarningContext, PromptInfo } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { aggregateConfigurationWarnings } from "../src/configurationWarnings.ts";

/**
 * DOC-05: native's Doctor page carries a Warnings card built from ONE flat list
 * (`PiScanner.buildWarnings`) covering every agent, skill and prompt. This port
 * already computed the per-agent conditions — and three native lacks — but only
 * ever showed them on the agent that owned them, so a user had to visit each
 * resource to discover a problem. This aggregates the SAME rules; it must never
 * become a second copy of them.
 */

const agent = (over: Partial<AgentInfo> = {}): AgentInfo =>
  ({
    name: "reviewer",
    description: "Review changes",
    scope: "global",
    filePath: "/home/.pi/agent/agents/reviewer.md",
    body: "",
    shadowed: false,
    replacesBuiltin: false,
    ...over,
  }) as AgentInfo;

const prompt = (name: string, scope: PromptInfo["scope"], filePath: string): PromptInfo =>
  ({ name, scope, filePath, body: "", invocation: `/${name}` }) as PromptInfo;

const context = (over: Partial<AgentWarningContext> = {}): AgentWarningContext => ({
  skillCandidateCounts: new Map(),
  disabledSkills: new Set(),
  exaConfigured: false,
  projectSelected: false,
  ...over,
});

describe("aggregated configuration warnings (DOC-05)", () => {
  it("names the agent each warning came from", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [agent({ name: "reviewer", skills: ["ghost"] })],
      warningContext: context(),
      prompts: [],
    });

    expect(warnings).toHaveLength(1);
    // Native's aggregated messages lead with the agent, because the card is read
    // away from the resource it describes.
    expect(warnings[0]!.message).toContain("reviewer");
    expect(warnings[0]!.message).toContain("ghost");
    expect(warnings[0]!.id).toBe("agent:global:reviewer:skill-missing");
  });

  it("collects across every agent, not just the first with a problem", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [
        agent({ name: "alpha", skills: ["ghost"] }),
        agent({ name: "beta", extensions: ["/x.ts"], tools: [] }),
      ],
      warningContext: context(),
      prompts: [],
    });

    expect(warnings.map((warning) => warning.id)).toEqual([
      "agent:global:alpha:skill-missing",
      "agent:global:beta:extensions-without-tools",
    ]);
  });

  it("reports a prompt name that exists in more than one scope", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [],
      warningContext: context(),
      prompts: [
        prompt("review", "global", "/home/.pi/agent/prompts/review.md"),
        prompt("review", "project", "/repo/.pi/agent/prompts/review.md"),
      ],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toBe("duplicate-prompt:review");
    // Both locations, so the user can tell which copy to delete.
    expect(warnings[0]!.message).toContain("/home/.pi/agent/prompts/review.md");
    expect(warnings[0]!.message).toContain("/repo/.pi/agent/prompts/review.md");
  });

  it("does not call a single prompt a duplicate", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [],
      warningContext: context(),
      prompts: [prompt("review", "global", "/home/.pi/agent/prompts/review.md")],
    });

    expect(warnings).toEqual([]);
  });

  it("treats the same file reached twice as one prompt", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [],
      warningContext: context(),
      prompts: [
        prompt("review", "global", "/home/.pi/agent/prompts/review.md"),
        prompt("review", "global", "/home/.pi/agent/prompts/review.md"),
      ],
    });

    // A scan that surfaces one file under two roots is not a user-visible
    // conflict, and native dedupes before deciding (dedupePromptWarningRecords).
    expect(warnings).toEqual([]);
  });

  it("ignores a shadowed definition the user cannot launch", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [agent({ name: "reviewer", skills: ["ghost"], shadowed: true })],
      warningContext: context(),
      prompts: [],
    });

    // Native aggregates its EFFECTIVE agents; a shadowed file is not in play,
    // so warning about it sends the user to fix the wrong copy.
    expect(warnings).toEqual([]);
  });

  it("ignores an agent the user turned off", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [agent({ name: "reviewer", skills: ["ghost"], disabled: true })],
      warningContext: context(),
      prompts: [],
    });

    // This codebase spells "effective" as !shadowed && !disabled; a disabled
    // agent cannot launch, so its configuration is not a problem to fix.
    expect(warnings).toEqual([]);
  });

  it("keeps same-name agents from different scopes apart", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [
        agent({ name: "reviewer", scope: "global", skills: ["ghost"] }),
        agent({ name: "reviewer", scope: "project", skills: ["ghost"] }),
      ],
      warningContext: context(),
      prompts: [],
    });

    // Colliding ids would collide as React keys in the Doctor list.
    expect(new Set(warnings.map((warning) => warning.id)).size).toBe(2);
  });

  it("sorts by message, so the card is stable between refreshes", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [
        agent({ name: "zulu", skills: ["ghost"] }),
        agent({ name: "alpha", skills: ["ghost"] }),
      ],
      warningContext: context(),
      prompts: [],
    });

    expect(warnings.map((warning) => warning.message)).toEqual(
      [...warnings.map((warning) => warning.message)].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "accent" }),
      ),
    );
    expect(warnings[0]!.message).toContain("alpha");
  });

  it("says nothing when every resource is healthy", () => {
    const warnings = aggregateConfigurationWarnings({
      agents: [agent({ name: "reviewer", skills: ["known"] })],
      warningContext: context({ skillCandidateCounts: new Map([["known", 1]]) }),
      prompts: [],
    });

    expect(warnings).toEqual([]);
  });
});
