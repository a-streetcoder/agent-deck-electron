import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILTIN_AGENTS_DIR } from "@agent-deck/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const home = mkdtempSync(path.join(tmpdir(), "agent-replacement-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-replacement-data-"));
const builtinFile = path.join(BUILTIN_AGENTS_DIR, "reviewer.md");
const builtinBefore = readFileSync(builtinFile);
const settingsFile = path.join(home, ".pi", "agent", "settings.json");
const customFile = path.join(home, ".pi", "agent", "agents", "reviewer.md");
let server: AgentDeckServer;

async function createReplacement(description: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/resources/agents`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      name: "reviewer",
      createFromBuiltin: "reviewer",
      edit: {
        description,
        defaultProgress: true,
        interactive: true,
        output: "Concise review summary",
        body: "Custom reviewer body.",
      },
    }),
  });
}

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home, USERPROFILE: home });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

describe("builtin custom replacement through PUT /resources/agents", () => {
  it("creates a global file from builtin frontmatter without settings or bundled writes", async () => {
    const response = await createReplacement("Editable reviewer");
    expect(response.status).toBe(200);
    expect(readFileSync(builtinFile).equals(builtinBefore)).toBe(true);
    expect(existsSync(settingsFile)).toBe(false);

    const content = readFileSync(customFile, "utf8");
    expect(content).toContain("description: Editable reviewer");
    expect(content).toContain("defaultExpectedOutcome: reportOnly");
    expect(content).toContain("defaultProgress: true");
    expect(content).toContain("interactive: true");
    expect(content).toContain("output: Concise review summary");
    expect(content).toContain("Custom reviewer body.");

    const listed = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/agents`)
    ).json()) as {
      agents: Array<{
        name: string;
        scope: string;
        shadowed: boolean;
        replacesBuiltin: boolean;
        defaultProgress?: boolean;
        interactive?: boolean;
        output?: string;
      }>;
    };
    expect(listed.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "reviewer",
          scope: "global",
          shadowed: false,
          replacesBuiltin: true,
          defaultProgress: true,
          interactive: true,
          output: "Concise review summary",
        }),
        expect.objectContaining({ name: "reviewer", scope: "builtin", shadowed: true }),
      ]),
    );
  });

  it("returns a collision and leaves the existing custom bytes unchanged", async () => {
    const before = readFileSync(customFile, "utf8");
    const response = await createReplacement("Must not overwrite");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "A resource already exists at that catalog location.",
    });
    expect(readFileSync(customFile, "utf8")).toBe(before);
    expect(readFileSync(builtinFile).equals(builtinBefore)).toBe(true);
    expect(existsSync(settingsFile)).toBe(false);
  });

  it("materializes the effective overridden builtin without changing settings", async () => {
    const coderBuiltin = path.join(BUILTIN_AGENTS_DIR, "coder.md");
    const coderBuiltinBefore = readFileSync(coderBuiltin);
    const coderCustom = path.join(home, ".pi", "agent", "agents", "coder.md");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(
      settingsFile,
      `${JSON.stringify(
        {
          unknownSetting: { preserve: true },
          subagents: {
            siblingSetting: "untouched",
            agentOverrides: {
              coder: {
                description: "Effective coder",
                whenToUse: false,
                tools: ["read", "grep"],
                systemPrompt: "Effective overridden prompt.",
                defaultExpectedOutcome: "reportOnly",
                interactive: true,
                output: "Effective report summary",
                defaultProgress: false,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const settingsBefore = readFileSync(settingsFile);

    const response = await fetch(`http://127.0.0.1:${server.port}/resources/agents`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        name: "coder",
        createFromBuiltin: "coder",
        edit: {
          description: "Effective coder",
          whenToUse: "",
          model: "",
          fallbackModels: [],
          thinking: "high",
          systemPromptMode: "replace",
          tools: ["read", "grep"],
          skills: [],
          mcpServers: [],
          body: "Effective overridden prompt.",
        },
      }),
    });
    expect(response.status).toBe(200);
    const custom = readFileSync(coderCustom, "utf8");
    expect(custom).toContain("description: Effective coder");
    expect(custom).toContain("tools: read, grep");
    expect(custom).toContain("defaultExpectedOutcome: reportOnly");
    expect(custom).toContain("interactive: true");
    expect(custom).toContain("output: Effective report summary");
    expect(custom).not.toContain("defaultProgress:");
    expect(custom).not.toContain("whenToUse:");
    expect(custom).toContain("Effective overridden prompt.");
    expect(readFileSync(coderBuiltin).equals(coderBuiltinBefore)).toBe(true);
    expect(readFileSync(settingsFile).equals(settingsBefore)).toBe(true);

    const listed = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/agents`)
    ).json()) as {
      agents: Array<{
        name: string;
        scope: string;
        replacesBuiltin: boolean;
        defaultProgress?: boolean;
      }>;
    };
    const listedCoder = listed.agents.find(
      (agent) => agent.name === "coder" && agent.scope === "global",
    );
    expect(listedCoder).toMatchObject({ replacesBuiltin: true });
    expect(listedCoder?.defaultProgress).toBeUndefined();
  });

  it.each([
    ["default progress", "invalid-progress", { defaultProgress: "yes" }],
    ["interactive", "invalid-interactive", { interactive: "yes" }],
    ["multiline output", "invalid-output", { output: "first\n# injected" }],
    ["oversized output", "oversized-output", { output: "x".repeat(1001) }],
  ])("rejects non-boolean %s without writing a custom agent", async (_label, name, invalidEdit) => {
    const invalidFile = path.join(home, ".pi", "agent", "agents", `${name}.md`);
    const response = await fetch(`http://127.0.0.1:${server.port}/resources/agents`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        name,
        edit: { ...invalidEdit, body: "No." },
      }),
    });
    expect(response.status).toBe(400);
    expect(existsSync(invalidFile)).toBe(false);
  });

  it("rejects replacement creation outside global scope", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/resources/agents`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "library",
        name: "reviewer-copy",
        createFromBuiltin: "reviewer",
        edit: { body: "No." },
      }),
    });
    expect(response.status).toBe(400);
    expect(
      existsSync(path.join(home, ".pi", "agent", "agent-library", "agents", "reviewer-copy.md")),
    ).toBe(false);
  });
});
