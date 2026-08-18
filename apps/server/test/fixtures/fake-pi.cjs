/* global setTimeout, setInterval, clearInterval, __filename */
// A scripted stand-in for `pi --mode rpc`, driven over stdin/stdout JSONL, so
// the PiHost Effect service (src/services/piHost.ts) can be tested hermetically:
// out-of-order correlation, exit-with-pending, abort mid-turn, malformed lines.
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let streamTimer = null;
let streamed = 0;

rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  switch (cmd.type) {
    case "get_state":
      send({
        id: cmd.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "fake-session",
          sessionFile: __filename,
          isStreaming: false,
          thinkingLevel: "off",
        },
      });
      break;
    case "get_session_stats":
      // Delayed reply — lands AFTER any get_state issued later (out-of-order).
      setTimeout(() => {
        send({
          id: cmd.id,
          type: "response",
          command: "get_session_stats",
          success: true,
          data: { tokens: 123 },
        });
      }, 150);
      break;
    case "set_session_name":
      if (cmd.name === "fail") {
        send({
          id: cmd.id,
          type: "response",
          command: "set_session_name",
          success: false,
          error: "boom",
        });
      } else if (cmd.name === "exit") {
        // Exit WITHOUT responding — pending RPCs must fail, never hang.
        process.exit(3);
      } else if (cmd.name === "burst-exit") {
        // A final burst of events followed by immediate death: the write
        // callback only guarantees the OS pipe RECEIVED the bytes, so the
        // reader can still observe the process exit while lines sit
        // undelivered in the pipe — the drain-gated exit must deliver them
        // all before the terminating ProcessExit.
        let payload = "";
        for (let i = 0; i < 200; i++) {
          payload += `${JSON.stringify({ type: "burst", n: i })}\n`;
        }
        process.stdout.write(payload, () => process.exit(7));
      } else if (cmd.name === "ignore-sigterm") {
        // Refuse the graceful shutdown signal so PiProcess.stop() must
        // escalate to SIGKILL after its grace period. POSIX-only semantics:
        // on Windows there is no graceful path to refuse (taskkill /F is an
        // unconditional TerminateProcess), so the handler is a harmless no-op.
        process.on("SIGTERM", () => {});
        send({ id: cmd.id, type: "response", command: "set_session_name", success: true });
      } else if (cmd.name === "spawn-stubborn-child") {
        // Kill-escalation + tree-kill combined: this process AND a spawned
        // grandchild both ignore SIGTERM, so only the escalated kill (POSIX:
        // SIGKILL to the process group; Windows: taskkill /T /F) reaps them.
        process.on("SIGTERM", () => {});
        const { spawn } = require("node:child_process");
        const stubborn = spawn(
          process.execPath,
          ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
          { stdio: "ignore" },
        );
        send({ type: "child_pid", pid: stubborn.pid });
        send({ id: cmd.id, type: "response", command: "set_session_name", success: true });
      } else if (cmd.name === "spawn-child") {
        // Spawn a long-lived grandchild (a stand-in for pi's stdio MCP
        // servers / subagents) and report its pid as an event — the tree
        // kill on scope close must reap it too.
        const { spawn } = require("node:child_process");
        const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        send({ type: "child_pid", pid: grandchild.pid });
        send({ id: cmd.id, type: "response", command: "set_session_name", success: true });
      } else {
        send({ id: cmd.id, type: "response", command: "set_session_name", success: true });
      }
      break;
    case "compact":
      // Never respond — exercises the timeout path.
      break;
    case "get_entries":
      // Canonical entry history for SessionManager seed tests: one stable user
      // entry so rebuilt transcripts use Pi's durable identity.
      send({
        id: cmd.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: {
          leafId: "entry-user-1",
          entries: [
            {
              type: "message",
              id: "entry-user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "hello world", timestamp: 1 },
            },
          ],
        },
      });
      break;
    case "get_messages":
      send({
        id: cmd.id,
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "hello world" }] },
      });
      break;
    case "prompt":
      if (cmd.message === "timeout-prompt") break;
      if (cmd.message === "reject-prompt") {
        send({
          id: cmd.id,
          type: "response",
          command: "prompt",
          success: false,
          error: "provider token=super-secret rejected prompt",
        });
        break;
      }
      if (cmd.message === "error-before-ack") {
        // The provider error lands BEFORE the prompt acknowledgement. Real pi can
        // interleave this way on a loaded machine, and it is what CI kept hitting:
        // the session's own accept handler must not wipe a failure that already
        // arrived for this turn.
        send({ type: "turn_start" });
        send({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Provider failed before the ack",
              content: [],
            },
          ],
        });
        send({ id: cmd.id, type: "response", command: "prompt", success: true });
        break;
      }
      send({ id: cmd.id, type: "response", command: "prompt", success: true });
      send({ type: "turn_start" });
      // FAKE_PI_HANG makes EVERY prompt stream forever (never agent_end) — used
      // to stand in for a still-running helper pi (e.g. an in-flight title
      // helper) so tests can assert scope close reaps it.
      if (cmd.message === "exit-before-end") {
        process.exit(3);
      } else if (cmd.message === "provider-error-then-exit") {
        rl.close();
        process.stdin.destroy();
        // End stdout and assign the nonzero exit only from its completion
        // callback. Setting exitCode before the asynchronous pipe write settles
        // lets an otherwise-idle Node process terminate with bytes still queued
        // under suite load, which models an event never produced rather than the
        // intended produced-event-vs-exit scheduling race.
        process.stdout.end(
          `${JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Provider failed: Bearer secret-token-value",
              content: [],
            },
          })}\n`,
          () => {
            process.exitCode = 9;
          },
        );
      } else if (cmd.message === "passive-status") {
        // pi's context-usage meter: an extension_ui_request nothing can answer,
        // emitted mid-turn. The session must stay ALIVE after idle — that is the
        // real-world shape (a live session sitting idle with the meter having
        // ticked), and exit handling would otherwise tear the pending-UI state
        // down before a test could observe it.
        send({
          type: "extension_ui_request",
          id: "status-1",
          method: "setStatus",
          statusKey: "context-progress",
          statusText: "ctx 7/100k",
        });
        send({ type: "agent_end", messages: [] });
        streamTimer = setInterval(() => {}, 1000);
      } else if (cmd.message === "fallback-error") {
        send({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Fallback provider failure",
              content: [],
            },
          ],
        });
      } else if (cmd.message === "stream-with-metadata-forever") {
        send({
          type: "message_end",
          message: {
            role: "assistant",
            model: "fake-child-model",
            usage: { input: 7, output: 3 },
          },
        });
        streamTimer = setInterval(() => {
          streamed += 1;
          send({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: `chunk-${streamed} ` },
          });
        }, 15);
      } else if (cmd.message === "stream-forever" || process.env.FAKE_PI_HANG === "1") {
        // A turn that never ends by itself — only `abort` stops it.
        streamTimer = setInterval(() => {
          streamed += 1;
          send({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: `chunk-${streamed} ` },
          });
        }, 15);
      } else if (cmd.message === "request-extension-ui") {
        send({
          type: "extension_ui_request",
          id: "extension-question-1",
          method: "confirm",
          title: "Approval needed",
        });
      } else if (cmd.message === "say-hello") {
        // A COMPLETE assistant turn (message_start → deltas → message_end), so
        // the domain reducer opens, streams, and finalizes a real assistant cell
        // — the SessionManager ingestion tests need a cell_final to key off.
        send({ type: "message_start", message: { role: "assistant" } });
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "he" },
        });
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "llo" },
        });
        send({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        });
        send({ type: "agent_end" });
      } else {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "he" },
        });
        process.stdout.write("this is not json\n");
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "llo" },
        });
        send({ type: "agent_end" });
      }
      break;
    case "steer":
    case "follow_up":
      if (cmd.message.startsWith("timeout")) break;
      send({
        id: cmd.id,
        type: "response",
        command: cmd.type,
        success: false,
        error: `${cmd.type} rejected api_key=command-secret`,
      });
      break;
    case "get_last_assistant_text":
      send({
        id: cmd.id,
        type: "response",
        command: "get_last_assistant_text",
        success: true,
        // A title helper's answer is whatever AGENT_DECK_FAKE_TITLE says, so a
        // test can exercise the SES-18 refresh — including the KEEP sentinel —
        // without a real model.
        data: { text: process.env.AGENT_DECK_FAKE_TITLE || "hello" },
      });
      break;
    case "abort":
      if (streamTimer) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
      send({ id: cmd.id, type: "response", command: "abort", success: true });
      send({ type: "agent_end" });
      break;
    default:
      send({
        id: cmd.id,
        type: "response",
        command: cmd.type,
        success: false,
        error: `unknown: ${cmd.type}`,
      });
  }
});
