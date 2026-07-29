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
});
