import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

let server: AgentDeckServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function draft() {
  const response = await fetch(`http://127.0.0.1:${server!.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: mkdtempSync(path.join(tmpdir(), "audit-race-cwd-")) }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { session: { id: string; updatedAt?: string } };
}

async function persisted(id: string) {
  const body = (await (await fetch(`http://127.0.0.1:${server!.port}/sessions`)).json()) as {
    sessions: Array<{
      id: string;
      updatedAt?: string;
      pinnedAt?: string;
      needsAttention?: boolean;
      finalSystemPromptAudit?: { text: string; capturedAt: string };
    }>;
  };
  return body.sessions.find((session) => session.id === id)!;
}

const audit = {
  text: "exact prompt added after the route's conceptual shallow snapshot",
  capturedAt: "2026-08-01T10:02:03.000Z",
};

describe("shallow session metadata mutations preserve prompt audit evidence", () => {
  it("runtime fence accepts only strictly increasing audit sequences", async () => {
    server = await startServer({
      dataDir: mkdtempSync(path.join(tmpdir(), "audit-sequence-data-")),
    });
    const { session } = await draft();
    const first = server.sessions.captureFinalSystemPromptAudit(session.id, audit, 2);
    expect(first?.accepted).toBe(true);
    expect(
      server.sessions.captureFinalSystemPromptAudit(
        session.id,
        { text: "older late response", capturedAt: "2026-08-01T10:03:03.000Z" },
        1,
      )?.accepted,
    ).toBe(false);
    expect(
      server.sessions.captureFinalSystemPromptAudit(
        session.id,
        { text: "equal replay", capturedAt: "2026-08-01T10:04:03.000Z" },
        2,
      )?.accepted,
    ).toBe(false);
    expect(server.sessions.get(session.id)?.meta.finalSystemPromptAudit).toEqual(audit);
  });

  it("pin re-reads authoritative live metadata immediately before persistence", async () => {
    server = await startServer({
      dataDir: mkdtempSync(path.join(tmpdir(), "audit-pin-race-data-")),
    });
    const { session } = await draft();
    const updatedAt = server.sessions.get(session.id)!.meta.updatedAt;
    expect(updatedAt).toBeTruthy();

    // Deterministic race ordering: persistence still has the pre-audit snapshot,
    // while the authoritative live owner receives audit evidence before PATCH.
    server.sessions.captureFinalSystemPromptAudit(session.id, audit, 1);
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions/${session.id}/pin`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(response.status).toBe(200);
    expect(await persisted(session.id)).toMatchObject({
      updatedAt,
      finalSystemPromptAudit: audit,
    });
  });

  it("attention acknowledgement merges the latest audit without activity bump", async () => {
    server = await startServer({
      dataDir: mkdtempSync(path.join(tmpdir(), "audit-attention-race-data-")),
    });
    const { session } = await draft();
    const live = server.sessions.get(session.id)!;
    live.meta.needsAttention = true;
    const updatedAt = live.meta.updatedAt;
    expect(updatedAt).toBeTruthy();

    server.sessions.captureFinalSystemPromptAudit(session.id, audit, 1);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/sessions/${session.id}/attention`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ needsAttention: false }),
      },
    );
    expect(response.status).toBe(200);
    expect(await persisted(session.id)).toMatchObject({
      updatedAt,
      needsAttention: false,
      finalSystemPromptAudit: audit,
    });
  });
});
