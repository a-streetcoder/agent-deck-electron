import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import type { SubagentCell } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";
const FIRST_PARENT = "PARENT_ONLY_SENTINEL: delegate the first isolated task";
const SECOND_PARENT = "directly follow up with the same child";
const FIRST_TASK = "Return CHILD_HISTORY_SENTINEL and remember it.";
const SECOND_TASK = "Prove CHILD_HISTORY_SENTINEL is in your own history.";

let mock: MockProviderServer;
let server: AgentDeckServer;
const home = mkdtempSync(path.join(tmpdir(), "pi-home-continuation-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-subagent-continuation-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-subagent-continuation-"));
const childRequests: ChatCompletionRequest[] = [];
const CONTINUATION_COMPLETION_TIMEOUT_MS = 60_000;

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = CONTINUATION_COMPLETION_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) {
    throw new Error(`timed out waiting ${timeoutMs}ms for continuation completion`);
  }
}

function systemText(body: ChatCompletionRequest): string {
  return body.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    )
    .join("\n");
}

function isChild(body: ChatCompletionRequest): boolean {
  return systemText(body).includes("focused subagent launched by Agent Deck");
}

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (lastUser, body) => {
      if (isChild(body) || body.messages.at(-1)?.role === "tool") return null;
      if (lastUser === FIRST_PARENT) {
        return {
          name: "managed_subagent",
          arguments: {
            task: FIRST_TASK,
            reads: [" AGENTS.md ", "src/SessionManager.ts", "AGENTS.md"],
          },
        };
      }
      if (lastUser === SECOND_PARENT) {
        const text = JSON.stringify(body.messages);
        const id = /Deck subagent ID: ([0-9a-f-]{36})/i.exec(text)?.[1];
        if (!id) throw new Error("stable subagent ID missing from first tool result");
        return {
          name: "managed_subagent",
          arguments: {
            task: SECOND_TASK,
            continueSubagentID: id,
            reads: ["docs/sync-seams.md"],
          },
        };
      }
      return null;
    },
    reply: (_lastUser, body) => {
      if (!isChild(body)) return "Parent delegation complete.";
      childRequests.push(body);
      return childRequests.length === 1
        ? "CHILD_HISTORY_SENTINEL: first child result."
        : "SECOND_RESULT: child history retained.";
    },
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
});

describe("managed_subagent real-Pi continuation", () => {
  it("resumes only child history with one stable run/card and ordered live deltas", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    const { session } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(session.id)!;

    await managed.prompt(FIRST_PARENT);
    await server.receipts.waitFor("idle", session.id);
    const firstCard = managed
      .snapshot()
      .state.cells.find((cell): cell is SubagentCell => cell.kind === "subagent")!;
    expect(firstCard.text).toContain("CHILD_HISTORY_SENTINEL");

    const continuationDeltas: Array<{ seq: number; delta: string }> = [];
    const unsubscribe = managed.bus.subscribe((event) => {
      if (event.event.type === "subagent_delta" && event.event.cellId === firstCard.id) {
        continuationDeltas.push({ seq: event.seq, delta: event.event.delta });
      }
    });
    await managed.prompt(SECOND_PARENT);
    await waitUntil(() => {
      const card = managed
        .snapshot()
        .state.cells.find((cell): cell is SubagentCell => cell.kind === "subagent");
      return card?.task === SECOND_TASK && card.status === "done";
    });
    unsubscribe();

    const cards = managed
      .snapshot()
      .state.cells.filter((cell): cell is SubagentCell => cell.kind === "subagent");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(firstCard.id);
    expect(cards[0]!.task).toBe(SECOND_TASK);
    expect(cards[0]!.text).toBe("SECOND_RESULT: child history retained.");
    expect(continuationDeltas.length).toBeGreaterThan(1);
    expect(continuationDeltas.map(({ seq }) => seq)).toEqual(
      continuationDeltas.map(({ seq }) => seq).sort((a, b) => a - b),
    );
    expect(continuationDeltas.map(({ delta }) => delta).join("")).toBe(
      "SECOND_RESULT: child history retained.",
    );

    expect(childRequests).toHaveLength(2);
    const continuationContext = JSON.stringify(childRequests[1]!.messages);
    expect(continuationContext).toContain(FIRST_TASK);
    expect(continuationContext).toContain("CHILD_HISTORY_SENTINEL");
    expect(continuationContext).not.toContain("PARENT_ONLY_SENTINEL");
    expect(continuationContext).toContain("docs/sync-seams.md");
    expect(continuationContext).toContain("task below is the only active assignment");
    expect(continuationContext).toContain("has not preloaded their contents");

    const persisted = JSON.parse(
      readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8"),
    ) as { runs: Array<Record<string, unknown>> };
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0]).toEqual(
      expect.objectContaining({
        id: firstCard.id,
        parentSessionId: session.id,
        source: "single",
        task: SECOND_TASK,
        summary: "SECOND_RESULT: child history retained.",
        sessionFile: expect.any(String),
        sessionOwnership: "owned",
        artifactRootId: firstCard.id,
        artifactRootToken: expect.any(String),
        currentTurnId: expect.any(String),
        declaredReads: ["docs/sync-seams.md"],
      }),
    );
    const run = persisted.runs[0]! as {
      currentTurnId: string;
      sessionFile: string;
    };
    const root = path.toNamespacedPath(
      realpathSync.native(path.join(dataDir, "Subagent Runs", firstCard.id)),
    );
    const turn = path.join(root, "turns", run.currentTurnId);
    expect(readFileSync(path.join(root, "input.md"), "utf8")).toBe(
      `${FIRST_TASK}\n\nRead first (project-relative hints; contents are not preloaded):\nAGENTS.md\nsrc/SessionManager.ts`,
    );
    expect(readFileSync(path.join(turn, "input.md"), "utf8")).toBe(
      `${SECOND_TASK}\n\nRead first (project-relative hints; contents are not preloaded):\ndocs/sync-seams.md`,
    );
    expect(readFileSync(path.join(turn, "system-prompt.md"), "utf8")).toContain(
      `Artifact directory: ${turn}`,
    );
    expect(readFileSync(path.join(turn, "system-prompt.md"), "utf8")).toContain(
      "Expected report outcome",
    );
    expect(readFileSync(path.join(turn, "output.md"), "utf8")).toBe(
      "SECOND_RESULT: child history retained.",
    );
    expect(path.dirname(run.sessionFile)).toBe(path.join(root, "sessions"));
    expect(lstatSync(run.sessionFile).isFile()).toBe(true);
    expect(readdirSync(path.join(root, "turns"))).toEqual([run.currentTurnId]);
    // The continuation poll stays at half the product's 120-second subagent
    // timeout; this outer bound leaves the first turn and final assertions
    // headroom instead of letting Vitest's 60-second default preempt the poll.
  }, 90_000);
});
