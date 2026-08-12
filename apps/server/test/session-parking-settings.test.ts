import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-parking-settings-"));
let server: AgentDeckServer;

const patch = (body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  server = await startServer({ dataDir });
});

afterAll(async () => server.close());

describe("idle parking settings route", () => {
  it("defaults enabled/10, enforces 1–120 integers, and survives restart", async () => {
    let body = (await (await fetch(`http://127.0.0.1:${server.port}/settings`)).json()) as {
      settings: {
        piAgentIdleParkingEnabled: boolean;
        piAgentIdleParkingTimeoutMinutes: number;
      };
    };
    expect(body.settings).toMatchObject({
      piAgentIdleParkingEnabled: true,
      piAgentIdleParkingTimeoutMinutes: 10,
    });

    for (const value of [0, 121, 1.5, "10", null]) {
      expect((await patch({ piAgentIdleParkingTimeoutMinutes: value })).status).toBe(400);
    }
    expect(
      (await patch({ piAgentIdleParkingEnabled: false, piAgentIdleParkingTimeoutMinutes: 37 }))
        .status,
    ).toBe(200);

    await server.close();
    server = await startServer({ dataDir });
    body = (await (await fetch(`http://127.0.0.1:${server.port}/settings`)).json()) as typeof body;
    expect(body.settings).toMatchObject({
      piAgentIdleParkingEnabled: false,
      piAgentIdleParkingTimeoutMinutes: 37,
    });
  });
});
