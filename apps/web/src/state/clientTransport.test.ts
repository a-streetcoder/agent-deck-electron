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
      getStreamGeneration: () => null,
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
      getStreamGeneration: () => "generation-current",
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
      request: { type: string; lastSeq?: number; streamGeneration?: string };
    };
    expect(subscribe.request).toEqual({
      type: "subscribe_session",
      sessionId: "s1",
      lastSeq: 4,
      streamGeneration: "generation-current",
    });
    transport.disconnect();
  });
});

/**
 * A same-id rebind (the server replaced a session's process — idle-parking
 * wake, checkpoint rollback's relaunch) must NOT tear the socket down: the
 * request whose handler CAUSED the rebind is still in flight on that socket,
 * and its reply is sent there. Closing rejects it with "transport closed" even
 * though the operation succeeded — which stranded the rollback confirm dialog
 * open forever. Resubscribe over the SAME socket instead, with no lastSeq so
 * the server answers with a full snapshot of the replacement runtime.
 */
describe("RpcClientTransport.resubscribe (same-id rebind)", () => {
  const connectedTransport = async (): Promise<{
    transport: RpcClientTransport;
    socket: FakeWebSocket;
    host: TransportHost;
  }> => {
    const host: TransportHost = {
      onServerMessage: vi.fn(),
      setConnection: vi.fn(),
      getLastSeq: () => 9,
      getStreamGeneration: () => "generation-old",
      onSessionSubscribed: vi.fn(),
    };
    const transport = new RpcClientTransport(host);
    transport.connect("s1");
    const socket = FakeWebSocket.instances[0]!;
    socket.onopen?.();
    const hello = JSON.parse(String(socket.send.mock.calls[0]![0])) as { id: number };
    socket.onmessage?.({
      data: JSON.stringify({ kind: "hello_ok", id: hello.id, sessions: [], imageReadToken: "t" }),
    });
    await Promise.resolve();
    await Promise.resolve();
    return { transport, socket, host };
  };

  it("keeps the live socket and asks for a full snapshot", async () => {
    const { transport, socket } = await connectedTransport();
    const before = socket.send.mock.calls.length;

    transport.resubscribe("s1");
    await Promise.resolve();

    expect(socket.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const frame = JSON.parse(String(socket.send.mock.calls[before]![0])) as {
      request: { type: string; sessionId: string; lastSeq?: number };
    };
    // No lastSeq/streamGeneration: the replacement runtime's ancestry is new,
    // so a gap replay would be meaningless — take the snapshot.
    expect(frame.request).toEqual({ type: "subscribe_session", sessionId: "s1" });
    transport.disconnect();
  });

  it("leaves an in-flight request pending instead of rejecting it", async () => {
    const { transport, socket } = await connectedTransport();
    const settled = vi.fn();
    const inFlight = transport.send({ type: "abort", sessionId: "s1" }).then(settled, settled);

    transport.resubscribe("s1");
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    // The reply still arrives on the same socket and settles it normally.
    const request = JSON.parse(String(socket.send.mock.calls.at(-2)![0])) as { id: number };
    socket.onmessage?.({ data: JSON.stringify({ kind: "reply", id: request.id, ok: true }) });
    await inFlight;
    expect(settled).toHaveBeenCalledOnce();
    transport.disconnect();
  });

  it("ignores a superseded resubscribe's completion (two rebinds in a row)", async () => {
    const { transport, socket, host } = await connectedTransport();
    const before = socket.send.mock.calls.length;

    transport.resubscribe("s1"); // A
    transport.resubscribe("s1"); // B supersedes A
    const first = JSON.parse(String(socket.send.mock.calls[before]![0])) as { id: number };
    const second = JSON.parse(String(socket.send.mock.calls[before + 1]![0])) as { id: number };

    // B settles first, then the superseded A: A must not re-fire the
    // sideband refetch against the newer runtime (Codex).
    socket.onmessage?.({ data: JSON.stringify({ kind: "reply", id: second.id, ok: true }) });
    await Promise.resolve();
    await Promise.resolve();
    socket.onmessage?.({ data: JSON.stringify({ kind: "reply", id: first.id, ok: true }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(host.onSessionSubscribed).toHaveBeenCalledTimes(1);
    transport.disconnect();
  });

  it("falls back to a full connect when the socket is gone or the session differs", async () => {
    const { transport } = await connectedTransport();
    transport.resubscribe("other-session");
    expect(FakeWebSocket.instances).toHaveLength(2);
    transport.disconnect();
  });
});
