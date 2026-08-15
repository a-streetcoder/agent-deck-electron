import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * SKL-20: AI skill summaries (native SkillDescriptionGenerationService) against
 * real pi: POST /resources/skills/summarize runs a one-shot helper over the
 * skill's SKILL.md and returns the sanitized summary. The mock provider's reply
 * carries the quote/label wrapping native strips, proving the sanitizer runs,
 * and a repeat request answers from the content-hash cache without a second
 * model call.
 */

process.env.AGENT_DECK_TEST = "1";

const RAW_REPLY =
  'Summary: "Automates alpha release chores so an agent can cut a build, tag it, and publish notes without manual steps."';
const SANITIZED =
  "Automates alpha release chores so an agent can cut a build, tag it, and publish notes without manual steps.";

let mock: MockProviderServer;
let server: AgentDeckServer;
let base: string;
let modelCalls = 0;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

beforeAll(async () => {
  mock = await startMockProvider({
    reply: () => {
      modelCalls += 1;
      return RAW_REPLY;
    },
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_DEFAULT_PROVIDER = MOCK_PROVIDER_ID;
  process.env.AGENT_DECK_DEFAULT_MODEL = MOCK_MODEL_ID;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    PI_SKIP_VERSION_CHECK: "1",
  });

  const skillDir = path.join(tmpHome, ".agents", "skills", "alpha");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha release helper\n---\nRuns the release chores.\n",
  );

  server = await startServer({ dataDir });
  base = `http://127.0.0.1:${server.port}`;
}, 60_000);

afterAll(async () => {
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_DEFAULT_PROVIDER;
  delete process.env.AGENT_DECK_DEFAULT_MODEL;
  delete process.env.AGENT_DECK_PI_ENV;
  await server?.close();
  await mock?.close();
});

describe("AI skill summary (SKL-20)", () => {
  it("summarizes a catalog skill via the one-shot helper, sanitized and cached", async () => {
    const res = await fetch(`${base}/resources/skills/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", name: "alpha" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: string };
    // native sanitization: wrapping quotes and the "Summary:" label are stripped
    expect(body.summary).toBe(SANITIZED);
    expect(modelCalls).toBe(1);

    // the identical SKILL.md answers from the content-hash cache — no re-bill
    const again = await fetch(`${base}/resources/skills/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", name: "alpha" }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { summary: string }).summary).toBe(SANITIZED);
    expect(modelCalls).toBe(1);

    // an unknown skill fails closed — nothing is read, nothing is generated
    const missing = await fetch(`${base}/resources/skills/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", name: "nope" }),
    });
    expect(missing.status).toBe(404);
    expect(modelCalls).toBe(1);
  }, 60_000);
});
