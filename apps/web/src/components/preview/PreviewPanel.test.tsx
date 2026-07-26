// @vitest-environment jsdom

import type { ProjectServerCommand } from "@agent-deck/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshedCommandSelection, ScriptsRunner } from "./PreviewPanel.tsx";

const command = (
  id: string,
  label: string,
  source: ProjectServerCommand["source"] = "package",
): ProjectServerCommand => ({ id, label, source, command: label, defaultPort: null });

const renderRunner = (
  scriptsState: "idle" | "loading" | "success" | "error",
  scripts: readonly ProjectServerCommand[] = [],
) => {
  const onRefresh = vi.fn();
  render(
    <ScriptsRunner
      scripts={scripts}
      scriptsState={scriptsState}
      selected={scripts[0]?.id ?? null}
      onSelect={() => {}}
      running={false}
      log=""
      server={null}
      startError={null}
      logEndRef={createRef<HTMLDivElement>()}
      onRun={() => {}}
      onStop={() => {}}
      onRefresh={onRefresh}
      onOpenServer={() => {}}
    />,
  );
  return onRefresh;
};

afterEach(cleanup);

describe("refreshedCommandSelection", () => {
  it("retains a current id only while the refreshed candidates still contain it", () => {
    const candidates = [command("package:ZGV2", "dev"), command("cargo:run", "Cargo", "cargo")];
    expect(refreshedCommandSelection("cargo:run", candidates)).toBe("cargo:run");
  });

  it("replaces a stale id with the refreshed preferred candidate", () => {
    const candidates = [command("cargo:run", "Cargo", "cargo"), command("package:ZGV2", "dev")];
    expect(refreshedCommandSelection("package:b2xk", candidates)).toBe("package:ZGV2");
    expect(refreshedCommandSelection("package:b2xk", [])).toBeNull();
  });
});

describe("ScriptsRunner candidate states", () => {
  it("announces loading without claiming the command list is empty", () => {
    renderRunner("loading");
    expect(screen.getByRole("status").textContent).toContain("Detecting server commands");
    expect(screen.queryByText("No server command detected")).toBeNull();
    expect((screen.getByLabelText("Detected server command") as HTMLSelectElement).disabled).toBe(
      true,
    );
  });

  it("surfaces a failed list as an alert with a working Retry action", () => {
    const retry = renderRunner("error");
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn’t load detected server commands",
    );
    expect(screen.queryByText("No server command detected")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
