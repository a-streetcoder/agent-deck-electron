//! #206 — binary-safe skill filesets.
//!
//! A single `.png` in a skill folder currently makes the WHOLE folder unreadable:
//! `import.rs` does `String::from_utf8(bytes)` and turns any non-UTF-8 FILE into
//! `ImportError::NonUtf8` → `StoreError::InvalidUtf8`, so inspection and import are
//! all-or-nothing per folder. Observed in agent-deck 2026-08-27: `~/.codex/skills/.system/*`
//! ship `assets/*.png`, so "Import from Claude & Codex" reports `couldn't read: Codex · Global`.
//!
//! The Agent Skills format does not restrict a skill to text. These tests pin the behaviour the
//! engine must have: binary bytes survive ingest → hash → materialize → three-way merge
//! byte-identically, and only a non-UTF-8 PATH is still an error.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use skill_engine::repos::{
    conflict_paths, import_git_repo, resolve_git_conflict_paths, sync_git_repo, Resolution,
};
use skill_engine::scope::{canonical_catalog, Scope};
use skill_engine::store::{import_local_folder, inspect_local_folder};

/// Real PNG signature, then a NUL, then bytes that are not valid UTF-8, then a CRLF pair —
/// every hazard in one fixture: the 0x00 that must force Binary even where the bytes decode,
/// the 0xFF 0xFE that cannot decode at all, and the 0x0D 0x0A that newline normalization
/// would rewrite if it ever touched a binary entry.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x0D, 0x0A, 0xFF, 0xFE, 0x0D, 0x0A, 0x42,
];

/// A second, DIFFERENT png — the "upstream changed it" side of a binary conflict.
const PNG_V2: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFE, 0xFF, 0x0D, 0x0A, 0x99,
];

/// And a third — the "I changed it locally" side.
const PNG_LOCAL: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0x02, 0xC3, 0x28, 0x0D, 0x0A,
];

fn write_bytes(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn write_text(path: &Path, text: &str) {
    write_bytes(path, text.as_bytes());
}

/// A folder the user could pick in a file dialog, holding one skill with a binary asset.
fn local_folder_with_a_png(dir: &Path) -> PathBuf {
    let root = dir.join("picked");
    write_text(
        &root.join("imagegen/SKILL.md"),
        "---\nname: imagegen\ndescription: Generate images\n---\n# imagegen\n",
    );
    write_text(&root.join("imagegen/reference.md"), "# refs\n");
    write_bytes(&root.join("imagegen/assets/icon.png"), PNG);
    root
}

#[test]
fn a_png_asset_no_longer_makes_the_whole_folder_unreadable() {
    let tmp = tempfile::tempdir().unwrap();
    let root = local_folder_with_a_png(tmp.path());
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let previews = inspect_local_folder(&home, &root)
        .expect("a skill carrying a binary asset must be inspectable, not RESOURCE_INVALID_UTF8");
    assert_eq!(previews.len(), 1, "{previews:?}");
    assert_eq!(previews[0].name, "imagegen");
    assert_eq!(
        previews[0].file_count, 3,
        "the binary file counts like any other file"
    );
    assert!(
        previews[0]
            .skill_md
            .as_deref()
            .is_some_and(|s| s.contains("# imagegen")),
        "the text SKILL.md is still previewable: {:?}",
        previews[0].skill_md
    );

    let imported = import_local_folder(&home, None, Scope::Global, &root, None).unwrap();
    assert_eq!(imported, vec!["imagegen".to_string()]);

    let materialized = canonical_catalog(&home).join("imagegen/assets/icon.png");
    assert_eq!(
        std::fs::read(&materialized).unwrap(),
        PNG,
        "the materialized binary must be byte-identical to the source"
    );
    assert_eq!(
        std::fs::read_to_string(canonical_catalog(&home).join("imagegen/reference.md")).unwrap(),
        "# refs\n",
        "the text sibling survives too"
    );
}

#[test]
fn newline_normalization_touches_text_only_never_binary_and_never_a_bat() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("picked");
    write_text(
        &root.join("kit/SKILL.md"),
        "---\nname: kit\ndescription: Kit\n---\n# kit\n",
    );
    write_text(&root.join("kit/notes.txt"), "one\r\ntwo\r\n");
    write_text(&root.join("kit/run.bat"), "@echo off\r\ngoto end\r\n");
    write_bytes(&root.join("kit/assets/icon.png"), PNG);
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    import_local_folder(&home, None, Scope::Global, &root, None).unwrap();
    let out = canonical_catalog(&home).join("kit");

    assert_eq!(
        std::fs::read_to_string(out.join("notes.txt")).unwrap(),
        "one\ntwo\n",
        "ordinary text is still normalized to LF at ingest"
    );
    assert_eq!(
        std::fs::read_to_string(out.join("run.bat")).unwrap(),
        "@echo off\r\ngoto end\r\n",
        "cmd.exe parses batch files by byte offset — is_crlf_sensitive still applies"
    );
    assert_eq!(
        std::fs::read(out.join("assets/icon.png")).unwrap(),
        PNG,
        "a binary entry containing 0x0D 0x0A must survive byte-identically"
    );
}

