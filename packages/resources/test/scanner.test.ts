import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentMatchesFilter } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { scanAgents, scanPrompts, scanSkillCandidates, scanSkills } from "../src/scanner.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "res-home-"));
}

function makeProject(): string {
  return mkdtempSync(path.join(tmpdir(), "res-proj-"));
}

function writeAgent(dir: string, name: string, frontmatter = ""): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: test agent ${name}\n${frontmatter}---\n\nYou are ${name}.\n`,
  );
}

describe("scanAgents", () => {
  it("preserves absent versus explicit empty extension policy with stable dedupe", () => {
    const absent = scanAgents({ home: makeHome() });
    expect(absent.find((agent) => agent.scope === "builtin")?.extensions).toBeUndefined();

    const home = makeHome();
    writeAgent(
      path.join(home, ".pi", "agent", "agents"),
      "extension-policy",
      "extensions:\n  - /one.ts\n  - /two.ts\n  - /one.ts\n",
    );
    expect(
      scanAgents({ home }).find((agent) => agent.name === "extension-policy")?.extensions,
    ).toEqual(["/one.ts", "/two.ts"]);

    writeAgent(path.join(home, ".pi", "agent", "agents"), "extension-none", "extensions: []\n");
    expect(
      scanAgents({ home }).find((agent) => agent.name === "extension-none")?.extensions,
    ).toEqual([]);
  });

  it("always includes the bundled builtin agents", () => {
    const agents = scanAgents({ home: makeHome() });
    const names = agents.filter((a) => a.scope === "builtin").map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["coder", "explorer", "planner", "reviewer"]));
  });

  it("scans a selected project's agents plus global, with legacy same-name precedence", () => {
    const home = makeHome();
    const project = makeProject();
    writeAgent(path.join(home, ".agents"), "shared", "tools: read\n");
    writeAgent(path.join(home, ".pi", "agent", "agents"), "shared", "tools: grep\n");
    writeAgent(path.join(project, ".pi", "agents"), "project-pi");
    writeAgent(path.join(project, ".agents"), "project-legacy");

    const agents = scanAgents({ home, projectPath: project });
    const shared = agents.filter((a) => a.name === "shared");
    expect(shared).toHaveLength(2);
    expect(shared[0]).toMatchObject({ scope: "global", tools: ["read"], shadowed: false });
    expect(shared[1]).toMatchObject({ scope: "global", tools: ["grep"], shadowed: true });
    // A selected project's `.pi/agents` are scanned with scope "project" (native parity).
    expect(agents.find((a) => a.name === "project-pi")).toMatchObject({ scope: "project" });
    // The vendor-neutral `<project>/.agents` (legacy-project scope) is a follow-up.
    expect(agents.some((a) => a.name === "project-legacy")).toBe(false);
  });

  it("discovers nested agents while excluding skills content", () => {
    const home = makeHome();
    writeAgent(path.join(home, ".pi", "agent", "agents", "team", "backend"), "nested");
    writeAgent(path.join(home, ".pi", "agent", "agents", "skills", "not-an-agent"), "hidden");
    writeAgent(path.join(home, ".pi", "agent", "agents", "team"), "SKILL");

    const agents = scanAgents({ home });
    expect(agents.find((agent) => agent.name === "nested")?.filePath).toContain(
      path.join("team", "backend", "nested.md"),
    );
    expect(agents.some((agent) => agent.name === "hidden")).toBe(false);
    expect(agents.some((agent) => agent.filePath.endsWith("SKILL.md"))).toBe(false);
  });

  it("keeps same-name library agents separate from active builtin/global agents", () => {
    const home = makeHome();
    writeAgent(path.join(home, ".pi", "agent", "agent-library", "agents"), "reviewer");
    writeAgent(path.join(home, ".pi", "agent", "agent-library", "agents"), "shared");
    writeAgent(path.join(home, ".pi", "agent", "agents"), "shared");
    writeAgent(path.join(home, ".pi", "agent", "agent-library", "agents"), "library-only");
    const agents = scanAgents({ home });
    const builtin = agents.find((agent) => agent.name === "reviewer" && agent.scope === "builtin")!;
    const library = agents.find((agent) => agent.name === "reviewer" && agent.scope === "library")!;
    expect(builtin.shadowed).toBe(false);
    expect(library).toMatchObject({ shadowed: true, replacesBuiltin: false });
    expect(
      agents.find((agent) => agent.name === "shared" && agent.scope === "global"),
    ).toMatchObject({ shadowed: false });
    expect(
      agents.find((agent) => agent.name === "shared" && agent.scope === "library"),
    ).toMatchObject({ shadowed: true, replacesBuiltin: false });
    expect(agents.find((agent) => agent.name === "library-only")).toMatchObject({
      scope: "library",
      shadowed: false,
    });
  });

  it("preserves absent versus explicit-empty Pi tool policy", () => {
    const home = makeHome();
    writeAgent(path.join(home, ".agents"), "defaults");
    writeAgent(path.join(home, ".agents"), "none", "tools: []\n");
    const agents = scanAgents({ home });
    expect(agents.find((item) => item.name === "defaults")).toMatchObject({
      tools: undefined,
      toolsExplicit: false,
    });
    expect(agents.find((item) => item.name === "none")).toMatchObject({
      tools: [],
      toolsExplicit: true,
    });
  });

  it("semantically separates ordered mcp: entries from ordinary Pi tools", () => {
    const home = makeHome();
    writeAgent(
      path.join(home, ".agents"),
      "adapter-user",
      "tools: read, mcp:search, grep, mcp:stale-external-name\n",
    );
    const agent = scanAgents({ home }).find((item) => item.name === "adapter-user")!;
    expect(agent.tools).toEqual(["read", "grep"]);
    expect(agent.mcpDirectTools).toEqual(["search", "stale-external-name"]);
  });

  it("parses comma-separated tools and marks a global replacement of a builtin", () => {
    const home = makeHome();
    writeAgent(path.join(home, ".agents"), "reviewer", "tools: read, grep\n");
    const agents = scanAgents({ home });
    const globalReviewer = agents.find((a) => a.name === "reviewer" && a.scope === "global")!;
    const builtinReviewer = agents.find((a) => a.name === "reviewer" && a.scope === "builtin")!;
    expect(globalReviewer.tools).toEqual(["read", "grep"]);
    expect(globalReviewer.shadowed).toBe(false);
    expect(globalReviewer.replacesBuiltin).toBe(true);
    expect(builtinReviewer.shadowed).toBe(true);
    expect(agentMatchesFilter(globalReviewer, "replaced")).toBe(true);
    expect(agentMatchesFilter(builtinReviewer, "replaced")).toBe(true);
  });
});

describe("scanSkills", () => {
  it("resolves ordered project-over-global and modern-over-legacy precedence", () => {
    const home = makeHome();
    const project = makeProject();
    const writeNamedSkill = (dir: string, body: string): string => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: shared\ndescription: ${body}\n---\n\n${body}\n`,
      );
      return dir;
    };
    const projectModern = writeNamedSkill(
      path.join(project, ".agents", "skills", "shared"),
      "project modern",
    );
    writeNamedSkill(path.join(project, ".pi", "skills", "shared"), "project pi");
    writeNamedSkill(path.join(home, ".pi", "agent", "skills", "shared"), "global modern");
    writeNamedSkill(path.join(home, ".agents", "skills", "shared"), "global legacy");

    expect(
      scanSkillCandidates({ home, projectPath: project }).filter((s) => s.name === "shared"),
    ).toEqual([expect.objectContaining({ baseDir: projectModern, body: "project modern" })]);

    const globalModern = path.join(home, ".pi", "agent", "skills", "shared");
    expect(scanSkillCandidates({ home }).filter((s) => s.name === "shared")).toEqual([
      expect.objectContaining({ baseDir: globalModern, body: "global modern" }),
    ]);
  });

  it("retains true same-priority collection ties only when no standard winner exists", () => {
    const home = makeHome();
    const collections = [makeProject(), makeProject()].map((root, index) => {
      const dir = path.join(root, `shared-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: shared\ndescription: collection ${index}\n---\n\nBody.\n`,
      );
      return dir;
    });
    expect(
      scanSkillCandidates({ home }, collections).filter((s) => s.name === "shared"),
    ).toHaveLength(2);
  });
  it("discovers modern and legacy global skills plus a selected project's skills", () => {
    const home = makeHome();
    const project = makeProject();
    for (const [dir, name] of [
      [path.join(home, ".pi", "agent", "skills"), "web-research"],
      [path.join(home, ".agents", "skills"), "legacy-skill"],
      [path.join(project, ".pi", "skills"), "project-skill"],
    ] as const) {
      const skillDir = path.join(dir, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Test skill\n---\n\nBody.\n`,
      );
    }
    const skills = scanSkills({ home, projectPath: project });
    expect(skills.find((s) => s.name === "web-research")).toMatchObject({ scope: "global" });
    expect(skills.find((s) => s.name === "legacy-skill")).toMatchObject({ scope: "global" });
    // A selected project's `.pi/skills` are scanned with scope "project" (native parity).
    expect(skills.find((s) => s.name === "project-skill")).toMatchObject({ scope: "project" });
  });

  it("excludes retained private deletion quarantines", () => {
    const home = makeHome();
    const quarantine = path.join(
      home,
      ".pi",
      "agent",
      "skills",
      ".agent-deck-resource-recovery-v1-11-quarantined-0123456789abcdef0123456789abcdef",
    );
    mkdirSync(quarantine, { recursive: true });
    writeFileSync(
      path.join(quarantine, "SKILL.md"),
      "---\nname: quarantined\ndescription: Private recovery evidence\n---\n\nBody.\n",
    );

    expect(scanSkills({ home }).some((skill) => skill.name === "quarantined")).toBe(false);
  });

  it("discovers in-place collection roots with standard same-name precedence", () => {
    const home = makeHome();
    const standard = path.join(home, ".pi", "agent", "skills", "shared");
    const collection = path.join(makeProject(), "shared");
    for (const [dir, description] of [
      [standard, "Standard"],
      [collection, "Collection"],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: shared\ndescription: ${description}\n---\n\nBody.\n`,
      );
    }
    const unique = path.join(path.dirname(collection), "collection-only");
    mkdirSync(unique);
    writeFileSync(
      path.join(unique, "SKILL.md"),
      "---\nname: collection-only\ndescription: Collection only\n---\n\nBody.\n",
    );

    const skills = scanSkills({ home }, [collection, unique]);
    expect(skills.filter((skill) => skill.name === "shared")).toEqual([
      expect.objectContaining({ scope: "global", description: "Standard" }),
    ]);
    expect(skills).toContainEqual(
      expect.objectContaining({ name: "collection-only", scope: "library", baseDir: unique }),
    );
  });

  it("reflects pi's disable-model-invocation frontmatter (native 7.6 detail)", () => {
    const home = makeHome();
    const manual = path.join(home, ".pi", "agent", "skills", "danger-op");
    mkdirSync(manual, { recursive: true });
    writeFileSync(
      path.join(manual, "SKILL.md"),
      "---\nname: danger-op\ndescription: A destructive op\ndisable-model-invocation: true\n---\n\nRun the op.\n",
    );
    const auto = path.join(home, ".pi", "agent", "skills", "helper");
    mkdirSync(auto, { recursive: true });
    writeFileSync(
      path.join(auto, "SKILL.md"),
      "---\nname: helper\ndescription: A helper\n---\n\nHelp.\n",
    );

    const skills = scanSkills({ home });
    expect(skills.find((s) => s.name === "danger-op")!.disableModelInvocation).toBe(true);
    expect(skills.find((s) => s.name === "helper")!.disableModelInvocation).toBe(false);
  });
});

