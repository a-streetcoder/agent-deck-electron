import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderLoginManager } from "../src/providerLogin.ts";

function roots() {
  return { home: mkdtempSync(path.join(tmpdir(), "login-home-")) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("provider login relay", () => {
  it("relays events, parks on a prompt, and completes on the response", async () => {
    let seenAnswer: string | undefined;
    const manager = new ProviderLoginManager(async (_path, _provider, _type, interaction) => {
      interaction.notify({ type: "progress", message: "Contacting provider…" });
      interaction.notify({
        type: "device_code",
        userCode: "WXYZ-1234",
        verificationUri: "https://example.test/device",
      });
      seenAnswer = await interaction.prompt({ type: "text", message: "Paste the code" });
      if (seenAnswer !== "hunter2") throw new Error("wrong code");
    });

    const id = manager.start(roots(), "anthropic", "oauth");
    let poll = manager.poll(id, 0)!;
    expect(poll.events.map((event) => event.type)).toEqual(["progress", "device_code", "prompt"]);
    expect(manager.respond(id, "hunter2")).toBe(true);
    await tick();
    poll = manager.poll(id, poll.nextCursor)!;
    expect(seenAnswer).toBe("hunter2");
    expect(poll.events.at(-1)).toEqual({ type: "done", ok: true });
  });

  it("surfaces a failed login", async () => {
    const manager = new ProviderLoginManager(async (_path, _provider, _type, interaction) => {
      await interaction.prompt({ type: "secret", message: "API key?" });
      throw new Error("invalid key");
    });
    const id = manager.start(roots(), "anthropic", "api_key");
    manager.respond(id, "nope");
    await tick();
    expect(manager.poll(id, 0)!.events.at(-1)).toEqual({
      type: "done",
      ok: false,
      error: "invalid key",
    });
  });

  it("relays a select and returns its option id", async () => {
    let chosen: string | undefined;
    const manager = new ProviderLoginManager(async (_path, _provider, _type, interaction) => {
      chosen = await interaction.prompt({
        type: "select",
        message: "Which account?",
        options: [
          { id: "team", label: "Team" },
          { id: "personal", label: "Personal" },
        ],
      });
    });
    const id = manager.start(roots(), "github-copilot", "oauth");
    expect(manager.poll(id, 0)!.events[0]).toMatchObject({ type: "select" });
    manager.respond(id, "personal");
    await tick();
    expect(chosen).toBe("personal");
  });

  it("honors per-prompt cancellation when an OAuth callback wins the race", async () => {
    const manager = new ProviderLoginManager(async (_path, _provider, _type, interaction) => {
      const controller = new AbortController();
      const manualEntry = interaction.prompt({
        type: "manual_code",
        message: "Paste a redirect URL",
        signal: controller.signal,
      });
      controller.abort();
      await expect(manualEntry).rejects.toThrow("cancelled");
      // The provider continues with the callback result after cancelling manual entry.
    });
    const id = manager.start(roots(), "openai-codex", "oauth");
    await tick();
    expect(manager.poll(id, 0)!.status).toBe("done");
  });

  it("forwards the Pi 1.x copy-code login steps (Anthropic headless) to the sheet", async () => {
    let pasted: string | undefined;
    // Same calls as pi-ai 1.2 anthropicOAuth.login choosing "Copy code login (headless)".
    const manager = new ProviderLoginManager(async (_path, _provider, _type, interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Select Anthropic login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "copy-code", label: "Copy code login (headless)", description: "No callback" },
        ],
      });
      if (method !== "copy-code") throw new Error(`unexpected ${method}`);
      interaction.notify({
        type: "auth_url",
        url: "https://claude.test/oauth/authorize?code=true",
        instructions: "Copy the code Anthropic shows and paste it here.",
      });
      interaction.notify({
        type: "info",
        message: "See the setup guide",
        links: [{ url: "https://docs.test/setup", label: "Setup" }],
      });
      pasted = await interaction.prompt({
        type: "manual_code",
        message: "Paste the code Anthropic shows after you sign in:",
        placeholder: "code#state",
        signal: interaction.signal,
      });
    });

    const id = manager.start(roots(), "anthropic", "oauth");
    expect(manager.poll(id, 0)!.events).toEqual([
      {
        type: "select",
        message: "Select Anthropic login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "copy-code", label: "Copy code login (headless)", description: "No callback" },
        ],
      },
    ]);
    expect(manager.respond(id, "copy-code")).toBe(true);
    await tick();
    expect(manager.poll(id, 1)!.events).toEqual([
      {
        type: "auth_url",
        url: "https://claude.test/oauth/authorize?code=true",
        instructions: "Copy the code Anthropic shows and paste it here.",
      },
      {
        type: "progress",
        message: "See the setup guide",
        links: [{ url: "https://docs.test/setup", label: "Setup" }],
      },
      {
        type: "prompt",
        message: "Paste the code Anthropic shows after you sign in:",
        placeholder: "code#state",
        secret: false,
        manualCode: true,
      },
    ]);
    expect(manager.respond(id, "abc#state")).toBe(true);
    await tick();
    expect(pasted).toBe("abc#state");
    expect(manager.poll(id, 0)!.status).toBe("done");
  });

  it("ignores responses when nothing is pending", () => {
    const manager = new ProviderLoginManager(async () => {});
    expect(manager.poll("nope", 0)).toBeUndefined();
    const id = manager.start(roots(), "anthropic", "oauth");
    expect(manager.respond(id, "x")).toBe(false);
  });
});