#[test]
#[allow(non_snake_case)] // the capitals are the point of the name
fn a_non_utf8_PATH_is_still_refused_and_the_message_names_the_PATH() {
    // Non-UTF-8 CONTENT stops being an error in this slice; a non-UTF-8 PATH does NOT — the
    // fileset key is a JSON string, so it must stay an error. What changes is the MESSAGE: today
    // it blames "content", which is now the one thing that is fine, and an operator reading
    // `RESOURCE_INVALID_UTF8` after this slice has exactly one possible cause to look for.
    assert_eq!(
        skill_engine::import::ImportError::NonUtf8(PathBuf::from("/s/na?me.md")).to_string(),
        "non-UTF-8 path: /s/na?me.md",
        "the import error must name the PATH"
    );
    let err = skill_engine::store::StoreError::InvalidUtf8("/s/na?me.md".to_string());
    assert_eq!(err.code(), "RESOURCE_INVALID_UTF8");
    let msg = err.to_string();
    assert!(
        msg.contains("path") && !msg.contains("content"),
        "the store error must name the PATH, not blame content: {msg}"
    );
}

#[test]
#[cfg(unix)]
#[allow(non_snake_case)] // the capitals are the point of the name
fn a_skill_whose_FILENAME_is_not_utf8_fails_closed_on_a_filesystem_that_allows_one() {
    // The end-to-end half of the rule above. APFS rejects such a name outright (EILSEQ), so on
    // macOS this skips rather than pretending to have proven anything; ext4 and CI Linux allow it.
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("picked");
    write_text(
        &root.join("kit/SKILL.md"),
        "---\nname: kit\ndescription: Kit\n---\n# kit\n",
    );
    let bad = root.join("kit").join(OsStr::from_bytes(b"na\xFFme.md"));
    if std::fs::write(&bad, "text").is_err() {
        println!("skip: this filesystem refuses a non-UTF-8 filename (EILSEQ)");
        return;
    }
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let err = inspect_local_folder(&home, &root)
        .expect_err("a non-UTF-8 path must still fail closed — the envelope key cannot hold it");
    assert_eq!(err.code(), "RESOURCE_INVALID_UTF8");
}

// ---------------------------------------------------------------------------------------------
// Git collections: a binary path in the three-way merge.
// ---------------------------------------------------------------------------------------------

fn git_in(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn commit_all(repo: &Path, msg: &str) {
    git_in(repo, &["add", "-A"]);
    git_in(repo, &["commit", "-q", "-m", msg]);
}

/// A repo whose single skill carries a binary asset; returns (url, repo_workdir).
fn binary_repo_fixture(dir: &Path) -> (String, PathBuf) {
    let repo = dir.join("upstream");
    write_text(
        &repo.join("kit/SKILL.md"),
        "---\nname: kit\ndescription: Kit skill\n---\n# kit v1",
    );
    write_text(&repo.join("kit/scripts/a.sh"), "echo a-v1");
    write_bytes(&repo.join("kit/assets/icon.png"), PNG);
    git_in(&repo, &["init", "-q"]);
    git_in(&repo, &["config", "user.email", "t@t.t"]);
    git_in(&repo, &["config", "user.name", "t"]);
    commit_all(&repo, "init");
    (format!("file://{}", repo.to_str().unwrap()), repo)
}

fn local_path(home: &Path, name: &str, rel: &str) -> PathBuf {
    canonical_catalog(home).join(name).join(rel)
}

#[test]
fn a_git_import_carries_a_binary_asset_through_byte_identically() {
    let tmp = tempfile::tempdir().unwrap();
    let (url, _repo) = binary_repo_fixture(tmp.path());
    let home = tmp.path().join("home");
    let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None)
        .expect("a repo whose skill carries a PNG must import");
    assert_eq!(out.skills, vec!["kit"]);
    assert_eq!(
        std::fs::read(local_path(&home, "kit", "assets/icon.png")).unwrap(),
        PNG
    );
    // and a second sync with nothing changed is clean — which only holds if the BASE snapshot
    // round-tripped the binary through the envelope (write_base → read_base). A base that drops
    // the PNG reads as both-sides motion and reports a permanent false conflict.
    let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
    assert_eq!(r.conflicts, Vec::<String>::new(), "{r:?}");
    assert_eq!(r.applied, Vec::<String>::new(), "{r:?}");
}

