import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { skillCatalogDirs } from "../src/paths.ts";
import { scanSkills } from "../src/scanner.ts";
import { writeSkillFile } from "../src/writer.ts";

/**
 * pi round-trip — the scar-tissue guard from the shared-engine handover
 * (`Syncr/docs/handover-agent-deck-p3.md`, "On the review").
 *
 * The engine's Rust emitter once wrote a description containing an emoji as `\u{FE0F}`,
 * which is NOT a YAML escape — pi refused to parse the frontmatter and the skill silently
 * *disappeared*. Every round-trip test on both sides passed anyway, because each parser
 * spoke the same wrong dialect as its own emitter. The ONLY check that caught it was
 * running the real pi loader over the bytes the emitter produced.
 *
 * So this test asserts a skill authored through agent-deck's live write path survives BOTH
 * readers: our own scanner AND pi's real `loadSkillsFromDir`. It guards today's
 * `YAML.stringify` emitter and, once `EngineSkillStore` is wired, it must be re-pointed at
 * the engine's emitter — that is the emitter the seam actually needs this guard for.
 */

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "skill-pi-roundtrip-"));
}

function globalSkillDir(roots: { home: string }, name: string): string {
  return path.join(skillCatalogDirs(roots).find((d) => d.scope === "global")!.dir, name);
}

/** Load a single authored skill through pi's real loader (the true cross-parser check). */
function loadViaPi(roots: { home: string }, name: string) {
  return loadSkillsFromDir({ dir: globalSkillDir(roots, name), source: "roundtrip-test" });
}

describe("skill authored by agent-deck round-trips through pi's real loader", () => {
  it("an emoji (variation selector) description survives — the exact defect that vanished", () => {
    const roots = { home: home() };
    // ✏️ is U+270F U+FE0F — the FE0F variation selector is what the bad emitter mangled.
    const description = "Edits files with the pencil ✏️ tool";
    writeSkillFile(roots, "global", "editor", { description, body: "Do the edit." });

    // agent-deck's own scanner.
    const scanned = scanSkills(roots);
    expect(scanned.map((s) => s.name)).toEqual(["editor"]);
    expect(scanned[0]!.description).toBe(description);

    // pi's real loader — the skill must not have vanished, and the emoji must be intact.
    const { skills, diagnostics } = loadViaPi(roots, "editor");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe(description);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("a description with YAML-significant punctuation (colon, quotes, #) round-trips", () => {
    const roots = { home: home() };
    const description = 'Formats code: uses "prettier" # not eslint';
    writeSkillFile(roots, "global", "fmt", { description, body: "Format it." });

    expect(scanSkills(roots)[0]!.description).toBe(description);
    const { skills } = loadViaPi(roots, "fmt");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe(description);
  });

  it("a multi-line description survives both readers", () => {
    const roots = { home: home() };
    const description = "First line of guidance.\nSecond line with a — dash and 🚀 emoji.";
    writeSkillFile(roots, "global", "multi", { description, body: "Body." });

    // Our scanner must preserve the full description content.
    const mine = scanSkills(roots)[0]!.description;
    expect(mine).toContain("First line of guidance.");
    expect(mine).toContain("Second line with a — dash and 🚀 emoji.");

    // pi must load it (not drop it) and keep both lines' content.
    const { skills } = loadViaPi(roots, "multi");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toContain("First line of guidance.");
    expect(skills[0]!.description).toContain("🚀");
  });
});
