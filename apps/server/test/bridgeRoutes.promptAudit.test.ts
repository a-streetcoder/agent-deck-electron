import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import type { ServerContext } from "../src/context.ts";
import { registerBridgeRoutes } from "../src/routes/bridge.ts";

const fastifies: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(fastifies.splice(0).map((fastify) => fastify.close()));
});

function harness() {
  const fastify = Fastify();
  fastifies.push(fastify);
  const meta: SessionMeta = { id: "session-a", cwd: "/tmp", createdAt: "2026-01-01T00:00:00Z" };
  let lastSequence = 0;
  const upsert = vi.fn();
  const broadcast = vi.fn();
  registerBridgeRoutes({
    fastify,
    sessions: {
      get: (id: string) => (id === meta.id ? { meta } : undefined),
      captureFinalSystemPromptAudit: (
        id: string,
        audit: NonNullable<SessionMeta["finalSystemPromptAudit"]>,
        sequence: number,
      ) => {
        if (id !== meta.id) return undefined;
        const accepted = sequence > lastSequence;
        if (accepted) {
          lastSequence = sequence;
          meta.finalSystemPromptAudit = audit;
        }
        return { accepted, meta };
      },
    },
    index: { upsert },
    broadcast,
    bridge: { dispatch: vi.fn() },
    bridgeTokens: new Map([[meta.id, "token-a"]]),
    askUser: {},
    supervisor: {},
    childSupervisors: new Map(),
    pendingSupervisor: new Map(),
    memoryEnabled: false,
    agentMemoryEnabled: () => false,
    memoryBaseDir: "",
    recallMemories: vi.fn(),
  } as unknown as ServerContext);
  const audit = (sequence: number, systemPrompt: string) =>
    fastify.inject({
      method: "POST",
      url: "/bridge",
      payload: {
        sessionId: meta.id,
        token: "token-a",
        tool: "__prompt_audit__",
        toolCallId: "prompt-audit",
        params: { sequence, systemPrompt },
      },
    });
  return { audit, meta, upsert, broadcast };
}

describe("prompt audit bridge sequence", () => {
  it("accepts an increasing write and ignores deterministic late/equal writes", async () => {
    const h = harness();
    expect((await h.audit(2, "newer")).json()).toMatchObject({ accepted: true });
    expect((await h.audit(1, "older late")).json()).toMatchObject({ accepted: false });
    expect((await h.audit(2, "equal replay")).json()).toMatchObject({ accepted: false });
    expect(h.meta.finalSystemPromptAudit?.text).toBe("newer");
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("requires a strict positive safe integer sequence", async () => {
    const h = harness();
    expect((await h.audit(0, "zero")).statusCode).toBe(400);
    expect((await h.audit(1.5, "fraction")).statusCode).toBe(400);
    const extra = await h.audit(1, "valid");
    expect(extra.statusCode).toBe(200);
  });
});
