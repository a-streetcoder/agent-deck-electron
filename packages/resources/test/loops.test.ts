import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LOOP_DEFAULT_CHECKPOINT_PROMPT,
  LOOP_DEFAULT_CLASSIFICATION_PROMPT,
  type LoopStructure,
} from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  deleteLoopFile as deleteLoopById,
  duplicateLoop as duplicateLoopById,
  loopsDir,
  scanLoops,
  writeLoopFile as persistLoopFile,
} from "../src/loops.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "loops-home-"));
}

function saveLoopFile(
  roots: { home: string },
  edit: Parameters<typeof persistLoopFile>[1],
): string {
  const existing = scanLoops(roots).find((loop) => loop.name === edit.name);
  const resultingStructure = edit.structure ?? existing?.structure ?? "singleAgent";
  const withRequiredAgent =
    resultingStructure === "singleAgent"
      ? { agentName: edit.agentName ?? existing?.agentName ?? "Agent A", ...edit }
      : edit;
  return persistLoopFile(
    roots,
    existing ? { ...withRequiredAgent, id: existing.id } : withRequiredAgent,
  );
}

function duplicateNamedLoop(roots: { home: string }, name: string): string {
  const loop = scanLoops(roots).find((candidate) => candidate.name === name);
  if (!loop) throw new Error(`missing fixture Loop: ${name}`);
  return duplicateLoopById(roots, loop.id);
}

function deleteNamedLoop(roots: { home: string }, name: string): void {
  const loop = scanLoops(roots).find((candidate) => candidate.name === name);
  if (loop) deleteLoopById(roots, loop.id);
}

function parseWithNativeLineReader(content: string): Record<string, string> {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const closingWithBody = normalized.indexOf("\n---\n", 4);
  const closing =
    closingWithBody >= 0
      ? closingWithBody
      : normalized.endsWith("\n---")
        ? normalized.length - 4
        : -1;
  if (closing < 0) return {};
  const frontmatter = normalized.slice(4, closing);
  return Object.fromEntries(
    frontmatter.split("\n").flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator < 0) return [];
      return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]];
    }),
  );
}

function writeExternalLoop(
  roots: { home: string },
  name: string,
  structure: LoopStructure,
): string {
  const dir = loopsDir(roots);
  const filePath = path.join(dir, "native.loop.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    filePath,
    `---\nname: ${name}\nstructure: ${structure}\nmaxIterations: 7\ncheckerRubric: preserve me\n---\n\nExternal goal.\n`,
  );
  return filePath;
}

