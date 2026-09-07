import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS_DIR } from "../src/paths.ts";
import { scanAgents } from "../src/scanner.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(subagents?: unknown) {
  const home = mkdtempSync(path.join(tmpdir(), "builtin-policy-"));
  homes.push(home);
  const settings = path.join(home, ".pi", "agent", "settings.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  if (subagents !== undefined) writeFileSync(settings, JSON.stringify({ subagents }));
  return { home, settings };
}

describe("global builtin agent policy", () => {
  it.each([undefined, false, true, "true", 1])("requires boolean true: %s", (flag) => {
    const { home } = fixture(flag === undefined ? undefined : { disableBuiltins: flag });
    const builtins = scanAgents({ home }).filter((agent) => agent.scope === "builtin");
    expect(builtins.length).toBeGreaterThan(0);
    for (const agent of builtins) expect(agent.disabled).toBe(flag === true);
  });

  it.each([false, true])("per-agent overrides win with disableBuiltins=%s", (disableBuiltins) => {
    const { home, settings } = fixture({
      disableBuiltins,
      agentOverrides: {
        coder: { disabled: false },
        reviewer: { disabled: true },
        planner: { description: "Custom metadata" },
        explorer: {},
      },
    });
    const before = readFileSync(settings);
    const builtinPath = path.join(BUILTIN_AGENTS_DIR, "coder.md");
    const builtinBefore = readFileSync(builtinPath);
    const agents = scanAgents({ home });
    for (const name of ["coder", "planner", "explorer"]) {
      expect(agents.find((agent) => agent.name === name)).toMatchObject({
        disabled: false,
        overridden: true,
      });
    }
    expect(agents.find((agent) => agent.name === "reviewer")).toMatchObject({ disabled: true });
    expect(readFileSync(settings)).toEqual(before);
    expect(readFileSync(builtinPath)).toEqual(builtinBefore);
  });

  it.each(["global", "project"])(
    "leaves %s custom agents and builtin shadows untouched",
    (scope) => {
      const { home } = fixture({
        disableBuiltins: true,
        agentOverrides: { coder: { disabled: true } },
      });
      const projectPath = path.join(home, "project");
      const dir =
        scope === "global"
          ? path.join(home, ".pi", "agent", "agents")
          : path.join(projectPath, ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      for (const name of ["coder", "custom"])
        writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n---\nCustom persona`);
      const agents = scanAgents({ home, projectPath });
      for (const name of ["coder", "custom"])
        expect(agents.find((agent) => agent.name === name && !agent.shadowed)).toMatchObject({
          scope,
          disabled: false,
        });
      expect(
        agents.find((agent) => agent.name === "coder" && agent.scope === "builtin"),
      ).toMatchObject({ shadowed: true, disabled: true });
    },
  );

  it("ignores project policy and tolerates malformed global settings", () => {
    const { home, settings } = fixture();
    const projectPath = path.join(home, "project");
    mkdirSync(path.join(projectPath, ".pi"), { recursive: true });
    writeFileSync(
      path.join(projectPath, ".pi", "settings.json"),
      JSON.stringify({
        subagents: { disableBuiltins: true, agentOverrides: { coder: { disabled: true } } },
      }),
    );
    for (const raw of ["{}", "{", "null", "[]", '{"subagents":[]}']) {
      writeFileSync(settings, raw);
      expect(
        scanAgents({ home, projectPath }).find((agent) => agent.name === "coder"),
      ).toMatchObject({ disabled: false });
      expect(readFileSync(settings, "utf8")).toBe(raw);
    }
  });
});
