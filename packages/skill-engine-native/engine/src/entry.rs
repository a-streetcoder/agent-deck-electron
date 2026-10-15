//! What ONE file of a skill is (#206).
//!
//! The Agent Skills format does not restrict a skill to text: `~/.codex/skills/.system/*` ship
//! `assets/*.png`, and before this module a single one of them made the WHOLE folder unreadable
//! (`String::from_utf8` in `import.rs` → `ImportError::NonUtf8`). So a fileset value is an entry
//! that is EITHER text or bytes, and text-ness is decided exactly ONCE — here, at ingest, in
//! `from_bytes`. Deciding it a second time anywhere else is how two definitions of identity
//! (and two hashes for one file) get born.
//!
//! Non-UTF-8 CONTENT is fine. Non-UTF-8 PATHS are still refused: a fileset key is a JSON string
//! in the envelope, so it cannot hold one.

use std::collections::BTreeMap;

/// One file of a skill: text, or bytes that are not text.
///
/// THE INVARIANT, ENFORCED BY CONSTRUCTION (round 43, fix round 3): a `FileEntry`'s kind is always
/// the kind `from_bytes` gives its bytes. The variants are PRIVATE and the only ways in run the
/// classifier, so "a binary entry holding text bytes" is not a value this type can hold.
///
/// That is what closes the envelope: `serialize_fileset` routes binary entries to `bin`, and
/// `parse_fileset` refuses a `bin` value whose bytes are text (retagging it Text would hand
/// declared-binary bytes to `normalize_fileset`, which rewrote `a\r\nb` to `a\nb` on the way to
/// disk). While `Binary(Vec<u8>)` was public, those two rules contradicted each other: a fileset
/// the type permitted serialized to an envelope the parser then refused, so `materialize_and_index`
/// rejected it and `read_base` degraded to no base. Make the value unconstructible and the
/// contradiction cannot arise — the refusal survives only for a forged or corrupted envelope,
/// where failing closed is the point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry(Repr);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Repr {
    Text(String),
    Binary(Vec<u8>),
}

/// A skill's files: relative POSIX path → entry, in BTreeMap order (the order everything hashes).
pub type Fileset = BTreeMap<String, FileEntry>;

impl FileEntry {
    /// THE text-ness decision, made once. Text iff the bytes are valid UTF-8 AND carry no NUL.
    ///
    /// The NUL rule matters even though such bytes decode: a NUL is what every tool uses to call
    /// a file binary, and newline normalization inside one would corrupt it. Everything else that
    /// decodes stays text, exactly as before this slice.
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        if bytes.contains(&0) {
            return FileEntry(Repr::Binary(bytes));
        }
        match String::from_utf8(bytes) {
            Ok(s) => FileEntry(Repr::Text(s)),
            Err(e) => FileEntry(Repr::Binary(e.into_bytes())),
        }
    }

    /// An entry a caller already holds as text. Goes through the SAME classifier, so it is a
    /// convenience and not a second kind decision: a string carrying a NUL becomes a binary entry
    /// (its bytes read back off disk as one, and there is only ever one answer per byte string).
    pub fn text(s: impl Into<String>) -> Self {
        Self::from_bytes(s.into().into_bytes())
    }

    /// The bytes to write to disk — the only thing `materialize` needs.
    pub fn as_bytes(&self) -> &[u8] {
        match &self.0 {
            Repr::Text(s) => s.as_bytes(),
            Repr::Binary(b) => b,
        }
    }

    /// The text, or `None` for a binary entry. Never a lossy conversion: a caller that needs text
    /// (frontmatter, previews) must handle "this file is not text" rather than see mojibake.
    pub fn as_text(&self) -> Option<&str> {
        match &self.0 {
            Repr::Text(s) => Some(s),
            Repr::Binary(_) => None,
        }
    }

    pub fn is_binary(&self) -> bool {
        matches!(self.0, Repr::Binary(_))
    }
}

