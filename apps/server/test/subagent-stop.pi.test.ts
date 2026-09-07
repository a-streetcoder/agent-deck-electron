import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DomainEvent } from "@agent-deck/domain";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
} from "@agent-deck/testkit";
import { expect, it, vi } from "vitest";
import { startServer } from "../src/index.ts";
import { LoopSessionSnapshotStore } from "../src/loopSessionSnapshots.ts";

process.env.AGENT_DECK_TEST = "1";

it("Loop cancellation primitives publish one stopped card before snapshot flush and restore", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-loop-stop-"));
  const dataDir = path.join(root, "data");
  const mock = await startMockProvider({
    chunkDelayMs: 40,
    reply: (message) =>
      message.includes("slow child")
        ? Array(500).fill("streaming evidence").join(" ")
        : "parent ready",
  });
  const previous = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  const extension = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = extension;
  let server = await startServer({ dataDir });
  const env = { HOME: root, USERPROFILE: root, PI_SKIP_VERSION_CHECK: "1" };
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: root,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [extension],
        env,
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(session.id)!;
    // Give the parent canonical Pi history so resume exercises actual history
    // seeding plus the persisted Loop synthetic-card layer after backend restart.
    await managed.prompt("prepare parent");
    await server.receipts.waitFor("idle", session.id);
    await vi.waitFor(() => expect(managed.meta.piSessionFile).toBeTruthy());
    const meta = { ...managed.meta };
    const events: DomainEvent[] = [];
    const unsubscribe = managed.bus.subscribe(({ event }) => events.push(event));
    const stopTracking = server.sessions.trackLoopSession(session.id);
    try {
      const result = server.sessions
        .runSubagent(session.id, "slow child", undefined, "none")
        .catch((error: unknown) => error);
      await vi.waitFor(
        () =>
          expect(events.filter((e) => e.type === "subagent_delta").length).toBeGreaterThanOrEqual(
            2,
          ),
        { timeout: 20_000 },
      );
      expect(events.filter((e) => e.type === "cell_final")).toHaveLength(0);
      // Exact routes/loops.ts cancel -> settled-finally order. No generic run
      // store exists for this constrained child; tracking must see the final.
      await server.sessions.destroy(session.id);
      stopTracking();
      await result;
      const finals = events.filter((e) => e.type === "cell_final" && e.cell.kind === "subagent");
      expect(finals).toHaveLength(1);
      const cells = managed.snapshot().state.cells.filter((c) => c.kind === "subagent");
      expect(cells).toHaveLength(1);
      expect(cells[0]).toEqual(
        expect.objectContaining({
          status: "stopped",
          text: expect.stringContaining("streaming"),
        }),
      );
      expect(cells[0]!.text.length).toBeLessThan(
        Array(500).fill("streaming evidence").join(" ").length,
      );
      expect(new LoopSessionSnapshotStore(dataDir, vi.fn()).get(session.id)).toEqual(cells);
      expect(readFileSync(path.join(dataDir, "loop-session-snapshots.json"), "utf8")).not.toContain(
        '"status": "running"',
      );
      const eventCount = events.length;
      await managed.stop();
      expect(events).toHaveLength(eventCount);
      await server.close();
      server = await startServer({ dataDir });
      const resumed = await server.sessions.resume(
        meta,
        {
          kind: "parent",
          resumeSessionPath: meta.piSessionFile,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [extension],
        },
        env,
      );
      expect(resumed.snapshot().state.cells.filter((c) => c.kind === "subagent")).toEqual(cells);
    } finally {
      stopTracking();
      unsubscribe();
    }
  } finally {
    await server.close();
    await mock.close();
    if (previous === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
