import type { SkillInfo } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { resolveExplicitSkills } from "../src/agentSkillResolution.ts";

const skill = (name: string, baseDir = `/skills/${name}`): SkillInfo => ({
  name,
  description: "test",
  scope: "global",
  filePath: `${baseDir}/SKILL.md`,
  baseDir,
  disableModelInvocation: false,
  body: "",
});

describe("resolveExplicitSkills", () => {
  it("fails named assignments for missing, disabled, ambiguity, and missing read", () => {
    const base = { agentName: "reviewer", strict: true, disabledSkills: new Set<string>() };
    expect(
      resolveExplicitSkills({ ...base, skillNames: ["missing"], candidates: [] }),
    ).toMatchObject({ status: "error", code: "missing" });
    expect(
      resolveExplicitSkills({
        ...base,
        skillNames: ["off"],
        candidates: [skill("off")],
        disabledSkills: new Set(["off"]),
      }),
    ).toMatchObject({ status: "error", code: "disabled" });
    expect(
      resolveExplicitSkills({
        ...base,
        skillNames: ["dup"],
        candidates: [skill("dup", "/a"), skill("dup", "/b")],
      }),
    ).toMatchObject({ status: "error", code: "ambiguous" });
    for (const tools of [["grep"], ["Read"]]) {
      expect(
        resolveExplicitSkills({
          ...base,
          skillNames: ["ok"],
          candidates: [skill("ok")],
          toolsExplicit: true,
          tools,
        }),
      ).toMatchObject({ status: "error", code: "read_required" });
    }
  });

  it("injects the unique skill in authored order and lets ambient stale names skip", () => {
    expect(
      resolveExplicitSkills({
        skillNames: ["two", "missing", "one", "two"],
        candidates: [skill("one"), skill("two")],
        disabledSkills: new Set(),
        strict: false,
      }),
    ).toEqual({
      status: "ok",
      skillDirs: ["/skills/two", "/skills/one"],
      skipped: ["missing"],
    });
  });
});