/// Both sides move the same binary path → a conflict whose kind is `binary` on both sides, the
/// local bytes untouched until the user chooses.
fn diverge_the_png(tmp: &Path) -> (PathBuf, String, PathBuf) {
    let (url, repo) = binary_repo_fixture(tmp);
    let home = tmp.join("home");
    let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
    write_bytes(&local_path(&home, "kit", "assets/icon.png"), PNG_LOCAL);
    write_bytes(&repo.join("kit/assets/icon.png"), PNG_V2);
    commit_all(&repo, "upstream repaints the icon");
    let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
    assert_eq!(r.conflicts, vec!["kit"], "{r:?}");
    assert_eq!(
        std::fs::read(local_path(&home, "kit", "assets/icon.png")).unwrap(),
        PNG_LOCAL,
        "a conflict never writes — the local bytes stay until the user resolves"
    );
    (home, out.collection_id, repo)
}

#[test]
fn a_both_sides_binary_change_is_a_conflict_of_kind_binary() {
    let tmp = tempfile::tempdir().unwrap();
    let (home, collection_id, _repo) = diverge_the_png(tmp.path());

    let (merge_id, paths) = conflict_paths(&home, None, &collection_id, "kit").unwrap();
    assert!(!merge_id.is_empty());
    assert_eq!(
        paths.len(),
        1,
        "only the both-sides path conflicts: {paths:?}"
    );
    assert_eq!(paths[0].path, "assets/icon.png");
    assert_eq!(
        (paths[0].local_kind.as_str(), paths[0].remote_kind.as_str()),
        ("binary", "binary"),
        "a binary side reports the fourth kind so the host can label it, not \"file\""
    );
}

#[test]
fn resolving_a_binary_conflict_as_remote_applies_the_upstream_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let (home, collection_id, _repo) = diverge_the_png(tmp.path());
    let (merge_id, _paths) = conflict_paths(&home, None, &collection_id, "kit").unwrap();

    resolve_git_conflict_paths(
        &home,
        None,
        &collection_id,
        "kit",
        &merge_id,
        &[("assets/icon.png".to_string(), Resolution::Remote)],
    )
    .unwrap();

    assert_eq!(
        std::fs::read(local_path(&home, "kit", "assets/icon.png")).unwrap(),
        PNG_V2,
        "no text coercion anywhere on the remote path"
    );
    let r = sync_git_repo(&home, None, &collection_id).unwrap();
    assert_eq!(
        r.conflicts,
        Vec::<String>::new(),
        "settled: the base advanced through the envelope, so the next sync is clean — {r:?}"
    );
}

#[test]
fn resolving_a_binary_conflict_as_mine_keeps_the_local_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let (home, collection_id, _repo) = diverge_the_png(tmp.path());
    let (merge_id, _paths) = conflict_paths(&home, None, &collection_id, "kit").unwrap();

    // "mine" is the DEFAULT — an omitted path keeps the local side (three_way already put it in
    // merged), and the settle must still advance the base so the divergence stops re-flagging.
    resolve_git_conflict_paths(&home, None, &collection_id, "kit", &merge_id, &[]).unwrap();

    assert_eq!(
        std::fs::read(local_path(&home, "kit", "assets/icon.png")).unwrap(),
        PNG_LOCAL,
        "the user's bytes are kept verbatim"
    );
    let r = sync_git_repo(&home, None, &collection_id).unwrap();
    assert_eq!(r.conflicts, Vec::<String>::new(), "{r:?}");
    assert_eq!(
        std::fs::read(local_path(&home, "kit", "assets/icon.png")).unwrap(),
        PNG_LOCAL,
        "and the NEXT sync does not quietly overwrite them"
    );
}

#[test]
fn an_upstream_only_binary_change_auto_applies() {
    let tmp = tempfile::tempdir().unwrap();
    let (url, repo) = binary_repo_fixture(tmp.path());
    let home = tmp.path().join("home");
    let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

    write_bytes(&repo.join("kit/assets/icon.png"), PNG_V2);
    commit_all(&repo, "upstream repaints the icon");

    let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
    assert_eq!(r.applied, vec!["kit"], "{r:?}");
    assert_eq!(r.conflicts, Vec::<String>::new(), "{r:?}");
    assert_eq!(
        std::fs::read(local_path(&home, "kit", "assets/icon.png")).unwrap(),
        PNG_V2
    );
}

