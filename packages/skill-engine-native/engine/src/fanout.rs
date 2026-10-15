//! Fan a canonical skill (~/.agents/skills/<slug>) out into each detected tool's
//! skills dir via symlink, with a copy fallback and dedup by resolved path.
//! Reconciliation repairs broken/missing/wrong-target links idempotently.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkStatus {
    Valid,
    Missing,
    Broken,
    WrongTarget,
    NotALink,
    /// The NAME was refused by containment — distinct from `Missing`, which means the link
    /// is simply absent. Collapsing the two made the sink's validation invisible to
    /// `fan_out`'s callers (review, Codex).
    Refused,
}

/// Status of `link_path` as a link to `canonical`.
pub fn link_status(link_path: &Path, canonical: &Path) -> LinkStatus {
    let meta = match fs::symlink_metadata(link_path) {
        Err(_) => return LinkStatus::Missing,
        Ok(m) => m,
    };
    // NOTE: on Windows `is_symlink()` is TRUE for a directory junction (verified empirically —
    // a junction is a reparse point and Rust reports it as a symlink), and `read_link` resolves
    // it. So the ordinary symlink path below handles junctions correctly and needs no special
    // case. An earlier version of this function carried one, guarded on `!is_symlink()`, which
    // therefore never executed: dead code resting on a false premise about the platform.
    if !meta.file_type().is_symlink() {
        return LinkStatus::NotALink;
    }
    let target = match fs::read_link(link_path) {
        Err(_) => return LinkStatus::Broken,
        Ok(t) => t,
    };
    let resolved = if target.is_absolute() {
        target
    } else {
        link_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(target)
    };
    match (resolved.canonicalize(), canonical.canonicalize()) {
        (Ok(a), Ok(b)) if a == b => LinkStatus::Valid,
        (Err(_), _) => LinkStatus::Broken,
        _ => LinkStatus::WrongTarget,
    }
}

#[cfg(unix)]
fn symlink_dir(canonical: &Path, link_path: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(canonical, link_path)
}
/// Windows: try a SYMLINK, then fall back to a JUNCTION.
///
/// `symlink_dir` needs SeCreateSymbolicLinkPrivilege — administrator or Developer Mode — so on an
/// ordinary Windows account it fails for every tool, which is exactly what the pre-existing
/// fanout/sync test failures were. A directory junction needs no elevation and behaves like a
/// symlink for the read path every coding agent uses. CLAUDE.md specified this ladder from the
/// start ("symlink, Windows junction, or copy-mode"); only the first rung existed.
#[cfg(windows)]
fn symlink_dir(canonical: &Path, link_path: &Path) -> std::io::Result<()> {
    match std::os::windows::fs::symlink_dir(canonical, link_path) {
        Ok(()) => Ok(()),
        Err(_) => junction::create(canonical, link_path),
    }
}

/// Remove a fan-out LINK (never its target).
///
/// `remove_file` deletes a symlink but NOT a Windows junction — a junction is a directory reparse
/// point, so it needs `remove_dir`. Deleting a link is the one operation where getting this wrong
/// is dangerous in both directions: fail, and disable silently leaves the skill in place; use
/// `remove_dir_all`, and you delete the canonical content THROUGH the link. Both removals here are
/// non-recursive, so neither can follow the link to its target.
pub fn remove_link(link_path: &Path) -> std::io::Result<()> {
    match fs::remove_file(link_path) {
        Ok(()) => Ok(()),
        // a junction (and a unix dir-symlink on some platforms) removes as a directory
        Err(_) => fs::remove_dir(link_path),
    }
}

/// Ensure `tool_skills_dir/<slug>` is a symlink to `canonical`. Idempotent; repairs
/// Broken/WrongTarget. Returns the resulting status.
pub fn ensure_link(
    tool_skills_dir: &Path,
    slug: &str,
    canonical: &Path,
) -> std::io::Result<LinkStatus> {
    // The OTHER sink: this is where a name becomes a link path, in a directory belonging to
    // someone else's tool. Same rule, same place — see `materialize_fileset`.
    crate::store::check_derived_name(slug).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{slug}: {e}"))
    })?;
    fs::create_dir_all(tool_skills_dir)?;
    let link_path = tool_skills_dir.join(slug);
    match link_status(&link_path, canonical) {
        LinkStatus::Valid => Ok(LinkStatus::Valid),
        LinkStatus::Missing => {
            symlink_dir(canonical, &link_path)?;
            Ok(LinkStatus::Valid)
        }
        LinkStatus::Broken | LinkStatus::WrongTarget => {
            remove_link(&link_path).ok(); // removes the link, not its target
            symlink_dir(canonical, &link_path)?;
            Ok(LinkStatus::Valid)
        }
        // a real dir/file occupies the slot — caller may fall back to copy-mode
        LinkStatus::NotALink => Ok(LinkStatus::NotALink),
        // `link_status` inspects an existing path and never judges names, so it cannot produce
        // this; the guard above returns Err before we get here. Unreachable, not ignorable.
        LinkStatus::Refused => Ok(LinkStatus::Refused),
    }
}

