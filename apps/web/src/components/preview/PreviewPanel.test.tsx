// @vitest-environment jsdom

import type { ProjectServerCommand } from "@agent-deck/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewBrowser, refreshedCommandSelection, ScriptsRunner } from "./PreviewPanel.tsx";

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

describe("PreviewBrowser embed (PRE-01, frame-blocking)", () => {
  const renderBrowser = (url: string) =>
    render(
      <PreviewBrowser
        url={url}
        onNavigate={() => {}}
        onBack={() => {}}
        onCaptureElement={() => true}
      />,
    );

  afterEach(() => {
    delete (window as { agentDeck?: unknown }).agentDeck;
  });

  it("embeds via a sandboxed iframe in the plain web build", () => {
    renderBrowser("http://localhost:5173/");
    expect(screen.getByTestId("preview-iframe")).toBeTruthy();
    expect(screen.queryByTestId("preview-webview")).toBeNull();
  });

  it("embeds via a real <webview> guest in the Electron shell, immune to X-Frame-Options", () => {
    (window as { agentDeck?: unknown }).agentDeck = { isElectron: true };
    renderBrowser("http://localhost:5173/");
    const webview = screen.getByTestId("preview-webview");
    expect(webview.getAttribute("src")).toBe("http://localhost:5173/");
    expect(webview.getAttribute("partition")).toBe("persist:agentdeck-preview");
    // No popups: window.open inside the preview stays dropped, like the iframe.
    expect(webview.hasAttribute("allowpopups")).toBe(false);
    expect(screen.queryByTestId("preview-iframe")).toBeNull();
  });

  it("clears the loading overlay when the webview guest stops loading", () => {
    (window as { agentDeck?: unknown }).agentDeck = { isElectron: true };
    renderBrowser("http://localhost:5173/");
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    fireEvent(screen.getByTestId("preview-webview"), new Event("did-stop-loading"));
    expect(screen.queryByTestId("preview-loading")).toBeNull();
  });

  it("reload remounts the guest, and the old guest's late event can't clear the new overlay", () => {
    (window as { agentDeck?: unknown }).agentDeck = { isElectron: true };
    renderBrowser("http://localhost:5173/");
    const first = screen.getByTestId("preview-webview");
    fireEvent(first, new Event("did-stop-loading"));
    expect(screen.queryByTestId("preview-loading")).toBeNull();

    fireEvent.click(screen.getByTestId("preview-reload"));
    const second = screen.getByTestId("preview-webview");
    expect(second).not.toBe(first); // key remount: a fresh guest element
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    // The DETACHED first guest firing late must not clear the new load's overlay.
    fireEvent(first, new Event("did-stop-loading"));
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    fireEvent(second, new Event("did-stop-loading"));
    expect(screen.queryByTestId("preview-loading")).toBeNull();
  });

  it("never mounts a webview for a non-loopback URL, even in the Electron shell", () => {
    (window as { agentDeck?: unknown }).agentDeck = { isElectron: true };
    renderBrowser("http://evil.example.com:5173/");
    expect(screen.getByTestId("preview-blocked")).toBeTruthy();
    expect(screen.queryByTestId("preview-webview")).toBeNull();
    expect(screen.queryByTestId("preview-iframe")).toBeNull();
  });
});
