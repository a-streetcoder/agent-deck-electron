import { Schema } from "effect";

/** Managed project-server preview wire contract. */
export const SCRIPT_MAX_OUTPUT_CHUNK = 65_536;
export const SCRIPT_MAX_SCROLLBACK_CHARS = 262_144;
export const SCRIPT_MAX_SCRIPTS = 500;
export const SCRIPT_NAME_MAX = 214;
export const SCRIPT_COMMAND_MAX = 16_384;

const wireInt = (description: string) =>
  Schema.Number.pipe(
    Schema.filter((n) => Number.isInteger(n) || "must be an integer", {
      identifier: "ScriptWireInt",
      description,
    }),
  );

export const ScriptRunId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
export type ScriptRunId = typeof ScriptRunId.Type;

/** Stable, server-owned identifier. Clients must treat this value as opaque. */
export const ProjectServerCommandId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(512),
);
export type ProjectServerCommandId = typeof ProjectServerCommandId.Type;

export const ProjectServerCommandSource = Schema.Literal("package", "cargo", "django", "static");
export type ProjectServerCommandSource = typeof ProjectServerCommandSource.Type;

/** One server-detected command proposal. The displayed command is informational. */
export const ProjectServerCommand = Schema.Struct({
  id: ProjectServerCommandId,
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(SCRIPT_NAME_MAX)),
  command: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(SCRIPT_COMMAND_MAX)),
  source: ProjectServerCommandSource,
  /** Advisory display metadata only; it never authorizes probing or embedding. */
  defaultPort: Schema.NullOr(
    wireInt("default server port").pipe(
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(65_535),
    ),
  ),
});
export type ProjectServerCommand = typeof ProjectServerCommand.Type;

export const DiscoveredServer = Schema.Struct({
  host: Schema.Literal("localhost"),
  port: wireInt("dev server port").pipe(
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(65_535),
  ),
  url: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_048)),
});
export type DiscoveredServer = typeof DiscoveredServer.Type;

export const ScriptClientRequest = Schema.Union(
  Schema.Struct({ type: Schema.Literal("scripts_list"), sessionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("script_start"),
    sessionId: Schema.String,
    /** The only client-controlled selector; cwd and launch argv are server-owned. */
    commandId: ProjectServerCommandId,
  }),
  Schema.Struct({ type: Schema.Literal("script_attach"), runId: ScriptRunId }),
  Schema.Struct({ type: Schema.Literal("script_stop"), runId: ScriptRunId }),
);
export type ScriptClientRequest = typeof ScriptClientRequest.Type;

export const ScriptPush = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("script_output"),
    runId: ScriptRunId,
    data: Schema.String.pipe(Schema.maxLength(SCRIPT_MAX_OUTPUT_CHUNK)),
  }),
  Schema.Struct({
    type: Schema.Literal("script_server"),
    runId: ScriptRunId,
    server: DiscoveredServer,
  }),
  Schema.Struct({
    type: Schema.Literal("script_exit"),
    runId: ScriptRunId,
    exitCode: Schema.NullOr(wireInt("script exit code")),
    signal: Schema.NullOr(Schema.String.pipe(Schema.maxLength(32))),
  }),
);
export type ScriptPush = typeof ScriptPush.Type;
