import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * EXT-01: settings.json `extensions` entries surface as catalog candidates with
 * provenance (native discoveryKind settingsExtension) — resolved against the
 * settings file's directory, labeled `settings`, existence-flagged.
 */

const resourceHome = mkdtempSync(path.join(tmpdir(), "ext-settings-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
let server: AgentDeckServer;

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: resourceHome });
  const piAgent = path.join(resourceHome, ".pi", "agent");
  mkdirSync(piAgent, { recursive: true });
  mkdirSync(path.join(resourceHome, "tools"), { recursive: true });
  writeFileSync(path.join(resourceHome, "tools", "listed.ts"), "export default () => {};");
  writeFileSync(
    path.join(piAgent, "settings.json"),
    JSON.stringify({ extensions: ["../../tools/listed.ts", "../../tools/ghost.ts"] }),
  );
  server = await startServer({ dataDir });
});

afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

describe("settings-defined extension candidates (EXT-01)", () => {
  it("lists settings.json entries with `settings` provenance and honest existence", async () => {
    const { extensions } = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/extensions`)
    ).json()) as {
      extensions: Array<{
        path: string;
        name: string;
        exists: boolean;
        source: string;
        scope: string;
      }>;
    };
    const listed = extensions.find((e) => e.name === "listed.ts")!;
    expect(listed.source).toBe("settings");
    expect(listed.scope).toBe("global");
    expect(listed.exists).toBe(true);
    expect(listed.path).toBe(path.resolve(resourceHome, "tools", "listed.ts"));
    // a declared-but-missing entry stays visible with exists:false — the user
    // configured it and should see it isn't there
    const ghost = extensions.find((e) => e.name === "ghost.ts")!;
    expect(ghost.source).toBe("settings");
    expect(ghost.exists).toBe(false);
  });
});
