//! Atomic materialization of a skill's files into a target (canonical or tool) directory.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Materialize a multi-file skill at `agents_root/<slug>/` **atomically as a whole skill**.
///
/// Per-FILE atomicity is not enough. The previous implementation wrote each file with its own
/// temp→fsync→rename and then pruned, so a crash mid-loop left a tree mixing old and new files,
/// with stale files unpruned and nothing able to detect it — and the displaced version was
/// overwritten in place rather than retained, making the engine LESS crash-safe than the
/// agent-deck code it replaces (review, both models; contract spec section 5).
///
/// So: stage the entire tree, fsync every file, then swap the directory into place in one
/// rename. A crash leaves either the old skill or the new one, never a blend.
///
/// Two deliberate consequences:
/// * Staging lives INSIDE the catalog under a dot-directory, and `scope::discover_scope` reads
///   only direct children, so a half-written skill is never discoverable. Staging in the
///   catalog's PARENT was worse: for `<root>/.agents/skills` that escapes into a shared
///   directory, where two catalogs — or two tests — collide.
/// * The staged name carries a process-unique counter as well as the pid, because the same
///   process can legitimately materialize the same slug into two catalogs at once.
/// * There is a sub-millisecond window during the swap where the skill directory does not exist.
///   The old code never had one (it only ever added/overwrote files). That is the price of
///   whole-skill atomicity on a platform without atomic directory exchange; a watching agent
///   re-reads on the next event. Pruning is gone: the staged tree IS exactly the fileset.
pub fn materialize_fileset<V: crate::entry::AsEntry>(
    agents_root: &Path,
    slug: &str,
    files: &BTreeMap<String, V>,
) -> std::io::Result<PathBuf> {
    // A path-building SINK. It enforces CONTAINMENT and filesystem legality (the derived-name
    // budget); the stricter base budget belongs at the name-ENTRY points, whose job is to leave
    // headroom so a name the engine DERIVES from a slug still fits here.
    //
    // Containment belongs where a name becomes a path, not in each
    // caller that remembers. The callers forgot repeatedly — `acknowledge_recovery` joined an
    // unvalidated token, `fan_out` an unvalidated slug, `sync_once` a cloud-manifest slug its
    // sibling `resync_skill` validated.
    //
    // A previous version of this comment claimed this and `ensure_link` were the ONLY two
    // sinks, so the class was closed. That was WRONG (review, Codex): `materialize_skill`,
    // `copy_skill`, `write_cursor_rule`, `disable_skill` and the conflict-copy reservation
    // all built paths from names too. They are guarded now, but the honest framing is that
    // this is one guarded sink among several — ENUMERATE before claiming a class is closed.
    crate::store::check_derived_name(slug).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{slug}: {e}"))
    })?;
    let dir = agents_root.join(slug);
    let staging_root = agents_root.join(".syncr-staging");
    fs::create_dir_all(&staging_root)?;
    let txn = next_txn_id();
    let staged = staging_root.join(format!("{slug}.{txn}"));
    let _ = fs::remove_dir_all(&staged);
    fs::create_dir_all(&staged)?;

    for (rel, content) in files {
        // Containment for the fileset KEYS, not just the skill name. `check_slug` guards the slug
        // and this guards every path inside it — the same class of check at the other half of the
        // same ingest, which is exactly the sibling-shaped gap this codebase keeps producing: a
        // key of `../../victim` or `/etc/passwd` otherwise reaches `File::create` directly.
        // Present callers sanitize upstream (import.rs strips symlinks and `..`), but
        // `fileset::parse_fileset` builds a map straight from a cloud version blob, whose keys are
        // not locally validated — so the guard belongs HERE, at the write, not at each caller.
        check_rel_path(rel)?;
        let path = staged.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = fs::File::create(&path)?;
        // bytes, not a string: a binary entry must land byte-identically (#206)
        f.write_all(content.entry_ref().bytes())?;
        f.sync_all()?;
    }

    fs::create_dir_all(agents_root)?;
    let result = swap_into_place(&staged, &dir);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staged);
    }
    // best-effort: drop the staging root once empty, so the catalog's parent stays tidy
    let _ = fs::remove_dir(&staging_root);
    result.map(|_| dir)
}

