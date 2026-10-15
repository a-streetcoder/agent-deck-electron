import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { SessionMeta } from "@agent-deck/contracts";
import { emptyTranscript, type TranscriptCell, type TranscriptState } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerContext } from "../src/context.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { SessionAuthorIndex } from "../src/persistence.ts";
import { registerSessionRoutes } from "../src/routes/sessions.ts";
import { LOOP_REVIEW_PROMPT_REFUSAL, setupRpcEndpoint } from "../src/rpcHandler.ts";
import { SessionAuthorStore } from "../src/sessionAuthors.ts";
import {
  MAX_MIRROR_BYTES,
  MAX_MIRROR_CELLS,
  mirrorTranscript,
  sessionTranscriptSource,
  type MirrorTranscript,
} from "../src/sessionMirror.ts";
import type { SessionManager } from "../src/SessionManager.ts";
import { setRequestUser } from "../src/trustedProxy.ts";

/** SRV-12c2: what a device mirroring a moved session reads, and Unlink on the device. */
const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
const text = (id: string, value: string, streaming = false): TranscriptCell => ({
  kind: "assistant",
  id,
  blocks: [{ kind: "text", text: value }] as never,
  streaming,
});
const stateOf = (cells: TranscriptCell[]): TranscriptState => ({ ...emptyTranscript(), cells });
const ids = (answer: MirrorTranscript) => answer.state.cells.map((cell) => cell.id);
/** The next request a client holding this answer's window would send. */
const nextQuery = (answer: MirrorTranscript, held: TranscriptCell[]) => ({
  afterEntryId: held.at(-1)!.id,
  prefixHash: answer.prefixHash,
  openIds: held
    .filter((cell) => cell.kind === "assistant" && cell.streaming)
    .map((cell) => cell.id),
});

