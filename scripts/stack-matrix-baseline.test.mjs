// node --test scripts/stack-matrix-baseline.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineExempts, stepStatus } from "./stack-matrix-baseline.mjs";

const known = {
  stack: "java-gradle",
  step: "dev",
  signature: "TempFileHelper.createTempDirectory",
  ticket: "SBX-07 ade-c3aa",
};
const failed = (lines, extra = {}) => ({
  step: "dev",
  pass: false,
  code: 1,
  excerpt: lines,
  ...extra,
});

test("the known error is exempt (case-insensitive)", () => {
  const result = failed([
    "\tat java.base/java.nio.file.tempfilehelper.createTempDirectory(…)",
    "BUILD FAILED",
  ]);
  assert.equal(baselineExempts(known, result), true);
});

test("a different error on a baselined step fails the gate", () => {
  assert.equal(baselineExempts(known, failed(["Address already in use"])), false);
});

test("a timeout, a transport error or a budget skip fails even with the signature", () => {
  const lines = ["TempFileHelper.createTempDirectory"];
  assert.equal(baselineExempts(known, failed(lines, { code: 124 })), false);
  assert.equal(baselineExempts(known, failed(lines, { code: 137 })), false);
  assert.equal(baselineExempts(known, failed(lines, { code: 255, transport: true })), false);
  assert.equal(baselineExempts(known, failed(lines, { skipped: "global budget spent" })), false);
});

test("no entry, no signature or a pass exempts nothing", () => {
  const lines = ["TempFileHelper.createTempDirectory"];
  assert.equal(baselineExempts(undefined, failed(lines)), false);
  assert.equal(baselineExempts({ ...known, signature: "" }, failed(lines)), false);
  assert.equal(baselineExempts(known, { ...failed(lines), pass: true }), false);
});

test("a disconnect after the status marker is a transport failure, never exempt", () => {
  const output =
    "\tat java.base/java.nio.file.TempFileHelper.createTempDirectory(…)\n@@matrix rc=1 ms=6400\n";
  const result = stepStatus(255, output);
  assert.equal(result.transport, true);
  assert.equal(result.pass, false);
  assert.equal(result.code, 255);
  assert.equal(baselineExempts(known, result), false);
  // A local timeout after a passing marker fails too.
  assert.equal(stepStatus(124, "@@matrix rc=0 ms=10\n").pass, false);
  // The same marker over a clean ssh is the command's own status.
  assert.equal(baselineExempts(known, stepStatus(0, output)), true);
});

test("the signature survives Gradle's trailing diagnostics in the dev-server probe", () => {
  const output = [
    "[sandbox] provider srt",
    "Caused by: java.nio.file.FileSystemException: /tmp/tomcat.8080: Read-only file system",
    "\tat java.base/java.nio.file.TempFileHelper.createTempDirectory(TempFileHelper.java:171) ~[na:na]",
    ...Array.from({ length: 12 }, (_, index) => `\tat frame${index}(Spring.java:${index})`),
    "",
    "FAILURE: Build failed with an exception.",
    "",
    "* What went wrong:",
    "Execution failed for task ':bootRun'.",
    "> Process 'command '/data/home/.local/jdk/bin/java'' finished with non-zero exit value 1",
    "",
    "* Try:",
    "> Run with --stacktrace option to get the stack trace.",
    "> Run with --info or --debug option to get more log output.",
    "> Run with --scan to get full insights from a Build Scan (powered by Develocity).",
    "> Get more help at https://help.gradle.org.",
    "",
    "BUILD FAILED in 3s",
    "no answer below 500 on port 8080 (last: 000)",
    "@@matrix rc=1 ms=6400",
  ].join("\n");
  const result = stepStatus(0, output);
  assert.equal(result.pass, false);
  assert.equal(result.transport, false);
  assert.equal(baselineExempts(known, result), true);
});
