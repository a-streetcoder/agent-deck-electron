import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import type { SubagentCell } from "@agent-deck/domain";
import { expect, it, vi } from "vitest";
import { startServer } from "../src/index.ts";
import type { StructuredSubagentResult, SubagentRunRecord } from "../src/subagentRunStore.ts";

/**
 * A7 against real Pi: a parent spawns a producer, then verifies it ad hoc through
 * spawn_subagent and managed_subagent with role "verify". The verifier runs read-only
 * (its write attempt through checker_shell is refused), sees the validation result the
 * server ran first, and its typed verdict lands on the producer's run record, in the
 * log as subagent.run.verified, and on the producer's card (REJECT with its reason).
 */

process.env.AGENT_DECK_TEST = "1";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const FOREIGN_RUN = "99999999-9999-4999-8999-999999999999";
const FAKE_TOKEN = `ghp_${"A1b2C3d4".repeat(4)}`;

const systemText = (body: ChatCompletionRequest): string =>
  JSON.stringify(body.messages.filter((m) => m.role === "system" || m.role === "developer"));
const isChild = (body: ChatCompletionRequest): boolean =>
  systemText(body).includes("focused subagent launched by Agent Deck");
const toolTexts = (body: ChatCompletionRequest): string[] =>
  body.messages
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
    );
const runIdIn = (text: string | undefined): string => text?.match(UUID)?.[0] ?? "missing";
const toolNames = (body: ChatCompletionRequest): string[] =>
  (Array.isArray(body.tools) ? body.tools : []).map(
    (tool) => (tool as { function: { name: string } }).function.name,
  );