impl PartialEq<str> for FileEntry {
    fn eq(&self, other: &str) -> bool {
        self.as_text() == Some(other)
    }
}
impl PartialEq<&str> for FileEntry {
    fn eq(&self, other: &&str) -> bool {
        self.as_text() == Some(*other)
    }
}

/// A borrowed view of an entry, so the hash / serialize / materialize plumbing can be written
/// ONCE and still accept the plain `String` filesets syncr-core's cloud paths use.
pub enum EntryRef<'a> {
    Text(&'a str),
    Binary(&'a [u8]),
}

impl EntryRef<'_> {
    pub fn bytes(&self) -> &[u8] {
        match self {
            EntryRef::Text(s) => s.as_bytes(),
            EntryRef::Binary(b) => b,
        }
    }
}

/// What a fileset VALUE has to be able to do. Implemented for `FileEntry` (the engine) and for
/// `String` (syncr-core's text-only cloud filesets), so there is one hash, one envelope and one
/// newline rule rather than a parallel set per value type.
pub trait AsEntry {
    fn entry_ref(&self) -> EntryRef<'_>;
    /// The LF ingest rule (`crate::normalize_newlines`), applied to text only — binary bytes are
    /// never rewritten.
    fn normalize_newlines_in_place(&mut self);
}

impl AsEntry for String {
    fn entry_ref(&self) -> EntryRef<'_> {
        EntryRef::Text(self)
    }
    fn normalize_newlines_in_place(&mut self) {
        let n = crate::normalize_newlines(self);
        if n != *self {
            *self = n;
        }
    }
}

impl AsEntry for FileEntry {
    fn entry_ref(&self) -> EntryRef<'_> {
        match &self.0 {
            Repr::Text(s) => EntryRef::Text(s),
            Repr::Binary(b) => EntryRef::Binary(b),
        }
    }
    fn normalize_newlines_in_place(&mut self) {
        // Text only, and normalization only ever REMOVES `\r`, so it cannot turn a text entry
        // into a binary one — the invariant holds without reclassifying.
        if let Repr::Text(s) = &mut self.0 {
            s.normalize_newlines_in_place();
        }
    }
}

/// Project a fileset to text-only, naming the first binary path when it cannot.
///
/// Used at syncr-core's CLOUD boundaries: the server's version blob is a `files` map of strings,
/// so a binary entry has nowhere to go. Failing closed with the path preserves exactly today's
/// behaviour (a binary skill is not pushable) instead of silently pushing a mangled file.
pub fn into_text_only(files: &Fileset) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for (path, entry) in files {
        match entry.as_text() {
            Some(s) => {
                out.insert(path.clone(), s.to_string());
            }
            None => return Err(path.clone()),
        }
    }
    Ok(out)
}

