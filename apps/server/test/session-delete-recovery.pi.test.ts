import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
} from "@agent-deck/testkit";
import { expect, it, vi } from "vitest";
import { SessionWorktreeStore } from "@agent-deck/loop-catalog-native";
import { startServer } from "../src/index.ts";
import type { SubagentRunRecord } from "../src/subagentRunStore.ts";

process.env.AGENT_DECK_TEST = "1";

const isChild = (body: ChatCompletionRequest) =>
  body.messages
    .filter((m) => m.role === "developer" || m.role === "system")
    .some((m) => JSON.stringify(m.content).includes("focused subagent launched by Agent Deck"));

it.each(["child", "parent"] as const)(
  "%s cleanup 409 permits real Pi resume and streamed delegation without restarting",
  async (failure) => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-delete-recovery-"));
    const cwd = path.join(root, "repo");
    const home = path.join(root, "home");
    const dataDir = path.join(root, "data");
    mkdirSync(cwd);
    mkdirSync(home);
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
    writeFileSync(path.join(cwd, "base"), "base");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "base",
      ],
      { cwd, stdio: "ignore" },
    );
    const mock = await startMockProvider({
      chunkDelayMs: 10,
      toolCall: (lastUser, body) => {
        if (isChild(body) || body.messages.at(-1)?.role === "tool") return null;
        return {
          name: "managed_parallel",
          arguments: { worktree: true, tasks: [{ task: lastUser }] },
        };
      },
      reply: (_lastUser, body) =>
        isChild(body)
          ? "RECOVERY_CHILD_SENTINEL: incrementally streamed child result after safe allocation."
          : "Delegation complete.",
    });
    const previousExtensions = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    const previousEnv = process.env.AGENT_DECK_PI_ENV;
    const env = { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" };
    process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
    process.env.AGENT_DECK_PI_ENV = JSON.stringify(env);
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let restoreDeletion: (() => void) | undefined;
    try {
      server = await startServer({ dataDir });
      const base = `http://127.0.0.1:${server.port}`;
      let projectId: string | undefined;
      if (failure === "parent") {
        const project = await fetch(`${base}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: cwd }),
        });
        expect(project.status).toBe(201);
        projectId = ((await project.json()) as { project: { id: string } }).project.id;
        const settings = await fetch(`${base}/settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ worktreeIsolation: true }),
        });
        expect(settings.status).toBe(200);
      }
      const response = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd,
          projectId,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
          env,
        }),
      });
      expect(response.status).toBe(201);
      const { session } = (await response.json()) as { session: { id: string; cwd: string } };
      const runs = () =>
        (
          JSON.parse(readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8")) as {
            runs: SubagentRunRecord[];
          }
        ).runs.filter((run) => run.parentSessionId === session.id);
      await server.sessions.get(session.id)!.prompt("first isolated delegation");
      await server.receipts.waitFor("idle", session.id);
      expect(runs()).toHaveLength(1);
      expect(runs()[0]!.status).toBe("completed");
      const childPath = runs()[0]!.worktreePath!;
      expect(existsSync(childPath)).toBe(true);
      if (failure === "child") {
        renameSync(childPath, `${childPath}-held`);
        writeFileSync(childPath, "foreign replacement");
      } else {
        expect(session.cwd).not.toBe(cwd);
        const original = SessionWorktreeStore.prototype.deleteWorktree;
        const spy = vi
          .spyOn(SessionWorktreeStore.prototype, "deleteWorktree")
          .mockImplementation(function (this: SessionWorktreeStore, target, identity) {
            if (target === session.cwd) throw new Error("parent fixture lock");
            return original.call(this, target, identity);
          });
        restoreDeletion = () => spy.mockRestore();
      }
      const failed = await fetch(`${base}/sessions/${session.id}`, { method: "DELETE" });
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({
        code:
          failure === "child"
            ? "subagent_worktree_cleanup_failed"
            : "session_worktree_cleanup_failed",
      });
      expect(server.sessions.get(session.id)).toBeUndefined();
      if (failure === "child") {
        rmSync(childPath);
        renameSync(`${childPath}-held`, childPath);
      } else {
        expect(runs()).toEqual([]);
        expect(existsSync(childPath)).toBe(false);
        expect(existsSync(session.cwd)).toBe(true);
        restoreDeletion!();
      }
      expect(
        (await fetch(`${base}/sessions/${session.id}/resume`, { method: "POST" })).status,
      ).toBe(200);
      const resumed = server.sessions.get(session.id)!;
      const deltas: number[] = [];
      const unsubscribe = resumed.bus.subscribe(({ seq, event }) => {
        if (event.type === "subagent_delta") deltas.push(seq);
      });
      try {
        await resumed.prompt("second isolated delegation after repair");
        // ReceiptBus remembers the first idle; wait for this turn's new child.
        await expect
          .poll(() => runs().filter((run) => run.status === "completed").length, {
            timeout: 60_000,
          })
          .toBe(failure === "child" ? 2 : 1);
        expect(runs()).toHaveLength(failure === "child" ? 2 : 1);
        expect(runs().every((run) => run.status === "completed")).toBe(true);
        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas).toEqual([...deltas].sort((a, b) => a - b));
      } finally {
        unsubscribe();
      }
      expect((await fetch(`${base}/sessions/${session.id}`, { method: "DELETE" })).status).toBe(
        200,
      );
      expect(runs()).toEqual([]);
      expect(
        (await fetch(`${base}/sessions/${session.id}/resume`, { method: "POST" })).status,
      ).toBe(404);
    } finally {
      restoreDeletion?.();
      await server?.close();
      await mock.close();
      if (previousExtensions === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
      else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previousExtensions;
      if (previousEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
      else process.env.AGENT_DECK_PI_ENV = previousEnv;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