describe("scanPrompts (native prompt.invocation + argument-hint, §8.1)", () => {
  function writePrompt(dir: string, file: string, content: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }

  it("derives the invocation from the FILE basename and reads argument-hint", () => {
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "prompts");
    writePrompt(
      dir,
      "review.md",
      "---\ndescription: Review a PR\nargument-hint: <pr-number>\n---\n\nReview #$1.\n",
    );

    const prompts = scanPrompts({ home });
    const review = prompts.find((p) => p.name === "review")!;
    expect(review.invocation).toBe("/review");
    expect(review.argumentHint).toBe("<pr-number>");
    expect(review.description).toBe("Review a PR");
  });

  it("identity is the basename — a divergent frontmatter `name` is ignored (matches pi)", () => {
    // pi registers the command under the basename and ignores a frontmatter
    // name, so `name` (which edit/rename/delete + the writer key off as
    // `${name}.md`) must be the basename — otherwise those actions target the
    // wrong file. A hand-authored divergent frontmatter name must not leak in.
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "prompts");
    writePrompt(
      dir,
      "ship-it.md",
      "---\nname: Ship It\ndescription: Ship\n---\n\nShip the build.\n",
    );

    const prompt = scanPrompts({ home }).find((p) => p.invocation === "/ship-it")!;
    expect(prompt).toBeDefined();
    expect(prompt.name).toBe("ship-it"); // the basename, NOT "Ship It"
    expect(prompt.invocation).toBe("/ship-it");
  });

  it("leaves argumentHint undefined when there's no argument-hint frontmatter", () => {
    const home = makeHome();
    const dir = path.join(home, ".pi", "agent", "prompts");
    writePrompt(dir, "note.md", "---\ndescription: A note\n---\n\nJust a note.\n");
    expect(scanPrompts({ home }).find((p) => p.name === "note")!.argumentHint).toBeUndefined();
  });

  it("discovers prompt-library as library plus a selected project's prompts", () => {
    const home = makeHome();
    const project = makeProject();
    writePrompt(
      path.join(home, ".pi", "agent", "prompt-library"),
      "catalog.md",
      "---\ndescription: Catalog prompt\n---\n\nlibrary body\n",
    );
    writePrompt(
      path.join(project, ".pi", "prompts"),
      "project-only.md",
      "---\ndescription: Project prompt\n---\n\nproject body\n",
    );

    const prompts = scanPrompts({ home, projectPath: project });
    expect(prompts.find((p) => p.name === "catalog")).toMatchObject({ scope: "library" });
    // A selected project's `.pi/prompts` are scanned with scope "project" (native parity).
    expect(prompts.find((p) => p.name === "project-only")).toMatchObject({ scope: "project" });
  });

  it("ships the native builtin prompts as a builtin source (PRM-02)", () => {
    // the four native bundled-prompts, scanned from the package's own builtin-prompts dir
    const home = makeHome();
    const prompts = scanPrompts({ home });
    const builtin = prompts.filter((p) => p.scope === "builtin").map((p) => p.name);
    expect(builtin.sort()).toEqual([
      "investigate-a-bug",
      "plan-a-feature",
      "refactor-for-clarity",
      "review-my-changes",
    ]);
    expect(prompts.find((p) => p.name === "plan-a-feature")!.invocation).toBe("/plan-a-feature");
  });

  it("a builtin always ranks LAST among same-named prompts (copy-to-customize wins)", () => {
    const home = makeHome();
    writePrompt(
      path.join(home, ".pi", "agent", "prompts"),
      "plan-a-feature.md",
      "---\ndescription: my customized copy\n---\n\nmine\n",
    );
    const matches = scanPrompts({ home }).filter((p) => p.name === "plan-a-feature");
    expect(matches).toHaveLength(2);
    // first-wins consumers (launch resolution) must see the user's copy first
    expect(matches[0]!.scope).toBe("global");
    expect(matches[1]!.scope).toBe("builtin");
  });

  it("surfaces package prompts with scope 'package', ranked below user catalogs, above builtin (PRM-03)", () => {
    const home = makeHome();
    const pkg = path.join(home, "my-pack");
    mkdirSync(path.join(pkg, "prompts"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "my-pack" }));
    writePrompt(
      path.join(pkg, "prompts"),
      "from-pack.md",
      "---\ndescription: a packaged prompt\nargument-hint: <x>\n---\n\npackaged body\n",
    );
    // a name COLLIDING with both a global prompt and a builtin
    writePrompt(path.join(pkg, "prompts"), "plan-a-feature.md", "packaged variant\n");
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: [pkg] }),
    );
    writePrompt(path.join(home, ".pi", "agent", "prompts"), "plan-a-feature.md", "user copy\n");

    const warnings: string[] = [];
    const prompts = scanPrompts({ home }, (w) => warnings.push(w));
    const packaged = prompts.find((p) => p.name === "from-pack")!;
    expect(packaged.scope).toBe("package");
    expect(packaged.invocation).toBe("/from-pack");
    expect(packaged.argumentHint).toBe("<x>");
    // ranking: the user's global copy first, then the package variant, then the builtin
    expect(prompts.filter((p) => p.name === "plan-a-feature").map((p) => p.scope)).toEqual([
      "global",
      "package",
      "builtin",
    ]);
  });

  it("refuses a symlinked prompt file escaping its package (POSIX)", () => {
    // a CONTAINED prompts dir may still hold a symlinked .md pointing outside the
    // package — per-file realpath containment must refuse it (review, Codex).
    // File symlinks need privilege on Windows; CI's linux/macos legs exercise this.
    if (process.platform === "win32") return;
    const home = makeHome();
    const pkg = path.join(home, "leak-pack");
    mkdirSync(path.join(pkg, "prompts"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "leak-pack" }));
    const outside = path.join(home, "secret.md");
    writeFileSync(outside, "---\ndescription: outside\n---\n\nsecret\n");
    symlinkSync(outside, path.join(pkg, "prompts", "leak.md"));
    writePrompt(path.join(pkg, "prompts"), "honest.md", "fine\n");
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: [pkg] }),
    );

    const names = scanPrompts({ home })
      .filter((p) => p.scope === "package")
      .map((p) => p.name);
    expect(names).toEqual(["honest"]);
  });

  it("reports package-prompt resolution warnings through onWarning (PRM-03)", () => {
    const home = makeHome();
    const pkg = path.join(home, "warn-pack");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "warn-pack", pi: { prompts: ["missing-dir"] } }),
    );
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ packages: [pkg] }),
    );
    const warnings: string[] = [];
    scanPrompts({ home }, (w) => warnings.push(w));
    expect(warnings.some((w) => w.includes("missing-dir"))).toBe(true);
  });

  it("merges EXTERNAL prompt references in place: library scope, external flag, never copied (PRM-05)", () => {
    const home = makeHome();
    const outside = path.join(home, "my-notes");
    mkdirSync(outside, { recursive: true });
    const refPath = path.join(outside, "kept-outside.md");
    writeFileSync(refPath, "---\ndescription: lives outside the catalogs\n---\n\nexternal body\n");
    const warnings: string[] = [];
    const prompts = scanPrompts({ home }, (w) => warnings.push(w), [
      refPath,
      path.join(outside, "vanished.md"), // missing → warned, not silent
      outside, // a directory is NOT a valid single-file reference
      path.join(outside, "not-markdown.txt"),
      refPath, // duplicate reference → one record
    ]);
    const external = prompts.filter((p) => p.external);
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({
      name: "kept-outside",
      scope: "library",
      filePath: refPath,
      invocation: "/kept-outside",
    });
    expect(warnings.some((w) => w.includes("vanished.md"))).toBe(true);
    // catalog prompts don't carry the flag
    expect(prompts.filter((p) => !p.external && p.name === "kept-outside")).toHaveLength(0);
  });

  it("a reference pointing INTO a catalog never duplicates the catalog record (PRM-05)", () => {
    const home = makeHome();
    const globalDir = path.join(home, ".pi", "agent", "prompts");
    writePrompt(globalDir, "already-cataloged.md", "---\ndescription: mine\n---\n\nbody\n");
    const prompts = scanPrompts({ home }, undefined, [
      path.join(globalDir, "already-cataloged.md"),
    ]);
    const matches = prompts.filter((p) => p.name === "already-cataloged");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.scope).toBe("global");
    expect(matches[0]!.external).toBeUndefined();
  });

  it("honors AGENT_DECK_BUILTIN_PROMPTS_DIR per call (hermetic override)", () => {
    const home = makeHome();
    const override = path.join(home, "custom-builtins");
    writePrompt(override, "special.md", "---\ndescription: overridden builtin\n---\n\nbody\n");
    process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR = override;
    try {
      const prompts = scanPrompts({ home });
      expect(prompts.filter((p) => p.scope === "builtin").map((p) => p.name)).toEqual(["special"]);
    } finally {
      delete process.env.AGENT_DECK_BUILTIN_PROMPTS_DIR;
    }
  });
});
