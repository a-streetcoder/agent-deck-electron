import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPiRuntimeDefaultModel } from "../src/routes/settings.ts";

describe("readPiRuntimeDefaultModel", () => {
  it("reads Pi settings.json defaultModel and ignores missing/malformed files", () => {
    const home = mkdtempSync(path.join(tmpdir(), "pi-runtime-default-"));
    expect(readPiRuntimeDefaultModel(home)).toBeNull();

    const agentDir = path.join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultModel: "grok-4.6" }),
    );
    expect(readPiRuntimeDefaultModel(home)).toBe("grok-4.6");

    writeFileSync(path.join(agentDir, "settings.json"), "{not json");
    expect(readPiRuntimeDefaultModel(home)).toBeNull();

    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "  " }));
    expect(readPiRuntimeDefaultModel(home)).toBeNull();
  });
});
