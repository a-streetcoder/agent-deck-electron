// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentCell, UserCell } from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { CellView } from "./cells.tsx";

afterEach(() => {
  cleanup();
  useAppStore.setState({ session: null });
});

describe("subagent durable status and content", () => {
  const renderSubagent = (overrides: Partial<SubagentCell> = {}) => {
    const cell: SubagentCell = {
      kind: "subagent",
      id: "durable-run",
      task: "Inspect the implementation",
      status: "interrupted",
      text: "partial output",
      error: "The app restarted before completion.",
      progress: [],
      ...overrides,
    };
    render(<CellView cell={cell} />);
  };

  it("announces stopped and interrupted as distinct statuses", () => {
    renderSubagent();
    expect(screen.getByText("interrupted")).toBeTruthy();
    cleanup();
    renderSubagent({ status: "stopped", error: "Stopped by parent shutdown." });
    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("shows partial output and its failure reason together", () => {
    renderSubagent({ status: "error", error: "Result persistence failed." });
    fireEvent.click(screen.getByRole("button", { name: /Subagent failed/i }));
    expect(screen.getByTestId("subagent-output").textContent).toBe("partial output");
    expect(screen.getByRole("alert").textContent).toBe("Result persistence failed.");
  });

  it("expands once when a retained terminal card resumes, then respects collapse", () => {
    const terminal: SubagentCell = {
      kind: "subagent",
      id: "durable-run",
      task: "First task",
      status: "done",
      text: "first result",
      progress: [],
    };
    const view = render(<CellView cell={terminal} />);
    const toggle = screen.getByRole("button", { name: /Subagent result/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    view.rerender(
      <CellView cell={{ ...terminal, task: "Follow-up", status: "running", text: "live delta" }} />,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    view.rerender(
      <CellView
        cell={{ ...terminal, task: "Follow-up", status: "running", text: "live delta two" }}
      />,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("bounds long task and output regions while keeping them keyboard focusable", () => {
    const task = "task ".repeat(20_000);
    const output = "output ".repeat(40_000);
    renderSubagent({ status: "done", task, text: output, error: undefined });
    fireEvent.click(screen.getByRole("button", { name: /Subagent result/i }));
    const taskRegion = screen.getByTestId("subagent-task");
    const outputRegion = screen.getByTestId("subagent-output");
    expect(taskRegion.getAttribute("tabindex")).toBe("0");
    expect(outputRegion.getAttribute("tabindex")).toBe("0");
    expect(taskRegion.textContent).toBe(task);
    expect(outputRegion.textContent).toBe(output);
    taskRegion.focus();
    expect(document.activeElement).toBe(taskRegion);
    outputRegion.focus();
    expect(document.activeElement).toBe(outputRegion);
  });
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
