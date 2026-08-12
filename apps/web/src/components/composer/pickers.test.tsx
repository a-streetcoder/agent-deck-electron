// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelChip, ThinkingChip } from "./pickers.tsx";

afterEach(cleanup);

describe("thinking-level presentation", () => {
  it("shows the raw level and no speculative menu while metadata is loading", () => {
    render(
      <ThinkingChip
        state={{ thinkingLevel: "max" }}
        levels={[]}
        metadataStatus="loading"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("thinking-chip-label").textContent).toBe("max");
    const trigger = screen.getByTestId("thinking-chip") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByTestId("thinking-menu")).toBeNull();
  });

  it("does not render an empty list when reasoning metadata has no levels", () => {
    render(
      <ThinkingChip
        state={{ thinkingLevel: "high" }}
        levels={[]}
        metadataStatus="unavailable"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("thinking-chip-label").textContent).toBe("high · levels unavailable");
    const trigger = screen.getByTestId("thinking-chip") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.getAttribute("aria-busy")).toBeNull();
    expect(trigger.getAttribute("title")).toMatch(/retry/i);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByTestId("thinking-menu")).toBeNull();
  });

  it("renders only the exact supplied levels and preserves unavailable state", () => {
    const onSelect = vi.fn();
    render(
      <ThinkingChip
        state={{ thinkingLevel: "xhigh" }}
        levels={["off", "low", "high", "max"]}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByTestId("thinking-chip-label").textContent).toBe("xhigh unavailable");
    fireEvent.click(screen.getByTestId("thinking-chip"));
    expect(screen.getByTestId("thinking-option-max")).toBeTruthy();
    expect(screen.queryByTestId("thinking-option-medium")).toBeNull();
    expect(screen.queryByTestId("thinking-option-xhigh")).toBeNull();
    expect(screen.getByTestId("thinking-option-off").getAttribute("role")).toBe("option");
    expect(screen.getByTestId("thinking-option-off").getAttribute("aria-selected")).toBe("false");
  });

  it("supports listbox keyboard navigation and restores trigger focus after selection", async () => {
    const onSelect = vi.fn();
    render(
      <ThinkingChip
        state={{ thinkingLevel: "off" }}
        levels={["off", "low", "high", "max"]}
        onSelect={onSelect}
      />,
    );

    const trigger = screen.getByTestId("thinking-chip");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("thinking-option-off")),
    );
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(screen.getByTestId("thinking-option-max"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByTestId("thinking-option-off"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("thinking-option-max"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("max");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("running picker guards", () => {
  it("closes and blocks an already-open model menu when disabled", () => {
    const onSelect = vi.fn();
    const view = render(
      <ModelChip
        state={{ provider: "mock", modelId: "a", thinkingLevel: "off" }}
        models={[{ provider: "mock", id: "b" }]}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("model-chip"));
    const oldOption = screen.getByTestId("model-option-b");
    view.rerender(
      <ModelChip
        state={{ provider: "mock", modelId: "a", thinkingLevel: "off" }}
        models={[{ provider: "mock", id: "b" }]}
        onSelect={onSelect}
        disabled
      />,
    );
    expect(screen.queryByTestId("model-menu")).toBeNull();
    fireEvent.click(oldOption);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes and blocks an already-open thinking menu when disabled", () => {
    const onSelect = vi.fn();
    const view = render(
      <ThinkingChip
        state={{ thinkingLevel: "off" }}
        levels={["off", "high"]}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("thinking-chip"));
    const oldOption = screen.getByTestId("thinking-option-high");
    view.rerender(
      <ThinkingChip
        state={{ thinkingLevel: "off" }}
        levels={["off", "high"]}
        onSelect={onSelect}
        disabled
      />,
    );
    expect(screen.queryByTestId("thinking-menu")).toBeNull();
    fireEvent.click(oldOption);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
