import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSkillEngineNative, type SkillEngineNative } from "../src/skills/skillEngineNative.ts";

/**
 * pi round-trip on the ENGINE emitter — the scar-tissue guard from the P3 handover, moved to
 * the seam it actually protects now that the engine owns writes.
 *
 * The engine's Rust emitter once wrote a description's emoji as `\u{FE0F}` (not a YAML escape),
 * so pi refused the frontmatter and the skill silently vanished — and it passed the engine's
 * OWN round-trip tests because its parser spoke the same wrong dialect as its emitter. The only
 * check that catches that class is running the REAL pi loader over the bytes the engine wrote.
 * Syncr CI runs this against every published binary; this pins the guard to the exact engine
 * version agent-deck ships, so a bad bump can't reach a release quietly.
 */

let engine: SkillEngineNative;
beforeAll(async () => {
  engine = await loadSkillEngineNative();
});

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "engine-pi-roundtrip-"));
}

/** Load an engine-written skill through pi's real loader (canonical `<home>/.agents/skills`). */
function loadViaPi(h: string, name: string) {
  return loadSkillsFromDir({ dir: path.join(h, ".agents", "skills", name), source: "roundtrip" });
}

describe("a skill written by the engine round-trips through pi's real loader", () => {
  it("an emoji (variation selector) description survives — the exact defect that vanished", () => {
    const h = home();
    const description = "Edits files with the pencil ✏️ tool";
    engine.writeSkill(h, undefined, "global", "editor", description, "Do the edit.");

    const { skills, diagnostics } = loadViaPi(h, "editor");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe(description);
    expect(diagnostics.filter((d) => d.type === "error")).toEqual([]);
  });

  it("a description with YAML-significant punctuation (colon, quotes, #) round-trips", () => {
    const h = home();
    const description = 'Formats code: uses "prettier" # not eslint';
    engine.writeSkill(h, undefined, "global", "fmt", description, "Format it.");

    const { skills } = loadViaPi(h, "fmt");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe(description);
  });

  it("a multi-line description survives, and body is preserved on a description-only edit", () => {
    const h = home();
    const description = "First line of guidance.\nSecond line with a — dash and 🚀 emoji.";
    engine.writeSkill(h, undefined, "global", "multi", description, "Body stays.");
    // The partial-edit defect class: a description-only edit must not destroy the body.
    engine.writeSkill(
      h,
      undefined,
      "global",
      "multi",
      "First line of guidance.\nEdited 🚀.",
      undefined,
    );

    const { skills } = loadViaPi(h, "multi");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toContain("First line of guidance.");
    expect(skills[0]!.description).toContain("🚀");
  });
});
