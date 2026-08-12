import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
const home = mkdtempSync(path.join(tmpdir(), "parking-pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "parking-pi-cwd-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "parking-pi-data-"));

const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(predicate()).toBe(true);
};

beforeAll(async () => {
  mock = await startMockProvider();
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_DEFAULT_PROVIDER = MOCK_PROVIDER_ID;
  process.env.AGENT_DECK_DEFAULT_MODEL = MOCK_MODEL_ID;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: home,
    USERPROFILE: home,
    PI_SKIP_VERSION_CHECK: "1",
  });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_DEFAULT_PROVIDER;
  delete process.env.AGENT_DECK_DEFAULT_MODEL;
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("real Pi idle parking", () => {
  it("releases and resumes one parent while preserving ordered streamed history", async () => {
    const session = server.sessions.create({
      cwd,
      plan: {
        kind: "parent",
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS!],
      },
    });
    const deltas: string[] = [];
    const unsubscribe = session.bus.subscribe(({ event }) => {
      if (event.type === "cell_delta") deltas.push(event.delta);
    });

    await session.prompt("first parking turn");
    await waitFor(
      () => session.snapshot().state.agentStatus === "idle" && Boolean(session.piSessionFile),
    );
    expect(deltas.length).toBeGreaterThan(1);

    server.sessions.configureIdleParking(30);
    await waitFor(() => session.isParked);
    expect(session.meta.endedAt).toBeUndefined();
    expect(session.meta.status).toBeUndefined();

    await session.prompt("second parking turn");
    await waitFor(() => {
      const state = server.sessions.get(session.meta.id)!.snapshot().state;
      return (
        state.agentStatus === "idle" &&
        state.cells.filter((cell) => cell.kind === "user").length === 2
      );
    });
    const live = server.sessions.get(session.meta.id)!;
    expect(live).toBe(session);
    const users = live
      .snapshot()
      .state.cells.filter((cell) => cell.kind === "user")
      .map((cell) => cell.text);
    expect(users).toEqual(["first parking turn", "second parking turn"]);
    expect(deltas.join("")).toContain("deliberately multi-word streaming reply");
    unsubscribe();
  }, 30_000);
});
