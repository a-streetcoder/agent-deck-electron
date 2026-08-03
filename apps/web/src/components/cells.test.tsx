// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentCell, UserCell } from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { CellView } from "./cells.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  delete window.agentDeck;
  useAppStore.setState({ session: null });
});

describe("per-message copy actions", () => {
  const clipboard = (writeText = vi.fn().mockResolvedValue(undefined)) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  };

  it("copies exact user text without requiring a stable entry or including attachments", async () => {
    const writeText = clipboard();
    const text = `  Keep markdown **exact**.\n${"long line ".repeat(2_000)}\n`;
    render(
      <CellView
        cell={{
          kind: "user",
          id: "user-copy",
          text,
          files: [{ name: "private.txt", path: "/private/private.txt" }],
        }}
      />,
    );

    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(copy.getAttribute("tabindex")).toBeNull();
    expect(copy.getAttribute("data-side")).toBe("leading");
    expect(copy.className).toContain("right-full");
    expect(copy.className).toContain("pointer-events-none");
    expect(copy.className).toContain("group-hover/message:pointer-events-auto");
    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("private.txt"));
    expect(screen.getByRole("button", { name: "Copied" }).getAttribute("data-state")).toBe(
      "copied",
    );
  });

  it("offers one trailing action and joins visible assistant text blocks canonically", async () => {
    const writeText = clipboard();
    const first = "First answer\n\n```ts\nconst exact = true;\n```";
    const second = "Streaming **canonical";
    render(
      <CellView
        cell={{
          kind: "assistant",
          id: "assistant-copy",
          streaming: true,
          errorMessage: "status metadata",
          blocks: [
            { kind: "thinking", contentIndex: 0, text: "private reasoning", done: true },
            { kind: "text", contentIndex: 1, text: first, done: true },
            { kind: "text", contentIndex: 2, text: second, done: false },
          ],
        }}
      />,
    );

    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(screen.getAllByTestId("message-copy")).toHaveLength(1);
    expect(copy.getAttribute("data-side")).toBe("trailing");
    expect(copy.className).toContain("left-full");
    expect(copy.className).toContain("pointer-events-none");
    expect(copy.className).toContain("group-focus-within/message:pointer-events-auto");
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${first}\n\n${second}`));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("private reasoning"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("status metadata"));
  });

  it("stays tabbable while hidden and activates from the keyboard without layout space", async () => {
    const writeText = clipboard();
    render(<CellView cell={{ kind: "user", id: "keyboard-copy", text: "Keyboard copy" }} />);

    const copy = screen.getByRole("button", { name: "Copy message" });
    expect(copy.className).toContain("absolute");
    expect(copy.className).toContain("opacity-0");
    expect(copy.className).toContain("focus:opacity-100");
    expect(copy.className).toContain("focus:pointer-events-auto");

    fireEvent.keyDown(document.body, { key: "Tab" });
    copy.focus();
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Enter" });
    copy.click();

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Keyboard copy"));
    expect(screen.getByRole("button", { name: "Copied" })).toBe(copy);
  });

  it("does not offer copy for missing or empty message content", () => {
    const view = render(
      <CellView
        cell={{ kind: "assistant", id: "missing-assistant", streaming: false, blocks: [] }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();

    view.rerender(<CellView cell={{ kind: "user", id: "empty-user", text: "" }} />);
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();

    view.rerender(
      <CellView
        cell={{
          kind: "assistant",
          id: "empty-assistant",
          streaming: false,
          blocks: [{ kind: "text", contentIndex: 0, text: "", done: true }],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
  });

  it("keeps idle feedback when the clipboard rejects the write", async () => {
    const writeText = clipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<CellView cell={{ kind: "user", id: "rejected-copy", text: "Retry me" }} />);

    const copy = screen.getByRole("button", { name: "Copy message" });
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Retry me"));
    expect(copy.getAttribute("data-state")).toBe("idle");
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("coexists with stable-entry Fork and Re-run while remaining available without one", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    const view = render(
      <CellView
        cell={{ kind: "user", id: "history-copy", entryId: "entry-1", text: "Try this" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fork before this message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-run from this message" })).toBeTruthy();

    view.rerender(<CellView cell={{ kind: "user", id: "live-copy", text: "Try this" }} />);
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fork before this message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-run from this message" })).toBeNull();
  });
});

describe("historic user message actions", () => {
  const historic: UserCell = {
    kind: "user",
    id: "user-entry-1",
    entryId: "entry-1",
    text: "Try this",
  };

  afterEach(() => useAppStore.setState({ session: null }));

  it("shows keyboard-reachable actions only for stable Pi entries", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    const view = render(<CellView cell={historic} />);
    expect(screen.getByRole("button", { name: "Fork before this message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-run from this message" })).toBeTruthy();
    view.rerender(<CellView cell={{ ...historic, entryId: undefined }} />);
    expect(screen.queryByRole("button", { name: "Fork before this message" })).toBeNull();
  });

  it("confirms destructive rerun, traps initial focus, closes on Escape, and restores focus", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    render(<CellView cell={historic} />);
    const trigger = screen.getByRole("button", { name: "Re-run from this message" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog").textContent).toContain(
      "Later conversation messages will be abandoned. Workspace files are not changed.",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("subagent durable status and content", () => {
  const setParentSession = () =>
    useAppStore.setState({
      session: {
        id: "12345678-1234-4234-8234-123456789abc",
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

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
    return render(<CellView cell={cell} />);
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

  it("offers hydrated cards an accessible, duplicate-safe opaque-id reveal", async () => {
    let finish!: (value: boolean) => void;
    const revealSubagentArtifacts = vi.fn(
      () => new Promise<boolean>((resolve) => (finish = resolve)),
    );
    window.agentDeck = { revealSubagentArtifacts };
    renderSubagent({ artifactRootId: "12345678-1234-4234-8234-123456789abc" });
    fireEvent.click(screen.getByRole("button", { name: /Subagent interrupted/i }));
    const reveal = screen.getByRole("button", { name: "Reveal Artifacts" });
    fireEvent.click(reveal);
    fireEvent.click(reveal);
    expect(revealSubagentArtifacts).toHaveBeenCalledTimes(1);
    expect(reveal.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Revealing");
    finish(true);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Artifacts revealed"),
    );
    expect(revealSubagentArtifacts).toHaveBeenCalledWith("12345678-1234-4234-8234-123456789abc");
  });

  it("hides artifact actions when the preload capability is unavailable", () => {
    renderSubagent({ artifactRootId: "12345678-1234-4234-8234-123456789abc" });
    fireEvent.click(screen.getByRole("button", { name: /Subagent interrupted/i }));
    expect(screen.queryByRole("button", { name: "Reveal Artifacts" })).toBeNull();
  });

  it("opens a read-only accessible child transcript and restores focus on Escape", async () => {
    setParentSession();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          transcript: {
            runId: "durable-run",
            parentSessionId: "12345678-1234-4234-8234-123456789abc",
            status: "done",
            task: "Inspect the implementation",
            source: "canonical",
            cells: [
              { kind: "user", id: "child-user", text: "child task" },
              {
                kind: "assistant",
                id: "child-assistant",
                blocks: [{ kind: "text", contentIndex: 0, text: "child answer", done: true }],
                streaming: false,
              },
            ],
          },
        }),
      }),
    );
    renderSubagent({ status: "done", error: undefined });
    fireEvent.click(screen.getByRole("button", { name: /Subagent result/i }));
    const trigger = screen.getByRole("button", { name: "Open child transcript" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Child transcript" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(screen.getByText("child answer")).toBeTruthy());
    expect(screen.getByTestId("child-transcript-source-status").textContent).toBe(
      "Canonical · Done",
    );
    const close = screen.getByRole("button", { name: "Close child transcript" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("child-transcript-dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    vi.unstubAllGlobals();
  });

  it("shows empty summary-only evidence and its honest source label", async () => {
    setParentSession();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          transcript: {
            runId: "durable-run",
            parentSessionId: "12345678-1234-4234-8234-123456789abc",
            status: "error",
            task: "A very long child task that must wrap without colliding ".repeat(20),
            source: "summary_only",
            notice: "Full canonical child history is unavailable.",
            cells: [],
          },
        }),
      }),
    );
    renderSubagent({ status: "error" });
    fireEvent.click(screen.getByRole("button", { name: /Subagent failed/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open child transcript" }));

    await screen.findByText("No child messages yet.");
    expect(screen.getByText("Full canonical child history is unavailable.")).toBeTruthy();
    expect(screen.getByTestId("child-transcript-source-status").textContent).toBe(
      "Final report only · Error",
    );
    expect(screen.getByTestId("child-transcript-task").className).toContain("break-words");
  });

  it("offers Retry after a transient transcript load failure", async () => {
    setParentSession();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Reader temporarily unavailable." }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          transcript: {
            runId: "durable-run",
            parentSessionId: "12345678-1234-4234-8234-123456789abc",
            status: "done",
            task: "Inspect the implementation",
            source: "canonical",
            cells: [],
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    renderSubagent({ status: "done", error: undefined });
    fireEvent.click(screen.getByRole("button", { name: /Subagent result/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open child transcript" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Reader temporarily unavailable.",
    );
    const close = screen.getByRole("button", { name: "Close child transcript" });
    const retry = screen.getByRole("button", { name: "Retry" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(retry);
    fireEvent.keyDown(retry, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No child messages yet.")).toBeTruthy();
  });

  it("polls terminal Live · Done through canonical finalization, then stops", async () => {
    vi.useFakeTimers();
    setParentSession();
    const response = (source: "live" | "canonical") => ({
      ok: true,
      json: async () => ({
        transcript: {
          runId: "durable-run",
          parentSessionId: "12345678-1234-4234-8234-123456789abc",
          status: "done",
          task: "Inspect the implementation",
          source,
          cells: [],
        },
      }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("live"))
      .mockResolvedValue(response("canonical"));
    vi.stubGlobal("fetch", fetchMock);
    renderSubagent({ status: "done", error: undefined });
    fireEvent.click(screen.getByRole("button", { name: /Subagent result/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open child transcript" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("child-transcript-source-status").textContent).toBe("Live · Done");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("child-transcript-source-status").textContent).toBe(
      "Canonical · Done",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps polling an open dialog across terminal to running continuation", async () => {
    setParentSession();
    const response = (source: "canonical" | "live", status: "done" | "running", text: string) => ({
      ok: true,
      json: async () => ({
        transcript: {
          runId: "durable-run",
          parentSessionId: "12345678-1234-4234-8234-123456789abc",
          status,
          task: status === "running" ? "Follow-up task" : "First task",
          source,
          cells: [
            {
              kind: "assistant",
              id: "child-assistant",
              blocks: [{ kind: "text", contentIndex: 0, text, done: status === "done" }],
              streaming: status === "running",
            },
          ],
        },
      }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response("canonical", "done", "first result"))
      // Brief stale endpoint response immediately after continuation starts.
      .mockResolvedValueOnce(response("canonical", "done", "first result"))
      .mockResolvedValueOnce(response("live", "running", "follow-up delta"))
      .mockResolvedValue(response("canonical", "done", "final follow-up"));
    vi.stubGlobal("fetch", fetchMock);
    const terminal: SubagentCell = {
      kind: "subagent",
      id: "durable-run",
      task: "First task",
      status: "done",
      text: "first result",
      progress: [],
    };
    const view = render(<CellView cell={terminal} />);
    fireEvent.click(screen.getByRole("button", { name: /Subagent result/i }));
    fireEvent.click(screen.getByRole("button", { name: "Open child transcript" }));
    await screen.findByText("first result");

    view.rerender(
      <CellView
        cell={{ ...terminal, task: "Follow-up task", status: "running", text: "follow-up" }}
      />,
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2_000,
    });
    expect(await screen.findByText("follow-up delta")).toBeTruthy();
    expect(screen.getByTestId("child-transcript-source-status").textContent).toBe("Live · Running");

    view.rerender(
      <CellView
        cell={{ ...terminal, task: "Follow-up task", status: "done", text: "final follow-up" }}
      />,
    );
    await screen.findByText("final follow-up");
    expect(screen.getByTestId("child-transcript-source-status").textContent).toBe(
      "Canonical · Done",
    );
    const terminalCalls = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(fetchMock).toHaveBeenCalledTimes(terminalCalls);
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
