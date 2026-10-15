// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectionCard } from "./GitHubConnectionCard.tsx";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const connected = {
  available: true,
  configured: true,
  connection: {
    login: "ale-gh",
    avatarUrl: "https://avatars.example/ale",
    scopes: ["repo"],
    connectedAt: "2026-10-15T00:00:00.000Z",
  },
};
const disconnected = { available: true, configured: true, connection: null };

/** Route fetch by "METHOD url"; each route answers its queue in order, the last one sticks. */
function routes(table: Record<string, unknown[]>): void {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const queue = table[key];
    if (!queue) throw new Error(`unexpected ${key}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next instanceof Response ? next : json(next);
  });
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GitHubConnectionCard (SRV-06)", () => {
  it("renders nothing when the server has no GitHub connections", async () => {
    routes({ "GET /runtime/github": [{ available: false, configured: false, connection: null }] });
    const { container } = render(<GitHubConnectionCard />);
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("says the GitHub app is not configured", async () => {
    routes({ "GET /runtime/github": [{ ...disconnected, configured: false }] });
    render(<GitHubConnectionCard />);
    expect((await screen.findByTestId("github-not-configured")).textContent).toContain(
      "GitHub app not configured",
    );
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("shows the user code and link, polls, then shows the account", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routes({
      "GET /runtime/github": [disconnected, connected],
      "POST /runtime/github/connect": [
        json(
          {
            id: "f1",
            userCode: "ABCD-1234",
            verificationUri: "https://github.com/login/device",
            interval: 1,
          },
          201,
        ),
      ],
      "GET /runtime/github/connect/f1": [
        { status: "pending", interval: 1 },
        { status: "done", login: "ale-gh" },
      ],
    });
    render(<GitHubConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "https://github.com/login/device" }).getAttribute("href"),
    ).toBe("https://github.com/login/device");
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect((await screen.findByText("@ale-gh")).textContent).toBe("@ale-gh");
  });

  it("shows why a sign-in ended and offers Connect again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routes({
      "GET /runtime/github": [disconnected],
      "POST /runtime/github/connect": [
        json({ id: "f2", userCode: "WXYZ-0000", verificationUri: "https://x", interval: 1 }, 201),
      ],
      "GET /runtime/github/connect/f2": [{ status: "expired", error: "The GitHub code expired." }],
    });
    render(<GitHubConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await screen.findByText("WXYZ-0000");
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect((await screen.findByRole("alert")).textContent).toBe("The GitHub code expired.");
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("disconnects", async () => {
    routes({
      "GET /runtime/github": [connected, disconnected],
      "DELETE /runtime/github": [{ ok: true }],
    });
    render(<GitHubConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/runtime/github", { method: "DELETE" });
  });
});
