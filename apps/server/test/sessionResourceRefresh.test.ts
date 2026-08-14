import type { SessionMeta } from "@agent-deck/contracts";
import type { LaunchPlan } from "@agent-deck/pi-host";
import { describe, expect, it, vi } from "vitest";
import { ReceiptBus } from "../src/receipts.ts";
import { SessionManager } from "../src/SessionManager.ts";

const plan = (marker: string): LaunchPlan => ({
  kind: "agent",
  systemPrompt: { mode: "replace", text: marker },
});

function harness(metaPatch: Partial<SessionMeta> = {}) {
  const meta: SessionMeta = {
    id: "refresh-session",
    cwd: "/worktree",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    launchPlan: plan("old"),
    launchResourceConfig: { version: 1 },
    launchResourceFingerprint: "old",
    finalSystemPromptAudit: { text: "old audit", capturedAt: "2026-01-02T00:00:00.000Z" },
    ...metaPatch,
  };
  let eligible = true;
  let parked = false;
  let subscriber:
    | ((value: { event: { type: "agent_status"; status: "idle" } }) => void)
    | undefined;
  const unsubscribe = vi.fn();
  const session = {
    meta,
    get isParked() {
      return parked;
    },
    get resourceRefreshEligible() {
      return eligible;
    },
    get isRunning() {
      return !parked;
    },
    currentParkingTransition: undefined,
    adoptRuntimeFrom: vi.fn((candidate: { meta: SessionMeta }) => {
      Object.assign(meta, candidate.meta);
      parked = false;
    }),
    bus: {
      subscribe: vi.fn((next: typeof subscriber) => {
        subscriber = next;
        return unsubscribe;
      }),
    },
    parkForResourceRefresh: vi.fn(async () => {
      parked = true;
      return true;
    }),
    configureIdleParking: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const published: SessionMeta[] = [];
  const manager = new SessionManager({} as never, new ReceiptBus(false), () => {});
  manager.configureIdleParking(null, (changed) => published.push({ ...changed }));
  const preflight = vi.fn(async () => async () => {});
  manager.configureResourceRefresh(
    () => ({
      plan: plan("new"),
      fingerprint: "new",
      config: { version: 1 },
      mcpServerIds: [],
    }),
    () => ({ API_TOKEN: "current-default", CURRENT_DEFAULT: "current" }),
    preflight,
  );
  const internals = manager as unknown as {
    sessions: Map<string, typeof session>;
    resourceRefreshDirty: Set<string>;
    resourceRefreshInFlight: Map<string, Promise<void>>;
    sessionEnvironmentOverrides: Map<string, Record<string, string | undefined>>;
    startRefresh(owner: typeof session, generation: number): void;
  };
  internals.sessions.set(meta.id, session);
  return {
    manager,
    internals,
    session,
    meta,
    published,
    preflight,
    setEligible: (value: boolean) => (eligible = value),
    setParked: (value: boolean) => (parked = value),
    idle: () => subscriber?.({ event: { type: "agent_status", status: "idle" } }),
  };
}

async function settle(h: ReturnType<typeof harness>) {
  await vi.waitFor(() => expect(h.internals.resourceRefreshInFlight.size).toBe(0));
}

describe("session launch-resource replacement coordination", () => {
  it("adopts a parked plan without eager resume/rebind and clears stale prompt audit", async () => {
    const h = harness({ parkedAt: "2026-01-03T00:00:00.000Z" });
    h.setParked(true);
    const resume = vi.spyOn(h.manager, "resume");
    h.internals.resourceRefreshDirty.add(h.meta.id);
    h.internals.startRefresh(h.session, 1);
    await settle(h);
    expect(resume).not.toHaveBeenCalled();
    expect(h.preflight).not.toHaveBeenCalled();
    expect(h.meta.launchResourceFingerprint).toBe("new");
    expect(h.meta.launchPlan).toEqual(plan("new"));
    expect(h.meta.finalSystemPromptAudit).toBeUndefined();
    expect(h.meta.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("does not prepare MCP while an active session is only deferring", async () => {
    const h = harness();
    h.setEligible(false);
    h.internals.resourceRefreshDirty.add(h.meta.id);
    h.internals.startRefresh(h.session, 1);
    await settle(h);
    expect(h.preflight).not.toHaveBeenCalled();
    expect(h.session.bus.subscribe).toHaveBeenCalledTimes(1);
  });

  it("arms one authoritative-idle retry when eligibility flips during park", async () => {
    const h = harness();
    h.session.parkForResourceRefresh.mockImplementationOnce(async () => {
      h.setEligible(false);
      return false;
    });
    h.internals.resourceRefreshDirty.add(h.meta.id);
    h.internals.startRefresh(h.session, 1);
    await settle(h);
    expect(h.session.bus.subscribe).toHaveBeenCalledTimes(1);
  });

  it("applies a verified live candidate without activity or stale prompt-audit mutation", async () => {
    const h = harness();
    vi.spyOn(h.manager, "resume").mockImplementation(async (replacementMeta) => {
      h.meta.launchPlan = replacementMeta.launchPlan;
      h.meta.launchResourceFingerprint = replacementMeta.launchResourceFingerprint;
      h.meta.finalSystemPromptAudit = replacementMeta.finalSystemPromptAudit;
      h.setParked(false);
      return h.session as never;
    });
    h.internals.resourceRefreshDirty.add(h.meta.id);
    h.internals.startRefresh(h.session, 1);
    await settle(h);
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect(h.meta.launchResourceFingerprint).toBe("new");
    expect(h.meta.finalSystemPromptAudit).toBeUndefined();
    expect(h.meta.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(h.internals.resourceRefreshDirty.has(h.meta.id)).toBe(false);
  });

  it("parked wake resolves current resources and holds preflight through launch", async () => {
    const h = harness({
      parkedAt: "2026-01-03T00:00:00.000Z",
      piSessionFile: "/tmp/session.jsonl",
    });
    h.setParked(true);
    let launchedMeta: SessionMeta | undefined;
    let launchedPlan: LaunchPlan | undefined;
    let launchedEnv: Record<string, string | undefined> | undefined;
    h.internals.sessionEnvironmentOverrides.set(h.meta.id, {
      API_TOKEN: "deck-secret-value",
    });
    const candidateSession = (meta: SessionMeta) => ({
      meta,
      seedFromHistory: vi.fn(async () => {}),
      seedSyntheticCells: vi.fn(),
      restorePlan: vi.fn(),
      startIngestion: vi.fn(),
      clearFailure: vi.fn(),
      publishMetaChanges: vi.fn(),
    });
    vi.spyOn(h.manager as never, "launch" as never).mockImplementation(((
      meta: SessionMeta,
      currentPlan: LaunchPlan,
      env: Record<string, string | undefined>,
    ) => {
      launchedMeta = meta;
      launchedPlan = currentPlan;
      launchedEnv = env;
      return candidateSession(meta);
    }) as never);
    const resumed = await h.manager.resume(h.meta, plan("old"));
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect(launchedPlan).toMatchObject({
      kind: "agent",
      systemPrompt: { text: "new" },
      resumeSessionPath: "/tmp/session.jsonl",
    });
    expect(launchedMeta?.launchResourceFingerprint).toBe("new");
    expect(launchedEnv).toMatchObject({
      API_TOKEN: "deck-secret-value",
      CURRENT_DEFAULT: "current",
    });
    expect(JSON.stringify(launchedMeta)).not.toContain("deck-secret-value");
    expect(JSON.stringify(launchedMeta)).not.toContain("envOverride");
    expect(resumed).toBe(h.session);
    expect(h.meta.launchResourceFingerprint).toBe("new");
  });

  it("parked wake preflight failure retains owner and never spawns", async () => {
    const h = harness({
      parkedAt: "2026-01-03T00:00:00.000Z",
      piSessionFile: "/tmp/session.jsonl",
    });
    h.setParked(true);
    h.manager.configureResourceRefresh(
      () => ({
        plan: plan("new"),
        fingerprint: "new",
        config: { version: 1 },
        mcpServerIds: ["required"],
      }),
      () => undefined,
      async () => {
        throw new Error("Assigned MCP server definition missing: required.");
      },
    );
    const launch = vi.spyOn(h.manager as never, "launch" as never);
    await expect(h.manager.resume(h.meta, plan("old"))).rejects.toThrow("MCP server");
    expect(launch).not.toHaveBeenCalled();
    expect(h.internals.sessions.get(h.meta.id)).toBe(h.session);
    expect(h.session.isParked).toBe(true);
    expect(h.meta.resourceRefreshError).toContain("MCP server");
  });

  it("clears process-local environment overrides on destroy and shutdown", async () => {
    const destroyed = harness();
    destroyed.internals.sessionEnvironmentOverrides.set(destroyed.meta.id, {
      API_TOKEN: "destroy-secret",
    });
    await destroyed.manager.destroy(destroyed.meta.id);
    expect(destroyed.internals.sessionEnvironmentOverrides.size).toBe(0);

    const stopped = harness();
    stopped.internals.sessionEnvironmentOverrides.set(stopped.meta.id, {
      API_TOKEN: "shutdown-secret",
    });
    await stopped.manager.stopAll();
    expect(stopped.internals.sessionEnvironmentOverrides.size).toBe(0);
  });

  it("does not false-succeed when an old-plan wake wins resume coalescing", async () => {
    const h = harness();
    const oldOwner = { ...h.session, meta: { ...h.meta }, resourceRefreshEligible: false };
    vi.spyOn(h.manager, "resume").mockImplementation(async () => {
      h.internals.sessions.set(h.meta.id, oldOwner);
      h.setEligible(false);
      return oldOwner as never;
    });
    h.internals.resourceRefreshDirty.add(h.meta.id);
    h.internals.startRefresh(h.session, 1);
    await settle(h);
    expect(oldOwner.meta.launchResourceFingerprint).toBe("old");
    expect(h.internals.resourceRefreshDirty.has(h.meta.id)).toBe(true);
    expect(oldOwner.bus.subscribe).toHaveBeenCalledTimes(1);
  });
});
