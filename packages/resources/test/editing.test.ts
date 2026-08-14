import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentMatchesFilter } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS_DIR } from "../src/paths.ts";
import {
  computeBuiltinOverride,
  mergeWithUnmanagedOverrideFields,
  readAgentOverrides,
  writeBuiltinAgentOverride,
} from "../src/overrides.ts";
import { materializeBuiltinAgentOverrideContent } from "../src/agentReplacement.ts";
import { parseAgentFile, scanAgents } from "../src/scanner.ts";
import {
  deleteAgentFile,
  importSkillsFromClone,
  renameAgentFile,
  setAgentDisabledFile,
  writeAgentFile,
  writePromptFile,
  writeSkillFile,
} from "../src/writer.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "edit-home-"));
}

describe("builtin override edit safety", () => {
  it("editing a builtin never touches the builtin file; override applies in scans", () => {
    const home = makeHome();
    const builtinFile = path.join(BUILTIN_AGENTS_DIR, "coder.md");
    const bytesBefore = readFileSync(builtinFile);

    const base = scanAgents({ home }).find((a) => a.name === "coder" && a.scope === "builtin")!;
    const override = computeBuiltinOverride(base, {
      description: "My customized coder",
      tools: ["read", "grep"],
    });
    expect(override).toEqual({ description: "My customized coder", tools: ["read", "grep"] });
    writeBuiltinAgentOverride({ home }, "coder", override);

    // THE guarantee: builtin file bytes are identical.
    expect(readFileSync(builtinFile).equals(bytesBefore)).toBe(true);

    const coder = scanAgents({ home }).find((a) => a.name === "coder")!;
    expect(coder).toMatchObject({
      scope: "builtin",
      overridden: true,
      description: "My customized coder",
      tools: ["read", "grep"],
    });
    // Body untouched by this override.
    expect(coder.body).toBe(base.body);

    // The scanned override flows through to the Agents screen "overridden" chip,
    // while a pristine builtin from the same scan does not.
    expect(agentMatchesFilter(coder, "overridden")).toBe(true);
    const pristine = scanAgents({ home }).find((a) => a.scope === "builtin" && !a.overridden)!;
    expect(agentMatchesFilter(pristine, "overridden")).toBe(false);
  });

  it("preserves unknown settings.json keys and prunes empty overrides", () => {
    const home = makeHome();
    const settingsFile = path.join(home, ".pi", "agent", "settings.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({ theme: "dark", subagents: { disableBuiltins: false } }, null, 2),
    );

    writeBuiltinAgentOverride({ home }, "coder", { description: "x" });
    let settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    expect(settings.theme).toBe("dark");
    expect(settings.subagents).toMatchObject({
      disableBuiltins: false,
      agentOverrides: { coder: { description: "x" } },
    });

    // Removing the override prunes agentOverrides but keeps sibling keys.
    writeBuiltinAgentOverride({ home }, "coder", null);
    settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    expect(settings.theme).toBe("dark");
    expect(settings.subagents).toEqual({ disableBuiltins: false });
  });

  it("refuses to overwrite an existing but malformed settings.json (data-loss guard)", () => {
    const home = makeHome();
    const settingsFile = path.join(home, ".pi", "agent", "settings.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, "{ this is not json");
    expect(() => writeBuiltinAgentOverride({ home }, "coder", { description: "x" })).toThrow();
    // The broken file is untouched for the user to repair.
    expect(readFileSync(settingsFile, "utf8")).toBe("{ this is not json");
    // Read-only catalog refresh fails closed to pristine builtins instead of
    // taking the Agents screen down while the user repairs the file.
    expect(
      scanAgents({ home }).find((agent) => agent.name === "coder" && agent.scope === "builtin")
        ?.overridden,
    ).not.toBe(true);
  });

  it("preserves an existing builtin outcome override across an unrelated editor merge", () => {
    const home = makeHome();
    const roots = { home };
    const base = scanAgents(roots).find(
      (agent) => agent.name === "coder" && agent.scope === "builtin",
    )!;
    writeBuiltinAgentOverride(roots, "coder", {
      defaultExpectedOutcome: "directProjectWrites",
      defaultProgress: false,
      interactive: false,
      output: "Write a concise review summary",
      futureField: "keep-me",
    });

    const unrelated = computeBuiltinOverride(base, { description: "Edited description" });
    const merged = mergeWithUnmanagedOverrideFields(readAgentOverrides(roots).coder, unrelated);
    expect(merged).toEqual({
      defaultExpectedOutcome: "directProjectWrites",
      defaultProgress: false,
      interactive: false,
      output: "Write a concise review summary",
      futureField: "keep-me",
      description: "Edited description",
    });
    writeBuiltinAgentOverride(roots, "coder", merged);
    expect(scanAgents(roots).find((agent) => agent.name === "coder")).toMatchObject({
      description: "Edited description",
      defaultExpectedOutcome: "directProjectWrites",
      interactive: false,
    });
    writeBuiltinAgentOverride(roots, "reviewer", { interactive: true });
    expect(
      scanAgents(roots).find((agent) => agent.name === "reviewer" && agent.scope === "builtin")
        ?.interactive,
    ).toBe(true);

    // An explicit API edit still wins because computed values merge last.
    const explicit = mergeWithUnmanagedOverrideFields(
      readAgentOverrides(roots).coder,
      computeBuiltinOverride(base, { defaultExpectedOutcome: "writeProjectFile" }),
    );
    expect(explicit?.defaultExpectedOutcome).toBe("writeProjectFile");
  });

  it("diffing equal values yields no override; body edits become systemPrompt", () => {
    const home = makeHome();
    const base = scanAgents({ home }).find((a) => a.name === "coder" && a.scope === "builtin")!;
    expect(computeBuiltinOverride(base, { description: base.description })).toBeNull();
    const withBody = computeBuiltinOverride(base, { body: "New prompt." });
    expect(withBody).toEqual({ systemPrompt: "New prompt." });
  });
});

describe("agent/skill file writer", () => {
  it("writes a new global agent to existing ~/.agents, otherwise the modern catalog", () => {
    const modernHome = makeHome();
    expect(writeAgentFile({ home: modernHome }, "global", "modern", { body: "Modern." })).toBe(
      path.join(modernHome, ".pi", "agent", "agents", "modern.md"),
    );
    expect(existsSync(path.join(modernHome, ".agents"))).toBe(false);

    const legacyHome = makeHome();
    mkdirSync(path.join(legacyHome, ".agents"));
    expect(writeAgentFile({ home: legacyHome }, "global", "legacy", { body: "Legacy." })).toBe(
      path.join(legacyHome, ".agents", "legacy.md"),
    );
  });

  it("applies false defaultProgress overrides and materializes them as absent for replacement", () => {
    const home = makeHome();
    const roots = { home };
    const builtin = readFileSync(path.join(BUILTIN_AGENTS_DIR, "coder.md"), "utf8");
    expect(parseAgentFile("coder.md", builtin, "builtin").defaultProgress).toBe(true);
    writeBuiltinAgentOverride(roots, "coder", { defaultProgress: false });
    expect(
      scanAgents(roots).find((agent) => agent.name === "coder" && agent.scope === "builtin")
        ?.defaultProgress,
    ).toBe(false);
    writeBuiltinAgentOverride(roots, "reviewer", { defaultProgress: true });
    expect(
      scanAgents(roots).find((agent) => agent.name === "reviewer" && agent.scope === "builtin")
        ?.defaultProgress,
    ).toBe(true);

    const materialized = materializeBuiltinAgentOverrideContent(builtin, {
      description: "Effective coder",
      whenToUse: false,
      tools: ["read", "grep"],
      systemPrompt: "Effective overridden prompt.",
      defaultExpectedOutcome: "reportOnly",
      interactive: true,
      output: "Review summary only",
      defaultProgress: false,
    });
    const effective = parseAgentFile("coder.md", materialized, "builtin");
    expect(effective).toMatchObject({
      name: "coder",
      description: "Effective coder",
      tools: ["read", "grep"],
      body: "Effective overridden prompt.",
    });
    expect(effective.whenToUse).toBeUndefined();
    expect(effective.defaultProgress).toBeUndefined();
    expect(effective.interactive).toBe(true);
    expect(materialized).toContain("defaultExpectedOutcome: reportOnly");
    expect(materialized).toContain("interactive: true");
    expect(materialized).toContain("output: Review summary only");
    expect(materialized).not.toContain("defaultProgress:");
  });

  it("sanitizes authored defaultReads entry-by-entry and round-trips custom edits", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = writeAgentFile(roots, "global", "reader", {
      defaultReads: [" AGENTS.md ", "../secret", "src/main.ts", "AGENTS.md", "C:\\secret"],
      body: "Read first.",
    });
    expect(readFileSync(filePath, "utf8")).toContain("defaultReads:");
    expect(readFileSync(filePath, "utf8")).not.toContain("secret");
    expect(scanAgents(roots).find((agent) => agent.name === "reader")?.defaultReads).toEqual([
      "AGENTS.md",
      "src/main.ts",
    ]);

    writeAgentFile(roots, "global", "reader", { defaultReads: [] });
    expect(readFileSync(filePath, "utf8")).not.toContain("defaultReads:");
  });

  it("refuses to persist sanitized defaultReads that exceed the launch budget", () => {
    const home = makeHome();
    const filePath = path.join(home, ".pi", "agent", "agents", "oversized-reader.md");
    expect(() =>
      writeAgentFile({ home }, "global", "oversized-reader", {
        defaultReads: Array.from({ length: 33 }, (_, index) => `path-${index}.md`),
        body: "Must not persist.",
      }),
    ).toThrow(/cannot exceed 32 safe, unique paths/u);
    expect(existsSync(filePath)).toBe(false);
  });

  it("applies effective builtin defaultReads overrides and materializes false without data loss", () => {
    const home = makeHome();
    const roots = { home };
    const builtin = readFileSync(path.join(BUILTIN_AGENTS_DIR, "reviewer.md"), "utf8");
    writeBuiltinAgentOverride(roots, "reviewer", {
      defaultReads: [" AGENTS.md ", "../unsafe", "docs/review.md"],
      futureField: "keep-me",
    });
    expect(
      scanAgents(roots).find((agent) => agent.name === "reviewer" && agent.scope === "builtin")
        ?.defaultReads,
    ).toEqual(["AGENTS.md", "docs/review.md"]);

    const base = parseAgentFile("reviewer.md", builtin, "builtin");
    expect(base.defaultReads).toEqual(["plan.md", "progress.md"]);
    const cleared = mergeWithUnmanagedOverrideFields(
      readAgentOverrides(roots).reviewer,
      computeBuiltinOverride(base, { defaultReads: [] }),
    );
    expect(cleared).toMatchObject({ defaultReads: false, futureField: "keep-me" });
    const materialized = materializeBuiltinAgentOverrideContent(builtin, cleared ?? undefined);
    expect(materialized).not.toContain("defaultReads:");
    expect(materialized).toContain("futureField: keep-me");
  });

  it("creates from builtin content without clobbering a colliding custom agent", () => {
    const home = makeHome();
    const roots = { home };
    const builtin = readFileSync(path.join(BUILTIN_AGENTS_DIR, "reviewer.md"), "utf8");
    const filePath = writeAgentFile(
      roots,
      "global",
      "reviewer",
      { description: "My reviewer" },
      { createOnly: true, baseContent: builtin },
    );
    const created = readFileSync(filePath, "utf8");
    expect(created).toContain("description: My reviewer");
    expect(created).toContain("defaultExpectedOutcome: reportOnly");
    expect(created).toContain("You are `reviewer`");

    expect(() =>
      writeAgentFile(
        roots,
        "global",
        "reviewer",
        { body: "clobbered" },
        { createOnly: true, baseContent: builtin },
      ),
    ).toThrow();
    expect(readFileSync(filePath, "utf8")).toBe(created);
  });

  it("edits an existing modern agent in place even when ~/.agents exists", () => {
    const home = makeHome();
    const modernDir = path.join(home, ".pi", "agent", "agents");
    mkdirSync(modernDir, { recursive: true });
    mkdirSync(path.join(home, ".agents"));
    const modernFile = path.join(modernDir, "modern.md");
    writeFileSync(modernFile, "---\nname: modern\ndescription: Before\n---\n\nBody.\n");

    expect(writeAgentFile({ home }, "global", "modern", { description: "After" })).toBe(modernFile);
    expect(readFileSync(modernFile, "utf8")).toContain("description: After");
    expect(existsSync(path.join(home, ".agents", "modern.md"))).toBe(false);

    setAgentDisabledFile({ home }, "global", "modern", true);
    expect(readFileSync(modernFile, "utf8")).toContain("disabled: true");
    expect(renameAgentFile({ home }, "global", "modern", "renamed")).toBe(
      path.join(modernDir, "renamed.md"),
    );
    deleteAgentFile({ home }, "global", "renamed");
    expect(existsSync(path.join(modernDir, "renamed.md"))).toBe(false);
  });

  it("rejects ambiguous same-name legacy/modern agent mutations", () => {
    const home = makeHome();
    for (const dir of [path.join(home, ".agents"), path.join(home, ".pi", "agent", "agents")]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "duplicate.md"), "---\nname: duplicate\n---\n\nBody.\n");
    }
    expect(() => writeAgentFile({ home }, "global", "duplicate", { body: "Changed." })).toThrow(
      "agent_ambiguous",
    );
    expect(() => setAgentDisabledFile({ home }, "global", "duplicate", true)).toThrow(
      "agent_ambiguous",
    );
    expect(() => renameAgentFile({ home }, "global", "duplicate", "renamed")).toThrow(
      "agent_ambiguous",
    );
    expect(() => deleteAgentFile({ home }, "global", "duplicate")).toThrow("agent_ambiguous");
    expect(readFileSync(path.join(home, ".agents", "duplicate.md"), "utf8")).toContain("Body.");
    expect(
      readFileSync(path.join(home, ".pi", "agent", "agents", "duplicate.md"), "utf8"),
    ).toContain("Body.");
  });

  it("writes native agent and prompt libraries", () => {
    const home = makeHome();
    expect(writeAgentFile({ home }, "library", "catalog-agent", { body: "Library." })).toBe(
      path.join(home, ".pi", "agent", "agent-library", "agents", "catalog-agent.md"),
    );
    expect(writePromptFile({ home }, "library", "catalog-prompt", { body: "Library." })).toBe(
      path.join(home, ".pi", "agent", "prompt-library", "catalog-prompt.md"),
    );
  });

  it("scans project resources but leaves in-app project writes to the shared engine", () => {
    // Display parity is restored (project skills/agents/prompts are SCANNED — see
    // scanner.test), but in-app WRITES go through the native writable-catalog
    // containment, which only recognizes home-based catalogs. Project writes are
    // owned by the shared skill engine (ADR-0002 P3; Syncr materializes project
    // `.agents/skills`), so agent-deck's soon-replaced native write path is
    // deliberately NOT extended for project scope — it fails closed at the boundary.
    const roots = { home: makeHome(), projectPath: mkdtempSync(path.join(tmpdir(), "edit-proj-")) };
    expect(() => writeAgentFile(roots, "project", "agent", { body: "No." })).toThrow(
      "not in a writable catalog",
    );
    expect(() => writeSkillFile(roots, "project", "skill", { body: "No." })).toThrow(
      "not in a writable catalog",
    );
    expect(() => writePromptFile(roots, "project", "prompt", { body: "No." })).toThrow(
      "not in a writable catalog",
    );
    expect(existsSync(path.join(roots.projectPath, ".pi"))).toBe(false);
  });

  it("creates and round-trips a global agent, preserving unknown frontmatter", () => {
    const home = makeHome();
    const roots = { home };

    const filePath = writeAgentFile(roots, "global", "helper", {
      description: "Helps out",
      tools: ["read"],
      body: "You are helper.",
    });
    // Inject an unknown field as an external tool would.
    const withUnknown = readFileSync(filePath, "utf8").replace(
      "---\n\n",
      "customField: keep-me\n---\n\n",
    );
    writeFileSync(filePath, withUnknown);

    writeAgentFile(roots, "global", "helper", { description: "Helps out more" });
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("customField: keep-me");
    expect(content).toContain("Helps out more");
    expect(content).toContain("You are helper.");

    const helper = scanAgents(roots).find((a) => a.name === "helper")!;
    expect(helper).toMatchObject({
      scope: "global",
      description: "Helps out more",
      tools: ["read"],
      body: "You are helper.",
    });
  });

  it("round-trips direct adapter tools in shared tools frontmatter without losing unknown fields", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = writeAgentFile(roots, "global", "adapter-user", {
      tools: ["read", "grep", "mcp:search", "mcp:stale-name"],
      body: "Use an external adapter.",
    });
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace("---\n\n", "customField: keep-me\n---\n\n"),
    );

    expect(readFileSync(filePath, "utf8")).toContain(
      "tools: read, grep, mcp:search, mcp:stale-name",
    );
    expect(scanAgents(roots).find((agent) => agent.name === "adapter-user")).toMatchObject({
      tools: ["read", "grep"],
      mcpDirectTools: ["search", "stale-name"],
    });

    writeAgentFile(roots, "global", "adapter-user", {
      tools: ["read", "grep", "mcp:fetch"],
    });
    const updated = readFileSync(filePath, "utf8");
    expect(updated).toContain("tools: read, grep, mcp:fetch");
    expect(updated).toContain("customField: keep-me");
  });

  it("keeps builtin direct tools in the combined tools override and tools:false clears both", () => {
    const home = makeHome();
    const base = scanAgents({ home }).find(
      (agent) => agent.name === "coder" && agent.scope === "builtin",
    )!;
    const configured = computeBuiltinOverride(base, {
      tools: ["read", "mcp:search", "mcp:fetch"],
    });
    expect(configured).toEqual({ tools: ["read", "mcp:search", "mcp:fetch"] });
    writeBuiltinAgentOverride({ home }, "coder", configured);
    expect(scanAgents({ home }).find((agent) => agent.name === "coder")).toMatchObject({
      tools: ["read"],
      mcpDirectTools: ["search", "fetch"],
    });

    writeBuiltinAgentOverride({ home }, "coder", { tools: false });
    const cleared = scanAgents({ home }).find((agent) => agent.name === "coder")!;
    expect(cleared.tools).toBeUndefined();
    expect(cleared.mcpDirectTools).toBeUndefined();
  });

  it("round-trips an agent's declared mcpServers through write + scan", () => {
    const home = makeHome();
    const roots = { home };

    const filePath = writeAgentFile(roots, "global", "researcher", {
      description: "Researches",
      mcpServers: ["github", "linear"],
      body: "You research.",
    });
    // Serialized to frontmatter as a comma list.
    expect(readFileSync(filePath, "utf8")).toContain("mcpServers: github, linear");

    const agent = scanAgents(roots).find((a) => a.name === "researcher")!;
    expect(agent.mcpServers).toEqual(["github", "linear"]);

    // Clearing removes the field.
    writeAgentFile(roots, "global", "researcher", { mcpServers: [] });
    expect(readFileSync(filePath, "utf8")).not.toContain("mcpServers:");
    expect(scanAgents(roots).find((a) => a.name === "researcher")!.mcpServers).toBeUndefined();
  });

  it("edits a builtin's mcpServers as a managed override, file untouched, and surfaces it", () => {
    const home = makeHome();
    const builtinFile = path.join(BUILTIN_AGENTS_DIR, "coder.md");
    const bytesBefore = readFileSync(builtinFile);

    // The editor always submits the current mcpServers, so it's diffed like tools.
    const base = scanAgents({ home }).find((a) => a.name === "coder" && a.scope === "builtin")!;
    const override = computeBuiltinOverride(base, { mcpServers: ["github", "linear"] });
    expect(override).toEqual({ mcpServers: ["github", "linear"] });
    writeBuiltinAgentOverride({ home }, "coder", override);

    expect(readFileSync(builtinFile).equals(bytesBefore)).toBe(true);
    const coder = scanAgents({ home }).find((a) => a.name === "coder")!;
    expect(coder.mcpServers).toEqual(["github", "linear"]);

    // Clearing it (empty list submitted) removes the override again.
    const cleared = mergeWithUnmanagedOverrideFields(
      readAgentOverrides({ home }).coder,
      computeBuiltinOverride(base, { mcpServers: [] }),
    );
    writeBuiltinAgentOverride({ home }, "coder", cleared);
    expect(scanAgents({ home }).find((a) => a.name === "coder")!.mcpServers).toBeUndefined();
  });

  it("round-trips native defaultExpectedOutcome and preserves unknown frontmatter", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = writeAgentFile(roots, "global", "delegator", {
      defaultExpectedOutcome: "editFilesInWorktree",
      body: "Delegate safely.",
    });
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace("---\n\n", "futureField: keep-me\n---\n\n"),
    );

    expect(
      scanAgents(roots).find((agent) => agent.name === "delegator")?.defaultExpectedOutcome,
    ).toBe("editFilesInWorktree");
    writeAgentFile(roots, "global", "delegator", {
      defaultExpectedOutcome: "directProjectWrites",
    });
    const updated = readFileSync(filePath, "utf8");
    expect(updated).toContain("defaultExpectedOutcome: directProjectWrites");
    expect(updated).toContain("futureField: keep-me");

    writeAgentFile(roots, "global", "delegator", { defaultExpectedOutcome: "" });
    expect(readFileSync(filePath, "utf8")).not.toContain("defaultExpectedOutcome:");
  });

  it("round-trips native defaultProgress metadata and omits its false/default state", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = writeAgentFile(roots, "global", "progress-reporter", {
      defaultProgress: true,
      body: "Report progress when the workflow supports it.",
    });
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace("---\n\n", "futureField: keep-me\n---\n\n"),
    );

    expect(scanAgents(roots).find((agent) => agent.name === "progress-reporter")).toMatchObject({
      defaultProgress: true,
    });
    expect(readFileSync(filePath, "utf8")).toContain("defaultProgress: true");

    writeAgentFile(roots, "global", "progress-reporter", { defaultProgress: false });
    const updated = readFileSync(filePath, "utf8");
    expect(updated).not.toContain("defaultProgress:");
    expect(updated).toContain("futureField: keep-me");
    expect(
      scanAgents(roots).find((agent) => agent.name === "progress-reporter")?.defaultProgress,
    ).toBeUndefined();
  });

  it("round-trips native output metadata, preserves unknown fields, and clears blank values", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = writeAgentFile(roots, "global", "reporter", {
      output: "Concise review summary",
      body: "Review carefully.",
    });
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace("---\n\n", "futureField: keep-me\n---\n\n"),
    );

    expect(scanAgents(roots).find((agent) => agent.name === "reporter")?.output).toBe(
      "Concise review summary",
    );
    writeAgentFile(roots, "global", "reporter", { output: "Updated summary" });
    expect(readFileSync(filePath, "utf8")).toContain("output: Updated summary");
    expect(readFileSync(filePath, "utf8")).toContain("futureField: keep-me");

    writeAgentFile(roots, "global", "reporter", { output: "" });
    expect(readFileSync(filePath, "utf8")).not.toContain("output:");
    expect(scanAgents(roots).find((agent) => agent.name === "reporter")?.output).toBeUndefined();
  });

  it("rejects unsafe authored output metadata during scanning", () => {
    expect(
      parseAgentFile(
        "multiline.md",
        "---\nname: multiline\noutput: |\n  first line\n  # injected section\n---\n\nBody.\n",
        "global",
      ).output,
    ).toBeUndefined();
    expect(
      parseAgentFile(
        "bounded.md",
        `---\nname: bounded\noutput: ${"x".repeat(1001)}\n---\n\nBody.\n`,
        "global",
      ).output,
    ).toBeUndefined();
  });

  it("round-trips native interactive metadata and omits its false/default state", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = writeAgentFile(roots, "global", "interviewer", {
      interactive: true,
      body: "Compatibility metadata only.",
    });
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace("---\n\n", "futureField: keep-me\n---\n\n"),
    );

    expect(scanAgents(roots).find((agent) => agent.name === "interviewer")).toMatchObject({
      interactive: true,
    });
    expect(readFileSync(filePath, "utf8")).toContain("interactive: true");

    writeAgentFile(roots, "global", "interviewer", { interactive: false });
    const updated = readFileSync(filePath, "utf8");
    expect(updated).not.toContain("interactive:");
    expect(updated).toContain("futureField: keep-me");
    expect(
      scanAgents(roots).find((agent) => agent.name === "interviewer")?.interactive,
    ).toBeUndefined();
  });

  it.each([
    ["defaultProgress", "defaultProgress"],
    ["interactive", "interactive"],
  ] as const)("parses only boolean %s frontmatter values", (_label, field) => {
    expect(
      parseAgentFile("enabled.md", `---\nname: enabled\n${field}: true\n---\n\nBody.\n`, "global")[
        field
      ],
    ).toBe(true);
    expect(
      parseAgentFile(
        "disabled.md",
        `---\nname: disabled\n${field}: false\n---\n\nBody.\n`,
        "global",
      )[field],
    ).toBe(false);
    expect(
      parseAgentFile(
        "invalid.md",
        `---\nname: invalid\n${field}: sometimes\n---\n\nBody.\n`,
        "global",
      )[field],
    ).toBeUndefined();
  });

  it("accepts native outcome labels, rejects unknown values, and applies builtin overrides", () => {
    const parsed = parseAgentFile(
      "named.md",
      "---\nname: named\ndefaultExpectedOutcome: Write/update project file\n---\n\nBody.\n",
      "global",
    );
    expect(parsed.defaultExpectedOutcome).toBe("writeProjectFile");
    expect(
      parseAgentFile(
        "unknown.md",
        "---\nname: unknown\ndefaultExpectedOutcome: futureMutationMode\n---\n\nBody.\n",
        "global",
      ).defaultExpectedOutcome,
    ).toBeUndefined();

    const home = makeHome();
    const builtinFile = path.join(BUILTIN_AGENTS_DIR, "coder.md");
    const bytesBefore = readFileSync(builtinFile);
    const base = scanAgents({ home }).find((agent) => agent.name === "coder")!;
    const override = computeBuiltinOverride(base, {
      defaultExpectedOutcome: "writeProjectFile",
    });
    expect(override).toEqual({ defaultExpectedOutcome: "writeProjectFile" });
    writeBuiltinAgentOverride({ home }, "coder", override);
    expect(readFileSync(builtinFile).equals(bytesBefore)).toBe(true);
    expect(
      scanAgents({ home }).find((agent) => agent.name === "coder")?.defaultExpectedOutcome,
    ).toBe("writeProjectFile");
  });

  it("round-trips an agent's fallbackModels through write + scan (no silent loss)", () => {
    const home = makeHome();
    const roots = { home };

    const filePath = writeAgentFile(roots, "global", "sequencer", {
      description: "Plans",
      model: "anthropic/claude-opus-4",
      fallbackModels: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
      body: "You plan.",
    });
    // Serialized comma-joined (native AgentPersistence.swift:339), like mcpServers.
    expect(readFileSync(filePath, "utf8")).toContain(
      "fallbackModels: anthropic/claude-sonnet-4, openai/gpt-4o",
    );

    const agent = scanAgents(roots).find((a) => a.name === "sequencer")!;
    expect(agent.fallbackModels).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o"]);

    // A later unrelated edit (the exact silent-loss bug) preserves fallbackModels.
    writeAgentFile(roots, "global", "sequencer", { description: "Plans better" });
    expect(readFileSync(filePath, "utf8")).toContain(
      "fallbackModels: anthropic/claude-sonnet-4, openai/gpt-4o",
    );
    expect(scanAgents(roots).find((a) => a.name === "sequencer")!.fallbackModels).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
    ]);

    // Clearing removes the field.
    writeAgentFile(roots, "global", "sequencer", { fallbackModels: [] });
    expect(readFileSync(filePath, "utf8")).not.toContain("fallbackModels:");
    expect(scanAgents(roots).find((a) => a.name === "sequencer")!.fallbackModels).toBeUndefined();
  });

  it("edits a builtin's fallbackModels as a managed override, file untouched", () => {
    const home = makeHome();
    const builtinFile = path.join(BUILTIN_AGENTS_DIR, "coder.md");
    const bytesBefore = readFileSync(builtinFile);

    const base = scanAgents({ home }).find((a) => a.name === "coder" && a.scope === "builtin")!;
    const override = computeBuiltinOverride(base, {
      fallbackModels: ["anthropic/claude-sonnet-4"],
    });
    expect(override).toEqual({ fallbackModels: ["anthropic/claude-sonnet-4"] });
    writeBuiltinAgentOverride({ home }, "coder", override);

    expect(readFileSync(builtinFile).equals(bytesBefore)).toBe(true);
    const coder = scanAgents({ home }).find((a) => a.name === "coder")!;
    expect(coder.fallbackModels).toEqual(["anthropic/claude-sonnet-4"]);

    // Clearing it (empty list submitted) removes the override again.
    const cleared = mergeWithUnmanagedOverrideFields(
      readAgentOverrides({ home }).coder,
      computeBuiltinOverride(base, { fallbackModels: [] }),
    );
    writeBuiltinAgentOverride({ home }, "coder", cleared);
    expect(scanAgents({ home }).find((a) => a.name === "coder")!.fallbackModels).toBeUndefined();
  });

  it("imports each SKILL.md subdirectory from a cloned repo, copying assets", () => {
    const home = makeHome();
    const clone = mkdtempSync(path.join(tmpdir(), "skillrepo-"));
    mkdirSync(path.join(clone, "alpha"), { recursive: true });
    writeFileSync(
      path.join(clone, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: A\n---\nAlpha body",
    );
    writeFileSync(path.join(clone, "alpha", "helper.py"), "print(1)\n"); // an asset
    mkdirSync(path.join(clone, "nested", "beta"), { recursive: true });
    writeFileSync(
      path.join(clone, "nested", "beta", "SKILL.md"),
      "---\nname: beta\ndescription: B\n---\nBeta body",
    );

    const result = importSkillsFromClone({ home }, "global", clone, "myrepo");
    expect(result.imported.sort()).toEqual(["alpha", "beta"]);
    expect(result.skipped).toEqual([]);

    const skillsRoot = path.join(home, ".pi", "agent", "skills");
    expect(existsSync(path.join(skillsRoot, "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillsRoot, "alpha", "helper.py"))).toBe(true); // asset copied
    expect(existsSync(path.join(skillsRoot, "beta", "SKILL.md"))).toBe(true);

    // A second import of the same names is skipped, not clobbered.
    const again = importSkillsFromClone({ home }, "global", clone, "myrepo");
    expect(again.imported).toEqual([]);
    expect(again.skipped.sort()).toEqual(["alpha", "beta"]);
  });

  it("fingerprints source payload before the immediate pre-import hold hook", () => {
    const home = makeHome();
    const clone = mkdtempSync(path.join(tmpdir(), "skillrepo-hook-"));
    writeFileSync(
      path.join(clone, "SKILL.md"),
      "---\nname: held\ndescription: Held\n---\nRemote body",
    );
    const destination = path.join(home, ".pi", "agent", "skills", "held");
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, "SKILL.md"), "local bytes");
    let fingerprint = "";

    const result = importSkillsFromClone({ home }, "global", clone, "held", true, {
      beforeImport: (_name, sourceFingerprint) => {
        fingerprint = sourceFingerprint;
        return false;
      },
    });

    expect(fingerprint).toMatch(/^tree-v1:[0-9a-f]{64}$/);
    expect(result).toMatchObject({ imported: [], skipped: ["held"] });
    expect(readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe("local bytes");
  });

  it("a root SKILL.md imports the whole repo as one skill, .git excluded", () => {
    const home = makeHome();
    const clone = mkdtempSync(path.join(tmpdir(), "skillrepo-root-"));
    writeFileSync(
      path.join(clone, "SKILL.md"),
      "---\nname: rootskill\ndescription: R\n---\nRoot body",
    );
    writeFileSync(path.join(clone, "data.txt"), "asset\n");
    mkdirSync(path.join(clone, ".git"), { recursive: true });
    writeFileSync(path.join(clone, ".git", "config"), "[core]\n");

    const result = importSkillsFromClone({ home }, "global", clone, "fallback-name");
    expect(result.imported).toEqual(["rootskill"]);
    const dest = path.join(home, ".pi", "agent", "skills", "rootskill");
    expect(existsSync(path.join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(dest, "data.txt"))).toBe(true);
    expect(existsSync(path.join(dest, ".git"))).toBe(false); // .git never copied
  });

  it("creates a skill SKILL.md discoverable by pi's loader", () => {
    const home = makeHome();
    const filePath = writeSkillFile({ home }, "global", "notes", {
      description: "Take notes",
      body: "How to take notes.",
    });
    expect(filePath.endsWith(path.join("notes", "SKILL.md"))).toBe(true);
    expect(readFileSync(filePath, "utf8")).toContain("description: Take notes");
  });
});
