// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
});
