// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/store.ts";
import { AgentChip, ModelChip, ThinkingChip } from "./pickers.tsx";

afterEach(cleanup);

it("uses the shared composer chip and selects an agent from its listbox", async () => {
  const onSelect = vi.fn();
  render(
    <AgentChip
      currentName={null}
      agents={[{ filePath: "/agents/reviewer.md", name: "Reviewer", scope: "global" }]}
      projectScoped
      onSelect={onSelect}
    />,
  );

  const trigger = screen.getByTestId("agent-picker");
  expect(trigger.className).toContain("min-h-control-sm");
  expect(screen.getByTestId("agent-chip-label").textContent).toBe("Orchestrator");
  fireEvent.click(trigger);
  expect(screen.getByTestId("agent-menu").getAttribute("role")).toBe("dialog");
  expect(screen.getByText("Available for this project")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "review" } });
  fireEvent.click(screen.getByTestId("agent-option-Reviewer"));
  expect(onSelect).toHaveBeenCalledWith("Reviewer");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

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

describe("SRV-14 credentials owner label", () => {
  afterEach(() => useAppStore.setState({ me: null, session: null }));
  const chip = (
    <ModelChip
      state={{ provider: "mock", modelId: "a", thinkingLevel: "off" }}
      models={[{ provider: "mock", id: "b" }]}
      onSelect={vi.fn()}
    />
  );

  it("names the owner in the chip and the menu when the viewer is not the owner", () => {
    useAppStore.setState({
      me: { id: "ale@example.com", email: "ale@example.com" },
      session: { createdBy: { id: "andrea@example.com", name: "Andrea" } } as never,
    });
    render(chip);
    expect(screen.getByTestId("model-chip-owner").textContent).toBe("runs on Andrea's credentials");
    fireEvent.click(screen.getByTestId("model-chip"));
    expect(screen.getByTestId("model-menu").textContent).toContain("runs on Andrea's credentials");
  });

  it("stays hidden for own sessions and on loopback", () => {
    useAppStore.setState({
      me: { id: "ale@example.com", email: "ale@example.com" },
      session: { createdBy: { id: "ale@example.com" } } as never,
    });
    const view = render(chip);
    expect(screen.queryByTestId("model-chip-owner")).toBeNull();
    useAppStore.setState({
      me: null,
      session: { createdBy: { id: "andrea@example.com" } } as never,
    });
    view.rerender(chip);
    expect(screen.queryByTestId("model-chip-owner")).toBeNull();
  });
});

describe("PRV-01 one Claude entry per model", () => {
  const open = (models: { provider: string; id: string }[]) => {
    render(<ModelChip state={null} models={models} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByTestId("model-chip"));
    return screen.getByTestId("model-group-claude");
  };
  const options = (group: HTMLElement) =>
    [...group.querySelectorAll("button")].map((button) => button.textContent);

  it("shows bridge models as plain Claude, without bridge wording", () => {
    const group = open([
      { provider: "claude-bridge", id: "claude-opus-4-5" },
      { provider: "claude-bridge", id: "claude-sonnet-4-5" },
    ]);
    expect(group.textContent).not.toMatch(/bridge/i);
    expect(group.firstElementChild?.textContent).toBe("Claude");
    expect(options(group)).toEqual(["claude-opus-4-5", "claude-sonnet-4-5"]);
    expect(screen.queryByTestId("model-group-claude-bridge")).toBeNull();
  });

  it("labels API-key anthropic models as API under the same group", () => {
    const group = open([{ provider: "anthropic", id: "claude-opus-4-5" }]);
    expect(options(group)).toEqual(["claude-opus-4-5 · API"]);
    expect(screen.queryByTestId("model-group-anthropic")).toBeNull();
  });

  it("lists both transports per model, the API one after its bridge twin", () => {
    const group = open([
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "anthropic", id: "claude-haiku-api-only" },
      { provider: "claude-bridge", id: "claude-opus-4-5" },
      { provider: "claude-bridge", id: "claude-sonnet-4-5" },
    ]);
    expect(options(group)).toEqual([
      "claude-opus-4-5",
      "claude-opus-4-5 · API",
      "claude-sonnet-4-5",
      "claude-haiku-api-only · API",
    ]);
  });

  it("badges the chip API only when the model is API-key backed", () => {
    const state = { provider: "anthropic", modelId: "claude-opus-4-5", thinkingLevel: "off" };
    const view = render(
      <ModelChip
        state={state}
        models={[{ provider: "anthropic", id: "claude-opus-4-5" }]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("model-chip-label").textContent).toBe("claude-opus-4-5");
    expect(screen.getByTestId("model-chip-api").textContent).toBe("API");
    // An existing session still on the OAuth sign-in: the server lists no anthropic.
    view.rerender(
      <ModelChip
        state={state}
        models={[{ provider: "claude-bridge", id: "claude-opus-4-5" }]}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("model-chip-api")).toBeNull();
  });
});
