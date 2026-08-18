// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { DoctorScreen } from "./RuntimeScreens.tsx";

/**
 * DOC-05: native's Doctor page carries a Warnings card so a configuration
 * problem is discoverable without opening the resource that owns it. This port
 * computed the same verdicts but only ever rendered them on the owning agent.
 */

const doctorResponse = (warnings: Array<{ id: string; message: string }>): Response =>
  new Response(
    JSON.stringify({
      report: {
        checks: [{ id: "pi-version", label: "Pi", status: "ok", detail: "0.82.0" }],
      },
      warnings,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

beforeEach(() => {
  useAppStore.setState({ currentProjectId: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Doctor configuration warnings (DOC-05)", () => {
  it("lists every aggregated warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        doctorResponse([
          { id: "agent:alpha:skill-missing", message: "Agent alpha: References missing skill x." },
          { id: "duplicate-prompt:review", message: "Duplicate prompt template /review exists." },
        ]),
      ),
    );
    render(<DoctorScreen />);

    await waitFor(() => expect(screen.getByTestId("doctor-warnings")).toBeTruthy());
    const rendered = screen.getAllByTestId("doctor-warning").map((node) => node.textContent);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain("Agent alpha");
    expect(rendered[1]).toContain("Duplicate prompt template /review");
  });

  it("shows no warnings section when the configuration is clean", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(doctorResponse([])));
    render(<DoctorScreen />);

    await waitFor(() => expect(screen.getByTestId("doctor-check")).toBeTruthy());
    // Native hides the card entirely rather than showing an empty one.
    expect(screen.queryByTestId("doctor-warnings")).toBeNull();
  });

  it("still renders checks when the server omits warnings entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ report: { checks: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    render(<DoctorScreen />);

    // An older server, or one that failed to scan, must not break the page.
    await waitFor(() => expect(screen.getByTestId("doctor-screen")).toBeTruthy());
    expect(screen.queryByTestId("doctor-error")).toBeNull();
    expect(screen.queryByTestId("doctor-warnings")).toBeNull();
  });
});
