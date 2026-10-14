# MCP proxy acceptance

Agent Deck exposes assigned MCP servers to Pi through one model-facing tool named `mcp`. The proxy resolves the authenticated session on every operation and applies the current project, named-agent, child, and global MCP policy before returning catalog metadata or calling a server.

## Model calls

```text
mcp({})
mcp({ search: "issue tracker" })
mcp({ describe: "github/create_issue" })
mcp({ tool: "github/create_issue", args: { title: "Fix login" } })
```

List and search return a bounded catalog of qualified `server/tool` names and short descriptions. Describe returns the requested tool's input schema. Catalog reads are live, cursor-paginated, capped by page and tool counts, cancellable, and checked again against authorization after asynchronous discovery. Calls validate the live catalog, forward cancellation, and recheck authorization before returning their result. An assigned server that cannot be queried is reported as unavailable without exposing another server's metadata.

## Compatibility and scope

An authored named parent or child `tools:` list should use `mcp` to allow the proxy. Existing exact names in the old `mcp__server__tool` format remain narrowly compatible: the launch allowlist includes `mcp`, while proxy dispatch permits only that exact legacy tool. Their sanitized aliases fail closed when multiple server IDs or tool names map to the same legacy identifier, because the original grant is ambiguous. `tools: []` grants no MCP access.

Agent frontmatter entries such as `mcp:search` are Pi MCP adapter tools. They remain separate from Agent Deck's app-managed `mcp` proxy and do not assign or authorize Agent Deck MCP servers.

MCP call results retain the Electron client's existing text result behavior. This change does not claim native multimodal MCP result parity.

## Evidence

- `apps/server/test/mcpTools.test.ts`: proxy actions, live freshness, parent and child scope, revocation, cancellation, ambiguous legacy aliases, errors, and connection lifecycle.
- `packages/mcp/test/client.test.ts`: pagination, repeated cursors, page and tool limits, cancellation, calls, and errors.
- `apps/server/test/mcp.pi.test.ts`, `mcp-http.pi.test.ts`, `mcp-project-isolation.pi.test.ts`, `mcp-per-agent.pi.test.ts`, and `subagent-mcp.pi.test.ts`: pinned real Pi stdio/HTTP calls, project isolation, named-agent scope, child scope, continuation, policy changes, and ordered streaming.
- `e2e/tests/mcp.spec.ts`: runtime bridge inventory and server removal behavior.

## Platform impact

| Platform | Implementation impact                                                                                                                          | Verification status                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| macOS    | Portable Node/TypeScript backend and generated Pi extension; no macOS-specific branch. Stdio process behavior uses the existing MCP transport. | Focused unit and pinned real Pi checks run locally on macOS.                                                             |
| Windows  | Same backend, proxy schema, authorization, pagination, and HTTP behavior. Existing MCP transport owns Windows process launch details.          | Covered by shared source and targeted platform-neutral tests; Windows CI was not run locally for this acceptance record. |
| Linux    | Same backend, proxy schema, authorization, pagination, and HTTP behavior. Existing MCP transport owns Linux process launch details.            | Covered by shared source and targeted platform-neutral tests; Linux CI was not run locally for this acceptance record.   |

## Validation record — 2026-09-16

The full local unit suite and all 143 pinned real-Pi tests passed. Later review
corrections passed focused manager, assignment, launch, named-parent, and child
checks, including disabling a legacy named parent and revocation immediately
before a remote call. Typecheck, lint/design-system, format, native addon
build/smoke, web build, and backend build passed.

The full UI run recorded 254 passed, 14 skipped, and one Loop keyboard-approval
failure. That unrelated scenario passed on isolated rerun; the original broad UI
run is not claimed green. The two previously reported failures are fixed:
callback tests use independent HTTP connections across fixed-port teardown/rebind,
and Doctor checks a controlled executable's independent version. The callback
suite passed 12 consecutive runs, and the pinned-runtime launch check remained
separate from the Doctor fixture.

Sol (medium thinking) implemented the change and performed independent review;
the primary agent reviewed and orchestrated validation. Review findings about
permission races, catalog bounds, legacy restrictions, and repeated resource
scanning were resolved. Cross-platform CI remains to be observed after push.
