import { describe, expect, it } from "vitest";
import { resolveSkillSource } from "../src/skillSource.ts";

/**
 * resolveSkillSource parses the ways a user names a skill repo (native
 * SkillRepositorySyncService.resolveSource): owner/repo shorthand, a skills.sh
 * link, an SSH remote, or a web tree URL (branch + path → ref + subdir).
 */

describe("resolveSkillSource", () => {
  it("expands owner/repo shorthand to a GitHub clone URL", () => {
    expect(resolveSkillSource("acme/skills")).toEqual({
      cloneUrl: "https://github.com/acme/skills.git",
    });
    // A trailing .git is tolerated and not doubled.
    expect(resolveSkillSource("acme/skills.git")).toEqual({
      cloneUrl: "https://github.com/acme/skills.git",
    });
  });

  it("parses a skills.sh link, capturing the slug as a subdir", () => {
    expect(resolveSkillSource("skills.sh/acme/pack")).toEqual({
      cloneUrl: "https://github.com/acme/pack.git",
    });
    expect(resolveSkillSource("https://skills.sh/acme/pack/deploy")).toEqual({
      cloneUrl: "https://github.com/acme/pack.git",
      subdir: "deploy",
    });
    // A reserved site page (not an owner) is rejected.
    expect(resolveSkillSource("skills.sh/docs/getting-started")).toBeNull();
  });

  it("matches native's reserved pages, query stripping, and host forms on skills.sh (SKL-17)", () => {
    // the native resolver reserves ALL of these first segments as site pages
    for (const page of [
      "docs",
      "topics",
      "agents",
      "leaderboard",
      "trending",
      "hot",
      "official",
      "new",
      "search",
    ]) {
      expect(resolveSkillSource(`skills.sh/${page}/anything`)).toBeNull();
      expect(resolveSkillSource(`skills.sh/${page.toUpperCase()}/anything`)).toBeNull();
    }
    // a query string is stripped before the path is read (native pathWithoutQuery)
    expect(resolveSkillSource("https://skills.sh/acme/pack?tab=readme")).toEqual({
      cloneUrl: "https://github.com/acme/pack.git",
    });
    // any skills.sh host form maps to the GitHub clone URL — native matches the
    // "skills.sh/" marker case-insensitively anywhere in the input
    expect(resolveSkillSource("https://www.skills.sh/acme/pack")).toEqual({
      cloneUrl: "https://github.com/acme/pack.git",
    });
    // the directory site itself is never a git host: a reserved page must not
    // fall through to the web-URL parser and produce a skills.sh clone URL
    expect(resolveSkillSource("https://www.skills.sh/trending/pack")).toBeNull();
    expect(resolveSkillSource("https://skills.sh/trending/pack")).toBeNull();
    // marker matching is case-insensitive at any position, exactly like native's
    // range(of:) scan — these pins document native-faithful semantics, including
    // the ones that look surprising in isolation:
    expect(resolveSkillSource("SKILLS.SH/acme/pack")).toEqual({
      cloneUrl: "https://github.com/acme/pack.git",
    });
    // a path SEGMENT named skills.sh re-anchors the parse (native does the same)
    expect(resolveSkillSource("https://github.com/acme/skills.sh/foo/bar")).toEqual({
      cloneUrl: "https://github.com/foo/bar.git",
    });
    // a reserved page after a skills.sh segment on ANOTHER host falls through to
    // that host's web parse (native: parseSkillsShURL nil -> parseWebURL)
    expect(resolveSkillSource("https://github.com/skills.sh/trending/pack")).toEqual({
      cloneUrl: "https://github.com/skills.sh/trending.git",
    });
    // native's substring host refusal also catches lookalike hosts — fail closed
    expect(resolveSkillSource("https://myskills.shop/acme/pack")).toBeNull();
  });

  it("normalizes an SSH remote to https", () => {
    expect(resolveSkillSource("git@github.com:acme/skills.git")).toEqual({
      cloneUrl: "https://github.com/acme/skills.git",
    });
  });

  it("parses a web tree URL into clone URL + ref + subdir", () => {
    expect(resolveSkillSource("https://github.com/acme/skills/tree/main/deploy/aws")).toEqual({
      cloneUrl: "https://github.com/acme/skills.git",
      ref: "main",
      subdir: "deploy/aws",
    });
    // GitLab's `/-/tree/` form.
    expect(resolveSkillSource("https://gitlab.com/acme/skills/-/tree/dev")).toEqual({
      cloneUrl: "https://gitlab.com/acme/skills.git",
      ref: "dev",
    });
    // A host-prefixed input without a scheme still parses as a web URL.
    expect(resolveSkillSource("github.com/acme/skills")).toEqual({
      cloneUrl: "https://github.com/acme/skills.git",
    });
  });

  it("drops a traversal subdir so discovery can't escape the clone", () => {
    // A skills.sh slug is split from the raw string (not URL-normalized), so a
    // `..` slug must be rejected rather than become a subdir.
    expect(resolveSkillSource("skills.sh/acme/pack/..")).toEqual({
      cloneUrl: "https://github.com/acme/pack.git",
    });
  });

  it("passes a local path / file URL through verbatim (the hermetic clone form)", () => {
    expect(resolveSkillSource("/tmp/some/repo")).toEqual({ cloneUrl: "/tmp/some/repo" });
    expect(resolveSkillSource("file:///tmp/repo")).toEqual({ cloneUrl: "file:///tmp/repo" });
  });

  it("returns null for empty or unparseable input", () => {
    expect(resolveSkillSource("")).toBeNull();
    expect(resolveSkillSource("   ")).toBeNull();
    expect(resolveSkillSource("just-one-segment")).toBeNull();
  });
});
