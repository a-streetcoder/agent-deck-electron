import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  affectedRegion,
  projectNodeTree,
  type EventEnvelope,
  type NodeTree,
} from "@agent-deck/domain";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * A10 against a REAL pi binary: the Run tree's "Retry from node" on a turn. Two turns in
 * a git repo, the second writes a file; the turn checkpoints carry their node reference;
 * affectedRegion over the session's real event log puts the frontier on the first turn;
 * the action's two steps (the existing checkpoint_rollback, then the dropped prompt
 * again, as NodeTreeView sends them) restore the files and re-run the turn.
 */

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
let sessionId: string;

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const repo = mkdtempSync(path.join(tmpdir(), "pi-node-retry-repo-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

/** Frame-level RPC client (as in checkpoints.pi.test.ts). */
class RpcFrameClient {
  readonly frames: Array<Record<string, unknown>> = [];
  private readonly socket: WebSocket;
  private readonly waiters: Array<{
    predicate: (f: Record<string, unknown>) => boolean;
    resolve: (f: Record<string, unknown>) => void;
  }> = [];
  private nextId = 1;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    this.socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      this.frames.push(frame);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        if (this.waiters[i]!.predicate(frame)) this.waiters.splice(i, 1)[0]!.resolve(frame);
      }
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve) => this.socket.once("open", resolve));
  }

  send(request: unknown): number {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, request }));
    return id;
  }

  async reply(id: number, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const predicate = (f: Record<string, unknown>) => f.id === id;
    const existing = this.frames.find(predicate);
    if (existing) return existing;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${id}`)), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

const sessionEvents = async (): Promise<EventEnvelope[]> => {
  const response = await fetch(
    `http://127.0.0.1:${server.port}/events?sessionId=${sessionId}&afterSeq=0&limit=1000`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { events: EventEnvelope[] }).events;
};

const turnKeys = (tree: NodeTree): string[] =>
  tree.roots[0]!.children.filter((node) => node.ref.type === "turn").map((node) => node.key);

/** Poll the log until the predicate holds (capture is forked off the idle boundary). */
const eventsUntil = async (
  ready: (events: EventEnvelope[]) => boolean,
): Promise<EventEnvelope[]> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const events = await sessionEvents();
    if (ready(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the event log never got there");
};
const count = (events: EventEnvelope[], kind: string): number =>
  events.filter((event) => event.kind === kind).length;

beforeAll(async () => {
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "# scratch\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);

  mock = await startMockProvider({ reply: () => "done" });
  server = await startServer({ dataDir });

  const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startImmediately: true,
      cwd: repo,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [writeMockProviderExtension(mock.baseUrl)],
      env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
    }),
  });
  expect(response.status).toBe(201);
  sessionId = ((await response.json()) as { session: { id: string } }).session.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

describe("retry from node on a turn over the real stack (A10)", () => {
  it("restores the frontier checkpoint and sends the turn's prompt again", async () => {
    const client = new RpcFrameClient(server.port);
    await client.open();

    client.send({ type: "prompt", sessionId, message: "first turn" });
    await server.receipts.waitFor("idle", sessionId);
    await server.receipts.waitFor("checkpoint_captured", sessionId);
    // The second turn's work: a file in the checkout.
    writeFileSync(path.join(repo, "second.txt"), "written during the second turn\n");
    client.send({ type: "prompt", sessionId, message: "second turn" });
    await server.receipts.waitFor("idle", sessionId);
    await server.receipts.waitFor("checkpoint_captured", sessionId);

    const before = await eventsUntil((events) => count(events, "checkpoint.created") >= 2);
    const tree = projectNodeTree(before, { sessionId });
    const [first, second] = turnKeys(tree);
    // Each checkpoint names the turn it belongs to.
    const created = before.filter((event) => event.kind === "checkpoint.created");
    expect(created.map((event) => (event.payload as { node?: unknown }).node)).toEqual([
      { type: "turn", id: first!.slice("turn:".length) },
      { type: "turn", id: second!.slice("turn:".length) },
    ]);

    // The second turn is the failed node: the first is trusted, its checkpoint the frontier.
    const region = affectedRegion(tree, second!)!;
    expect(region.trusted).toContain(first);
    expect(region.affected).toContain(`checkpoint:${sessionId}/1`);
    expect(region.frontier).toMatchObject({ key: first, sessionId, turnIndex: 0 });

    // The node action: the existing rollback, then the dropped prompt.
    const rolled = await client.reply(
      client.send({
        type: "checkpoint_rollback",
        sessionId,
        turnIndex: region.frontier!.turnIndex,
      }),
    );
    expect(rolled).toMatchObject({
      kind: "checkpoint_rollback_ok",
      filesRestored: true,
      nextPrompt: "second turn",
    });
    expect(existsSync(path.join(repo, "second.txt"))).toBe(false);
    client.send({ type: "prompt", sessionId, message: rolled.nextPrompt });
    await server.receipts.waitFor("idle", sessionId);

    const after = await eventsUntil((events) => count(events, "session.turn.completed") >= 3);
    expect(after.find((event) => event.kind === "checkpoint.rolledBack")).toMatchObject({
      actor: { type: "user" },
      payload: { turnIndex: 0 },
    });
    const prompts = after.filter((event) => event.kind === "turn.prompted");
    expect(prompts.map((event) => (event.payload as { label?: string }).label)).toEqual([
      "first turn",
      "second turn",
      "second turn",
    ]);
    // The truncated checkpoint is marked removed; the re-run is a new turn.
    const replayed = projectNodeTree(after, { sessionId });
    expect(replayed.nodes.get(`checkpoint:${sessionId}/1`)?.removed).toBe(true);
    expect(turnKeys(replayed)).toHaveLength(3);
    client.close();
  });
});
