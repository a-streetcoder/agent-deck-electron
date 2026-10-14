import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GIT_IDENTITIES_FILE,
  GitIdentityMap,
  coAuthorTrailers,
  gitIdentityEnv,
} from "../src/gitIdentity.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deck-git-identities-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeMap = (value: unknown) =>
  writeFileSync(path.join(dir, GIT_IDENTITIES_FILE), JSON.stringify(value));

describe("gitIdentityEnv", () => {
  it("uses the mapped name and noreply email for the owner, case-insensitively", () => {
    writeMap({ "Ale@Example.com": { name: "Ale M", email: "1+ale@users.noreply.github.com" } });
    expect(gitIdentityEnv({ id: "ale@example.com" }, new GitIdentityMap(dir))).toEqual({
      GIT_AUTHOR_NAME: "Ale M",
      GIT_AUTHOR_EMAIL: "1+ale@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Ale M",
      GIT_COMMITTER_EMAIL: "1+ale@users.noreply.github.com",
    });
  });

  it("falls back to the identity name, else the email local part, and the Access email", () => {
    const map = new GitIdentityMap(dir); // no file
    expect(gitIdentityEnv({ id: "bo@example.com", name: "Bo" }, map)).toMatchObject({
      GIT_AUTHOR_NAME: "Bo",
      GIT_AUTHOR_EMAIL: "bo@example.com",
    });
    expect(gitIdentityEnv({ id: "bo@example.com" }, map).GIT_COMMITTER_NAME).toBe("bo");
  });

  it("ignores a malformed file and invalid entries instead of failing the launch", () => {
    writeFileSync(path.join(dir, GIT_IDENTITIES_FILE), "{not json");
    expect(gitIdentityEnv({ id: "bo@example.com" }, new GitIdentityMap(dir)).GIT_AUTHOR_EMAIL).toBe(
      "bo@example.com",
    );
    writeMap({ "bo@example.com": { name: "Bo" } });
    expect(gitIdentityEnv({ id: "bo@example.com" }, new GitIdentityMap(dir)).GIT_AUTHOR_EMAIL).toBe(
      "bo@example.com",
    );
  });

  it("changes nothing without an owner or without a mapping store", () => {
    expect(gitIdentityEnv(undefined, new GitIdentityMap(dir))).toEqual({});
    expect(gitIdentityEnv({ id: "bo@example.com" }, undefined)).toEqual({});
  });

  it("strips newlines and angle brackets so a name cannot forge trailer lines", () => {
    const env = gitIdentityEnv(
      { id: "x@example.com", name: "Eve\nCo-authored-by: Mallory <m@x>" },
      new GitIdentityMap(dir),
    );
    expect(env.GIT_AUTHOR_NAME).toBe("Eve Co-authored-by: Mallory m@x");
  });
});

describe("coAuthorTrailers", () => {
  it("credits each other author once through the mapping, never the owner", () => {
    writeMap({ "g@example.com": { name: "Guest", email: "2+g@users.noreply.github.com" } });
    const map = new GitIdentityMap(dir);
    const owner = { id: "o@example.com" };
    expect(
      coAuthorTrailers(owner, [owner, { id: "g@example.com" }, { id: "G@example.com" }], map),
    ).toEqual(["Co-authored-by: Guest <2+g@users.noreply.github.com>"]);
    expect(coAuthorTrailers(undefined, [{ id: "g@example.com" }], map)).toEqual([]);
  });
});