describe("loop definition store", () => {
  it("keeps direct Node filesystem authority out of Loop catalog persistence", () => {
    const source = readFileSync(new URL("../src/loops.ts", import.meta.url), "utf8");
    expect(source.match(/from ["']node:fs(?:\/promises)?["']/g) ?? []).toEqual([]);
    expect(
      source.match(
        /\b(?:readFile|readFileSync|writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync)\b/g,
      ) ?? [],
    ).toEqual([]);
    expect(source).toContain("scanLoopCatalog");
    expect(source).toContain("createLoopCatalogFile");
    expect(source).toContain("replaceLoopCatalogFile");
    expect(source).toContain("deleteLoopCatalogFile");
  });

  it("creates, round-trips, updates, and deletes a loop", () => {
    const home = makeHome();
    const roots = { home };

    const filePath = saveLoopFile(roots, {
      name: "Fix Flaky Tests",
      description: "Iterate until the suite is green",
      goal: "Find and fix the flaky test.",
      structure: "singleAgent",
      agentName: "coder",
      maxIterations: 5,
      validationCommand: "pnpm test",
      writeTarget: "currentCheckout",
    });
    // Slugged filename under the loops dir; goal is the markdown body.
    expect(filePath).toBe(path.join(loopsDir(roots), "fix-flaky-tests.loop.md"));
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toContain("name: Fix Flaky Tests");
    expect(raw).toContain("maxIterations: 5");
    expect(raw).toContain("Find and fix the flaky test.");

    const [loop] = scanLoops(roots);
    expect(loop).toMatchObject({
      name: "Fix Flaky Tests",
      description: "Iterate until the suite is green",
      goal: "Find and fix the flaky test.",
      structure: "singleAgent",
      agentName: "coder",
      maxIterations: 5,
      validationCommand: "pnpm test",
      writeTarget: "currentCheckout",
      source: "user",
    });

    // An update by the same name preserves the file + changes fields.
    saveLoopFile(roots, { name: "Fix Flaky Tests", maxIterations: 8 });
    const updated = scanLoops(roots).find((l) => l.name === "Fix Flaky Tests")!;
    expect(updated.maxIterations).toBe(8);
    expect(updated.goal).toBe("Find and fix the flaky test."); // body preserved

    deleteNamedLoop(roots, "Fix Flaky Tests");
    expect(scanLoops(roots)).toEqual([]);
  });

  it("preserves unlimited 0, clamps positive maxIterations to 100, and defaults fields", () => {
    const home = makeHome();
    const roots = { home };
    saveLoopFile(roots, { name: "big", maxIterations: 999, goal: "g" });
    saveLoopFile(roots, { name: "small", maxIterations: 0, goal: "g" });
    const loops = scanLoops(roots);
    expect(loops.find((l) => l.name === "big")!.maxIterations).toBe(100);
    expect(loops.find((l) => l.name === "small")!.maxIterations).toBe(0);
    // Unset structure/writeTarget default sensibly on read.
    expect(loops.find((l) => l.name === "big")!.structure).toBe("singleAgent");
    expect(loops.find((l) => l.name === "big")!.writeTarget).toBe("artifactMarkdown");
  });

  it("round-trips native launch context, availability, legacy values, and stable non-slug identity", () => {
    const roots = { home: makeHome() };
    const directory = loopsDir(roots);
    mkdirSync(directory, { recursive: true });
    const nativePath = path.join(directory, "Native Odd Name @1.loop.md");
    writeFileSync(
      nativePath,
      [
        "---",
        "name: Native Context",
        "structure: singleAgent",
        "launchContextScope: everyIteration",
        `launchContextJSON: ${JSON.stringify('line 1\r\n"quoted"')}`,
        "availability: projectPaths",
        'projectPathsJSON: ["/repo/a", "/repo/a", " /repo/b "]',
        "maxIterations: 101",
        "nativeOnly: keep",
        "---",
        "",
        "Goal body.",
        "",
      ].join("\r\n"),
    );

    const [native] = scanLoops(roots);
    expect(native).toMatchObject({
      name: "Native Context",
      launchContext: 'line 1\r\n"quoted"',
      launchContextScope: "everyIteration",
      availability: "projectPaths",
      projectPaths: ["/repo/a", "/repo/b"],
      maxIterations: 100,
    });
    expect(native!.id).not.toContain("/");

    saveLoopFile(roots, {
      id: native!.id,
      name: native!.name,
      launchContext: 'new\nmultiline "context"',
      launchContextScope: "firstIterationOnly",
      availability: "projectPaths",
      projectPaths: ["/repo/b", "/repo/b", "/repo/a"],
      maxIterations: 0,
    });
    const raw = readFileSync(nativePath, "utf8");
    expect(raw).toContain('launchContextJSON: "new\\nmultiline \\"context\\""');
    expect(raw).toContain('projectPathsJSON: ["/repo/b","/repo/a"]');
    expect(raw).toContain("nativeOnly: keep");
    expect(existsSync(path.join(directory, "native-context.loop.md"))).toBe(false);

    const copyName = duplicateLoopById(roots, native!.id);
    expect(copyName).toBe("Copy of Native Context");
    expect(scanLoops(roots).find((loop) => loop.name === copyName)).toMatchObject({
      launchContext: 'new\nmultiline "context"',
      projectPaths: ["/repo/b", "/repo/a"],
      maxIterations: 0,
    });
    deleteLoopById(roots, native!.id);
    expect(existsSync(nativePath)).toBe(false);
  });

  it("round-trips native goal evaluator JSON, legacy/default values, and overrides", () => {
    const roots = { home: makeHome() };
    saveLoopFile(roots, {
      name: "Evaluator Config",
      goal: "Ship safely.",
      agentName: "Agent A",
      successCondition: "Tests pass.\nNo regressions.",
      successConditionSource: "custom",
      evaluatorProvider: "mock-provider-b",
      evaluatorModel: "mock-evaluator",
      evaluatorThinkingLevel: "high",
    });
    const saved = scanLoops(roots).find((loop) => loop.name === "Evaluator Config")!;
    expect(saved).toMatchObject({
      successCondition: "Tests pass.\nNo regressions.",
      successConditionSource: "custom",
      evaluatorProvider: "mock-provider-b",
      evaluatorModel: "mock-evaluator",
      evaluatorThinkingLevel: "high",
    });
    expect(readFileSync(saved.filePath, "utf8")).toContain("evaluatorProvider: mock-provider-b");
    expect(readFileSync(saved.filePath, "utf8")).toContain(
      'successConditionJSON: "Tests pass.\\nNo regressions."',
    );
    saveLoopFile(roots, {
      id: saved.id,
      name: saved.name,
      evaluatorModel: "",
    });
    expect(readFileSync(saved.filePath, "utf8")).not.toContain("evaluatorProvider:");
    expect(scanLoops(roots).find((loop) => loop.id === saved.id)).toMatchObject({
      evaluatorProvider: undefined,
      evaluatorModel: undefined,
    });

    const directory = loopsDir(roots);
    writeFileSync(
      path.join(directory, "legacy-evaluator.loop.md"),
      "---\nname: Legacy Evaluator\nagentName: Agent A\nsuccessCondition: Legacy done\n---\nDefault goal\n",
    );
    writeFileSync(
      path.join(directory, "default-evaluator.loop.md"),
      "---\nname: Default Evaluator\nagentName: Agent A\n---\nBody is success\n",
    );
    expect(scanLoops(roots).find((loop) => loop.name === "Legacy Evaluator")).toMatchObject({
      successCondition: "Legacy done",
      successConditionSource: "custom",
    });
    expect(scanLoops(roots).find((loop) => loop.name === "Default Evaluator")).toMatchObject({
      successCondition: "Body is success",
      successConditionSource: "goal",
    });

    saveLoopFile(roots, {
      name: "Explicit Equal",
      goal: "Same text",
      agentName: "Agent A",
      successCondition: "Same text",
      successConditionSource: "custom",
    });
    const explicit = scanLoops(roots).find((loop) => loop.name === "Explicit Equal")!;
    expect(explicit).toMatchObject({
      successCondition: "Same text",
      successConditionSource: "custom",
    });
    expect(readFileSync(explicit.filePath, "utf8")).toContain('successConditionJSON: "Same text"');

    saveLoopFile(roots, {
      id: explicit.id,
      name: explicit.name,
      goal: "New goal",
      successCondition: "New goal",
      successConditionSource: "goal",
    });
    const reset = scanLoops(roots).find((loop) => loop.name === "Explicit Equal")!;
    expect(reset).toMatchObject({ successCondition: "New goal", successConditionSource: "goal" });
    expect(readFileSync(reset.filePath, "utf8")).not.toContain("successConditionJSON:");
  });

  it("falls back from valid JSON with wrong metadata types without hiding the Loop", () => {
    const roots = { home: makeHome() };
    const directory = loopsDir(roots);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "wrong-types.loop.md"),
      [
        "---",
        "name: Wrong Types",
        'launchContextJSON: {"not":"a string"}',
        "launchContext: legacy context",
        "availability: projectPaths",
        'projectPathsJSON: "not an array"',
        "projectPaths: /legacy/a | /legacy/b",
        "---",
        "",
        "Still visible.",
      ].join("\n"),
    );
    writeFileSync(
      path.join(directory, "wrong-array.loop.md"),
      [
        "---",
        "name: Wrong Array",
        'launchContextJSON: ["not", "a string value"]',
        "availability: projectPaths",
        'projectPathsJSON: ["valid", 42]',
        "---",
        "",
        "Also visible.",
      ].join("\n"),
    );

    expect(scanLoops(roots)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Wrong Types",
          launchContext: "legacy context",
          projectPaths: ["/legacy/a", "/legacy/b"],
        }),
        expect.objectContaining({
          name: "Wrong Array",
          launchContext: undefined,
          projectPaths: [],
        }),
      ]),
    );
  });

  it("uses opaque identity only when a display name collides with another record id", () => {
    const roots = { home: makeHome() };
    persistLoopFile(roots, { name: "Alpha", goal: "alpha goal", agentName: "Agent A" });
    const alpha = scanLoops(roots).find((loop) => loop.name === "Alpha")!;
    persistLoopFile(roots, {
      name: alpha.id,
      goal: "collision goal",
      agentName: "Agent A",
    });
    const collision = scanLoops(roots).find((loop) => loop.name === alpha.id)!;

    persistLoopFile(roots, { id: alpha.id, name: "Alpha", description: "selected alpha" });
    expect(scanLoops(roots).find((loop) => loop.id === alpha.id)?.description).toBe(
      "selected alpha",
    );
    expect(scanLoops(roots).find((loop) => loop.id === collision.id)?.goal).toBe("collision goal");

    expect(duplicateLoopById(roots, alpha.id)).toBe("Copy of Alpha");
    expect(scanLoops(roots).some((loop) => loop.name === `Copy of ${alpha.id}`)).toBe(false);
    deleteLoopById(roots, alpha.id);
    expect(scanLoops(roots).some((loop) => loop.id === alpha.id)).toBe(false);
    expect(scanLoops(roots).find((loop) => loop.id === collision.id)?.name).toBe(alpha.id);
  });

  it("parses legacy launch context and pipe-separated project paths", () => {
    const roots = { home: makeHome() };
    const directory = loopsDir(roots);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "legacy.loop.md"),
      "---\nname: Legacy\nlaunchContext: legacy context\navailability: projectPaths\nprojectPaths: /one | /two | /one\n---\n\nGoal.\n",
    );
    expect(scanLoops(roots)[0]).toMatchObject({
      launchContext: "legacy context",
      launchContextScope: "firstIterationOnly",
      availability: "projectPaths",
      projectPaths: ["/one", "/two"],
      maxIterations: 3,
    });
  });

  it("preserves unknown frontmatter from a native .loop.md on update", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = saveLoopFile(roots, { name: "native", goal: "g" });
    // Inject a native-only field an external app wrote.
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace("---\n\n", "checkerRubric: be strict\n---\n\n"),
    );
    saveLoopFile(roots, { name: "native", description: "updated" });
    expect(readFileSync(filePath, "utf8")).toContain("checkerRubric: be strict");
  });

  it("edits a loop whose filename doesn't match its name slug, in place (no orphan)", () => {
    const home = makeHome();
    const roots = { home };
    // A native-style file whose filename ≠ slug(name).
    const dir = loopsDir(roots);
    mkdirSync(dir, { recursive: true });
    const oddPath = path.join(dir, "custom-file.loop.md");
    writeFileSync(oddPath, "---\nname: Renamed Loop\nmaxIterations: 2\n---\n\nDo the thing.\n");

    // Editing by name must update THAT file, not create renamed-loop.loop.md.
    saveLoopFile(roots, { name: "Renamed Loop", maxIterations: 7 });
    expect(existsSync(path.join(dir, "renamed-loop.loop.md"))).toBe(false); // no orphan created
    expect(readFileSync(oddPath, "utf8")).toContain("maxIterations: 7");
    expect(scanLoops(roots)).toHaveLength(1);

    // Delete by name removes the actual file.
    deleteNamedLoop(roots, "Renamed Loop");
    expect(existsSync(oddPath)).toBe(false);
  });

  it("duplicates a loop as 'Copy of X', de-duplicating on repeat", () => {
    const home = makeHome();
    const roots = { home };
    saveLoopFile(roots, {
      name: "Nightly",
      goal: "run nightly",
      maxIterations: 4,
      validationCommand: "make check",
      agentName: "coder",
    });

    const first = duplicateNamedLoop(roots, "Nightly");
    expect(first).toBe("Copy of Nightly");
    const copy = scanLoops(roots).find((l) => l.name === "Copy of Nightly")!;
    expect(copy).toMatchObject({
      goal: "run nightly",
      maxIterations: 4,
      validationCommand: "make check",
      agentName: "coder",
    });

    // A second duplicate of the same source gets a numbered name.
    expect(duplicateNamedLoop(roots, "Nightly")).toBe("Copy of Nightly (2)");
    expect(scanLoops(roots)).toHaveLength(3);

    expect(() => duplicateLoopById(roots, "missing-id")).toThrow("loop_not_found");
  });

  it("round-trips native-flat Maker+Checker fields and unknown metadata in a non-slug file", () => {
    const roots = { home: makeHome() };
    const dir = loopsDir(roots);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "native-review.loop.md");
    writeFileSync(
      filePath,
      "---\nname: Review Loop\nstructure: makerChecker\nmakerName: Maker\ncheckerName: Checker\ncheckerRubric: Verify tests and evidence\nnativeOnly: keep\n---\n\nShip safely.\n",
    );
    expect(scanLoops(roots)[0]).toMatchObject({
      makerName: "Maker",
      checkerName: "Checker",
      checkerRubric: "Verify tests and evidence",
    });
    saveLoopFile(roots, { name: "Review Loop", checkerRubric: "Require green tests" });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toContain("checkerRubric: Require green tests");
    expect(raw).toContain("nativeOnly: keep");
    expect(existsSync(path.join(dir, "review-loop.loop.md"))).toBe(false);
    expect(duplicateNamedLoop(roots, "Review Loop")).toBe("Copy of Review Loop");
    expect(scanLoops(roots).find((loop) => loop.name === "Copy of Review Loop")).toMatchObject({
      structure: "makerChecker",
      makerName: "Maker",
      checkerName: "Checker",
      checkerRubric: "Require green tests",
    });
  });

  it("round-trips native Pipeline order, repeated names, duplication, and unknown metadata", () => {
    const roots = { home: makeHome() };
    const dir = loopsDir(roots);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "native-pipeline.loop.md");
    writeFileSync(
      filePath,
      [
        "---",
        "name: Native Pipeline",
        "unknownZulu: last",
        "pipelineStages: Agent A | Agent A | Agent B",
        "maxIterations: 7",
        "source: user",
        "validationCommand: pnpm test",
        "structure: agentPipeline",
        "description: Native ordered pipeline",
        "unknownAlpha: first",
        "writeTarget: artifactMarkdown",
        "---",
        "",
        "Ship in order.",
        "",
      ].join("\n"),
    );
    expect(scanLoops(roots)[0]).toMatchObject({
      structure: "agentPipeline",
      pipelineStages: ["Agent A", "Agent A", "Agent B"],
    });
    saveLoopFile(roots, {
      name: "Native Pipeline",
      pipelineStages: ["Agent B", "Agent A", "Agent A"],
    });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toBe(
      [
        "---",
        "name: Native Pipeline",
        "description: Native ordered pipeline",
        "source: user",
        "structure: agentPipeline",
        "writeTarget: artifactMarkdown",
        "maxIterations: 7",
        "validationCommand: pnpm test",
        "pipelineStages: Agent B | Agent A | Agent A",
        "unknownAlpha: first",
        "unknownZulu: last",
        "---",
        "",
        "Ship in order.",
        "",
      ].join("\n"),
    );
    expect(duplicateNamedLoop(roots, "Native Pipeline")).toBe("Copy of Native Pipeline");
    const pipelineCopy = scanLoops(roots).find((loop) => loop.name === "Copy of Native Pipeline")!;
    expect(pipelineCopy).toMatchObject({
      pipelineStages: ["Agent B", "Agent A", "Agent A"],
    });
    expect(readFileSync(pipelineCopy.filePath, "utf8")).toBe(
      raw
        .replace("name: Native Pipeline", "name: Copy of Native Pipeline")
        .replace("unknownAlpha: first", "availability: allProjects\nunknownAlpha: first"),
    );
    expect(() =>
      saveLoopFile(
        { home: makeHome() },
        {
          name: "Empty Pipeline",
          goal: "g",
          structure: "agentPipeline",
          pipelineStages: [],
        },
      ),
    ).toThrow("At least one pipeline stage");
    expect(() =>
      saveLoopFile(
        { home: makeHome() },
        {
          name: "Blank Pipeline",
          goal: "g",
          structure: "agentPipeline",
          pipelineStages: ["Agent A", " "],
        },
      ),
    ).toThrow("cannot be blank");
  });

  it("normalizes, canonically serializes, edits, and duplicates native Parallel branches", () => {
    const roots = { home: makeHome() };
    const dir = loopsDir(roots);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "native-parallel.loop.md");
    writeFileSync(
      filePath,
      [
        "---",
        "unknownZulu: last",
        "parallelBranches: Agent A |  | Agent B | Agent A |   | Agent C | Agent B",
        "name: Native Parallel",
        "source: user",
        "maxIterations: 4",
        "structure: parallelAgents",
        "description: Independent reports",
        "unknownAlpha: first",
        "writeTarget: artifactMarkdown",
        "validationCommand: exit 0",
        "---",
        "",
        "Investigate independently.",
        "",
      ].join("\n"),
    );
    expect(scanLoops(roots)[0]).toMatchObject({
      structure: "parallelAgents",
      parallelBranches: ["Agent A", "Agent B", "Agent C"],
    });

    saveLoopFile(roots, {
      name: "Native Parallel",
      parallelBranches: [" Agent B ", "", "Agent B", "Agent A", "  ", "Agent C", "Agent A"],
    });
    const expected = [
      "---",
      "name: Native Parallel",
      "description: Independent reports",
      "source: user",
      "structure: parallelAgents",
      "writeTarget: artifactMarkdown",
      "maxIterations: 4",
      "validationCommand: exit 0",
      "parallelBranches: Agent B | Agent A | Agent C",
      "unknownAlpha: first",
      "unknownZulu: last",
      "---",
      "",
      "Investigate independently.",
      "",
    ].join("\n");
    expect(readFileSync(filePath, "utf8")).toBe(expected);

    expect(duplicateNamedLoop(roots, "Native Parallel")).toBe("Copy of Native Parallel");
    const copy = scanLoops(roots).find((loop) => loop.name === "Copy of Native Parallel")!;
    expect(copy.parallelBranches).toEqual(["Agent B", "Agent A", "Agent C"]);
    expect(readFileSync(copy.filePath, "utf8")).toBe(
      expected
        .replace("name: Native Parallel", "name: Copy of Native Parallel")
        .replace("unknownAlpha: first", "availability: allProjects\nunknownAlpha: first"),
    );
  });

  it("rejects invalid or unsafe Parallel definitions without mutation", () => {
    const roots = { home: makeHome() };
    expect(() =>
      saveLoopFile(roots, {
        name: "Blank Parallel",
        goal: "Investigate",
        structure: "parallelAgents",
        parallelBranches: ["", "   "],
        writeTarget: "artifactMarkdown",
      }),
    ).toThrow("At least one parallel branch agent");
    expect(() =>
      saveLoopFile(roots, {
        name: "Unsafe Parallel",
        goal: "Investigate",
        structure: "parallelAgents",
        parallelBranches: ["Agent A"],
        writeTarget: "currentCheckout",
      }),
    ).toThrow("report-only");
    expect(existsSync(loopsDir(roots))).toBe(false);

    const filePath = writeExternalLoop(roots, "Persisted Unsafe", "parallelAgents");
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace(
        "maxIterations: 7",
        "writeTarget: newWorktree\nparallelBranches: Agent A | Agent B\nmaxIterations: 7",
      ),
    );
    const original = readFileSync(filePath, "utf8");
    expect(() => saveLoopFile(roots, { name: "Persisted Unsafe", description: "no" })).toThrow(
      "report-only",
    );
    expect(() => duplicateNamedLoop(roots, "Persisted Unsafe")).toThrow("report-only");
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("cross-reads, canonically edits, and duplicates native Discovery/Triage metadata", () => {
    const roots = { home: makeHome() };
    const filePath = path.join(loopsDir(roots), "native-triage.loop.md");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "unknownZulu: last",
        "classificationPrompt: Classify by severity and assign an owner.",
        "name: Native Triage",
        "triageAgent: Explorer",
        "structure: discoveryTriage",
        "writeTarget: artifactMarkdown",
        "maxIterations: 3",
        "unknownAlpha: first",
        "---",
        "",
        "Discover release risks.",
        "",
      ].join("\n"),
    );

    expect(scanLoops(roots)[0]).toMatchObject({
      structure: "discoveryTriage",
      triageAgent: "Explorer",
      classificationPrompt: "Classify by severity and assign an owner.",
    });
    saveLoopFile(roots, {
      name: "Native Triage",
      description: "Classified discovery",
      triageAgent: "Triage Agent",
      classificationPrompt:
        "  Severity: high impact # release\r\nOwner and evidence\rSafest next action  ",
    });
    const normalizedPrompt =
      "Severity: high impact # release Owner and evidence Safest next action";
    const expected = [
      "---",
      "name: Native Triage",
      "description: Classified discovery",
      "structure: discoveryTriage",
      "writeTarget: artifactMarkdown",
      "maxIterations: 3",
      "triageAgent: Triage Agent",
      `classificationPrompt: ${normalizedPrompt}`,
      "unknownAlpha: first",
      "unknownZulu: last",
      "---",
      "",
      "Discover release risks.",
      "",
    ].join("\n");
    const saved = readFileSync(filePath, "utf8");
    expect(saved).toBe(expected);
    expect(parseWithNativeLineReader(saved).classificationPrompt).toBe(normalizedPrompt);

    expect(duplicateNamedLoop(roots, "Native Triage")).toBe("Copy of Native Triage");
    const copy = scanLoops(roots).find((loop) => loop.name === "Copy of Native Triage")!;
    expect(copy).toMatchObject({
      triageAgent: "Triage Agent",
      classificationPrompt: normalizedPrompt,
    });
    const copied = readFileSync(copy.filePath, "utf8");
    expect(copied).toBe(
      expected
        .replace("name: Native Triage", "name: Copy of Native Triage")
        .replace("unknownAlpha: first", "availability: allProjects\nunknownAlpha: first"),
    );
    expect(parseWithNativeLineReader(copied).classificationPrompt).toBe(normalizedPrompt);
  });

  it("accepts native final delimiters and cross-reads quoted triage text without changing bodies", () => {
    const prompt = 'Severity: "high" # release';
    const nativeRoots = { home: makeHome() };
    const nativePath = path.join(loopsDir(nativeRoots), "final-delimiter.loop.md");
    mkdirSync(path.dirname(nativePath), { recursive: true });
    const nativeOnly = [
      "---",
      "name: Final Delimiter Triage",
      "structure: discoveryTriage",
      "writeTarget: artifactMarkdown",
      "triageAgent: Explorer",
      `classificationPrompt: ${prompt}`,
      "---",
    ].join("\n");
    writeFileSync(nativePath, nativeOnly);

    expect(parseWithNativeLineReader(nativeOnly).classificationPrompt).toBe(prompt);
    expect(scanLoops(nativeRoots)[0]).toMatchObject({
      name: "Final Delimiter Triage",
      goal: "",
      triageAgent: "Explorer",
      classificationPrompt: prompt,
    });

    const electronRoots = { home: makeHome() };
    const electronPath = saveLoopFile(electronRoots, {
      name: "Electron Triage",
      structure: "discoveryTriage",
      goal: "Discover release risks.",
      triageAgent: "Explorer",
      classificationPrompt: prompt,
      writeTarget: "artifactMarkdown",
    });
    const serialized = readFileSync(electronPath, "utf8");
    const serializedNative = parseWithNativeLineReader(serialized);
    expect(serializedNative.classificationPrompt).toBe(prompt);
    expect(Object.keys(serializedNative).indexOf("triageAgent")).toBeLessThan(
      Object.keys(serializedNative).indexOf("classificationPrompt"),
    );
    expect(scanLoops(electronRoots)[0]).toMatchObject({
      goal: "Discover release risks.",
      classificationPrompt: prompt,
    });

    expect(duplicateNamedLoop(electronRoots, "Electron Triage")).toBe("Copy of Electron Triage");
    const duplicate = scanLoops(electronRoots).find(
      (loop) => loop.name === "Copy of Electron Triage",
    )!;
    const duplicateText = readFileSync(duplicate.filePath, "utf8");
    expect(parseWithNativeLineReader(duplicateText).classificationPrompt).toBe(prompt);
    expect(duplicate).toMatchObject({
      goal: "Discover release risks.",
      classificationPrompt: prompt,
    });
  });

  it("defaults missing and blank native Discovery/Triage classification prompts", () => {
    for (const [name, promptLine] of [
      ["Missing Prompt", ""],
      ["Blank Prompt", "classificationPrompt:    \n"],
    ] as const) {
      const roots = { home: makeHome() };
      const filePath = path.join(loopsDir(roots), "native-triage.loop.md");
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        `---\nname: ${name}\nstructure: discoveryTriage\ntriageAgent: Explorer\n${promptLine}writeTarget: artifactMarkdown\n---\n\nDiscover risks.\n`,
      );
      expect(scanLoops(roots)[0]!.classificationPrompt).toBe(LOOP_DEFAULT_CLASSIFICATION_PROMPT);
      saveLoopFile(roots, { name, description: "canonicalized" });
      const saved = readFileSync(filePath, "utf8");
      expect(parseWithNativeLineReader(saved).classificationPrompt).toBe(
        LOOP_DEFAULT_CLASSIFICATION_PROMPT,
      );
    }
  });

  it("round-trips, defaults, edits, and duplicates native Human Approval definitions", () => {
    const roots = { home: makeHome() };
    const filePath = path.join(loopsDir(roots), "native-approval.loop.md");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const prompt = 'Severity: "high" # release';
    writeFileSync(
      filePath,
      [
        "---",
        "name: Native Approval",
        "structure: humanApproval",
        "writeTarget: currentCheckout",
        `checkpointPrompt: ${prompt}`,
        "zetaMetadata: preserved",
        "---",
      ].join("\n"),
    );
    expect(scanLoops(roots)[0]).toMatchObject({
      structure: "humanApproval",
      goal: "",
      checkpointPrompt: prompt,
    });

    saveLoopFile(roots, { name: "Native Approval", description: "edited" });
    const saved = readFileSync(filePath, "utf8");
    expect(parseWithNativeLineReader(saved).checkpointPrompt).toBe(prompt);
    expect(saved).toContain("zetaMetadata: preserved");
    expect(saved.indexOf("checkpointPrompt:")).toBeLessThan(saved.indexOf("zetaMetadata:"));

    expect(duplicateNamedLoop(roots, "Native Approval")).toBe("Copy of Native Approval");
    const copy = scanLoops(roots).find((loop) => loop.name === "Copy of Native Approval")!;
    expect(copy).toMatchObject({ checkpointPrompt: prompt, goal: "" });
    expect(parseWithNativeLineReader(readFileSync(copy.filePath, "utf8")).checkpointPrompt).toBe(
      prompt,
    );

    const blankRoots = { home: makeHome() };
    const blankPath = saveLoopFile(blankRoots, {
      name: "Default Approval",
      structure: "humanApproval",
      checkpointPrompt: " \r\n ",
    });
    expect(scanLoops(blankRoots)[0]?.checkpointPrompt).toBe(LOOP_DEFAULT_CHECKPOINT_PROMPT);
    expect(parseWithNativeLineReader(readFileSync(blankPath, "utf8")).checkpointPrompt).toBe(
      LOOP_DEFAULT_CHECKPOINT_PROMPT,
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed on catalog and final symlinks without touching outside sentinels",
    () => {
      const home = makeHome();
      const victim = path.join(home, "victim");
      mkdirSync(victim);
      const sentinel = path.join(victim, "sentinel");
      writeFileSync(sentinel, "safe");
      symlinkSync(victim, path.join(home, ".pi"));
      expect(() => saveLoopFile({ home }, { name: "Unsafe", goal: "bad" })).toThrow(
        expect.objectContaining({ code: "LOOP_CATALOG_UNSAFE_COMPONENT" }),
      );
      expect(readFileSync(sentinel, "utf8")).toBe("safe");

      const secondHome = makeHome();
      const directory = loopsDir({ home: secondHome });
      mkdirSync(directory, { recursive: true });
      symlinkSync(sentinel, path.join(directory, "unsafe.loop.md"));
      expect(scanLoops({ home: secondHome })).toEqual([]);
      expect(() => saveLoopFile({ home: secondHome }, { name: "Unsafe", goal: "bad" })).toThrow(
        "loop_slug_conflict",
      );
      deleteNamedLoop({ home: secondHome }, "Unsafe");
      expect(readFileSync(sentinel, "utf8")).toBe("safe");
    },
  );

  it("rejects a different name that collides on the same slug", () => {
    const home = makeHome();
    const roots = { home };
    saveLoopFile(roots, { name: "My Loop", goal: "g" });
    expect(() => saveLoopFile(roots, { name: "my-loop", goal: "g2" })).toThrow(
      "loop_slug_conflict",
    );
  });
});
