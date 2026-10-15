import { describe, expect, it } from "vitest";
import { redactPaths, redactSecrets } from "../src/events.ts";

const prefixes = [
  { path: "C:\\Users\\Alice\\AppData\\Roaming\\Agent Deck", placeholder: "<dataDir>" },
  { path: "C:\\Users\\Alice", placeholder: "<home>" },
  { path: "/home/bob/work/acme/", placeholder: "<project>" },
];

describe("redactPaths", () => {
  it("replaces known roots longest first, either separator, any case", () => {
    expect(
      redactPaths("see c:/users/alice/AppData/Roaming/Agent Deck/events/x.jsonl", prefixes),
    ).toBe("see <dataDir>/events/x.jsonl");
    expect(redactPaths("open C:\\Users\\Alice\\notes.txt now", prefixes)).toBe(
      "open <home>\\notes.txt now",
    );
    expect(redactPaths("cd /home/bob/work/acme/src", prefixes)).toBe("cd <project>/src");
    // A root only matches at a path boundary.
    expect(redactPaths("C:\\Users\\Alicia\\x", prefixes)).toBe("<path>");
  });

  it("replaces any other absolute path embedded mid-text", () => {
    expect(
      redactPaths(
        "a D:\\secret\\plan.md, b \\\\server\\share\\f, c /tmp/x.log, d ~/.ssh/id_rsa, e /Users/c/k",
        [],
      ),
    ).toBe("a <path>, b <path>, c <path>, d <path>, e <path>");
    expect(redactPaths("https://example.com/home/page and refs/agent-deck/x", [])).toBe(
      "https://example.com/home/page and refs/agent-deck/x",
    );
  });
});

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
    expect(
      redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"),
    ).toBe("<secret>");
  });
});
