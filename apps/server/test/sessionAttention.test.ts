import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

let server: AgentDeckServer | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe("session attention acknowledgement route", () => {
  it("allows only idempotent literal-false acknowledgement", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-attention-route-"));
    server = await startServer({ dataDir });
    const createdResponse = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const created = (await createdResponse.json()) as { session: SessionMeta };
    const live = server.sessions.get(created.session.id)!;
    const updatedAt = live.meta.updatedAt;
    live.meta.needsAttention = true;

    const forbidden = await fetch(
      `http://127.0.0.1:${server.port}/sessions/${created.session.id}/attention`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needsAttention: true }),
      },
    );
    expect(forbidden.status).toBe(400);
    expect(live.meta.needsAttention).toBe(true);

    const acknowledged = await fetch(
      `http://127.0.0.1:${server.port}/sessions/${created.session.id}/attention`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needsAttention: false }),
      },
    );
    expect(acknowledged.status).toBe(200);
    expect(((await acknowledged.json()) as { session: SessionMeta }).session.needsAttention).toBe(
      false,
    );
    expect(live.meta.needsAttention).toBe(false);
    expect(live.meta.updatedAt).toBe(updatedAt);

    const repeated = await fetch(
      `http://127.0.0.1:${server.port}/sessions/${created.session.id}/attention`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needsAttention: false }),
      },
    );
    expect(repeated.status).toBe(200);
  });

  it("cannot resurrect a row when acknowledgement races deletion", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-attention-delete-race-"));
    server = await startServer({ dataDir });
    const createdResponse = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const created = (await createdResponse.json()) as { session: SessionMeta };
    server.sessions.get(created.session.id)!.meta.needsAttention = true;

    const deletion = fetch(`http://127.0.0.1:${server.port}/sessions/${created.session.id}`, {
      method: "DELETE",
    });
    const acknowledgement = fetch(
      `http://127.0.0.1:${server.port}/sessions/${created.session.id}/attention`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needsAttention: false }),
      },
    );
    const [deleted, acknowledged] = await Promise.all([deletion, acknowledgement]);
    expect(deleted.status).toBe(200);
    expect([404, 409]).toContain(acknowledged.status);

    const list = (await (await fetch(`http://127.0.0.1:${server.port}/sessions`)).json()) as {
      sessions: SessionMeta[];
    };
    expect(list.sessions.some((session) => session.id === created.session.id)).toBe(false);
  });
});
