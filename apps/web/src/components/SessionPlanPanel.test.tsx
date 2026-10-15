// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import { emptyTranscript, type SessionPlanItem } from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { SessionPlanPanel } from "./SessionPlanPanel.tsx";

afterEach(() => {
  cleanup();
  useAppStore.setState({
    transcript: emptyTranscript(),
    session: null,
    questionNavigationRequest: null,
  });
});

const showPlan = (plan: SessionPlanItem[]) =>
  useAppStore.setState({
    transcript: { ...emptyTranscript(), plan },
    session: { id: "s1", cwd: "/tmp", createdAt: "2026-10-15T00:00:00.000Z" } as SessionMeta,
  });

it("groups a dependency plan by step with agents, the verdict note and Show run", () => {
  showPlan([
    { id: "join", title: "Join", status: "todo", dependsOn: ["a", "b"], assignee: "coder" },
    { id: "a", title: "Build A", status: "done", assignee: "coder", runId: "run-a" },
    {
      id: "b",
      title: "Build B",
      status: "blocked",
      assignee: "coder",
      verifiedBy: "reviewer",
      runId: "run-b",
      note: "REJECT: tests missing",
    },
  ]);
  render(<SessionPlanPanel />);

  const steps = within(screen.getByTestId("plan-steps")).getAllByRole("region");
  expect(steps.map((step) => step.getAttribute("aria-label"))).toEqual(["Step 1", "Step 2"]);
  expect(
    steps.map((step) =>
      within(step)
        .getAllByTestId("plan-item")
        .map((row) => row.textContent),
    ),
  ).toEqual([
    [
      "●Build Aby coderShow run",
      "▲Build Bby coder · verified by reviewerREJECT: tests missingShow run",
    ],
    ["○Joinafter a, b · by coder"],
  ]);
  expect(screen.getByTestId("plan-progress").textContent).toBe("1/3");

  fireEvent.click(within(steps[0]!).getAllByRole("button", { name: "Show run" })[1]!);
  expect(useAppStore.getState().questionNavigationRequest).toMatchObject({
    sessionId: "s1",
    cellId: "run-b",
  });
});

it("keeps the checklist for a plan without dependencies, with agents and Show run", () => {
  showPlan([
    { id: "a", title: "One", status: "done" },
    { id: "b", title: "Two", status: "in_progress", assignee: "coder", runId: "run-2" },
  ]);
  render(<SessionPlanPanel />);
  expect(screen.queryByTestId("plan-steps")).toBeNull();
  expect(screen.getAllByTestId("plan-item").map((row) => row.textContent)).toEqual([
    "●One",
    "◐Twoby coderShow run",
  ]);
});
