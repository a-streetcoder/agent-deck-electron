import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canRevealSubagentArtifacts,
  chooseDirectory,
  chooseFiles,
  notifyAttention,
  onFocusSession,
  syncAttention,
} from "./native.ts";

const stubBridge = (bridge: unknown): void => {
  vi.stubGlobal("window", { agentDeck: bridge });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subagent artifact capability", () => {
  it("reports only the purpose-built preload method", () => {
    stubBridge({ isElectron: true });
    expect(canRevealSubagentArtifacts()).toBe(false);
    stubBridge({ revealSubagentArtifacts: vi.fn() });
    expect(canRevealSubagentArtifacts()).toBe(true);
  });
});

describe("durable attention bridge", () => {
  it("forwards sync and bounded notification hints", () => {
    const sync = vi.fn();
    const notify = vi.fn();
    stubBridge({ isElectron: true, syncAttention: sync, notifyAttention: notify });

    syncAttention();
    notifyAttention({ sessionId: "chat", title: "My session", body: "Needs attention" });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "chat",
      title: "My session",
      body: "Needs attention",
    });
  });

  it("is a safe no-op when absent or throwing", () => {
    stubBridge(undefined);
    expect(() => syncAttention()).not.toThrow();
    expect(() => notifyAttention({ sessionId: "chat", title: "x", body: "y" })).not.toThrow();

    const notify = vi.fn(() => {
      throw new Error("ipc down");
    });
    stubBridge({ notifyAttention: notify });
    expect(() => notifyAttention({ sessionId: "chat", title: "x", body: "y" })).not.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("onFocusSession", () => {
  it("subscribes through the allow-listed bridge and returns its cleanup", () => {
    const cleanup = vi.fn();
    const subscribe = vi.fn().mockReturnValue(cleanup);
    const handler = vi.fn();
    stubBridge({ isElectron: true, onFocusSession: subscribe });

    const unsubscribe = onFocusSession(handler);

    expect(subscribe).toHaveBeenCalledWith(handler);
    unsubscribe();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("is a safe no-op when the bridge is absent or throws", () => {
    stubBridge(undefined);
    expect(() => onFocusSession(vi.fn())()).not.toThrow();

    stubBridge({
      onFocusSession: vi.fn(() => {
        throw new Error("ipc down");
      }),
    });
    expect(() => onFocusSession(vi.fn())()).not.toThrow();
  });
});

describe("chooseFiles", () => {
  it("delegates to the trusted bridge and keeps only bounded string paths", async () => {
    const choose = vi.fn().mockResolvedValue(["/tmp/a.txt", 42, "C:\\work\\b.txt"]);
    stubBridge({ isElectron: true, chooseFiles: choose });

    await expect(chooseFiles({ title: "Attach" })).resolves.toEqual([
      "/tmp/a.txt",
      "C:\\work\\b.txt",
    ]);
    expect(choose).toHaveBeenCalledWith({ title: "Attach" });
  });

  it("returns an empty selection when unavailable, malformed, or rejected", async () => {
    stubBridge(undefined);
    await expect(chooseFiles()).resolves.toEqual([]);

    stubBridge({ chooseFiles: vi.fn().mockResolvedValue({ path: "/tmp/no.txt" }) });
    await expect(chooseFiles()).resolves.toEqual([]);

    stubBridge({ chooseFiles: vi.fn().mockRejectedValue(new Error("cancelled")) });
    await expect(chooseFiles()).resolves.toEqual([]);
  });
});

describe("chooseDirectory", () => {
  it("delegates to the trusted bridge and keeps only bounded string paths", async () => {
    const choose = vi.fn().mockResolvedValue(["/tmp/project", 42, "C:\\work\\project"]);
    stubBridge({ isElectron: true, chooseDirectory: choose });

    await expect(chooseDirectory({ title: "Attach Folders", multiple: true })).resolves.toEqual([
      "/tmp/project",
      "C:\\work\\project",
    ]);
    expect(choose).toHaveBeenCalledWith({ title: "Attach Folders", multiple: true });
  });

  it("returns an empty selection when unavailable, malformed, or rejected", async () => {
    stubBridge(undefined);
    await expect(chooseDirectory()).resolves.toEqual([]);

    stubBridge({ chooseDirectory: vi.fn().mockResolvedValue({ path: "/tmp/project" }) });
    await expect(chooseDirectory()).resolves.toEqual([]);

    stubBridge({ chooseDirectory: vi.fn().mockRejectedValue(new Error("cancelled")) });
    await expect(chooseDirectory()).resolves.toEqual([]);
  });
});
