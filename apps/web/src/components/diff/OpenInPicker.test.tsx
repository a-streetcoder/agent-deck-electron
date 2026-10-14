// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/store.ts";
import { OpenInPicker } from "./OpenInPicker.tsx";

vi.mock("../../state/wsBridge.ts", () => ({
  fetchAvailableEditors: vi.fn(async () => []),
  openFileInEditor: vi.fn(),
}));

afterEach(() => {
  cleanup();
  useAppStore.setState({ me: null });
});

it("opens in the preferred editor on a loopback server", () => {
  const onOpen = vi.fn();
  render(<OpenInPicker available={["vscode", "zed"]} preferred="vscode" onOpen={onOpen} />);
  const button = screen.getByTestId("open-in-editor") as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("open-in-menu-trigger")).toBeTruthy();
});

it("SRV-09: renders disabled with the shared-server title, no menu", () => {
  useAppStore.setState({ me: { id: "ale@example.com", email: "ale@example.com" } });
  const onOpen = vi.fn();
  render(<OpenInPicker available={["vscode", "zed"]} preferred="vscode" onOpen={onOpen} />);
  const button = screen.getByTestId("open-in-editor") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toBe("Not available on a shared server");
  fireEvent.click(button);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.queryByTestId("open-in-menu-trigger")).toBeNull();
});
