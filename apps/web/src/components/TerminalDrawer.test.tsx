// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { TerminalDrawer } from "./TerminalDrawer.tsx";

// xterm needs a canvas jsdom lacks; the drawer never builds one with the socket closed.
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));
vi.mock("../state/wsBridge.ts", () => ({
  closeSessionTerminal: vi.fn(),
  openSessionInExternalTerminal: vi.fn(),
  openSessionTerminal: vi.fn(),
  sendTerminalInput: vi.fn(),
  sendTerminalResize: vi.fn(),
  subscribeTerminalPush: vi.fn(() => () => {}),
}));

beforeEach(() => {
  // A closed socket keeps xterm out of jsdom; the drawer header still renders.
  useAppStore.setState({
    terminalOpen: true,
    connection: "closed",
    session: { id: "s1" } as NonNullable<ReturnType<typeof useAppStore.getState>["session"]>,
  });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ me: null });
});

it("offers Continue in external terminal on a loopback server", () => {
  useAppStore.setState({ me: null });
  render(<TerminalDrawer />);
  expect(screen.getByTestId("terminal-open-external")).toBeTruthy();
});

it("SRV-09: hides Continue in external terminal on a shared server", () => {
  useAppStore.setState({ me: { id: "ale@example.com", email: "ale@example.com" } });
  render(<TerminalDrawer />);
  expect(screen.getByTestId("terminal-kill")).toBeTruthy();
  expect(screen.queryByTestId("terminal-open-external")).toBeNull();
});
