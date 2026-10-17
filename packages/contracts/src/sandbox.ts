// ADR 0007: a project's `.agent-deck/sandbox.json`, which extends the server's
// default network allow-list for every session of that project.
import { Either, ParseResult, Schema } from "effect";

/** Most entries one project may add to the allow-list. */
export const MAX_PROJECT_SANDBOX_DOMAINS = 200;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// The port rule is srt's (`parsePortSuffix`): no leading zero, at most 65535.
const DOMAIN_PATTERN = new RegExp(
  `^(\\*\\.)?(${LABEL}(?:\\.${LABEL})*)(?::([1-9]\\d{0,4}))?$`,
  "i",
);
/** A last label URL parsers read as an IPv4 number (decimal, octal or 0x hex). */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|\d+)$/i;

/**
 * Why `value` is not a sandbox allow-list entry, or undefined when it is one:
 * a hostname of at least two labels or `*.hostname` (at least two labels after
 * the star), with an optional `:port` (1-65535, no leading zero). No scheme,
 * path, IP literal or localhost. Everything accepted here srt's
 * `isValidAllowedDomainEntry` accepts too; this is stricter.
 */
export function sandboxDomainProblem(value: string): string | undefined {
  const match = value.length <= 260 ? DOMAIN_PATTERN.exec(value) : null;
  if (!match) return `"${value}" is not a hostname, a *.hostname or either with :port`;
  const [, wildcard, host = "", port] = match;
  const labels = host.toLowerCase().split(".");
  if (NUMERIC_LABEL.test(labels.at(-1) ?? "")) return `"${value}" is an IP address, not a hostname`;
  if (labels.at(-1) === "localhost") return `"${value}" is localhost`;
  if (labels.length < 2) {
    return wildcard
      ? `"${value}" is too wide: name at least two labels after *.`
      : `"${value}" needs at least two labels (a.example)`;
  }
  if (port !== undefined && Number(port) > 65_535) return `"${value}" has a port above 65535`;
  return undefined;
}

export const isSandboxDomain = (value: string): boolean =>
  sandboxDomainProblem(value) === undefined;

const SandboxDomain = Schema.String.pipe(Schema.filter((value) => sandboxDomainProblem(value)));

export const ProjectSandboxConfig = Schema.mutable(
  Schema.Struct({
    allowedDomains: Schema.optionalWith(
      Schema.mutable(Schema.Array(SandboxDomain)).pipe(
        Schema.maxItems(MAX_PROJECT_SANDBOX_DOMAINS),
        Schema.filter((domains) => {
          const seen = new Set<string>();
          const repeated = domains.filter((domain) => {
            const key = domain.toLowerCase();
            if (seen.has(key)) return true;
            seen.add(key);
            return false;
          });
          return repeated.length === 0 ? undefined : `duplicate entries: ${repeated.join(", ")}`;
        }),
      ),
      { exact: true },
    ),
  }),
);
export type ProjectSandboxConfig = typeof ProjectSandboxConfig.Type;

export type ProjectSandboxConfigResult =
  | { ok: true; config: ProjectSandboxConfig }
  | { ok: false; problems: string[] };

const decode = Schema.decodeUnknownEither(ProjectSandboxConfig, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * Parse the JSON value of `.agent-deck/sandbox.json`. Unknown keys, wrong
 * types, invalid or repeated domains and more than 200 entries are refused as
 * a whole; each problem comes back as one line naming its path.
 */
export function parseProjectSandboxConfig(value: unknown): ProjectSandboxConfigResult {
  const result = decode(value);
  if (Either.isRight(result)) return { ok: true, config: result.right };
  const problems = ParseResult.ArrayFormatter.formatErrorSync(result.left).map((issue) =>
    issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  );
  return { ok: false, problems };
}
