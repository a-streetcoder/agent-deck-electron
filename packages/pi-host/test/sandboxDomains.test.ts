import { isSandboxDomain } from "@agent-deck/contracts";
import { DEFAULT_SANDBOX_DOMAINS } from "@agent-deck/domain";
import { isValidAllowedDomainEntry } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { describe, expect, it } from "vitest";

// `.agent-deck/sandbox.json` entries end up in srt's per-command list, which
// srt validates with isValidAllowedDomainEntry (a refused entry fails the
// wrap). Our parser must never accept what srt refuses.
const AGREED = [
  "intranet",
  "example.com",
  "EXAMPLE.com",
  "example.com:443",
  "example.com:0443",
  "example.com:00080",
  "example.com:0",
  "example.com:65535",
  "example.com:65536",
  "*.co.uk",
  "*.example.com:8443",
  "*.com",
  "*",
  "xn--bcher-kva.example",
  "a.b.c:443",
  "https://example.com",
  "example.com/path",
  "a.*.example",
  ".example.com",
  "example.com.",
];
// Stricter than srt on purpose: no IP literals, no localhost.
const STRICTER = [
  "10.0.0.1",
  "127.0.0.1:8080",
  "[::1]",
  "localhost",
  "app.localhost",
  "*.dev.localhost",
];

describe("allow-list entries: our parser and srt 0.0.80", () => {
  it.each(AGREED)("agree on %s", (entry) => {
    expect(isSandboxDomain(entry)).toBe(isValidAllowedDomainEntry(entry));
  });

  it.each(STRICTER.filter((entry) => isValidAllowedDomainEntry(entry)))(
    "refuse %s, which srt would accept",
    (entry) => {
      expect(isSandboxDomain(entry)).toBe(false);
    },
  );

  // srt refuses a whole initialize over one bad default, so every session would fail.
  it.each([...DEFAULT_SANDBOX_DOMAINS])("accept the default host %s", (entry) => {
    expect(isSandboxDomain(entry)).toBe(true);
    expect(isValidAllowedDomainEntry(entry)).toBe(true);
  });

  it("the default list has no repeats", () => {
    const lower = DEFAULT_SANDBOX_DOMAINS.map((entry) => entry.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});
