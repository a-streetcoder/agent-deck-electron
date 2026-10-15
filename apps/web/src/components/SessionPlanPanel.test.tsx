// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyTranscript, type SessionPlanItem } from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { SessionPlanPanel } from "./SessionPlanPanel.tsx";

afterEach(() => {
  cleanup();
  useAppStore.setState({ transcript: emptyTranscript() });
});

const showPlan = (plan: SessionPlanItem[]) =>
  useAppStore.setState({ transcript: { ...emptyTranscript(), plan } });

it("renders a dependency plan as topological lanes with assignee, verifier and run link", () => {
  showPlan([
    { id: "join", title: "Join", status: "todo", dependsOn: ["a", "b"], assignee: "coder" },
    { id: "a", title: "Build A", status: "done", assignee: "coder", runId: "run-a" },
    {
      id: "b",
      title: "Build B",
      status: "in_progress",
      assignee: "coder",
      verifiedBy: "reviewer",
      runId: "run-b",
    },
  ]);
  const card = document.createElement("div");
  card.setAttribute("data-cell-id", "run-b");
  card.scrollIntoView = vi.fn();
  document.body.append(card);
  render(<SessionPlanPanel />);

  const lanes = within(screen.getByTestId("plan-lanes")).getAllByRole("list");
  expect(
    lanes.map((lane) =>
      within(lane)
        .getAllByTestId("plan-node")
        .map((n) => n.textContent),
    ),
  ).toEqual([
    ["●Build Aby coderShow run", "◐Build Bby coder · verified by reviewerShow run"],
    ["○Joinafter a, b · by coder"],
  ]);
  expect(screen.queryAllByTestId("plan-item")).toHaveLength(0);
  expect(screen.getByTestId("plan-progress").textContent).toBe("1/3");

  fireEvent.click(within(lanes[0]!).getAllByRole("button", { name: "Show run" })[1]!);
  expect(card.scrollIntoView).toHaveBeenCalled();
  card.remove();
});

it("keeps the checklist for a plan without dependencies", () => {
  showPlan([
    { id: "a", title: "One", status: "done" },
    { id: "b", title: "Two", status: "todo", assignee: "coder" },
  ]);
  render(<SessionPlanPanel />);
  expect(screen.queryByTestId("plan-lanes")).toBeNull();
  expect(screen.getAllByTestId("plan-item").map((row) => row.textContent)).toEqual([
    "●One",
    "○Two",
  ]);
});