#[test]
#[allow(non_snake_case)] // the capitals are the point of the name
fn rewriting_SKILL_md_no_longer_refuses_a_skill_that_has_a_binary_sibling() {
    // The behaviour this slice deliberately INVERTS. store.rs refuses the rewrite today
    // ("refusing is the only correct answer until the fileset carries bytes") because reading the
    // tree errored on the PNG and the whole-directory swap would have deleted it. The GUARANTEE —
    // every sibling survives a SKILL.md rewrite — is unchanged; the mechanism is no longer refusal.
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path();
    skill_engine::store::write_skill(
        home,
        "deploy",
        "---\nname: Deploy\ndescription: d\n---\n# v1",
    )
    .unwrap();
    let dir = canonical_catalog(home).join("deploy");
    write_bytes(&dir.join("references/logo.png"), PNG);
    write_text(&dir.join("scripts.sh"), "echo hi");

    skill_engine::store::write_skill(
        home,
        "deploy",
        "---\nname: Deploy\ndescription: d\n---\n# v2",
    )
    .expect("a binary sibling must no longer block a rewrite");

    assert_eq!(
        std::fs::read(dir.join("references/logo.png")).unwrap(),
        PNG,
        "the binary sibling survives the whole-directory swap byte-identically"
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("scripts.sh")).unwrap(),
        "echo hi"
    );
    assert!(std::fs::read_to_string(dir.join("SKILL.md"))
        .unwrap()
        .contains("# v2"));
}

#[test]
fn a_text_only_fileset_still_hashes_and_serializes_exactly_as_before() {
    // Hashes are IDENTITY here: the collection cursor, the base snapshot and (through
    // syncr-core) local history all key off `fileset_hash`, and every already-installed store
    // holds hashes computed by today's code. If a text-only fileset hashes one bit differently,
    // every skill on every machine looks changed at once. These literals were computed on main
    // (1463c7e) before the FileEntry migration.
    let a: BTreeMap<String, String> = [
        ("SKILL.md".to_string(), "# s\n".to_string()),
        ("refs/a.md".to_string(), "# a\n".to_string()),
    ]
    .into_iter()
    .collect();
    let b: BTreeMap<String, String> = [("SKILL.md".to_string(), "# s".to_string())]
        .into_iter()
        .collect();

    assert_eq!(
        skill_engine::repos::fileset_hash(&a),
        "06bbb21618d7fd053620cb9d67d98f6d116440ece560cdfbdf8655059b2342b0"
    );
    assert_eq!(
        skill_engine::repos::fileset_hash(&b),
        "718206c297052e30ff56cdbceb04f38659f45998408409e1218713f2e9216abc"
    );
    assert_eq!(
        skill_engine::fileset::serialize_fileset(&a),
        r##"{"files":{"SKILL.md":"# s\n","refs/a.md":"# a\n"}}"##
    );
    assert_eq!(
        skill_engine::fileset::serialize_fileset(&b),
        r##"{"files":{"SKILL.md":"# s"}}"##
    );
}

#[test]
#[cfg(unix)]
fn the_two_unsafe_causes_stop_collapsing_into_one_symlink_shaped_message() {
    // `repos::import_err` maps BOTH `UnsafeSymlink` and `UnsafeEntry` to
    // `StoreError::UnsafeComponent(path)`, discarding which one it was — so a fifo or a device
    // node in a skill tree is reported to the user as an unsafe *path component*, and agent-deck
    // shows the symlink wording for a cause that has nothing to do with links. Same code
    // (`RESOURCE_UNSAFE_COMPONENT`, unchanged), different message.
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    // (a) a symlink inside the tree
    let a = tmp.path().join("with-link");
    write_text(
        &a.join("kit/SKILL.md"),
        "---\nname: kit\ndescription: Kit\n---\n# kit\n",
    );
    write_text(&a.join("target.md"), "x");
    std::os::unix::fs::symlink(a.join("target.md"), a.join("kit/link.md")).unwrap();
    let err = inspect_local_folder(&home, &a).expect_err("a symlink inside a skill tree is unsafe");
    assert_eq!(err.code(), "RESOURCE_UNSAFE_COMPONENT");
    assert!(
        err.to_string().contains("symlink"),
        "the symlink cause must say symlink: {err}"
    );

    // (b) a fifo inside the tree — NOT a symlink, and the message must not claim one
    let b = tmp.path().join("with-fifo");
    write_text(
        &b.join("kit/SKILL.md"),
        "---\nname: kit\ndescription: Kit\n---\n# kit\n",
    );
    let fifo = b.join("kit/pipe");
    let ok = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        println!("skip: mkfifo unavailable");
        return;
    }
    let err = inspect_local_folder(&home, &b).expect_err("a fifo in a skill tree is unsafe");
    assert_eq!(err.code(), "RESOURCE_UNSAFE_COMPONENT");
    let msg = err.to_string();
    assert!(
        !msg.contains("symlink"),
        "a fifo is not a symlink — the message must name the real cause: {msg}"
    );
    assert!(
        msg.contains("non-regular"),
        "the message must name the real cause: {msg}"
    );
}
