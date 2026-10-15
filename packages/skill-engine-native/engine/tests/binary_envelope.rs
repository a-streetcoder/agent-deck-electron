//! #206 — the type-level half of the slice: `FileEntry`, the `bin` envelope, and the fail-closed
//! base64 decode. Every assertion here is about the ENVELOPE as identity: a text-only fileset
//! serializes to exactly the string it always did, a binary entry round-trips byte-identically,
//! and anything the parser cannot fully account for is an error rather than a plausible-looking
//! fileset with a file missing.

use std::collections::BTreeMap;

use skill_engine::entry::{FileEntry, Fileset};
use skill_engine::fileset::{parse_fileset, serialize_fileset};

const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE,
];

fn fs_of(entries: &[(&str, FileEntry)]) -> Fileset {
    entries
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

#[test]
fn text_ness_is_decided_once_at_ingest() {
    // valid UTF-8, no NUL → Text
    assert_eq!(
        FileEntry::from_bytes(b"# hello\n".to_vec()),
        FileEntry::text("# hello\n")
    );
    // valid UTF-8 but carries a NUL → Binary. A NUL is what every tool uses to decide "binary",
    // and normalizing newlines inside such a file would corrupt it.
    assert!(FileEntry::from_bytes(b"a\0b".to_vec()).is_binary());
    // not UTF-8 at all → Binary
    assert!(FileEntry::from_bytes(PNG.to_vec()).is_binary());
    // and the bytes come back untouched either way
    assert_eq!(FileEntry::from_bytes(PNG.to_vec()).as_bytes(), PNG);
    assert!(FileEntry::from_bytes(PNG.to_vec()).as_text().is_none());
}

#[test]
fn a_text_only_fileset_serializes_to_exactly_the_string_it_does_today() {
    let f = fs_of(&[
        ("SKILL.md", FileEntry::text("# s\n")),
        ("refs/a.md", FileEntry::text("# a\n")),
    ]);
    assert_eq!(
        serialize_fileset(&f),
        r##"{"files":{"SKILL.md":"# s\n","refs/a.md":"# a\n"}}"##,
        "no `bin` key when there is no binary — the envelope is identity"
    );
}

#[test]
fn a_binary_entry_round_trips_through_the_envelope_byte_identically() {
    let f = fs_of(&[
        ("SKILL.md", FileEntry::text("# s\n")),
        ("assets/icon.png", FileEntry::from_bytes(PNG.to_vec())),
    ]);
    let blob = serialize_fileset(&f);
    let v: serde_json::Value = serde_json::from_str(&blob).unwrap();
    assert!(
        v["files"].get("assets/icon.png").is_none(),
        "a path appears in exactly one of the two maps"
    );
    assert!(v["bin"]["assets/icon.png"].is_string());
    assert!(
        !blob.contains('\n'),
        "standard base64, no line breaks: {blob}"
    );
    assert_eq!(parse_fileset(&blob).unwrap(), f);
}

#[test]
fn an_invalid_base64_bin_value_is_a_parse_error_not_a_dropped_file() {
    // Fail closed. Silently skipping the entry yields a plausible-looking fileset that is simply
    // missing a file — and a base snapshot missing a file reads as deletion on the next merge.
    let blob = r##"{"files":{"SKILL.md":"# s"},"bin":{"assets/icon.png":"!!! not base64 !!!"}}"##;
    assert!(parse_fileset(blob).is_err());
    // and the shapes a lenient decoder waves through
    for bad in [
        r##"{"files":{},"bin":{"a.png":"AAAA"}}"##, // valid — control (three NULs: binary)
        r##"{"files":{},"bin":{"a.png":"QQ="}}"##,  // wrong padding
        r##"{"files":{},"bin":{"a.png":"QQ\nQ="}}"##, // embedded newline
        r##"{"files":{},"bin":{"a.png":"QQQQQ"}}"##, // bad length
        r##"{"files":{},"bin":{"a.png":42}}"##,     // not even a string
        r##"{"files":{"a.png":"x"},"bin":{"a.png":"AAAA"}}"##, // in both maps
    ]
    .iter()
    .skip(1)
    {
        assert!(
            parse_fileset(bad).is_err(),
            "must not parse leniently: {bad}"
        );
    }
    assert!(parse_fileset(r##"{"files":{},"bin":{"a.png":"AAAA"}}"##).is_ok());
}

#[test]
fn a_legacy_raw_blob_is_still_a_single_text_skill_md() {
    let f = parse_fileset("# just markdown\nbody").unwrap();
    assert_eq!(f.len(), 1);
    assert_eq!(f["SKILL.md"], FileEntry::text("# just markdown\nbody"));
}

#[test]
fn a_binary_entry_hashes_with_a_marker_that_cannot_collide_with_a_text_length() {
    // Text records stay `{path.len}\n{path}\n{content.len}\n{content}\n`; a binary record uses
    // `B{bytes.len}` so no text length's digit run can produce the same prefix.
    // Same bytes, different kind: `Q` `Q` as text, and the NUL-bearing bytes that are binary by
    // the one classifier. (The old form of this test tagged the SAME bytes both ways — a value the
    // type no longer permits, and the source of the closure defect the validator caught.)
    let text = fs_of(&[("a", FileEntry::text("QQ"))]);
    let bin = fs_of(&[("a", FileEntry::from_bytes(PNG.to_vec()))]);
    assert_ne!(
        skill_engine::repos::fileset_hash(&text),
        skill_engine::repos::fileset_hash(&bin),
        "a binary record must not hash as a text one"
    );
    // A text entry whose CONTENT is the base64 of the binary one still hashes differently: the
    // `B` marker on the length is what keeps the two records apart.
    let looks_encoded = fs_of(&[(
        "a",
        FileEntry::text(skill_engine::entry::base64_encode(PNG)),
    )]);
    assert_ne!(
        skill_engine::repos::fileset_hash(&looks_encoded),
        skill_engine::repos::fileset_hash(&bin),
    );
    // Identity survives the serialize round-trip for both kinds.
    for f in [&text, &bin, &looks_encoded] {
        let round: BTreeMap<String, FileEntry> = parse_fileset(&serialize_fileset(f)).unwrap();
        assert_eq!(
            skill_engine::repos::fileset_hash(&round),
            skill_engine::repos::fileset_hash(f)
        );
    }
}

// ── round 43 review findings ────────────────────────────────────────────────────────────────────

#[test]
fn a_parsed_entrys_kind_is_always_what_its_bytes_would_be_read_back_as() {
    // The reported HIGH, in its surviving form: whatever the parser ACCEPTS, each entry's kind is
    // the one its bytes get on the way back off disk. Nothing on disk remembers "this was tagged
    // binary" — a re-read through `read_skill_fileset` classifies bytes, so a mismatch here means
    // the index's materialize-time envelope can never match the one a later scan builds, and the
    // freshly written skill is reported edited forever. (A `bin` value whose bytes are NOT binary
    // is refused outright — see `a_text_shaped_bin_value_never_reaches_disk_with_its_bytes_rewritten`.)
    let blob = format!(
        r##"{{"files":{{"SKILL.md":"# s"}},"bin":{{"nul":"AAAA","png":"{}"}}}}"##,
        skill_engine::entry::base64_encode(PNG)
    );
    let f = parse_fileset(&blob).unwrap();
    for (path, entry) in &f {
        assert_eq!(
            *entry,
            FileEntry::from_bytes(entry.as_bytes().to_vec()),
            "kind of {path} must be the one its bytes get on the way back off disk"
        );
    }
    // bytes are untouched
    assert_eq!(f["nul"].as_bytes(), &[0u8, 0, 0]);
    assert_eq!(f["png"].as_bytes(), PNG);
    // and so identity survives the disk round-trip: re-serializing the canonical fileset is what
    // a scan of the materialized tree will hash.
    assert_eq!(parse_fileset(&serialize_fileset(&f)).unwrap(), f);
}

#[test]
fn envelope_shaped_json_is_validated_as_an_envelope_not_waved_through_as_legacy_markdown() {
    // The reported MEDIUM: validation only began once `files` was an object, so a malformed
    // envelope fell through to the legacy raw-SKILL.md fallback — and its invalid base64 with it.
    // A `bin` OBJECT is what commits a blob to the envelope contract; a non-object `files` or
    // `bin` on its own is legacy markdown (see
    // `legacy_raw_json_is_not_an_envelope_just_because_it_mentions_files_or_bin`).
    for bad in [
        r##"{"files":null,"bin":{"assets/icon.png":"%%%"}}"##,
        r##"{"bin":{"assets/icon.png":"%%%"}}"##,
        r##"{"files":[],"bin":{"assets/icon.png":"%%%"}}"##,
        r##"{"bin":{"a.png":"AAAA"}}"##,
    ] {
        assert!(
            parse_fileset(bad).is_err(),
            "envelope-shaped JSON must be judged as an envelope: {bad}"
        );
    }
    // JSON with neither envelope key keeps the legacy behaviour — a SKILL.md is allowed to be
    // any text at all, including JSON.
    let f = parse_fileset(r##"{"title":"not an envelope"}"##).unwrap();
    assert_eq!(f.len(), 1);
    assert_eq!(f["SKILL.md"], r##"{"title":"not an envelope"}"##);
}

#[test]
fn only_the_envelope_module_may_decode_the_bin_half() {
    // A guard rule, not a behaviour test. The defect this slice's review found twice over is the
    // repo's dominant one: a SECOND copy of a decision. `repos::read_base` had hand-rolled its own
    // envelope parser and therefore its own (wrong) Text/Binary decision. There is now exactly one
    // decoder, and this fails the build if a second one appears.
    //
    // Fails closed: an unreadable source directory is a failure, not a pass.
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let entries = std::fs::read_dir(&src).expect("the engine's src/ must be readable");
    let mut scanned = 0;
    for e in entries {
        let path = e.expect("readable dir entry").path();
        if path.extension().and_then(|x| x.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let body = std::fs::read_to_string(&path).expect("readable source file");
        scanned += 1;
        if name == "fileset.rs" || name == "entry.rs" {
            continue;
        }
        assert!(
            !body.contains("base64_decode"),
            "{name} decodes base64 itself — the `bin` half of the envelope belongs to \
             fileset.rs alone (one parser, one kind decision)"
        );
    }
    assert!(scanned > 5, "the guard scanned almost nothing: {scanned}");
    assert!(
        std::fs::read_to_string(src.join("fileset.rs"))
            .unwrap()
            .contains("base64_decode"),
        "the guard is anchored to a real decoder living in fileset.rs"
    );
}

// ── round 43, fix round 2: the two findings the validator upheld ─────────────────────────────────

#[test]
fn a_text_shaped_bin_value_never_reaches_disk_with_its_bytes_rewritten() {
    // The upheld HIGH. Canonicalizing a `bin` value to Text (because its bytes happen to be valid
    // UTF-8 with no NUL) hands those bytes to `normalize_fileset`, which is the ONE thing an
    // explicitly-binary entry must never meet: `YQ0KYg==` is `a\r\nb`, and it landed on disk as
    // `a\nb`. The kind test alone could not see it — it checked the bytes BEFORE normalization.
    let blob = r##"{"files":{"SKILL.md":"# s"},"bin":{"asset":"YQ0KYg=="}}"##;
    if let Ok(mut f) = parse_fileset(blob) {
        skill_engine::import::normalize_fileset(&mut f);
        let tmp = tempfile::tempdir().unwrap();
        let dir = skill_engine::materialize::materialize_fileset(tmp.path(), "s", &f).unwrap();
        assert_eq!(
            std::fs::read(dir.join("asset")).unwrap(),
            b"a\r\nb",
            "an entry the envelope declared BINARY was rewritten on its way to disk"
        );
    }
    // The contract this settles on: a `bin` value whose bytes are not binary is not a fileset the
    // engine can produce (`serialize_fileset` routes text entries to `files`), so it is a
    // MALFORMED envelope — refused, never silently retagged. Fail closed, and no entry can then
    // carry two identities: every accepted entry's kind is what disk will give it back.
    let err = parse_fileset(blob).expect_err("a text-shaped `bin` value must be refused");
    assert!(
        err.to_string().contains("asset"),
        "the error must name the offending path, got: {err}"
    );
    for bad in [
        r##"{"files":{},"bin":{"a":"QQ=="}}"##,     // "A" — plain text
        r##"{"files":{},"bin":{"a":""}}"##,         // empty — an empty file reads back as Text
        r##"{"files":{},"bin":{"a":"YQ0KYg=="}}"##, // a\r\nb
    ] {
        assert!(parse_fileset(bad).is_err(), "must refuse {bad}");
        assert!(
            skill_engine::fileset::parse_envelope(bad).is_err(),
            "must refuse {bad}"
        );
    }
    // and a GENUINELY binary value — the case #206 exists for — still parses and still round-trips
    // byte-identically through normalize + materialize, CRLF bytes and all.
    let good = format!(
        r##"{{"files":{{"SKILL.md":"# s\r\n"}},"bin":{{"assets/icon.png":"{}"}}}}"##,
        skill_engine::entry::base64_encode(PNG)
    );
    let mut f = parse_fileset(&good).unwrap();
    skill_engine::import::normalize_fileset(&mut f);
    let tmp = tempfile::tempdir().unwrap();
    let dir = skill_engine::materialize::materialize_fileset(tmp.path(), "s", &f).unwrap();
    assert_eq!(std::fs::read(dir.join("assets/icon.png")).unwrap(), PNG);
    assert_eq!(std::fs::read(dir.join("SKILL.md")).unwrap(), b"# s\n");
}

#[test]
fn legacy_raw_json_is_not_an_envelope_just_because_it_mentions_files_or_bin() {
    // The upheld MEDIUM. A SKILL.md is allowed to be ANY text, JSON included; the envelope
    // discriminator has to be envelope SHAPE, not the mere presence of a key name. `files` counts
    // only as an OBJECT (every real envelope has one — `serialize_fileset` always emits it, even
    // empty), and `bin` only as an object, which is what keeps the invalid-base64 rejection.
    for raw in [
        r##"{"files":"documentation about files"}"##,
        r##"{"bin":"a descriptive label"}"##,
        r##"{"files":42}"##,
        r##"{"files":null}"##,
        r##"{"bin":[]}"##,
    ] {
        let f = parse_fileset(raw)
            .unwrap_or_else(|e| panic!("{raw} is legacy markdown, not an envelope: {e}"));
        assert_eq!(f.len(), 1, "{raw}");
        assert_eq!(f["SKILL.md"], raw);
    }
    // A `bin` OBJECT is an attempted envelope and is still held to the contract — this is the
    // hazard the earlier round closed and it must stay closed.
    for bad in [
        r##"{"files":null,"bin":{"assets/icon.png":"%%%"}}"##,
        r##"{"files":[],"bin":{"assets/icon.png":"%%%"}}"##,
        r##"{"bin":{"assets/icon.png":"%%%"}}"##,
        r##"{"bin":{"a.png":"QQ=="}}"##,
    ] {
        assert!(parse_fileset(bad).is_err(), "malformed envelope: {bad}");
    }
}

#[test]
fn the_canonical_serializer_can_never_produce_an_envelope_the_parser_refuses() {
    // Round 43, fix round 3 (the validator's HIGH): producer/consumer CLOSURE. `serialize_fileset`
    // is the only writer of an envelope and `parse_fileset` the only reader, so for EVERY fileset
    // the type can hold, `parse(serialize(f)) == f`. It did not hold: `Binary` accepted any bytes,
    // including text ones, while the parser refuses a `bin` value whose bytes are text — so a
    // fileset the type permitted could be written and never read back (`materialize_and_index`
    // rejecting it outright, `read_base` degrading to no base at all).
    //
    // The fix is at the TYPE, not the parser: bytes are classified by the one constructor, so
    // "binary entry holding text bytes" is unconstructible and the refusal is unreachable from
    // the producer while still failing closed on a forged envelope.
    for bytes in [
        b"a\r\nb".to_vec(),           // text bytes — must never land under `bin`
        b"QQ".to_vec(),               // text that also looks like base64
        b"".to_vec(),                 // empty
        b"# hi\n".to_vec(),           // ordinary markdown
        vec![0x00, 0x00, 0x00],       // NUL-only
        b"a\0b".to_vec(),             // UTF-8 with a NUL
        PNG.to_vec(),                 // real binary
        vec![0xFF, 0xFE, 0x0D, 0x0A], // non-UTF-8 carrying CRLF
    ] {
        let f = fs_of(&[("asset", FileEntry::from_bytes(bytes.clone()))]);
        let blob = serialize_fileset(&f);
        let back = parse_fileset(&blob)
            .unwrap_or_else(|e| panic!("canonical envelope for {bytes:?} refused: {e}"));
        assert_eq!(back, f, "round-trip changed the fileset for {bytes:?}");
        assert_eq!(back["asset"].as_bytes(), &bytes[..], "bytes for {bytes:?}");
    }
    // The shape the type USED to permit — text bytes tagged binary — is now unconstructible:
    // `FileEntry::Binary(b"a\r\nb".to_vec())` does not compile, and `FileEntry::text` /
    // `from_bytes` both classify, so no caller can hand the serializer one.
    assert!(!FileEntry::text("a\r\nb").is_binary());
    assert!(!FileEntry::from_bytes(b"a\r\nb".to_vec()).is_binary());
    // A FORGED envelope still fails closed rather than being retagged.
    let forged = format!(
        r##"{{"files":{{}},"bin":{{"asset":"{}"}}}}"##,
        skill_engine::entry::base64_encode(b"a\r\nb")
    );
    assert!(
        parse_fileset(&forged).is_err(),
        "a text-shaped `bin` value is not something any producer can write; refuse it"
    );
}