describe("mirrorTranscript", () => {
  it("answers the open cells again and the new ones after the last held cell", () => {
    const held = [text("a", "one"), text("b", "partial", true)];
    const first = mirrorTranscript(stateOf(held));
    expect(first).toMatchObject({ reset: true, firstId: "a", truncated: false });
    expect(ids(first)).toEqual(["a", "b"]);
    const now = stateOf([text("a", "one"), text("b", "partial and more", true), text("c", "x")]);
    const next = mirrorTranscript(now, nextQuery(first, held));
    expect(next.reset).toBe(false);
    expect(ids(next)).toEqual(["b", "c"]);
    expect(next.state.agentStatus).toBe("idle");
    // Nothing changed: nothing but the open cell again.
    const same = mirrorTranscript(now, nextQuery(next, now.cells));
    expect(ids(same)).toEqual(["b"]);
  });

  it("resets when a settled cell changed, the anchor is unknown or the hash is missing", () => {
    const held = [
      {
        kind: "subagent",
        id: "run",
        task: "t",
        status: "done",
        text: "ok",
        progress: [],
      } as TranscriptCell,
      text("a", "one"),
    ];
    const first = mirrorTranscript(stateOf(held));
    // A7: a verdict lands on the finished card later.
    const verdict = stateOf([
      { ...held[0]!, verdict: { passed: false } } as unknown as TranscriptCell,
      held[1]!,
    ]);
    const changed = mirrorTranscript(verdict, nextQuery(first, held));
    expect(changed.reset).toBe(true);
    expect(ids(changed)).toEqual(["run", "a"]);
    expect(changed.state.cells[0]).toMatchObject({ verdict: { passed: false } });
    expect(
      mirrorTranscript(stateOf(held), { ...nextQuery(first, held), afterEntryId: "gone" }).reset,
    ).toBe(true);
    expect(mirrorTranscript(stateOf(held), { afterEntryId: "a" }).reset).toBe(true);
  });

  it("redacts secret-like keys whatever their value, and secrets in free text, never ids", () => {
    const tool: TranscriptCell = {
      kind: "tool",
      id: "tool-token=abcdefgh123",
      toolCallId: "token=abcdefgh123",
      toolName: "bash",
      args: {
        command: `curl -H "Authorization: Bearer ${KEY}"`,
        token: { value: "nested-secret-value" },
        headers: [{ cookie: "sid=cookie-value" }],
      },
      status: "done",
      result: `{"refresh_token":"x","password": "pass word", "id_token":"y"} export API_KEY=${KEY} \\"access_token\\":\\"esc-value\\"`,
    };
    const answer = mirrorTranscript(stateOf([text("a", `key ${KEY}`), tool]));
    const out = JSON.stringify(answer);
    for (const secret of [
      KEY,
      "nested-secret-value",
      "cookie-value",
      '"x"',
      "pass word",
      '"y"',
      "esc-value",
      "Bearer",
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain("<secret>");
    expect(ids(answer)).toEqual(["a", "tool-token=abcdefgh123"]);
    expect(answer.state.cells[1]).toMatchObject({ toolCallId: "token=abcdefgh123" });
  });

  it("redacts every secret name in free text, the value up to whitespace or a quote", () => {
    const lines = [
      "DATABASE_URL=postgres://user:plain-db@host/db",
      "AWS_SECRET_ACCESS_KEY=plain-aws",
      "STRIPE_SECRET_KEY=plain-stripe",
      "password_hash: plain-hash",
      'connection_string="plain-conn"',
      "SENTRY_DSN=https://plain-dsn@sentry.example/1",
    ];
    const out = JSON.stringify(mirrorTranscript(stateOf([text("a", lines.join("\n"))])));
    for (const secret of ["plain-db", "plain-aws", "plain-stripe", "plain-hash", "plain-conn"])
      expect(out, secret).not.toContain(secret);
    expect(out).not.toContain("plain-dsn");
    expect(out).toContain("DATABASE_URL=<secret>");
  });

  it("redacts a whole connection string, semicolons and spaces included, up to the line end", () => {
    const value =
      "connection_string=AccountName=demo;AccountKey=plain-key;EndpointSuffix=x y\nnext line";
    const out = JSON.stringify(mirrorTranscript(stateOf([text("a", value)])));
    for (const secret of ["AccountName", "demo", "plain-key", "EndpointSuffix"])
      expect(out, secret).not.toContain(secret);
    expect(out).toContain("connection_string=<secret>\\nnext line");
  });

  it("redacts an ODBC connection string past its backslashes and braces", () => {
    const value = "connection_string=Server=db\\instance;UID=sa;PWD={first;remaining-secret}";
    const out = JSON.stringify(mirrorTranscript(stateOf([text("a", value)])));
    for (const secret of ["Server=", "instance", "UID=", "sa;", "{first", "remaining-secret"])
      expect(out, secret).not.toContain(secret);
    expect(out).toContain("connection_string=<secret>");
  });

  it("redacts a qualified secret key (database_password, dbPassword, github.token)", () => {
    const tool: TranscriptCell = {
      kind: "tool",
      id: "t1",
      toolCallId: "c1",
      toolName: "bash",
      args: {
        database_password: "plain-one",
        dbPassword: "plain-two",
        "github.token": "plain-3",
        AWS_SECRET_ACCESS_KEY: "plain-4",
        secretKey: "plain-5",
        password_hash: "plain-6",
        DATABASE_URL: "plain-7",
        connectionString: "plain-8",
        SENTRY_DSN: "plain-9",
        // Never secrets: counters, ids and the working directory stay as they are.
        inputTokens: 11,
        outputTokens: 12,
        maxTokens: 13,
        parentId: "keep-parent",
        requestId: "keep-request",
        runId: "keep-run",
        sessionId: "keep-session",
        cwd: "keep-cwd",
      },
      status: "done",
      result: "export AWS_SECRET_ACCESS_KEY=plain-free-text",
    };
    const out = JSON.stringify(mirrorTranscript(stateOf([tool])));
    for (const secret of ["plain-one", "plain-two", "plain-3", "plain-4", "plain-5", "plain-6"])
      expect(out, secret).not.toContain(secret);
    for (const secret of ["plain-7", "plain-8", "plain-9", "plain-free-text"])
      expect(out, secret).not.toContain(secret);
    expect(out).toContain('"database_password":"<secret>"');
    expect(out).toContain('"inputTokens":11,"outputTokens":12,"maxTokens":13');
    for (const kept of ["keep-parent", "keep-request", "keep-run", "keep-session", "keep-cwd"])
      expect(out, kept).toContain(kept);
    expect(out).toContain('"id":"t1"');
  });

  it("caps the window from the newest end, says so, and keeps an oversized cell as a notice", () => {
    const many = Array.from({ length: MAX_MIRROR_CELLS + 50 }, (_, i) => text(`c${i}`, "x"));
    const counted = mirrorTranscript(stateOf(many));
    expect(counted.state.cells).toHaveLength(MAX_MIRROR_CELLS);
    expect(counted).toMatchObject({ truncated: true, firstId: "c50" });

    const big = Array.from({ length: 12 }, (_, i) => text(`b${i}`, "y".repeat(400_000)));
    const sized = mirrorTranscript(stateOf(big));
    expect(JSON.stringify(sized).length).toBeLessThanOrEqual(MAX_MIRROR_BYTES + 1000);
    expect(sized.truncated).toBe(true);
    expect(sized.state.cells.at(-1)!.id).toBe("b11");

    // Over 512 KB: a notice (secret text inside is never walked); still open while it streams.
    const huge = mirrorTranscript(
      stateOf([text("h", `${KEY} ${"z".repeat(600_000)}`), text("s", "z".repeat(600_000), true)]),
    );
    expect(huge.state.cells).toEqual([
      expect.objectContaining({ id: "h", kind: "notice" }),
      expect.objectContaining({ id: "s", kind: "notice", open: true }),
    ]);
    expect(huge.state.cells[0]).not.toHaveProperty("open");
  });
});

describe("sessionTranscriptSource", () => {
  const meta = { id: "s1", cwd: "/tmp", createdAt: "now" } as SessionMeta;
  const live = (over: Record<string, unknown>) =>
    ({
      get: () => ({
        isParked: false,
        isRunning: true,
        snapshot: () => ({ seq: 3, state: stateOf([text("live", "streaming")]) }),
        ...over,
      }),
    }) as unknown as Pick<SessionManager, "get">;

  it("reads a running session's in-memory transcript, else the file, and fails on a bad file", async () => {
    const running = await sessionTranscriptSource(live({}), meta);
    expect(running.source).toBe("live");
    expect(running.state.cells[0]!.id).toBe("live");
    const parked = await sessionTranscriptSource(live({ isParked: true }), meta);
    expect(parked).toEqual({ source: "file", state: emptyTranscript() });
    await expect(
      sessionTranscriptSource(
        { get: () => undefined },
        { ...meta, piSessionFile: "/no/such.jsonl" },
      ),
    ).rejects.toThrow();
  });
});

describe("POST /sessions/:id/prompt through the socket's dispatch", () => {
  const SID = randomUUID();
  const LOOP = randomUUID();
  const dataDir = mkdtempSync(path.join(tmpdir(), "deck prompt route "));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  async function setup() {
    const now = new Date().toISOString();
    const metas: SessionMeta[] = [
      { id: SID, cwd: dataDir, createdAt: now, lifecycle: "started", piSessionFile: "x.jsonl" },
      { id: LOOP, cwd: dataDir, createdAt: now, loopReviewRunId: "run-1" },
    ];
    const prompt = vi.fn(async () => {});
    const running = new Map<string, unknown>();
    const liveOf = (meta: SessionMeta) => ({ meta, isRunning: true, isParked: false, prompt });
    running.set(LOOP, liveOf(metas[1]!));
    const sessions = {
      get: (id: string) => running.get(id),
      list: () => [],
      resume: vi.fn(async (meta: SessionMeta) => {
        running.set(meta.id, liveOf(meta));
        return running.get(meta.id);
      }),
      mutationClaims: { owner: () => "resume" },
    };
    const index = {
      find: (match: (meta: SessionMeta) => boolean) => metas.find(match),
      list: () => metas,
    };
    const turnPrompted = vi.fn(() => ({ rejected: vi.fn() }));
    const authors = new SessionAuthorStore(new SessionAuthorIndex(dataDir));
    const rpc = setupRpcEndpoint({
      sessions: sessions as unknown as SessionManager,
      terminals: {} as never,
      diffs: {} as never,
      editors: {} as never,
      files: {} as never,
      scripts: {} as never,
      checkpoints: {} as never,
      rollback: {} as never,
      sessionImages: undefined as never,
      sessionPastes: undefined as never,
      sessionAuthors: authors,
      events: { turnPrompted } as never,
    });
    const fastify = Fastify();
    fastify.addHook("onRequest", async (request) =>
      setRequestUser(request.raw, { id: "andrea@example.com", email: "andrea@example.com" }),
    );
    registerSessionRoutes({
      fastify,
      sessions,
      index,
      promptSession: rpc.prompt,
    } as unknown as ServerContext);
    await fastify.ready();
    return { fastify, sessions, prompt, turnPrompted, authors };
  }

  it("reopens an ended session, stages the author, emits turn.prompted and answers 202", async () => {
    const { fastify, sessions, prompt, turnPrompted, authors } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: `/sessions/${SID}/prompt`,
      payload: { text: "hi there" },
    });
    expect(res.statusCode, res.body).toBe(202);
    // A resume claim already held (the page opening it) does not refuse the prompt.
    expect(sessions.resume).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("hi there", undefined, undefined, undefined);
    expect(turnPrompted).toHaveBeenCalledWith(
      SID,
      expect.objectContaining({ type: "user" }),
      "prompt",
      "hi there",
    );
    const cell = { kind: "user", id: "u1", text: "hi there" } as const;
    expect(authors.attachToUserCell(SID, cell, undefined).author).toMatchObject({
      id: "andrea@example.com",
    });
    await fastify.close();
  });

  it("refuses a Loop review session as the socket does", async () => {
    const { fastify, prompt } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: `/sessions/${LOOP}/prompt`,
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: LOOP_REVIEW_PROMPT_REFUSAL });
    expect(prompt).not.toHaveBeenCalled();
    await fastify.close();
  });
});

