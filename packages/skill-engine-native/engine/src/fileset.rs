//! Parse a skill version blob into a fileset, mirroring the web's `serializeFileset`: a JSON
//! envelope `{"files":{...}}` is a multi-file skill; anything else is a legacy raw `SKILL.md`.
//! This is what lets the client materialize every file of a multi-file skill, not just SKILL.md.
//!
//! #206 added the `bin` half: binary files (icons, fixtures) live in a sibling map as standard
//! base64, so a text-only skill serializes to EXACTLY the string it always did — the envelope is
//! identity, and every already-stored hash must stay valid.

use std::collections::BTreeMap;

use crate::entry::{base64_decode, base64_encode, AsEntry, EntryRef, FileEntry, Fileset};

/// Serialize a fileset into THE canonical envelope: `{"files":{...}}` (plus `{"bin":{...}}` when
/// any entry is binary) with keys in BTreeMap order. This is the single serialization everything
/// hashes — the index, the version store — so "same content" always means "same hash", on any
/// machine. Two serializers would be two definitions of identity.
///
/// `bin` is omitted when empty, and a path appears in exactly one of the two maps, so a fileset
/// with no binary entries produces byte-for-byte what it produced before #206.
pub fn serialize_fileset<V: AsEntry>(files: &BTreeMap<String, V>) -> String {
    let mut text = serde_json::Map::new();
    let mut bin = serde_json::Map::new();
    for (k, v) in files {
        match v.entry_ref() {
            EntryRef::Text(s) => {
                text.insert(k.clone(), serde_json::Value::String(s.to_string()));
            }
            EntryRef::Binary(b) => {
                bin.insert(k.clone(), serde_json::Value::String(base64_encode(b)));
            }
        }
    }
    if bin.is_empty() {
        serde_json::json!({ "files": serde_json::Value::Object(text) }).to_string()
    } else {
        serde_json::json!({
            "files": serde_json::Value::Object(text),
            "bin": serde_json::Value::Object(bin),
        })
        .to_string()
    }
}

/// Why a blob is not a fileset. Every variant FAILS CLOSED: a blob the parser cannot fully
/// account for yields no fileset at all, never a plausible-looking one with a file missing —
/// a base snapshot short one file reads as a deletion on the next merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid fileset envelope: {}", self.0)
    }
}
impl std::error::Error for ParseError {}

/// Parse a version blob into its fileset. JSON envelope → its files; otherwise the whole
/// blob is a single `SKILL.md`.
///
/// ENVELOPE-SHAPED JSON IS JUDGED AS AN ENVELOPE (round 43 review). Validation used to begin only
/// once `files` was an object, so `{"files":null,"bin":{"a.png":"%%%"}}` fell out of the envelope
/// branch and into the legacy fallback — carrying its invalid base64 with it, silently, as a
/// one-file "SKILL.md" whose text was the malformed JSON.
///
/// The discriminator is envelope SHAPE, not a key NAME (round 43, fix round 2). Committing on the
/// mere presence of `"files"` also captured legacy raw markdown that merely happens to be JSON
/// mentioning it — `{"files":"documentation about files"}` used to parse as a one-file SKILL.md and
/// briefly became an error. So: an envelope is a blob whose `files` is an OBJECT (every real
/// envelope has one — `serialize_fileset` always emits it, empty or not) or whose `bin` is an
/// OBJECT (which is what holds the malformed-base64 case above to the contract). Anything else is
/// legacy: a SKILL.md is allowed to be any text at all, JSON included.
pub fn parse_fileset(blob: &str) -> Result<Fileset, ParseError> {
    match serde_json::from_str::<serde_json::Value>(blob) {
        Ok(v) if is_envelope_shaped(&v) => parse_envelope_value(&v),
        _ => Ok(legacy_raw(blob)),
    }
}

/// Does this JSON claim to be an envelope? Only an OBJECT under either key counts; see
/// `parse_fileset`. Deliberately shape-based in both directions: it never waves a malformed
/// envelope through to the legacy fallback, and it never captures raw markdown that isn't one.
fn is_envelope_shaped(v: &serde_json::Value) -> bool {
    v.get("files").map(|f| f.is_object()) == Some(true)
        || v.get("bin").map(|b| b.is_object()) == Some(true)
}

/// Parse a blob that MUST be an envelope — no legacy raw-SKILL.md fallback.
///
/// This is what the git BASE snapshot reads (`repos::read_base`), which used to hand-roll its own
/// envelope parser: two parsers meant two kind decisions, and the copy tagged every `bin` entry
/// Binary whatever its bytes were (round 43 review). One parser, one definition of identity.
pub fn parse_envelope(blob: &str) -> Result<Fileset, ParseError> {
    let v: serde_json::Value =
        serde_json::from_str(blob).map_err(|e| ParseError(format!("not JSON: {e}")))?;
    parse_envelope_value(&v)
}

