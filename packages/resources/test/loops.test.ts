import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOOP_STRUCTURE_UNSUPPORTED_CODE, type LoopStructure } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { deleteLoopFile, duplicateLoop, loopsDir, scanLoops, writeLoopFile } from "../src/loops.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "loops-home-"));
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
  it("creates, round-trips, updates, and deletes a loop", () => {
    const home = makeHome();
    const roots = { home };

    const filePath = writeLoopFile(roots, {
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
    writeLoopFile(roots, { name: "Fix Flaky Tests", maxIterations: 8 });
    const updated = scanLoops(roots).find((l) => l.name === "Fix Flaky Tests")!;
    expect(updated.maxIterations).toBe(8);
    expect(updated.goal).toBe("Find and fix the flaky test."); // body preserved

    deleteLoopFile(roots, "Fix Flaky Tests");
    expect(scanLoops(roots)).toEqual([]);
  });

  it("clamps maxIterations into 1..20 and defaults the structure/writeTarget", () => {
    const home = makeHome();
    const roots = { home };
    writeLoopFile(roots, { name: "big", maxIterations: 999, goal: "g" });
    writeLoopFile(roots, { name: "small", maxIterations: 0, goal: "g" });
    const loops = scanLoops(roots);
    expect(loops.find((l) => l.name === "big")!.maxIterations).toBe(20);
    expect(loops.find((l) => l.name === "small")!.maxIterations).toBe(1);
    // Unset structure/writeTarget default sensibly on read.
    expect(loops.find((l) => l.name === "big")!.structure).toBe("singleAgent");
    expect(loops.find((l) => l.name === "big")!.writeTarget).toBe("artifactMarkdown");
  });

  it("preserves unknown frontmatter from a native .loop.md on update", () => {
    const home = makeHome();
    const roots = { home };
    const filePath = writeLoopFile(roots, { name: "native", goal: "g" });
    // Inject a native-only field an external app wrote.
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace("---\n\n", "checkerRubric: be strict\n---\n\n"),
    );
    writeLoopFile(roots, { name: "native", description: "updated" });
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
    writeLoopFile(roots, { name: "Renamed Loop", maxIterations: 7 });
    expect(existsSync(path.join(dir, "renamed-loop.loop.md"))).toBe(false); // no orphan created
    expect(readFileSync(oddPath, "utf8")).toContain("maxIterations: 7");
    expect(scanLoops(roots)).toHaveLength(1);

    // Delete by name removes the actual file.
    deleteLoopFile(roots, "Renamed Loop");
    expect(existsSync(oddPath)).toBe(false);
  });

  it("duplicates a loop as 'Copy of X', de-duplicating on repeat", () => {
    const home = makeHome();
    const roots = { home };
    writeLoopFile(roots, {
      name: "Nightly",
      goal: "run nightly",
      maxIterations: 4,
      validationCommand: "make check",
      agentName: "coder",
    });

    const first = duplicateLoop(roots, "Nightly");
    expect(first).toBe("Copy of Nightly");
    const copy = scanLoops(roots).find((l) => l.name === "Copy of Nightly")!;
    expect(copy).toMatchObject({
      goal: "run nightly",
      maxIterations: 4,
      validationCommand: "make check",
      agentName: "coder",
    });

    // A second duplicate of the same source gets a numbered name.
    expect(duplicateLoop(roots, "Nightly")).toBe("Copy of Nightly (2)");
    expect(scanLoops(roots)).toHaveLength(3);

    expect(() => duplicateLoop(roots, "Ghost")).toThrow("loop_not_found");
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
    writeLoopFile(roots, { name: "Review Loop", checkerRubric: "Require green tests" });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toContain("checkerRubric: Require green tests");
    expect(raw).toContain("nativeOnly: keep");
    expect(existsSync(path.join(dir, "review-loop.loop.md"))).toBe(false);
    expect(duplicateLoop(roots, "Review Loop")).toBe("Copy of Review Loop");
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
    writeLoopFile(roots, {
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
    expect(duplicateLoop(roots, "Native Pipeline")).toBe("Copy of Native Pipeline");
    const pipelineCopy = scanLoops(roots).find((loop) => loop.name === "Copy of Native Pipeline")!;
    expect(pipelineCopy).toMatchObject({
      pipelineStages: ["Agent B", "Agent A", "Agent A"],
    });
    expect(readFileSync(pipelineCopy.filePath, "utf8")).toBe(
      raw.replace("name: Native Pipeline", "name: Copy of Native Pipeline"),
    );
    expect(() =>
      writeLoopFile(
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
      writeLoopFile(
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

  it.each<LoopStructure>(["parallelAgents", "discoveryTriage", "humanApproval"])(
    "rejects unsupported %s writes/duplicates without mutation and permits explicit conversion",
    (structure) => {
      const createRoots = { home: makeHome() };
      expect(() =>
        writeLoopFile(createRoots, { name: "Unsupported Create", goal: "g", structure }),
      ).toThrow(expect.objectContaining({ code: LOOP_STRUCTURE_UNSUPPORTED_CODE, structure }));
      expect(existsSync(loopsDir(createRoots))).toBe(false);

      // Native/external tools may have written this structure. Public updates
      // that inherit it and direct duplication both fail without touching it.
      const roots = { home: makeHome() };
      const filePath = writeExternalLoop(roots, "Native Loop", structure);
      const original = readFileSync(filePath, "utf8");
      expect(() =>
        writeLoopFile(roots, { name: "Native Loop", description: "no mutation" }),
      ).toThrow(expect.objectContaining({ code: LOOP_STRUCTURE_UNSUPPORTED_CODE, structure }));
      expect(() => duplicateLoop(roots, "Native Loop")).toThrow(
        expect.objectContaining({ code: LOOP_STRUCTURE_UNSUPPORTED_CODE, structure }),
      );
      expect(scanLoops(roots)).toHaveLength(1);
      expect(readFileSync(filePath, "utf8")).toBe(original);
      expect(existsSync(path.join(loopsDir(roots), "copy-of-native-loop.loop.md"))).toBe(false);

      // Explicit conversion is the sole supported write and retains unknown
      // native metadata plus fields/body omitted by this edit.
      expect(
        writeLoopFile(roots, {
          name: "Native Loop",
          structure: "singleAgent",
          description: "converted",
        }),
      ).toBe(filePath);
      const converted = readFileSync(filePath, "utf8");
      expect(converted).toContain("structure: singleAgent");
      expect(converted).toContain("checkerRubric: preserve me");
      expect(converted).toContain("maxIterations: 7");
      expect(converted).toContain("External goal.");
      expect(scanLoops(roots)[0]).toMatchObject({
        structure: "singleAgent",
        description: "converted",
      });
    },
  );

  it("rejects a different name that collides on the same slug", () => {
    const home = makeHome();
    const roots = { home };
    writeLoopFile(roots, { name: "My Loop", goal: "g" });
    expect(() => writeLoopFile(roots, { name: "my-loop", goal: "g2" })).toThrow(
      "loop_slug_conflict",
    );
  });
});
