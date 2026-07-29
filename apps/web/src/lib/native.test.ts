import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseFiles, signalAttention } from "./native.ts";

const stubBridge = (bridge: unknown): void => {
  vi.stubGlobal("window", { agentDeck: bridge });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signalAttention", () => {
  it("forwards the payload to the Electron bridge when present", () => {
    const signal = vi.fn();
    stubBridge({ isElectron: true, signalAttention: signal });

    signalAttention({ kind: "turn-complete", title: "My session", body: "Turn complete" });

    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith({
      kind: "turn-complete",
      title: "My session",
      body: "Turn complete",
    });
  });

  it("is a no-op in a plain browser (no bridge)", () => {
    stubBridge(undefined);
    // Must not throw when window.agentDeck is absent.
    expect(() => signalAttention({ kind: "approval-needed", title: "x", body: "y" })).not.toThrow();
  });

  it("is a no-op against an older bridge lacking signalAttention", () => {
    stubBridge({ isElectron: true });
    expect(() => signalAttention({ kind: "turn-complete", title: "x", body: "y" })).not.toThrow();
  });

  it("swallows a throwing bridge so a domain-transition detector never sees it", () => {
    const signal = vi.fn(() => {
      throw new Error("ipc down");
    });
    stubBridge({ isElectron: true, signalAttention: signal });

    expect(() => signalAttention({ kind: "turn-complete", title: "x", body: "y" })).not.toThrow();
    expect(signal).toHaveBeenCalledTimes(1);
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
