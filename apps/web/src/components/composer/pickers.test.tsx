// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelChip, ThinkingChip } from "./pickers.tsx";

afterEach(cleanup);

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