/// Fan `canonical` out into each tool skills dir, deduped by resolved path.
pub fn fan_out(
    slug: &str,
    canonical: &Path,
    tool_skills_dirs: &[PathBuf],
) -> Vec<(PathBuf, LinkStatus)> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out = Vec::new();
    for dir in tool_skills_dirs {
        let _ = fs::create_dir_all(dir);
        let key = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if !seen.insert(key) {
            continue;
        }
        // An INVALID NAME is not a missing link: swallowing it made the sink's validation
        // unusable as an error boundary for this API (review, Codex). Report it as its own
        // status so callers can distinguish refusal from absence.
        let status = match ensure_link(dir, slug, canonical) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => LinkStatus::Refused,
            Err(_) => LinkStatus::Missing,
        };
        out.push((dir.join(slug), status));
    }
    out
}

/// Copy-mode fallback: copy the canonical skill's files into target/<slug> and drop a
/// provenance marker recording the source.
pub fn copy_skill(
    tool_skills_dir: &Path,
    slug: &str,
    canonical: &Path,
) -> std::io::Result<PathBuf> {
    // A path-building SINK: see `materialize_fileset`. The claim that there were only two of
    // these was WRONG (review, Codex) — this is one of five more it enumerated.
    crate::store::check_derived_name(slug).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{slug}: {e}"))
    })?;
    let dest = tool_skills_dir.join(slug);
    fs::create_dir_all(&dest)?;
    for entry in fs::read_dir(canonical)? {
        let entry = entry?;
        let from = entry.path();
        if from.is_file() {
            fs::copy(&from, dest.join(entry.file_name()))?;
        }
    }
    let marker = format!("{{\"source\":\"{}\"}}", canonical.to_string_lossy());
    fs::write(dest.join(".syncr-source.json"), marker)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_canonical(root: &Path) -> PathBuf {
        let c = root.join("agents").join("skills").join("git-helper");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("SKILL.md"), "# Git").unwrap();
        c
    }

    #[test]
    fn fan_out_creates_valid_links_in_each_tool() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = make_canonical(tmp.path());
        let claude = tmp.path().join(".claude/skills");
        let cursor = tmp.path().join(".cursor/skills");
        let res = fan_out("git-helper", &canonical, &[claude.clone(), cursor.clone()]);
        assert_eq!(res.len(), 2);
        assert!(res.iter().all(|(_, s)| *s == LinkStatus::Valid));
        assert_eq!(
            fs::read_to_string(claude.join("git-helper").join("SKILL.md")).unwrap(),
            "# Git"
        );
    }

    #[test]
    fn fan_out_dedups_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = make_canonical(tmp.path());
        let claude = tmp.path().join(".claude/skills");
        let res = fan_out("git-helper", &canonical, &[claude.clone(), claude.clone()]);
        assert_eq!(res.len(), 1);
        let res2 = fan_out("git-helper", &canonical, std::slice::from_ref(&claude));
        assert_eq!(res2[0].1, LinkStatus::Valid);
    }

    #[test]
    fn reconcile_repairs_wrong_target() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = make_canonical(tmp.path());
        let claude = tmp.path().join(".claude/skills");
        fs::create_dir_all(&claude).unwrap();
        let wrong = tmp.path().join("elsewhere");
        fs::create_dir_all(&wrong).unwrap();
        symlink_dir(&wrong, &claude.join("git-helper")).unwrap();
        assert_eq!(
            link_status(&claude.join("git-helper"), &canonical),
            LinkStatus::WrongTarget
        );
        assert_eq!(
            ensure_link(&claude, "git-helper", &canonical).unwrap(),
            LinkStatus::Valid
        );
        assert_eq!(
            link_status(&claude.join("git-helper"), &canonical),
            LinkStatus::Valid
        );
    }

    #[test]
    fn copy_mode_writes_files_and_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = make_canonical(tmp.path());
        let tool = tmp.path().join(".iflow/skills");
        let dest = copy_skill(&tool, "git-helper", &canonical).unwrap();
        assert_eq!(fs::read_to_string(dest.join("SKILL.md")).unwrap(), "# Git");
        assert!(dest.join(".syncr-source.json").exists());
    }
}
