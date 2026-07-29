// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UserCell } from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { CellView } from "./cells.tsx";

afterEach(() => {
  cleanup();
  useAppStore.setState({ session: null });
});

describe("user file attachments", () => {
  it("renders a file-only history entry as a durable chip without exposing its tag", async () => {
    const path = '/definitely-missing/ses-06/notes & "plans".txt';
    const cell: UserCell = {
      kind: "user",
      id: "user-file-entry",
      text: "",
      files: [{ name: 'notes & "plans".txt', path }],
    };

    render(<CellView cell={cell} />);

    expect(await screen.findByText("Attached a file.")).toBeTruthy();
    const chip = screen.getByRole("listitem", {
      name: `notes & "plans".txt: ${path}`,
    });
    expect(chip.getAttribute("title")).toBe(path);
    expect(document.body.textContent).not.toContain("<file");
  });

  it("renders a missing folder as a distinct durable chip without exposing its reference", async () => {
    const path = "/definitely-missing/ses-07/project folder";
    const cell: UserCell = {
      kind: "user",
      id: "user-folder-entry",
      text: "",
      folders: [{ name: "project folder", path }],
    };

    render(<CellView cell={cell} />);

    expect(await screen.findByText("Attached a folder.")).toBeTruthy();
    const chip = screen.getByRole("listitem", {
      name: `project folder: ${path}`,
    });
    expect(chip.getAttribute("title")).toBe(path);
    expect(chip.getAttribute("data-kind")).toBe("folder");
    expect(document.body.textContent).not.toContain("folder:");
  });

  it("summarizes mixed file and folder history without changing their chip kinds", async () => {
    const cell: UserCell = {
      kind: "user",
      id: "user-mixed-entry",
      text: "",
      files: [{ name: "notes.txt", path: "/tmp/notes.txt" }],
      folders: [{ name: "project", path: "/tmp/project" }],
    };

    render(<CellView cell={cell} />);

    expect(await screen.findByText("Attached 1 file and 1 folder.")).toBeTruthy();
    expect(
      screen.getByRole("listitem", { name: "notes.txt: /tmp/notes.txt" }).getAttribute("data-kind"),
    ).toBe("file");
    expect(
      screen.getByRole("listitem", { name: "project: /tmp/project" }).getAttribute("data-kind"),
    ).toBe("folder");
  });

  it("renders a durable compact paste chip with an escaped selectable preview", async () => {
    const paste = {
      id: 1,
      marker: "[paste #1 1001 chars]",
      text: `<script>alert("not html")</script>${"x".repeat(970)}`,
    };
    const cell: UserCell = {
      kind: "user",
      id: "user-paste-entry",
      text: "",
      pastes: [paste],
    };

    render(<CellView cell={cell} />);

    expect(await screen.findByText("Attached a paste.")).toBeTruthy();
    const chip = screen.getByRole("button", { name: `Preview ${paste.marker}` });
    expect(chip.closest("li")?.getAttribute("data-kind")).toBe("paste");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByTestId("paste-preview-dialog")).toBeNull();

    fireEvent.click(chip);
    expect(screen.getByRole("dialog", { name: "Pasted text preview" })).toBeTruthy();
    expect(screen.getByTestId("paste-preview-content").textContent).toBe(paste.text);
    expect(document.querySelector("script")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("paste-preview-dialog")).toBeNull();
  });
});
