// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TRANSCRIPT_VISIBILITY } from "@agent-deck/contracts";
import { useAppStore } from "../state/store.ts";
import { setImageReadToken } from "../lib/sessionImageUrl.ts";
import { CellView } from "./cells.tsx";

afterEach(cleanup);
const cell = {
  kind: "user" as const,
  id: "user-1",
  text: "",
  images: [
    { id: "a", width: 10, height: 20 },
    { id: "b", width: 20, height: 10 },
  ],
};

describe("sent image gallery", () => {
  it("renders image-only messages lazily with opaque URLs and accessible labels", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(<CellView cell={cell} />);
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]!.getAttribute("loading")).toBe("lazy");
    expect(images[0]!.getAttribute("decoding")).toBe("async");
    expect(images[0]!.getAttribute("src")).toContain("/session-images/s1/a?token=secret");
    expect(document.body.textContent).not.toContain("base64");
  });
  it("uses the generalized trapped dialog and restores focus", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(<CellView cell={cell} />);
    const trigger = screen.getByRole("button", { name: "Expand Sent image 1" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText(/Sent image 2/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("fails closed to an unavailable tile and retries after token rotation", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(<CellView cell={cell} />);
    fireEvent.error(screen.getAllByRole("img")[0]!);
    expect(screen.getByRole("img", { name: "Sent image 1 unavailable" })).toBeTruthy();
    act(() => setImageReadToken("replacement"));
    expect(screen.getByAltText("Sent image 1").getAttribute("src")).toContain("token=replacement");
  });

  it("keeps an image-only message readable while previews are hidden and does not reopen", async () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    const { rerender } = render(<CellView cell={cell} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Sent image 1" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(
      <CellView
        cell={cell}
        transcriptVisibility={{ ...DEFAULT_TRANSCRIPT_VISIBILITY, showImages: false }}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(screen.getByText("Attached 2 images.")).toBeTruthy());

    rerender(<CellView cell={cell} transcriptVisibility={DEFAULT_TRANSCRIPT_VISIBILITY} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("retains hidden image provenance beside text and other attachment kinds", async () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(
      <CellView
        cell={{
          ...cell,
          text: "Review these inputs",
          files: [{ name: "notes.txt", path: "/tmp/notes.txt" }],
        }}
        transcriptVisibility={{ ...DEFAULT_TRANSCRIPT_VISIBILITY, showImages: false }}
      />,
    );

    expect(await screen.findByText("Review these inputs")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "2 images: Image previews hidden" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "notes.txt: /tmp/notes.txt" })).toBeTruthy();
    expect(screen.queryByTestId("sent-image-gallery")).toBeNull();
  });
});
