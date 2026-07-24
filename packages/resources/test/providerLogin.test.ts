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

  it("ignores responses when nothing is pending", () => {
    const manager = new ProviderLoginManager(async () => {});
    expect(manager.poll("nope", 0)).toBeUndefined();
    const id = manager.start(roots(), "anthropic", "oauth");
    expect(manager.respond(id, "x")).toBe(false);
  });
});
