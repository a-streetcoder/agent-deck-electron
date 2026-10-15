// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LoopGraphView } from "./LoopGraphView.tsx";

afterEach(cleanup);

const nodes = () =>
  screen.getAllByTestId("loop-graph-node").map((node) => [node.dataset.node, node.dataset.status]);

it("draws a definition's builtin template as depth columns with its cycle budget", () => {
  render(
    <LoopGraphView
      loop={{
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        maxIterations: 3,
      }}
    />,
  );
  const steps = screen.getAllByRole("list");
  expect(steps.map((step) => step.getAttribute("aria-label"))).toEqual([
    "Step 1",
    "Step 2",
    "Step 3",
  ]);
  expect(within(steps[0]!).getByText("· Maker")).toBeTruthy();
  // A definition has no run: no statuses.
  expect(nodes()).toEqual([
    ["maker", undefined],
    ["checker", undefined],
    ["evaluator", undefined],
  ]);
  expect(screen.getByTestId("loop-graph-repeat").textContent).toBe(
    "↻ Next iteration on Checker FAIL or Goal evaluator CONTINUE · up to 3",
  );
});

it("shows a run's per-node status from the latest iteration's children", () => {
  render(
    <LoopGraphView
      loop={{
        structure: "agentPipeline",
        maxIterations: 0,
        graph: {
          nodes: [
            { id: "plan", kind: "stage", agentName: "Planner" },
            { id: "build", kind: "stage", agentName: "Builder" },
            { id: "review", kind: "checker", agentName: "Reviewer" },
            { id: "judge", kind: "evaluator" },
          ],
          edges: [
            { from: "plan", to: "build" },
            { from: "build", to: "review" },
            { from: "review", to: "judge" },
            { from: "judge", to: "plan", when: "CONTINUE", budgeted: true },
          ],
        },
      }}
      runChildren={[
        { id: "1", phase: "stage", stageIndex: 0, status: "completed" },
        { id: "2", phase: "stage", stageIndex: 1, status: "failed" },
        // A legacy record without a status: running once started.
        { id: "3", phase: "checker", startedAt: "2026-10-15T00:00:00Z" },
      ]}
    />,
  );
  expect(nodes()).toEqual([
    ["plan", "done"],
    ["build", "error"],
    ["review", "running"],
    ["judge", "pending"],
  ]);
  expect(screen.getByText("Stage 2")).toBeTruthy();
  expect(screen.getByTestId("loop-graph-repeat").textContent).toContain("no iteration limit");
});

it("says why an invalid graph cannot be drawn", () => {
  render(
    <LoopGraphView
      loop={{
        structure: "singleAgent",
        maxIterations: 1,
        graph: { nodes: [{ id: "m", kind: "maker" }], edges: [] },
      }}
    />,
  );
  expect(screen.getByTestId("loop-graph-error").textContent).toBe(
    "Graph unavailable: A loop graph needs exactly one evaluator.",
  );
});
