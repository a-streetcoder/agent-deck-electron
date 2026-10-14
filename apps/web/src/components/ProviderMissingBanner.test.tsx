// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAppStore } from "../state/store.ts";
import { ProviderMissingBanner } from "./ProviderMissingBanner.tsx";

const user = { id: "ale@example.com", email: "ale@example.com" };
afterEach(() => {
  cleanup();
  useAppStore.setState({ me: null, session: null, view: "chat" });
});

it("shows nothing on a loopback server or when a provider is connected", () => {
  render(<ProviderMissingBanner />);
  expect(screen.queryByTestId("provider-missing-banner")).toBeNull();
  useAppStore.setState({ me: { ...user, providersConnected: true } });
  render(<ProviderMissingBanner />);
  expect(screen.queryByTestId("provider-missing-banner")).toBeNull();
});

it("SRV-13: warns a user with no provider and opens Providers", () => {
  useAppStore.setState({ me: { ...user, providersConnected: false } });
  render(<ProviderMissingBanner />);
  expect(screen.getByTestId("provider-missing-banner").textContent).toContain(
    "You have not connected a model provider yet.",
  );
  expect(screen.getByTestId("provider-missing-banner").textContent).toContain(
    "start a session, or work in a session shared with you.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Providers" }));
  expect(useAppStore.getState().view).toBe("providers");
});

it("SRV-14: stays quiet inside a session owned by someone else", () => {
  useAppStore.setState({
    me: { ...user, providersConnected: false },
    session: { createdBy: { id: "andrea@example.com", name: "Andrea" } } as never,
  });
  render(<ProviderMissingBanner />);
  expect(screen.queryByTestId("provider-missing-banner")).toBeNull();
});
