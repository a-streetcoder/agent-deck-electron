//! agent-deck filesystem integration — the shared-FS seam.
//!
//! agent-deck (the Swift menu-bar app) discovers skills by scanning a directory tree:
//! any folder that directly contains a `SKILL.md` is a skill root, and it reads only
//! that file's leading `--- … ---` frontmatter to resolve `name` + `description`
//! (see agent-deck's `SkillFrontmatter` / `ExternalSkillDiscovery`). Syncr materializes
//! skills into exactly that layout (`materialize::materialize_skill` writes
//! `<agents_root>/<slug>/SKILL.md`), so the two integrate through the filesystem — no IPC,
//! no FFI. This module re-implements agent-deck's frontmatter parse so we can assert, in
//! tests, that what Syncr writes is exactly what agent-deck will read back.

use std::collections::BTreeMap;

/// The `name` + `description` agent-deck resolves for a skill. `name` falls back to the
/// skill folder name when frontmatter omits it; `description` is `None` when absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: Option<String>,
}

/// Parse a leading `--- … ---` frontmatter block into key/value pairs, matching
/// agent-deck's `SkillFrontmatter.parse`: requires a `---\n` prefix, closes on the first
/// `\n---\n` or a trailing `\n---`, and reads flat `key: value` lines (skipping blanks and
/// `#` comments). Returns an empty map when no frontmatter block is present.
fn parse_frontmatter(text: &str) -> BTreeMap<String, String> {
    let normalized = text.replace("\r\n", "\n");
    let mut map = BTreeMap::new();
    let Some(remainder) = normalized.strip_prefix("---\n") else {
        return map;
    };
    let body = if let Some(idx) = remainder.find("\n---\n") {
        &remainder[..idx]
    } else if let Some(stripped) = remainder.strip_suffix("\n---") {
        stripped
    } else {
        return map;
    };
    let lines: Vec<&str> = body.split('\n').collect();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        i += 1;
        // Only a COLUMN-0 key is top level. An indented `description:` belongs to some other key's
        // nested map, and treating it as top level made the engine report the inner value.
        if raw.is_empty() || raw.starts_with([' ', '\t', '#', '-']) {
            continue;
        }
        let Some(sep) = raw.find(':') else { continue };
        let key = raw[..sep].trim();
        if key.is_empty() {
            continue;
        }
        let rest = raw[sep + 1..].trim();
        // BLOCK SCALARS. `description: >-` followed by indented lines is one value; reading the
        // header alone reported the literal string ">-" as the description — which then got written
        // back as `description: ">-"` on the next edit, permanently replacing the user's text.
        let value = match block_header(rest) {
            Some((literal, chomp)) => {
                let mut collected: Vec<&str> = Vec::new();
                while i < lines.len() {
                    let l = lines[i];
                    if !l.is_empty() && !l.starts_with([' ', '\t']) {
                        break; // dedented to column 0 — the block ended
                    }
                    collected.push(l);
                    i += 1;
                }
                fold_block(&collected, literal, chomp)
            }
            None => unquote_scalar(rest),
        };
        map.insert(key.to_string(), value);
    }
    map
}

/// Recognise a block scalar header (`|`, `>`, with optional `-`/`+` chomping and an explicit
/// indent digit). Returns `(is_literal, chomp)` where chomp is `-` strip, `+` keep, ` ` clip.
fn block_header(rest: &str) -> Option<(bool, char)> {
    let mut chars = rest.chars();
    let literal = match chars.next()? {
        '|' => true,
        '>' => false,
        _ => return None,
    };
    let mut chomp = ' ';
    for c in chars {
        match c {
            '-' | '+' => chomp = c,
            d if d.is_ascii_digit() => {}
            _ => return None, // trailing junk: not a block header after all
        }
    }
    Some((literal, chomp))
}

/// Join a block scalar's lines the way a YAML reader does: literal keeps newlines, folded turns
/// single newlines into spaces (a blank line stays a newline). Chomping trims the tail.
fn fold_block(lines: &[&str], literal: bool, chomp: char) -> String {
    let indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    let stripped: Vec<String> = lines
        .iter()
        .map(|l| {
            if l.len() >= indent {
                l[indent..].to_string()
            } else {
                String::new()
            }
        })
        .collect();
    let mut out = String::new();
    if literal {
        out = stripped.join("\n");
    } else {
        for (n, l) in stripped.iter().enumerate() {
            if n > 0 {
                // a blank line is a real newline; otherwise consecutive lines fold to one space
                if l.trim().is_empty() || stripped[n - 1].trim().is_empty() {
                    out.push('\n');
                } else {
                    out.push(' ');
                }
            }
            out.push_str(l);
        }
    }
    match chomp {
        '-' => out.trim_end_matches('\n').to_string(),
        '+' => out,
        _ => {
            let t = out.trim_end_matches('\n');
            if t.len() == out.len() {
                out
            } else {
                format!("{t}\n")
            }
        }
    }
}