describe("mirror routes", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "deck mirror "));
  const S_FILE = randomUUID();
  const S_POINTER = randomUUID();
  const S_BROKEN = randomUUID();
  const piFile = path.join(scratch, "file.jsonl");
  const pointerFile = path.join(scratch, "pointer.jsonl");
  let server: AgentDeckServer;
  const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
  const send = (p: string, body: unknown, method = "POST") =>
    fetch(url(p), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const rpc = (request: Record<string, unknown>) =>
    new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
      socket.on("open", () => socket.send(JSON.stringify({ id: 4, request })));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          kind: string;
          id: number;
          ok: boolean;
          error?: string;
        };
        if (frame.kind !== "reply" || frame.id !== 4) return;
        socket.close();
        resolve(frame);
      });
      socket.on("error", reject);
    });

  beforeAll(async () => {
    const now = new Date().toISOString();
    const lines = (cwd: string) =>
      [
        { type: "session", version: 3, id: randomUUID(), timestamp: now, cwd },
        {
          type: "message",
          id: "e1",
          parentId: null,
          timestamp: now,
          message: { role: "user", content: `use ${KEY}` },
        },
        {
          type: "message",
          id: "e2",
          parentId: "e1",
          timestamp: now,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")
        .concat("\n");
    writeFileSync(piFile, lines(scratch));
    writeFileSync(pointerFile, lines(scratch));
    const base = { cwd: scratch, createdAt: now, updatedAt: now, lifecycle: "started" };
    writeFileSync(
      path.join(scratch, "sessions.json"),
      JSON.stringify([
        { id: S_FILE, ...base, title: "On the server", piSessionFile: piFile },
        { id: S_BROKEN, ...base, piSessionFile: path.join(scratch, "missing.jsonl") },
        {
          id: S_POINTER,
          ...base,
          title: "Moved",
          piSessionFile: pointerFile,
          sharedTo: {
            serverOrigin: "https://deck.example.test",
            serverSessionId: randomUUID(),
            sharedAt: now,
            mode: "snapshot",
          },
        },
      ]),
    );
    server = await startServer({ dataDir: scratch });
  });
  afterAll(async () => {
    await server?.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  });

  it("GET /sessions/:id answers the meta with its activity, 404 when unknown", async () => {
    const res = await fetch(url(`/sessions/${S_FILE}`));
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as { session: SessionMeta };
    expect(session).toMatchObject({ id: S_FILE, title: "On the server", activity: "idle" });
    const gone = await fetch(url(`/sessions/${randomUUID()}`));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ code: "unknown_session", error: "unknown session" });
  });

  it("GET /sessions/:id/transcript reads the Pi file, redacted, incrementally", async () => {
    const res = await fetch(url(`/sessions/${S_FILE}/transcript`));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    const body = JSON.parse(raw) as MirrorTranscript;
    expect(body).toMatchObject({ source: "file", reset: true, truncated: false });
    expect(body.state.cells.map((cell) => cell.kind)).toEqual(["user", "assistant"]);
    const last = body.state.cells[1]!.id;
    const next = (await (
      await fetch(
        url(
          `/sessions/${S_FILE}/transcript?afterEntryId=${encodeURIComponent(last)}&prefixHash=${body.prefixHash}&openId=a&openId=b`,
        ),
      )
    ).json()) as MirrorTranscript;
    expect(next).toMatchObject({ reset: false, prefixHash: body.prefixHash });
    expect(next.state.cells).toEqual([]);
    const gone = await fetch(url(`/sessions/${randomUUID()}/transcript`));
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe("unknown_session");
    // An unreadable Pi file is not an empty transcript.
    const broken = await fetch(url(`/sessions/${S_BROKEN}/transcript`));
    expect(broken.status).toBe(503);
    // A browser page from another origin never reads conversation content.
    const foreign = await fetch(url(`/sessions/${S_FILE}/transcript`), {
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
  });

  it("POST /sessions/:id/prompt takes only { text } and refuses a pointer", async () => {
    for (const body of [
      {},
      { text: "" },
      { text: " " },
      { text: "x".repeat(32_001) },
      { text: "hi", images: [] },
    ]) {
      const res = await send(`/sessions/${S_FILE}/prompt`, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    const gone = await send(`/sessions/${randomUUID()}/prompt`, { text: "hi" });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe("unknown_session");
    const pointer = await send(`/sessions/${S_POINTER}/prompt`, { text: "hi" });
    expect(pointer.status).toBe(409);
    expect(((await pointer.json()) as { code: string }).code).toBe("session_shared");
  });

  it("Unlink turns the pointer back into a local session resumable from its Pi file", async () => {
    // A pointer refuses a rename and every socket mutation.
    expect((await send(`/sessions/${S_POINTER}`, { title: "x" }, "PATCH")).status).toBe(409);
    expect((await rpc({ type: "steer", sessionId: S_POINTER, message: "x" })).error ?? "").toMatch(
      /session_shared/,
    );
    const res = await send(`/sessions/${S_POINTER}/shared-to`, { sharedTo: null }, "PATCH");
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as { session: SessionMeta };
    expect(session.sharedTo).toBeUndefined();
    expect(session.piSessionFile).toBe(pointerFile);
    expect(existsSync(pointerFile)).toBe(true);
    // Nothing answers session_shared any more: the session is ordinary again.
    expect((await send(`/sessions/${S_POINTER}`, { title: "Back home" }, "PATCH")).status).toBe(
      200,
    );
    expect(
      (await rpc({ type: "steer", sessionId: S_POINTER, message: "x" })).error ?? "",
    ).not.toMatch(/session_shared/);
    const listed = (await (await fetch(url(`/sessions/${S_POINTER}`))).json()) as {
      session: SessionMeta;
    };
    expect(listed.session.sharedTo).toBeUndefined();
    // A second Unlink is a no-op.
    const again = await send(`/sessions/${S_POINTER}/shared-to`, { sharedTo: null }, "PATCH");
    expect(again.status).toBe(200);
  });
});
