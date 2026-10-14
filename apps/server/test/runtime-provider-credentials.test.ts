import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/** SRV-10: off a shared server, provider keys and sign-in routes behave as before. */

const resourceHome = mkdtempSync(path.join(tmpdir(), "provider-creds-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
let server: AgentDeckServer;
const endpoint = (pathname: string) => `http://127.0.0.1:${server.port}${pathname}`;

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: resourceHome });
  server = await startServer({ dataDir });
});
afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

it("writes a provider key to the global .env on a loopback server", async () => {
  const response = await fetch(endpoint("/runtime/env"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", key: "ANTHROPIC_API_KEY", value: "local-key" }),
  });
  expect(response.status).toBe(200);
  expect(readFileSync(path.join(resourceHome, ".pi", "agent", ".env"), "utf8")).toContain(
    "ANTHROPIC_API_KEY=",
  );
});

it("does not refuse provider login or logout on a loopback server", async () => {
  for (const route of ["/runtime/providers/no-such/login", "/runtime/providers/no-such/logout"]) {
    const response = await fetch(endpoint(route), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authType: "api_key" }),
    });
    expect(response.status).toBe(404);
  }
});
