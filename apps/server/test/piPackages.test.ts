import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { declaredPiPackages } from "../src/piPackages.ts";

describe("declaredPiPackages (SBX-09)", () => {
  it("lists string and object sources, and nothing for a missing or invalid file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deck-pi-packages-"));
    expect(declaredPiPackages(dir)).toEqual([]);
    writeFileSync(path.join(dir, "settings.json"), "{not json");
    expect(declaredPiPackages(dir)).toEqual([]);
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ packages: ["npm:pi-claude-bridge", { source: "git:example/skill" }, 3] }),
    );
    expect(declaredPiPackages(dir)).toEqual(["npm:pi-claude-bridge", "git:example/skill"]);
  });
});
