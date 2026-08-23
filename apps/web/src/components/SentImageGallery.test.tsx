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
  it("renders image-only messages as preview pills with lazy thumbnails and accessible labels", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(<CellView cell={cell} />);
    expect(screen.getByRole("button", { name: "Preview Sent image 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview Sent image 2" })).toBeTruthy();
    const images = document.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]!.getAttribute("loading")).toBe("lazy");
    expect(images[0]!.getAttribute("decoding")).toBe("async");
    expect(images[0]!.getAttribute("src")).toContain("/session-images/s1/a?token=secret");
    expect(document.body.textContent).not.toContain("base64");
  });
  it("uses the submitted filename and opens the persisted image from its pill", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(
      <CellView cell={{ ...cell, images: [{ id: "a", name: "1.png", width: 10, height: 20 }] }} />,
    );

    const trigger = screen.getByRole("button", { name: "Preview 1.png" });
    expect(trigger.getAttribute("title")).toBe("1.png");
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Expanded image preview" })).toBeTruthy();
    expect(screen.getAllByText("1.png")).toHaveLength(2);
    expect(screen.getByAltText("1.png").getAttribute("src")).toContain(
      "/session-images/s1/a?token=secret",
    );
  });

  it("uses the generalized trapped dialog and restores focus", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(<CellView cell={cell} />);
    const trigger = screen.getByRole("button", { name: "Preview Sent image 1" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getAllByText(/Sent image 2/)).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("fails closed to an unavailable tile and retries after token rotation", () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    render(<CellView cell={cell} />);
    fireEvent.error(document.querySelectorAll("img")[0]!);
    expect(screen.getByText("Sent image 1 (unavailable)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview Sent image 1" })).toBeNull();
    act(() => setImageReadToken("replacement"));
    expect(screen.getByRole("button", { name: "Preview Sent image 1" })).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toContain("token=replacement");
  });

  it("keeps an image-only message readable while previews are hidden and does not reopen", async () => {
    useAppStore.setState({ session: { id: "s1", cwd: "/tmp", createdAt: "now" } });
    setImageReadToken("secret");
    const { rerender } = render(<CellView cell={cell} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview Sent image 1" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(
      <CellView
        cell={cell}
        transcriptVisibility={{ ...DEFAULT_TRANSCRIPT_VISIBILITY, showImages: false }}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    await waitFor(() => expect(screen.getByText("Attached 2 images.")).toBeTruthy());

    rerender(<CellView cell={cell} transcriptVisibility={DEFAULT_TRANSCRIPT_VISIBILITY} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelectorAll("img")).toHaveLength(2);
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