// ── base64, strictly ────────────────────────────────────────────────────────────────────────────
//
// Hand-rolled rather than a dependency: the dependency list IS this crate's contract (ADR 0004 —
// everything here ships inside agent-deck's Electron addon), and a codec is 40 lines. STRICT is
// the point: a lenient decoder that shrugs at bad padding or embedded whitespace would let a
// corrupted base snapshot parse as a SHORTER file, which the next merge reads as a deletion.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64, padded, no line breaks.
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn sextet(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decode standard base64. Rejects anything that is not canonical: a length that is not a
/// multiple of 4, any character outside the alphabet (whitespace and newlines included),
/// misplaced padding, and non-zero bits in a padded tail.
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(4) {
        return Err(format!("base64 length {} is not a multiple of 4", b.len()));
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let chunks = b.len() / 4;
    for (i, chunk) in b.chunks(4).enumerate() {
        let pad = chunk.iter().filter(|c| **c == b'=').count();
        if pad != 0 && i + 1 != chunks {
            return Err("base64 padding before the final quantum".to_string());
        }
        if pad > 2 {
            return Err("base64 quantum is all padding".to_string());
        }
        // padding must be a SUFFIX of the quantum
        for (j, c) in chunk.iter().enumerate() {
            if *c == b'=' && j < 4 - pad {
                return Err("base64 padding is not at the end of the quantum".to_string());
            }
        }
        let mut n: u32 = 0;
        for c in chunk.iter().take(4 - pad) {
            let v =
                sextet(*c).ok_or_else(|| format!("invalid base64 character {:?}", *c as char))?;
            n = (n << 6) | v;
        }
        n <<= 6 * pad as u32;
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        // a padded quantum must not carry bits that decode to a byte it then drops
        if pad > 0 && bytes[3 - pad..].iter().any(|b| *b != 0) {
            return Err("base64 padded quantum has non-zero trailing bits".to_string());
        }
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_ness_is_decided_by_utf8_and_the_absence_of_a_nul() {
        assert_eq!(
            FileEntry::from_bytes(b"# hi\n".to_vec()),
            FileEntry::text("# hi\n")
        );
        // The kind is a FUNCTION of the bytes, and the only way to build an entry runs it — so a
        // "binary entry" holding text bytes cannot be constructed at all (round 43, fix round 3).
        // `FileEntry::text` is the same decision, not a second one.
        assert!(!FileEntry::from_bytes(b"a\r\nb".to_vec()).is_binary());
        assert!(FileEntry::text("a\0b").is_binary());
        assert_eq!(FileEntry::text("a\0b").as_bytes(), b"a\0b");
        assert!(FileEntry::from_bytes(b"a\0b".to_vec()).is_binary());
        assert!(FileEntry::from_bytes(vec![0x89, 0xFF, 0xFE]).is_binary());
        assert_eq!(
            FileEntry::from_bytes(vec![0x89, 0xFF]).as_bytes(),
            &[0x89, 0xFF]
        );
        assert!(FileEntry::from_bytes(vec![0xFF]).as_text().is_none());
    }

    #[test]
    fn newline_normalization_never_touches_binary_bytes() {
        let mut png = FileEntry::from_bytes(vec![0x89, 0x0D, 0x0A, 0x00]);
        png.normalize_newlines_in_place();
        assert_eq!(png.as_bytes(), &[0x89, 0x0D, 0x0A, 0x00]);
        let mut t = FileEntry::text("a\r\nb");
        t.normalize_newlines_in_place();
        assert_eq!(t, FileEntry::text("a\nb"));
    }

    #[test]
    fn base64_round_trips_every_tail_length() {
        for n in 0..40usize {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 7 + 3) as u8).collect();
            let enc = base64_encode(&bytes);
            assert!(!enc.contains('\n'));
            assert_eq!(base64_decode(&enc).unwrap(), bytes, "n={n}");
        }
        assert_eq!(base64_encode(b"A"), "QQ==");
        assert_eq!(base64_decode("QQ==").unwrap(), b"A");
    }

    #[test]
    fn base64_decoding_fails_closed_on_everything_non_canonical() {
        for bad in [
            "QQ=", "QQQQQ", "QQ\nQ=", "QQ ==", "Q===", "=QQQ", "QQ=Q", "QQ*=", "QR==",
        ] {
            assert!(base64_decode(bad).is_err(), "must reject {bad:?}");
        }
    }

    #[test]
    fn into_text_only_names_the_binary_path_it_cannot_carry() {
        let f: Fileset = [
            ("SKILL.md".to_string(), FileEntry::text("# s")),
            (
                "assets/i.png".to_string(),
                FileEntry::from_bytes(vec![0xFF, 0xFE]),
            ),
        ]
        .into_iter()
        .collect();
        assert_eq!(into_text_only(&f).unwrap_err(), "assets/i.png");
        let text: Fileset = [("SKILL.md".to_string(), FileEntry::text("# s"))]
            .into_iter()
            .collect();
        assert_eq!(into_text_only(&text).unwrap()["SKILL.md"], "# s");
    }
}