/// Undo YAML scalar quoting, which a real YAML reader does and this parser did not.
///
/// The asymmetry was self-amplifying: `compose_skill_md` quotes `a: b` to `"a: b"`, the parser read
/// the quotes back as part of the value, and the next edit quoted THAT — growing a pair of escapes
/// per save. It also broke identity: a quoted `name` never matched the same skill's unquoted name,
/// so precedence dedup stopped seeing them as one skill, and pi/agent-deck (which use a real YAML
/// reader) and this engine disagreed about what a skill is even called.
fn unquote_scalar(v: &str) -> String {
    let bytes = v.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        return unescape_double_quoted(&v[1..v.len() - 1]);
    }
    if bytes.len() >= 2 && bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'' {
        // single-quoted: the only escape is a doubled quote
        return v[1..v.len() - 1].replace("''", "'");
    }
    // PLAIN scalar: a `#` that follows whitespace starts a comment and is NOT part of the value.
    // Keeping it meant the engine listed `#1 tool` as a description where a real reader sees an
    // empty value — and pi then drops the skill, so we advertised what it would never load. A `#`
    // with no preceding space (`C#`) is an ordinary character and stays.
    let mut cut = None;
    let mut prev_ws = true; // start-of-value counts as preceded by whitespace
    for (i, c) in v.char_indices() {
        if c == '#' && prev_ws {
            cut = Some(i);
            break;
        }
        prev_ws = c == ' ' || c == '\t';
    }
    match cut {
        Some(i) => v[..i].trim_end().to_string(),
        None => v.to_string(),
    }
}

/// The YAML double-quoted escape set — the one a real reader implements, so what we write and what
/// pi reads are the same string. This previously spoke Rust's `Debug` dialect (`\u{XXXX}`), which
/// is not valid YAML: emitter and parser agreed with each other and with nothing else, and a
/// standard `é` came back as literal garbage, changing the skill's identity.
fn unescape_double_quoted(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    fn take_hex(chars: &mut std::iter::Peekable<std::str::Chars>, n: usize) -> Option<char> {
        let mut hex = String::with_capacity(n);
        for _ in 0..n {
            hex.push(chars.next()?);
        }
        u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32)
    }
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('0') => out.push('\0'),
            Some('a') => out.push('\u{7}'),
            Some('b') => out.push('\u{8}'),
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('v') => out.push('\u{b}'),
            Some('f') => out.push('\u{c}'),
            Some('r') => out.push('\r'),
            Some('e') => out.push('\u{1b}'),
            Some('N') => out.push('\u{85}'),
            Some('_') => out.push('\u{a0}'),
            Some('L') => out.push('\u{2028}'),
            Some('P') => out.push('\u{2029}'),
            Some('x') => out.push(take_hex(&mut chars, 2).unwrap_or('\u{FFFD}')),
            Some('u') => out.push(take_hex(&mut chars, 4).unwrap_or('\u{FFFD}')),
            Some('U') => out.push(take_hex(&mut chars, 8).unwrap_or('\u{FFFD}')),
            // \" \\ \/ and anything else: the character itself
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Resolve name+description from parsed frontmatter, mirroring agent-deck's
/// `nameAndDescription(fromFrontmatter:fallbackName:)`.
fn name_and_description(
    fields: &BTreeMap<String, String>,
    fallback_name: &str,
) -> SkillFrontmatter {
    let name = fields
        .get("name")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| fallback_name.to_string());
    let description = fields
        .get("description")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    SkillFrontmatter { name, description }
}

/// The full shape agent-deck's `SkillInfo` needs from a SKILL.md (contract spec §1). `disabled` is
/// deliberately absent: it is agent-deck's app-level disable list, layered on AFTER listSkills, and
/// the engine must not populate it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDetail {
    pub name: String,
    /// Empty string when absent — agent-deck's `SkillInfo.description` is not optional.
    pub description: String,
    /// Frontmatter flag: the skill is manual-only, never model-invoked.
    pub disable_model_invocation: bool,
    /// SKILL.md with the frontmatter block stripped, trimmed (agent-deck scanner.ts:160).
    pub body: String,
}

/// Parse a SKILL.md into everything `SkillInfo` needs. Mirrors agent-deck's scanner so the two
/// cannot disagree about a skill's identity — which matters because precedence dedups on `name`.
pub fn skill_md_detail(skill_md: &str, fallback_name: &str) -> SkillDetail {
    let fields = parse_frontmatter(skill_md);
    let fm = name_and_description(&fields, fallback_name);
    // pi tests `frontmatter["disable-model-invocation"] === true` against a YAML 1.2 parse, where
    // only the literal `true` is boolean — `yes` and `1` are STRINGS and do not disable anything.
    // Accepting them here made the engine hide a skill from the model that pi still offers it.
    let truthy = |v: &String| v.trim() == "true";
    SkillDetail {
        name: fm.name,
        description: fm.description.unwrap_or_default(),
        disable_model_invocation: fields
            .get("disable-model-invocation")
            .or_else(|| fields.get("disableModelInvocation"))
            .is_some_and(truthy),
        body: strip_frontmatter(skill_md).trim().to_string(),
    }
}

