// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/store.ts";
import { runCommand } from "../state/commands.ts";
import { Sidebar } from "./Sidebar.tsx";

afterEach(cleanup);

beforeEach(() => {
  useAppStore.setState({
    view: "chat",
    panelExpanded: false,
    me: null,
    meKnown: true,
    connection: "open",
    session: null,
    projects: [{ id: "p1", name: "Alpha", path: "/alpha", createdAt: "2026-01-01T00:00:00.000Z" }],
    sessions: [{ id: "a", projectId: "p1", cwd: "/alpha", createdAt: "2026-01-01T00:00:00.000Z" }],
  });
});

const layer = (id: string) => screen.getByTestId(id);

describe("Sidebar (UI-01 inverted layering)", () => {
  it("shows the sessions list without any click and hides the nav pull-up", () => {
    render(<Sidebar />);
    expect(screen.getByTestId("chat-a")).toBeTruthy();
    expect(layer("sessions-layer").getAttribute("aria-hidden")).toBe("false");
    expect(layer("orchestrate-expanded").getAttribute("aria-hidden")).toBe("true");
    expect(layer("orchestrate-expanded").hasAttribute("inert")).toBe(true);
    expect(screen.queryByTestId("sidebar-signed-in")).toBeNull();
  });

  it("shows a generic icon and Local in the user row when there is no signed-in user", () => {
    render(<Sidebar />);
    const card = screen.getByTestId("orchestrate-expand");
    expect(card.textContent).toContain("Orchestrate");
    expect(screen.getByTestId("orchestrate-user").textContent).toBe("Local");
    expect(screen.getByTestId("orchestrate-user-icon").querySelector("svg")).toBeTruthy();
  });

  it("shows only the generic icon until /me answers (no Local flash on a shared server)", () => {
    useAppStore.setState({ meKnown: false });
    render(<Sidebar />);
    expect(screen.getByTestId("orchestrate-user").textContent).toBe("");
    expect(screen.getByTestId("orchestrate-user-icon").querySelector("svg")).toBeTruthy();
    act(() => useAppStore.getState().setMe(null));
    expect(screen.getByTestId("orchestrate-user").textContent).toBe("Local");
  });

  it("shows initials and the display name, with the email in the title", () => {
    useAppStore.setState({ me: { id: "u1", email: "ada.lovelace@example.com", name: "Ada King" } });
    render(<Sidebar />);
    const row = screen.getByTestId("orchestrate-user");
    expect(row.getAttribute("title")).toBe("ada.lovelace@example.com");
    expect(screen.getByTestId("orchestrate-user-icon").textContent).toBe("AK");
    expect(row.textContent).toContain("Ada King");
  });

  it("falls back to the email local part without a name", () => {
    useAppStore.setState({ me: { id: "u1", email: "ada@example.com" } });
    render(<Sidebar />);
    expect(screen.getByTestId("orchestrate-user-icon").textContent).toBe("AD");
    expect(screen.getByTestId("orchestrate-user").textContent).toBe("AD" + "ada");
  });

  it("shows the generic icon and Local, not the raw id, without a name or email", () => {
    useAppStore.setState({ me: { id: "user-7f3a", email: "" } });
    render(<Sidebar />);
    expect(screen.getByTestId("orchestrate-user").textContent).toBe("Local");
    expect(screen.getByTestId("orchestrate-user-icon").querySelector("svg")).toBeTruthy();
  });

  it("expands the nav from the user row, keeps it open on nav selection, and collapses back", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId("orchestrate-user"));
    expect(useAppStore.getState().panelExpanded).toBe(true);
    expect(layer("orchestrate-expanded").getAttribute("aria-hidden")).toBe("false");
    expect(layer("sessions-layer").getAttribute("aria-hidden")).toBe("true");
    expect(layer("sessions-layer").hasAttribute("inert")).toBe(true);

    fireEvent.click(screen.getByTestId("nav-skills"));
    expect(useAppStore.getState()).toMatchObject({ view: "skills", panelExpanded: true });

    fireEvent.click(screen.getByTestId("orchestrate-collapse"));
    expect(useAppStore.getState().panelExpanded).toBe(false);
    expect(layer("sessions-layer").getAttribute("aria-hidden")).toBe("false");
  });

  it("the panel toggle command (mod+s) toggles the Orchestrate pull-up", () => {
    render(<Sidebar />);
    act(() => runCommand("panel.sessions.toggle"));
    expect(layer("orchestrate-expanded").getAttribute("aria-hidden")).toBe("false");
    act(() => runCommand("panel.sessions.toggle"));
    expect(layer("orchestrate-expanded").getAttribute("aria-hidden")).toBe("true");
  });

  it("entering chat collapses the pull-up without persisting it", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId("orchestrate-expand"));
    expect(localStorage.getItem("agentdeck-orchestrate-expanded")).toBe("1");
    act(() => useAppStore.getState().setView("skills"));
    expect(layer("orchestrate-expanded").getAttribute("aria-hidden")).toBe("false");
    act(() => useAppStore.getState().setView("chat"));
    expect(layer("sessions-layer").getAttribute("aria-hidden")).toBe("false");
    expect(layer("orchestrate-expanded").getAttribute("aria-hidden")).toBe("true");
    expect(localStorage.getItem("agentdeck-orchestrate-expanded")).toBe("1");
  });

  it("shows the attention count on the Orchestrate header", () => {
    useAppStore.setState({
      panelExpanded: true,
      sessions: [
        { id: "a", cwd: "/alpha", createdAt: "2026-01-01T00:00:00.000Z", needsAttention: true },
        { id: "b", cwd: "/alpha", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    render(<Sidebar />);
    expect(screen.getByTestId("orchestrate-attention-count").textContent).toBe("1");
  });

  it("hands focus to the collapse button on open and back to the card on close", () => {
    render(<Sidebar />);
    const opener = screen.getByTestId("orchestrate-expand");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByTestId("orchestrate-collapse"));
    fireEvent.click(screen.getByTestId("orchestrate-collapse"));
    expect(document.activeElement).toBe(opener);
  });

  it("does not steal focus from outside the sidebar when the pull-up toggles", () => {
    render(
      <>
        <input data-testid="outside" />
        <Sidebar />
      </>,
    );
    const outside = screen.getByTestId("outside");
    outside.focus();
    act(() => runCommand("panel.sessions.toggle"));
    expect(document.activeElement).toBe(outside);
  });
});
