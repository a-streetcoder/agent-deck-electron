import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/events.ts";

describe("redactSecrets", () => {
  it("replaces token-like strings and keeps the surrounding text", () => {
    expect(
      redactSecrets(
        "key sk-proj-abcdefghijklmnop1234 gh ghp_abcdefghijklmnopqrstuvwxyz12 auth: Bearer abcdefghijklmnopqrstu",
      ),
    ).toBe("key <secret> gh <secret> auth: Bearer <secret>");
    expect(redactSecrets('password="hunter2-long" api_key=AbCdEf123456 token: xyz')).toBe(
      'password="<secret>" api_key=<secret> token: xyz',
    );
    // SRV-06: every GitHub token prefix (OAuth device flow gho_, app user ghu_, ...).
    expect(
      redactSecrets(
        "gho_abcdefghijklmnopqrstuvwxyz12 ghu_abcdefghijklmnopqrstuvwxyz12 ghs_abcdefghijklmnopqrstuvwxyz12 ghr_abcdefghijklmnopqrstuvwxyz12 github_pat_11ABCDEFG0123456789abcdef",
      ),
    ).toBe("<secret> <secret> <secret> <secret> <secret>");
    expect(
      redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"),
    ).toBe("<secret>");
  });
});