/// SKILL.md minus its leading frontmatter block. Returns the whole text when there is none.
/// A file that is frontmatter only yields an empty body.
fn strip_frontmatter(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    let Some(remainder) = normalized.strip_prefix("---\n") else {
        return normalized;
    };
    match remainder.find("\n---\n") {
        Some(idx) => remainder[idx + 5..].to_string(),
        None => match remainder.strip_suffix("\n---") {
            Some(_) => String::new(),
            None => normalized,
        },
    }
}

/// Parse a SKILL.md string into the name+description agent-deck would resolve, given the
/// skill's folder name as the fallback. The in-memory equivalent of agent-deck reading
/// `<root>/SKILL.md` off disk.
pub fn skill_md_frontmatter(skill_md: &str, fallback_name: &str) -> SkillFrontmatter {
    name_and_description(&parse_frontmatter(skill_md), fallback_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materialize::materialize_skill;

    const SKILL: &str =
        "---\nname: git-helper\ndescription: Help with git\n---\n# Git Helper\nUse git well.\n";

    #[test]
    fn parses_name_and_description() {
        let fm = skill_md_frontmatter(SKILL, "fallback");
        assert_eq!(fm.name, "git-helper");
        assert_eq!(fm.description.as_deref(), Some("Help with git"));
    }

    #[test]
    fn falls_back_to_folder_name_when_name_absent() {
        let fm = skill_md_frontmatter("---\ndescription: d\n---\nbody", "my-folder");
        assert_eq!(fm.name, "my-folder");
        assert_eq!(fm.description.as_deref(), Some("d"));
    }

    #[test]
    fn description_is_none_when_absent() {
        let fm = skill_md_frontmatter("---\nname: x\n---\nbody", "fb");
        assert_eq!(fm.name, "x");
        assert_eq!(fm.description, None);
    }

    #[test]
    fn closes_on_trailing_fence_without_newline() {
        // agent-deck accepts a frontmatter block that ends the file at `\n---`.
        let fm = skill_md_frontmatter("---\nname: y\ndescription: z\n---", "fb");
        assert_eq!(fm.name, "y");
        assert_eq!(fm.description.as_deref(), Some("z"));
    }

    #[test]
    fn no_frontmatter_yields_fallback_and_none() {
        let fm = skill_md_frontmatter("# just a body\n", "fb");
        assert_eq!(fm.name, "fb");
        assert_eq!(fm.description, None);
    }

    #[test]
    fn quoted_scalars_round_trip_without_accreting_escapes() {
        // The identity bug: compose quotes, parse must unquote, or every save adds a layer.
        let md = crate::store::compose_skill_md("git: helper", Some("does \"things\""), Some("b"));
        let fm = skill_md_frontmatter(&md, "fb");
        assert_eq!(fm.name, "git: helper");
        assert_eq!(fm.description.as_deref(), Some("does \"things\""));

        // and again through a second edit — the value must be identical, not re-quoted
        let md2 = crate::store::apply_edit(Some(&md), &fm.name, None, None);
        let fm2 = skill_md_frontmatter(&md2, "fb");
        assert_eq!(fm2.name, "git: helper");
        assert_eq!(fm2.description.as_deref(), Some("does \"things\""));
    }

    #[test]
    fn single_quoted_scalar_is_unquoted() {
        let fm = skill_md_frontmatter("---\nname: 'it''s'\n---\nb", "fb");
        assert_eq!(fm.name, "it's");
    }

    #[test]
    fn materialized_skill_satisfies_agentdeck_scan_contract() {
        // The integration assertion: Syncr materializes a skill, then a scan that mirrors
        // agent-deck's discovery reads back the same name + description.
        let tmp = tempfile::tempdir().unwrap();
        let agents_root = tmp.path();
        materialize_skill(agents_root, "git-helper", SKILL).unwrap();

        // The folder is a skill root (contains SKILL.md), and the frontmatter round-trips.
        let md = std::fs::read_to_string(agents_root.join("git-helper").join("SKILL.md")).unwrap();
        let scanned = skill_md_frontmatter(&md, "git-helper");
        assert_eq!(scanned.name, "git-helper");
        assert_eq!(scanned.description.as_deref(), Some("Help with git"));

        // A folder without SKILL.md is not a skill root — discovery returns nothing for it.
        std::fs::create_dir_all(agents_root.join("not-a-skill")).unwrap();
        let found = crate::scope::discover_dir(agents_root, crate::scope::Scope::Global).unwrap();
        assert!(found.iter().all(|s| s.slug != "not-a-skill"));
    }
}