/// Replace `target` with `staged` as close to atomically as the platform allows: displace the old
/// tree, move the new one in, then drop the displaced. If the second rename fails the displaced
/// tree is restored, so a failure leaves the ORIGINAL skill intact rather than nothing.
/// A fileset key must be a relative path of ordinary components — no root, no prefix, no `..`,
/// no `.`. Returns InvalidInput so the caller surfaces a permanent error rather than a retryable
/// one.
fn check_rel_path(rel: &str) -> std::io::Result<()> {
    use std::path::Component;
    if rel.is_empty() || rel.contains('\0') {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid fileset path: {rel:?}"),
        ));
    }
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(_) => {}
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("fileset path escapes the skill directory: {rel}"),
                ))
            }
        }
    }
    Ok(())
}

/// A process-unique transaction id. Both the staged AND the displaced directory carry it: naming
/// the displaced tree by pid alone let two same-process writers of the same slug collide on one
/// `.slug.displaced.<pid>` path — verified, 14 of 40 concurrent rounds left an orphan holding a
/// full copy of the previous tree. The NAPI consumer is in-process and multi-request, which is
/// exactly that setting.
fn next_txn_id() -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!(
        "{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

fn swap_into_place(staged: &Path, target: &Path) -> std::io::Result<()> {
    let displaced = target.with_file_name(format!(
        ".{}.displaced.{}",
        target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "skill".into()),
        next_txn_id()
    ));
    let had_old = target.exists();
    if had_old {
        rename_retry(target, &displaced)?;
    }
    match rename_retry(staged, target) {
        Ok(()) => {
            if had_old {
                let _ = fs::remove_dir_all(&displaced);
            }
            Ok(())
        }
        Err(e) => {
            // Roll back, so a failed swap is a no-op rather than a deletion. The restore RETRIES
            // for the same reason the forward rename does (a watcher holding a handle), and if it
            // still fails we must not report only the forward error — the skill is now missing and
            // its content is sitting in `displaced`. Say so, with the path, so it is recoverable.
            if had_old {
                if let Err(restore_err) = rename_retry(&displaced, target) {
                    return Err(std::io::Error::other(format!(
                        "swap failed ({e}) AND rollback failed ({restore_err}); previous version retained at {}",
                        displaced.display()
                    )));
                }
            }
            Err(e)
        }
    }
}

/// Rename with a short retry. On Windows a rename fails while any file in the tree is open —
/// agents live-watch these directories, so a transient sharing violation is expected rather
/// than exceptional (agent-deck hit the same RESOURCE_BUSY class in its native swap).
fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..5 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(10 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// Write `content` to `agents_root/<slug>/SKILL.md` atomically: a temp file in the
/// same directory, fsync, then `rename`. Never leaves a partially-written SKILL.md
/// (agents live-watch these dirs).
pub fn materialize_skill(
    agents_root: &Path,
    slug: &str,
    content: &str,
) -> std::io::Result<PathBuf> {
    // A path-building SINK: see `materialize_fileset`. The claim that there were only two of
    // these was WRONG (review, Codex) — this is one of five more it enumerated.
    crate::store::check_derived_name(slug).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{slug}: {e}"))
    })?;
    let dir = agents_root.join(slug);
    fs::create_dir_all(&dir)?;
    let final_path = dir.join("SKILL.md");
    let tmp_path = dir.join(format!(".SKILL.md.tmp.{}", std::process::id()));
    {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp_path, &final_path)?; // atomic on the same filesystem
    Ok(final_path)
}