fn parse_envelope_value(v: &serde_json::Value) -> Result<Fileset, ParseError> {
    let files = v
        .get("files")
        .and_then(|f| f.as_object())
        .ok_or_else(|| ParseError("`files` is missing or not an object".to_string()))?;
    let mut out = Fileset::new();
    for (path, val) in files {
        let s = val
            .as_str()
            .ok_or_else(|| ParseError(format!("`files[{path}]` is not a string")))?;
        // Through the ONE classifier (`FileEntry::text` → `from_bytes`), not a Text tag asserted
        // by the map a value arrived in: a legacy `files` value carrying a NUL (pre-#206 ingest
        // used `String::from_utf8`, which accepts one) is binary by the only definition this crate
        // has, and tagging it Text would both violate the type invariant and normalize newlines
        // inside it. It still round-trips — `serialize_fileset` then writes it under `bin`.
        out.insert(path.clone(), FileEntry::text(s));
    }
    if let Some(raw_bin) = v.get("bin") {
        let bin = raw_bin
            .as_object()
            .ok_or_else(|| ParseError("`bin` is not an object".to_string()))?;
        for (path, val) in bin {
            let s = val
                .as_str()
                .ok_or_else(|| ParseError(format!("`bin[{path}]` is not a string")))?;
            let bytes = base64_decode(s).map_err(|e| ParseError(format!("`bin[{path}]`: {e}")))?;
            if out.contains_key(path) {
                return Err(ParseError(format!(
                    "{path} appears in both `files` and `bin`"
                )));
            }
            // A `bin` VALUE MUST ACTUALLY BE BINARY (round 43, fix round 2) — and since fix
            // round 3 this is UNREACHABLE from the canonical producer: `FileEntry` classifies its
            // bytes at construction (`entry.rs`), so "a binary entry holding text bytes" is not a
            // value that exists and `serialize_fileset` cannot emit a text-shaped `bin`. Every
            // fileset the type can hold survives `parse(serialize(f)) == f`. What is left here is
            // a corrupt or forged envelope, and two facts say refuse it rather than retag it.
            //
            // One: the kind is a function of the bytes — nothing on disk remembers "this was
            // tagged binary", so a materialized file whose bytes are valid UTF-8 with no NUL is
            // read back as Text by `import::read_skill_fileset`, and an entry kept Binary against
            // its bytes would have two identities (the index recording the binary-envelope hash at
            // materialize time, every later scan hashing the text envelope — the skill born
            // edited, forever; git bases the same way, with a wrong conflict kind). Two: an entry
            // the envelope declares BINARY must never meet `normalize_fileset`, and retagging it
            // Text is precisely how it does — `YQ0KYg==` reached disk as `a\nb`, not `a\r\nb`
            // (`syncr_core::materialize_and_index` normalizes every parsed blob).
            //
            // Refusing costs no producer anything: `bin` arrived WITH the byte-classified
            // `FileEntry`, so there is no legacy store holding a text-shaped one to migrate, and
            // folder and git ingest classify through `FileEntry::from_bytes` without coming
            // through here at all. Fail closed.
            let entry = FileEntry::from_bytes(bytes);
            if !entry.is_binary() {
                return Err(ParseError(format!(
                    "`bin[{path}]` decodes to text (valid UTF-8, no NUL); a binary entry must \
                     carry binary bytes"
                )));
            }
            out.insert(path.clone(), entry);
        }
    }
    Ok(out)
}

/// A blob that is not an envelope is the whole of a single `SKILL.md` — the pre-fileset format,
/// still in every old store.
fn legacy_raw(blob: &str) -> Fileset {
    let mut out = Fileset::new();
    out.insert("SKILL.md".to_string(), FileEntry::text(blob));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_json_envelope_into_a_fileset() {
        let blob = r##"{"files":{"SKILL.md":"# s","scripts/x.sh":"echo hi",".mcp.json":"{}"}}"##;
        let fs = parse_fileset(blob).unwrap();
        assert_eq!(fs.len(), 3);
        assert_eq!(fs["SKILL.md"], "# s");
        assert_eq!(fs["scripts/x.sh"], "echo hi");
        assert_eq!(fs[".mcp.json"], "{}");
    }

    #[test]
    fn legacy_raw_blob_becomes_single_skill_md() {
        let fs = parse_fileset("# just markdown\nbody").unwrap();
        assert_eq!(fs.len(), 1);
        assert_eq!(fs["SKILL.md"], "# just markdown\nbody");
    }
}
