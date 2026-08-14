import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintLaunchResources } from "../src/launchResources.ts";

describe("launch resource fingerprint", () => {
  it("tracks selected resource bytes but ignores resume identity and unrelated UI files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-fingerprint-"));
    const skill = path.join(root, "skill");
    mkdirSync(skill);
    writeFileSync(path.join(skill, "SKILL.md"), "first");
    const instructions = path.join(root, "AGENTS.md");
    writeFileSync(instructions, "rules one");
    const plan = {
      kind: "parent" as const,
      skills: [skill],
      resumeSessionPath: path.join(root, "conversation-a.jsonl"),
    };
    const initial = fingerprintLaunchResources(plan, [instructions]);
    expect(
      fingerprintLaunchResources(
        { ...plan, resumeSessionPath: path.join(root, "conversation-b.jsonl") },
        [instructions],
      ),
    ).toBe(initial);

    writeFileSync(path.join(root, "avatar.png"), "ui only");
    expect(fingerprintLaunchResources(plan, [instructions])).toBe(initial);
    writeFileSync(path.join(skill, "SKILL.md"), "second");
    expect(fingerprintLaunchResources(plan, [instructions])).not.toBe(initial);
  });

  it("fails closed for required symlinks but stably skips unsafe optional candidates", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-symlink-"));
    const target = path.join(root, "target.md");
    const linked = path.join(root, "linked.md");
    writeFileSync(target, "content");
    symlinkSync(target, linked);
    expect(() => fingerprintLaunchResources({ kind: "parent", extensions: [linked] }, [])).toThrow(
      "required launch resource",
    );
    expect(fingerprintLaunchResources({ kind: "parent" }, [linked])).toBe(
      fingerprintLaunchResources({ kind: "parent" }, [linked]),
    );
  });

  it("bounds aggregate selected resource traversal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-bounded-"));
    for (let index = 0; index <= 2_000; index += 1) {
      writeFileSync(path.join(root, `${index}.md`), "x");
    }
    expect(() => fingerprintLaunchResources({ kind: "parent", skills: [root] }, [])).toThrow(
      "required launch resource",
    );
  });

  it("tracks applicable instruction bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-instructions-"));
    const instructions = path.join(root, "AGENTS.md");
    writeFileSync(instructions, "one");
    const before = fingerprintLaunchResources({ kind: "parent" }, [instructions]);
    writeFileSync(instructions, "two");
    expect(fingerprintLaunchResources({ kind: "parent" }, [instructions])).not.toBe(before);
  });
});
