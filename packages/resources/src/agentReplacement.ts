import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import type { AgentOverride } from "./overrides.ts";

/**
 * Materialize the effective global builtin definition used as the base for a
 * custom replacement. Override fields become ordinary frontmatter, `false`
 * removes a field, and systemPrompt replaces the markdown body. The builtin
 * name remains its stable identity even if malformed settings contain `name`.
 */
export function materializeBuiltinAgentOverrideContent(
  builtinContent: string,
  override: AgentOverride | undefined,
): string {
  const parsed = parseFrontmatter(builtinContent);
  const frontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  let body = parsed.body.trim();
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key === "name") continue;
    if (key === "systemPrompt") {
      if (typeof value === "string") body = value;
      continue;
    }
    if (value === false) {
      // `tools: false` is the builtin override representation of an explicit
      // empty allowlist; a custom replacement must preserve it as `tools: []`.
      if (key === "tools") frontmatter.tools = [];
      else delete frontmatter[key];
    } else {
      // Avoid invoking Object.prototype setters for hostile/unknown settings keys.
      Object.defineProperty(frontmatter, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}
