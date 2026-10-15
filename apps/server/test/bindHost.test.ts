import { describe, expect, it } from "vitest";
import { resolveBindHost } from "../src/bindHost.ts";

describe("resolveBindHost", () => {
  it("defaults to loopback and normalizes every loopback value to IPv4 127.0.0.1", () => {
    expect(resolveBindHost({})).toEqual({ host: undefined, warnings: [] });
    // The Pi bridge and the HEALTHCHECK call 127.0.0.1; ::1/localhost may bind IPv6 only.
    for (const value of [" 127.0.0.1 ", "::1", "localhost"]) {
      expect(resolveBindHost({ AGENT_DECK_HOST: value }).host).toBe("127.0.0.1");
    }
  });

  it("refuses a wildcard without the trusted proxy or the opt-out", () => {
    expect(() => resolveBindHost({ AGENT_DECK_HOST: "0.0.0.0" })).toThrow(/unauthenticated/);
    expect(() =>
      resolveBindHost({ AGENT_DECK_HOST: "::", AGENT_DECK_TRUSTED_PROXY: "Cloudflare" }),
    ).toThrow(/unauthenticated/);
    expect(() =>
      resolveBindHost({
        AGENT_DECK_HOST: "0.0.0.0",
        AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST: "true",
      }),
    ).toThrow(/unauthenticated/);
  });

  it("allows a wildcard behind the trusted proxy or with the explicit opt-out", () => {
    expect(
      resolveBindHost({ AGENT_DECK_HOST: "0.0.0.0", AGENT_DECK_TRUSTED_PROXY: "cloudflare" }).host,
    ).toBe("0.0.0.0");
    expect(
      resolveBindHost({ AGENT_DECK_HOST: "::", AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST: "1" }).host,
    ).toBe("::");
  });

  it("refuses a specific non-loopback address even behind the proxy", () => {
    expect(() =>
      resolveBindHost({ AGENT_DECK_HOST: "10.0.0.5", AGENT_DECK_TRUSTED_PROXY: "cloudflare" }),
    ).toThrow(/not supported/);
  });

  it("warns when the trusted proxy value is set but is not exactly cloudflare", () => {
    expect(resolveBindHost({ AGENT_DECK_TRUSTED_PROXY: "cloudfare" }).warnings).toEqual([
      expect.stringContaining("trusted-proxy mode is OFF"),
    ]);
    expect(resolveBindHost({ AGENT_DECK_TRUSTED_PROXY: "cloudflare" }).warnings).toEqual([]);
  });
});
