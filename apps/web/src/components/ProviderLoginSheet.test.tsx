// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderLoginSheet } from "./ProviderLoginSheet.tsx";
import { useAppStore } from "../state/store.ts";

vi.mock("../lib/native.ts", () => ({ openExternal: vi.fn(async () => true) }));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Pi 1.x Anthropic copy-code login after the method was chosen.
const copyCodeEvents = [
  { type: "auth_url", url: "https://claude.test/oauth/authorize", instructions: "Paste the code" },
  {
    type: "prompt",
    message: "Paste the code Anthropic shows after you sign in:",
    placeholder: "code#state",
    secret: false,
    manualCode: true,
  },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ loginId: "login-1", ok: true });
      expect(String(input)).toMatch(/^\/runtime\/providers\/login\/login-1/);
      return jsonResponse({ events: copyCodeEvents, status: "running", nextCursor: 2 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState({ me: null });
});

function renderSheet() {
  render(
    <ProviderLoginSheet
      provider={{ id: "anthropic", name: "Anthropic" }}
      authType="oauth"
      onClose={() => {}}
      onDone={() => {}}
    />,
  );
}

describe("ProviderLoginSheet copy-code login", () => {
  it("shows the paste field at once on a shared server, where Pi's callback is unreachable", async () => {
    useAppStore.setState({ me: { id: "ale@example.com", email: "ale@example.com" } });
    renderSheet();
    const input = await screen.findByTestId("login-prompt-input");
    expect(input.getAttribute("placeholder")).toBe("code#state");
    expect(screen.queryByRole("button", { name: "Enter a code manually" })).toBeNull();
  });

  it("keeps manual entry behind a button on a local app, where the callback completes", async () => {
    renderSheet();
    await screen.findByRole("button", { name: "Enter a code manually" });
    expect(screen.queryByTestId("login-prompt-input")).toBeNull();
  });
});