#[cfg(test)]
mod tests {
    // The slug is guarded by store::check_slug; the KEYS inside the fileset were not. A cloud
    // version blob reaches parse_fileset with unvalidated keys, so the guard belongs at the write.
    #[test]
    fn fileset_keys_that_escape_the_skill_directory_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in [
            "../escape.txt",
            "../../escape.txt",
            "a/../../escape.txt",
            "/abs.txt",
            "./x.txt",
        ] {
            let files = std::collections::BTreeMap::from([(bad.to_string(), "pwn".to_string())]);
            let e = super::materialize_fileset(tmp.path(), "victim", &files).unwrap_err();
            assert_eq!(
                e.kind(),
                std::io::ErrorKind::InvalidInput,
                "{bad} must be refused"
            );
        }
        // nothing escaped, and no partial skill was left behind
        assert!(!tmp.path().join("escape.txt").exists());
        assert!(!tmp.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn ordinary_nested_keys_still_work() {
        let tmp = tempfile::tempdir().unwrap();
        let files = std::collections::BTreeMap::from([
            ("SKILL.md".to_string(), "x".to_string()),
            ("scripts/run.sh".to_string(), "echo".to_string()),
            ("references/deep/notes.md".to_string(), "n".to_string()),
        ]);
        let dir = super::materialize_fileset(tmp.path(), "ok", &files).unwrap();
        assert!(dir.join("scripts/run.sh").exists());
        assert!(dir.join("references/deep/notes.md").exists());
    }

    use super::*;

    #[test]
    fn writes_skill_md_with_exact_content() {
        let tmp = tempfile::tempdir().unwrap();
        let p = materialize_skill(tmp.path(), "git-helper", "# Git\nbody").unwrap();
        assert_eq!(p, tmp.path().join("git-helper").join("SKILL.md"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "# Git\nbody");
    }

    #[test]
    fn leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        materialize_skill(tmp.path(), "x", "abc").unwrap();
        let dir = tmp.path().join("x");
        let temps: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(temps.is_empty(), "temp files left behind");
    }

    #[test]
    fn materialize_fileset_prunes_files_removed_from_the_skill() {
        let tmp = tempfile::tempdir().unwrap();
        // first sync: a 3-file skill with a nested script
        let mut v1 = BTreeMap::new();
        v1.insert("SKILL.md".to_string(), "# s".to_string());
        v1.insert("scripts/run.sh".to_string(), "echo hi".to_string());
        v1.insert("references/old.md".to_string(), "# old".to_string());
        let dir = materialize_fileset(tmp.path(), "use-railway", &v1).unwrap();
        assert!(dir.join("scripts/run.sh").exists());
        assert!(dir.join("references/old.md").exists());

        // re-sync with the script and the whole references/ dir dropped upstream
        let mut v2 = BTreeMap::new();
        v2.insert("SKILL.md".to_string(), "# s2".to_string());
        materialize_fileset(tmp.path(), "use-railway", &v2).unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "# s2",
            "kept file updated"
        );
        assert!(
            !dir.join("scripts/run.sh").exists(),
            "removed file must be pruned"
        );
        assert!(
            !dir.join("scripts").exists(),
            "emptied dir must be cleaned up"
        );
        assert!(
            !dir.join("references/old.md").exists(),
            "removed nested file must be pruned"
        );
        assert!(
            !dir.join("references").exists(),
            "emptied nested dir must be cleaned up"
        );
    }

    #[test]
    fn materialize_fileset_writes_every_file_at_its_subpath() {
        let tmp = tempfile::tempdir().unwrap();
        let mut files = BTreeMap::new();
        files.insert("SKILL.md".to_string(), "# s".to_string());
        files.insert("scripts/run.sh".to_string(), "echo hi".to_string());
        files.insert("references/a.md".to_string(), "# a".to_string());
        files.insert(".mcp.json".to_string(), "{}".to_string());

        let dir = materialize_fileset(tmp.path(), "use-railway", &files).unwrap();
        assert_eq!(dir, tmp.path().join("use-railway"));
        assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "# s");
        assert_eq!(
            fs::read_to_string(dir.join("scripts/run.sh")).unwrap(),
            "echo hi"
        );
        assert_eq!(
            fs::read_to_string(dir.join("references/a.md")).unwrap(),
            "# a"
        );
        assert_eq!(fs::read_to_string(dir.join(".mcp.json")).unwrap(), "{}");
        // no temp files left in nested dirs
        let temps: Vec<_> = fs::read_dir(dir.join("scripts"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(temps.is_empty());
    }
}
