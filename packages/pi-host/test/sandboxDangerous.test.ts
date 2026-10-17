import { SRT_DANGEROUS_DIRECTORIES, SRT_DANGEROUS_FILES } from "@agent-deck/domain";
import {
  DANGEROUS_FILES,
  getDangerousDirectories,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import { describe, expect, it } from "vitest";

// The domain's violation filter mirrors srt's own write denies inside the
// working folder (sandboxAllowsWrite). An srt upgrade that changes them must
// change the copy too, or real refusals are hidden from the transcript.
describe("srt's dangerous files and directories (pinned copy)", () => {
  it("the domain copy is srt's list", () => {
    expect([...SRT_DANGEROUS_FILES]).toEqual([...DANGEROUS_FILES]);
    expect([...SRT_DANGEROUS_DIRECTORIES]).toEqual(getDangerousDirectories());
  });
});
