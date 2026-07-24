import { beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:1234" });
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("RpcClientTransport.disconnect", () => {
  it("closes and forgets the prior subscription so stale callbacks cannot reactivate it", () => {
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
    transport.send({ type: "abort", sessionId: "old-session" });
    expect(socket.send).not.toHaveBeenCalled();
  });
});
