import { beforeEach, describe, expect, it, vi } from "vitest";
import { getImageReadToken, setImageReadToken } from "../lib/sessionImageUrl.ts";
import { RpcClientTransport, type TransportHost } from "./clientTransport.ts";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  setImageReadToken("");
  vi.useRealTimers();
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:1234" });
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("RpcClientTransport.disconnect", () => {
  it("closes and forgets the prior subscription so stale callbacks cannot reactivate it", async () => {
    const statuses: string[] = [];
    const host: TransportHost = {
      onServerMessage: vi.fn(),
      setConnection: (status) => statuses.push(status),
      getLastSeq: () => 0,
      onSessionSubscribed: vi.fn(),
    };
    const transport = new RpcClientTransport(host);

    transport.connect("old-session");
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain("/rpc");
    transport.disconnect();

    expect(socket.close).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe("closed");
    socket.onopen?.();
    expect(host.onSessionSubscribed).not.toHaveBeenCalled();
    await expect(transport.send({ type: "abort", sessionId: "old-session" })).rejects.toThrow(
      "transport not connected",
    );
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("refreshes the image capability before resubscribing after reconnect", async () => {
    vi.useFakeTimers();
    const host: TransportHost = {
      onServerMessage: vi.fn(),
      setConnection: vi.fn(),
      getLastSeq: () => 4,
      onSessionSubscribed: vi.fn(),
    };
    const transport = new RpcClientTransport(host);
    transport.connect("s1");
    const first = FakeWebSocket.instances[0]!;
    first.onopen?.();
    const firstHello = JSON.parse(String(first.send.mock.calls[0]![0])) as { id: number };
    first.onmessage?.({
      data: JSON.stringify({
        kind: "hello_ok",
        id: firstHello.id,
        sessions: [],
        imageReadToken: "first-token",
      }),
    });
    await Promise.resolve();
    expect(getImageReadToken()).toBe("first-token");

    first.onclose?.();
    await vi.advanceTimersByTimeAsync(500);
    const second = FakeWebSocket.instances[1]!;
    second.onopen?.();
    const secondHello = JSON.parse(String(second.send.mock.calls[0]![0])) as { id: number };
    second.onmessage?.({
      data: JSON.stringify({
        kind: "hello_ok",
        id: secondHello.id,
        sessions: [],
        imageReadToken: "rotated-token",
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(getImageReadToken()).toBe("rotated-token");
    const subscribe = JSON.parse(String(second.send.mock.calls[1]![0])) as {
      request: { type: string; lastSeq?: number };
    };
    expect(subscribe.request).toEqual({ type: "subscribe_session", sessionId: "s1", lastSeq: 4 });
    transport.disconnect();
  });
});