interface LoggedEvent {
  kind: string;
  subject: { id: string };
  parent?: { type: string; id: string };
  payload: Record<string, unknown>;
}
const loggedEvents = (dataDir: string): LoggedEvent[] => {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(path.join(dir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent);
};

it("verifies a finished run ad hoc: typed verdicts, the event, the card, read-only", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-verify-"));
  // Prints the session's own HOME (its launch env) and a fake token, which also sits in
  // the command itself: both must reach the verifier redacted.
  const validation = `node -e "process.stdout.write('a7-validated home=' + process.env.HOME + ' ${FAKE_TOKEN}')"`;
  const escape = `node -e "require('fs').writeFileSync('a7-escape.txt', 'x')"`;
  const mock = await startMockProvider({
    chunkDelayMs: 5,
    toolCall: (_user, body) => {
      const results = toolTexts(body);
      if (isChild(body)) {
        // The REJECT verifier first tries to write through its only shell.
        if (systemText(body).includes("verify: check TASK_WORK") && results.length === 0)
          return { name: "checker_shell", arguments: { command: escape } };
        return null;
      }
      if (!JSON.stringify(body.tools ?? []).includes("spawn_subagent")) return null;
      const producer = runIdIn(results[0]);
      switch (results.length) {
        case 0:
          return { name: "spawn_subagent", arguments: { task: "TASK_WORK: build part A" } };
        case 1:
          return { name: "await_subagents", arguments: { runIds: [producer] } };
        case 2:
          return {
            name: "spawn_subagent",
            arguments: { task: "recheck TASK_WORK", role: "verify", targetRunId: producer },
          };
        case 3:
          return { name: "await_subagents", arguments: { runIds: [runIdIn(results[2])] } };
        case 4:
          return {
            name: "managed_subagent",
            arguments: {
              task: "check TASK_WORK",
              role: "verify",
              targetRunId: producer,
              validationCommand: validation,
            },
          };
        case 6:
          return { name: "await_subagents", arguments: { runIds: [runIdIn(results[2])] } };
        case 5:
          return {
            name: "managed_subagent",
            arguments: { task: "check a stranger", role: "verify", targetRunId: FOREIGN_RUN },
          };
        default:
          return null;
      }
    },
    reply: (_user, body) => {
      if (!isChild(body)) return "parent finished";
      const system = systemText(body);
      if (system.includes("verify: recheck TASK_WORK")) return "APPROVE\nLooks complete.";
      if (system.includes("verify: check TASK_WORK")) return "REJECT: the change has no tests";
      return "WORK_RESULT part A built";
    },
  });
  const previous = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  const dataDir = path.join(root, "data");
  const server = await startServer({ dataDir });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd: root,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: root, USERPROFILE: root, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(session.id)!;
    await managed.prompt("Build, then verify");
    const final = await vi.waitFor(
      () => {
        const request = mock.requests.find((r) => !isChild(r) && toolTexts(r).length === 7);
        expect(request).toBeDefined();
        return request!;
      },
      { timeout: 90_000, interval: 250 },
    );
    const [spawned, , spawnedVerify, awaitedVerify, rejected, refused, awaitedAgain] =
      toolTexts(final);
    const producerId = runIdIn(spawned);

    // spawn_subagent role verify: the awaited verifier result carries its typed verdict.
    const approverId = runIdIn(spawnedVerify);
    expect(JSON.parse(spawnedVerify!)).toEqual({ runId: approverId, targetRunId: producerId });
    const [approver] = (JSON.parse(awaitedVerify!) as { results: StructuredSubagentResult[] })
      .results;
    expect(approver).toMatchObject({
      id: approverId,
      status: "completed",
      verdict: { decision: "APPROVE", reason: "Looks complete.", verifierRunId: approverId },
    });

    // managed_subagent role verify returns the typed verdict directly.
    const verdict = JSON.parse(rejected!) as {
      runId: string;
      targetRunId: string;
      verdict: { decision: string; reason: string; verifierRunId: string };
    };
    expect(verdict).toEqual({
      runId: verdict.runId,
      targetRunId: producerId,
      verdict: {
        decision: "REJECT",
        reason: "the change has no tests",
        verifierRunId: verdict.runId,
      },
    });
    // A run of no run of this session is refused.
    expect(refused).toContain("Verifier failed.");
    expect(refused).toContain(`No Deck subagent ${FOREIGN_RUN} in this session`);
    // Two verifiers on one producer: the first still returns its own APPROVE after the
    // second one's REJECT replaced the producer's latest verdict.
    expect(
      (JSON.parse(awaitedAgain!) as { results: StructuredSubagentResult[] }).results[0]?.verdict,
    ).toEqual({ decision: "APPROVE", reason: "Looks complete.", verifierRunId: approverId });

    // The verifier: read-only tools, validation evidence first, its write refused.
    const verifierRequests = mock.requests.filter(
      (r) => isChild(r) && systemText(r).includes("verify: check TASK_WORK"),
    );
    const tools = toolNames(verifierRequests[0]!);
    expect(tools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "checker_shell"]));
    for (const writer of ["bash", "edit", "write"]) expect(tools).not.toContain(writer);
    const prompt = systemText(verifierRequests[0]!);
    expect(prompt).toContain("Validation (already run by Agent Deck, before your review): passed");
    // The session's launch env (HOME from its own env), as JSON text.
    expect(prompt).toContain(JSON.stringify(`a7-validated home=${root}`).slice(1, -1));
    expect(prompt).not.toContain(FAKE_TOKEN);
    expect(prompt).toContain("<secret>");
    expect(prompt).toContain("WORK_RESULT part A built");
    const refusal = toolTexts(verifierRequests.at(-1)!);
    expect(refusal[0]).toContain("checker_shell refused");
    expect(existsSync(path.join(root, "a7-escape.txt"))).toBe(false);

    // Records: the verifier is role verify on its target; the target holds the last verdict.
    const records = server.sessions;
    const verifierRecord = records.subagentRunRecord(
      session.id,
      verdict.runId,
    ) as SubagentRunRecord;
    expect(verifierRecord).toMatchObject({
      role: "verify",
      targetRunId: producerId,
      status: "completed",
    });
    expect(records.subagentRunRecord(session.id, producerId)?.verdict).toEqual(verdict.verdict);
    expect(verifierRecord.verdict).toEqual(verdict.verdict);
    // The stored task (the verifier prompt) and the logged one carry no secret.
    expect(verifierRecord.task).not.toContain(FAKE_TOKEN);
    expect(verifierRecord.task).toContain("<secret>");

    // The log: one verified event per verdict; each verifier hangs under the producer.
    const events = loggedEvents(dataDir);
    expect(JSON.stringify(events.filter((e) => e.kind.startsWith("subagent.run.")))).not.toContain(
      FAKE_TOKEN,
    );
    expect(events.filter((e) => e.kind === "subagent.run.verified").map((e) => e.payload)).toEqual([
      expect.objectContaining({
        runId: producerId,
        verifierRunId: approverId,
        verdict: "APPROVE",
        reason: "Looks complete.",
      }),
      expect.objectContaining({
        runId: producerId,
        verifierRunId: verdict.runId,
        verdict: "REJECT",
        reason: "the change has no tests",
      }),
    ]);
    for (const id of [approverId, verdict.runId]) {
      expect(
        events.find((e) => e.kind === "subagent.run.created" && e.subject.id === id)?.parent,
      ).toEqual({ type: "subagentRun", id: producerId });
    }

    // The producer's card shows the REJECT with its reason; the verifier cards point at it.
    const cards = managed
      .snapshot()
      .state.cells.filter((c): c is SubagentCell => c.kind === "subagent");
    expect(cards.find((c) => c.id === producerId)?.verdict).toEqual(verdict.verdict);
    expect(cards.find((c) => c.id === verdict.runId)?.targetRunId).toBe(producerId);
  } finally {
    await server.close();
    await mock.close();
    if (previous === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it("verifies a worktree producer inside its worktree, with base and HEAD to diff against", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-verify-wt-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  writeFileSync(path.join(project, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: project });
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"],
    { cwd: project },
  );
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: project,
    encoding: "utf8",
  }).trim();
  const mock = await startMockProvider({
    chunkDelayMs: 5,
    toolCall: (_user, body) => {
      const results = toolTexts(body);
      if (isChild(body)) {
        if (results.length > 0) return null;
        if (systemText(body).includes("verify: check TASK_WT"))
          return { name: "checker_shell", arguments: { command: "git status --short" } };
        return { name: "write", arguments: { path: "a7-made.txt", content: "made\n" } };
      }
      if (!JSON.stringify(body.tools ?? []).includes("spawn_subagent")) return null;
      const producer = runIdIn(results[0]);
      switch (results.length) {
        case 0:
          return {
            name: "spawn_subagent",
            arguments: { task: "TASK_WT: write a7-made.txt", worktree: true },
          };
        case 1:
          return { name: "await_subagents", arguments: { runIds: [producer] } };
        case 2:
          return {
            name: "managed_subagent",
            arguments: { task: "check TASK_WT", role: "verify", targetRunId: producer },
          };
        default:
          return null;
      }
    },
    reply: (_user, body) =>
      !isChild(body)
        ? "parent finished"
        : systemText(body).includes("verify: check TASK_WT")
          ? "APPROVE\nThe file is there."
          : "WT_RESULT written",
  });
  const previous = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  const server = await startServer({ dataDir: path.join(root, "data") });
  try {
    const base_ = `http://127.0.0.1:${server.port}`;
    const created = (await (
      await fetch(`${base_}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: project }),
      })
    ).json()) as { project: { id: string } };
    const response = await fetch(`${base_}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd: project,
        projectId: created.project.id,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: root, USERPROFILE: root, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    await server.sessions.get(session.id)!.prompt("Write in a worktree, then verify");
    const final = await vi.waitFor(
      () => {
        const request = mock.requests.find((r) => !isChild(r) && toolTexts(r).length === 3);
        expect(request).toBeDefined();
        return request!;
      },
      { timeout: 90_000, interval: 250 },
    );
    const verdict = JSON.parse(toolTexts(final)[2]!) as { verdict: { decision: string } };
    expect(verdict.verdict.decision).toBe("APPROVE");
    const verifierRequests = mock.requests.filter(
      (r) => isChild(r) && systemText(r).includes("verify: check TASK_WT"),
    );
    const prompt = systemText(verifierRequests[0]!);
    expect(prompt).toContain(`Base commit: ${base}; HEAD: ${base}`);
    expect(prompt).toContain("- a7-made.txt");
    // checker_shell ran in the producer's worktree: it sees the new file.
    expect(toolTexts(verifierRequests.at(-1)!)[0]).toContain("a7-made.txt");
    expect(existsSync(path.join(project, "a7-made.txt"))).toBe(false);
  } finally {
    await server.close();
    await mock.close();
    if (previous === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
