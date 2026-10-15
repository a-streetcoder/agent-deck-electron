//! Untrusted-repo import — the ingest capability agent-deck has and syncr-core lacked
//! (Syncr ADR-0004). Given a cloned/checked-out repository working tree (arbitrary,
//! user-supplied — it may contain symlinks, `..`, or non-regular files), discover its
//! skill roots and read each into a **sanitized** `{path -> content}` fileset that the
//! rest of the engine (`materialize`, `index`) can trust.
//!
//! Sanitize-at-the-boundary is the whole point: every escape vector is rejected HERE,
//! once, so `materialize` downstream stays the simple temp→fsync→rename it already is.
//! Rejected: symlinks (any entry), non-regular files (fifos/devices/sockets), and
//! non-UTF-8 paths. Because we never follow a symlink and never join a `..`, a booby-
//! trapped repo cannot make the reader touch a path outside the skill root.
//!
//! One deliberate exception, opt-in via `LinkPolicy::FollowTopLevel` and used ONLY for folders
//! the user picked on their own machine: a symlink that is a direct child of the scanned folder
//! may be followed to a skill root (fan-out writes exactly such links). The followed target is
//! then read under the same rules as any other skill tree — links inside it are still refused.

use std::fmt;
use std::path::{Path, PathBuf};

use crate::entry::{AsEntry, FileEntry, Fileset};

/// A skill discovered in a repo: its slug (the folder name) and its sanitized fileset
/// (relative POSIX paths → file contents), ready for `materialize::materialize_fileset`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedSkill {
    pub slug: String,
    pub files: Fileset,
    /// Set when discovery FOLLOWED a top-level symlink to reach this skill (local-folder policy
    /// only, see `LinkPolicy`): the canonical directory the files were read from. `None` for a
    /// plain directory — and always `None` for a repo clone.
    pub link_target: Option<PathBuf>,
}

/// Whether discovery may follow a symlinked directory that is a DIRECT child of the scanned
/// root. Never for a repo clone (an untrusted tree can link anywhere on disk); yes for a folder
/// the user picked on their own machine, where `~/.claude/skills/<name>` is routinely a fan-out
/// link into `~/.agents/skills/<name>`. Either way the followed target is still a trust
/// boundary: symlinks INSIDE it are refused, exactly like any other skill tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkPolicy {
    /// Ignore symlinked entries during discovery (repo clones).
    Ignore,
    /// Follow a top-level symlink whose resolved target is itself a skill root (local folders).
    FollowTopLevel,
}

/// One discovered skill root: the path discovery found it at, and — when it was reached through
/// a followed top-level symlink — the canonical target the fileset must be read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRoot {
    pub path: PathBuf,
    pub link_target: Option<PathBuf>,
}

impl SkillRoot {
    /// The directory to actually read: the link target when followed, else the path itself.
    pub fn read_dir(&self) -> &Path {
        self.link_target.as_deref().unwrap_or(&self.path)
    }
}

/// Why an import was refused. All variants fail CLOSED — a repo that trips any of these
/// contributes no skill rather than a partially-trusted one.
#[derive(Debug)]
pub enum ImportError {
    /// A symlink was found inside the tree; following it could escape the skill root.
    UnsafeSymlink(PathBuf),
    /// A non-regular, non-directory entry (fifo, socket, device, …).
    UnsafeEntry(PathBuf),
    /// A path was not valid UTF-8 (a fileset KEY is a JSON string, so it cannot hold one).
    /// Non-UTF-8 CONTENT is not an error — it is a binary `FileEntry` (#206).
    NonUtf8(PathBuf),
    /// An underlying I/O failure while reading the tree.
    Io(String),
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImportError::UnsafeSymlink(p) => {
                write!(f, "unsafe symlink in skill tree: {}", p.display())
            }
            ImportError::UnsafeEntry(p) => {
                write!(f, "unsafe non-regular entry in skill tree: {}", p.display())
            }
            ImportError::NonUtf8(p) => write!(f, "non-UTF-8 path: {}", p.display()),
            ImportError::Io(e) => write!(f, "io error reading skill tree: {e}"),
        }
    }
}
impl std::error::Error for ImportError {}

impl From<std::io::Error> for ImportError {
    fn from(e: std::io::Error) -> Self {
        ImportError::Io(e.to_string())
    }
}

const SKILL_FILE: &str = "SKILL.md";

/// Discover skill roots in a repo working tree, matching agent-deck's discovery contract
/// (`agentdeck.rs`): a directory that DIRECTLY contains a readable `SKILL.md` is a skill
/// root, and we never descend past a root. `.git` is skipped. Symlinked directories are
/// never traversed (they are ignored here and rejected if inside a root by the reader).
pub fn discover_skill_roots(clone_dir: &Path) -> Result<Vec<PathBuf>, ImportError> {
    Ok(discover_skill_roots_with(clone_dir, LinkPolicy::Ignore)?
        .into_iter()
        .map(|r| r.path)
        .collect())
}

/// Policy-aware discovery. With `LinkPolicy::FollowTopLevel`, a symlink that is a DIRECT child
/// of `clone_dir` is resolved (`canonicalize`, so a dangling link is simply skipped); it counts
/// as a skill root only when the resolved target is a directory that directly contains
/// `SKILL.md`, and is never descended into as a catalog. Deeper symlinks stay ignored here and
/// refused by the reader.
pub fn discover_skill_roots_with(
    clone_dir: &Path,
    policy: LinkPolicy,
) -> Result<Vec<SkillRoot>, ImportError> {
    let mut roots = Vec::new();
    let mut stack = vec![clone_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if dir.join(SKILL_FILE).is_file() {
            roots.push(SkillRoot {
                path: dir,
                link_target: None,
            });
            continue; // a skill root — do not descend past it
        }
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                if policy == LinkPolicy::FollowTopLevel && dir == clone_dir {
                    if let Some(target) = resolve_linked_skill_root(&entry.path()) {
                        roots.push(SkillRoot {
                            path: entry.path(),
                            link_target: Some(target),
                        });
                    }
                }
                continue;
            }
            if !file_type.is_dir() {
                continue;
            }
            if entry.file_name() == ".git" {
                continue;
            }
            stack.push(entry.path());
        }
    }
    roots.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(roots)
}

/// The canonical target of a top-level symlink IF it is a skill root; `None` for a dangling
/// link, a link to a file, or a link to a directory without a direct `SKILL.md`.
fn resolve_linked_skill_root(link: &Path) -> Option<PathBuf> {
    let target = std::fs::canonicalize(link).ok()?;
    if !target.is_dir() {
        return None;
    }
    // `is_file` follows links — a SKILL.md that is itself a symlink is refused later by the
    // reader, so let discovery see it and the reader deliver the precise error.
    if !target.join(SKILL_FILE).is_file() {
        return None;
    }
    Some(target)
}

/// Read a single skill root into a sanitized fileset. Rejects any symlink, non-regular
/// entry, or non-UTF-8 PATH anywhere in the subtree; a non-UTF-8 FILE is a binary entry
/// (#206). Relative paths use `/`.
pub fn read_skill_fileset(root: &Path) -> Result<Fileset, ImportError> {
    let mut files = Fileset::new();
    read_dir_into(root, root, &mut files)?;
    Ok(files)
}

fn read_dir_into(root: &Path, dir: &Path, out: &mut Fileset) -> Result<(), ImportError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        // A symlink anywhere in the tree is refused before it is ever followed — this is
        // the escape guard. `.git` is skipped (repo metadata, not skill content).
        if file_type.is_symlink() {
            return Err(ImportError::UnsafeSymlink(path));
        }
        if file_type.is_dir() {
            if entry.file_name() == ".git" {
                continue;
            }
            read_dir_into(root, &path, out)?;
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| ImportError::UnsafeEntry(path.clone()))?;
            let rel = rel
                .to_str()
                .ok_or_else(|| ImportError::NonUtf8(path.clone()))?
                .replace('\\', "/");
            // Text-ness is decided ONCE, here (`FileEntry::from_bytes`). A PNG used to fail the
            // whole folder; it is now simply a binary entry (#206).
            let bytes = std::fs::read(&path)?;
            let mut entry = FileEntry::from_bytes(bytes);
            // Normalized at ingest — an untrusted repo cloned on Windows arrives CRLF by default
            // (git core.autocrlf), and the same skill must not hash two different ways by platform.
            //
            // Except where the line ending is LOAD-BEARING. `cmd.exe` parses batch files by byte
            // offset and mis-handles LF-only `goto`/labels, so normalizing a sibling `run.bat`
            // silently broke a script the engine does not own and was never asked to reformat.
            // The exception is narrow and by extension because it is a FORMATTING call, not a trust
            // boundary — the default stays "normalize", so an unrecognised type keeps the
            // cross-platform hash guarantee rather than opting out of it.
            if !is_crlf_sensitive(&rel) {
                // text only — `normalize_newlines_in_place` never touches binary bytes
                entry.normalize_newlines_in_place();
            }
            out.insert(rel, entry);
        } else {
            // fifo/socket/device/… — not skill content, refuse.
            return Err(ImportError::UnsafeEntry(path));
        }
    }
    Ok(())
}

/// Files whose interpreter depends on CRLF. Kept deliberately tiny — every addition trades a real
/// cross-platform hash guarantee for one interpreter's quirk.
pub(crate) fn is_crlf_sensitive(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".bat") || lower.ends_with(".cmd")
}

/// Normalize a whole fileset to LF (respecting the CRLF-sensitive exception) — THE ingest rule,
/// applied to filesets arriving as parsed blobs rather than read from disk. Every path into the
/// hash-bearing stores must pass through either this or `read_dir_into`'s per-file equivalent;
/// an ingest point that skips both reintroduces the platform-dependent-hash bug.
pub fn normalize_fileset<V: AsEntry>(files: &mut std::collections::BTreeMap<String, V>) {
    for (rel, content) in files.iter_mut() {
        if !is_crlf_sensitive(rel) {
            content.normalize_newlines_in_place();
        }
    }
}

/// Import every skill in a repo working tree: discover roots, read each into a sanitized
/// fileset. A root whose subtree contains an unsafe entry fails the WHOLE import (fail
/// closed) rather than importing a partially-trusted skill.
pub fn import_repo(clone_dir: &Path) -> Result<Vec<ImportedSkill>, ImportError> {
    import_tree_with(clone_dir, LinkPolicy::Ignore)
}

/// Read every skill in a folder the USER picked on their own machine: like `import_repo`, but
/// top-level symlinked skills are followed (`LinkPolicy::FollowTopLevel`) and reported via
/// `ImportedSkill::link_target`. The slug is the LINK's name — that is the name the folder
/// presents the skill under — while the files come from the resolved target.
pub fn import_local_tree(root: &Path) -> Result<Vec<ImportedSkill>, ImportError> {
    import_tree_with(root, LinkPolicy::FollowTopLevel)
}

fn import_tree_with(dir: &Path, policy: LinkPolicy) -> Result<Vec<ImportedSkill>, ImportError> {
    let mut skills = Vec::new();
    for root in discover_skill_roots_with(dir, policy)? {
        let slug = root
            .path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| ImportError::NonUtf8(root.path.clone()))?
            .to_string();
        let files = read_skill_fileset(root.read_dir())?;
        skills.push(ImportedSkill {
            slug,
            files,
            link_target: root.link_target,
        });
    }
    Ok(skills)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn imports_a_single_skill_repo() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("SKILL.md"), "# root skill");
        write(&tmp.path().join("scripts/run.sh"), "echo hi");
        let skills = import_repo(tmp.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].files["SKILL.md"], "# root skill");
        assert_eq!(skills[0].files["scripts/run.sh"], "echo hi");
    }

    #[test]
    fn discovers_multiple_skill_roots_and_stops_at_each() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a/SKILL.md"), "# a");
        write(&tmp.path().join("b/SKILL.md"), "# b");
        // A file nested BELOW a skill root must not become its own root.
        write(&tmp.path().join("a/nested/deep.md"), "# deep");
        let roots = discover_skill_roots(tmp.path()).unwrap();
        assert_eq!(roots.len(), 2);
        let skills = import_repo(tmp.path()).unwrap();
        let slugs: Vec<_> = skills.iter().map(|s| s.slug.as_str()).collect();
        assert!(slugs.contains(&"a") && slugs.contains(&"b"));
        // the nested file is part of skill `a`, not a separate skill
        let a = skills.iter().find(|s| s.slug == "a").unwrap();
        assert_eq!(a.files["nested/deep.md"], "# deep");
    }

    #[test]
    fn a_folder_without_skill_md_is_not_a_root() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("docs/readme.md"), "# not a skill");
        assert!(import_repo(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn skips_git_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("SKILL.md"), "# s");
        write(&tmp.path().join(".git/config"), "[core]");
        let skills = import_repo(tmp.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert!(!skills[0].files.keys().any(|k| k.starts_with(".git")));
    }

    // Creating a symlink needs privilege on Windows; the rejection logic is
    // platform-agnostic, so exercise it where symlinks always work.
    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_inside_a_skill_tree() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("SKILL.md"), "# s");
        // a symlink pointing outside the skill root — the classic escape
        symlink("/etc/passwd", tmp.path().join("leak")).unwrap();
        let err = import_repo(tmp.path()).unwrap_err();
        assert!(matches!(err, ImportError::UnsafeSymlink(_)), "got {err:?}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_subdirectory() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("SKILL.md"), "# s");
        fs::create_dir(tmp.path().join("real")).unwrap();
        symlink(tmp.path().join("real"), tmp.path().join("linkdir")).unwrap();
        let err = import_repo(tmp.path()).unwrap_err();
        assert!(matches!(err, ImportError::UnsafeSymlink(_)), "got {err:?}");
    }

    // A user-picked LOCAL folder may hold skills as symlinks — e.g. `~/.claude/skills/<name>`
    // pointing at `~/.agents/skills/<name>` is exactly what fan-out writes. Git discovery must
    // keep ignoring them (a clone can link anywhere on disk), but the local policy follows a
    // TOP-LEVEL link whose target is itself a skill root, reads through the resolved target,
    // and reports the target so the host can tell "linked" from "copied".
    #[cfg(unix)]
    #[test]
    fn local_policy_follows_a_top_level_symlinked_skill_dir() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("real-skill");
        write(&target.join("SKILL.md"), "# real");
        write(&target.join("refs/a.md"), "# a");
        symlink(&target, tmp.path().join("linked")).unwrap();
        write(&tmp.path().join("plain/SKILL.md"), "# plain");

        // git policy: the link is invisible, exactly as before
        let git = import_repo(tmp.path()).unwrap();
        assert_eq!(
            git.iter().map(|s| s.slug.as_str()).collect::<Vec<_>>(),
            vec!["plain"]
        );
        assert!(git[0].link_target.is_none());

        // local policy: the link is a skill named after the LINK, read from the target
        let local = import_local_tree(tmp.path()).unwrap();
        let mut slugs: Vec<_> = local.iter().map(|s| s.slug.as_str()).collect();
        slugs.sort();
        assert_eq!(slugs, vec!["linked", "plain"]);
        let linked = local.iter().find(|s| s.slug == "linked").unwrap();
        assert_eq!(linked.files["SKILL.md"], "# real");
        assert_eq!(linked.files["refs/a.md"], "# a");
        assert_eq!(
            linked.link_target.as_deref(),
            Some(fs::canonicalize(&target).unwrap().as_path())
        );
        assert!(local
            .iter()
            .find(|s| s.slug == "plain")
            .unwrap()
            .link_target
            .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn local_policy_ignores_links_that_are_not_skill_roots_and_still_refuses_inner_links() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        // a link to a FILE, a link to a dir WITHOUT SKILL.md, and a dangling link: all ignored
        write(&elsewhere.path().join("note.md"), "# note");
        symlink(
            elsewhere.path().join("note.md"),
            tmp.path().join("file-link"),
        )
        .unwrap();
        fs::create_dir(elsewhere.path().join("notskill")).unwrap();
        symlink(
            elsewhere.path().join("notskill"),
            tmp.path().join("dir-link"),
        )
        .unwrap();
        symlink(
            elsewhere.path().join("missing"),
            tmp.path().join("dangling"),
        )
        .unwrap();
        assert!(import_local_tree(tmp.path()).unwrap().is_empty());

        // a followed target is still a trust boundary: a symlink INSIDE it is refused
        let target = elsewhere.path().join("leaky");
        write(&target.join("SKILL.md"), "# leaky");
        symlink("/etc/passwd", target.join("leak")).unwrap();
        symlink(&target, tmp.path().join("linked")).unwrap();
        let err = import_local_tree(tmp.path()).unwrap_err();
        assert!(matches!(err, ImportError::UnsafeSymlink(_)), "got {err:?}");
    }

    #[test]
    fn imported_fileset_round_trips_through_materialize() {
        // The integration point: what import produces, materialize can write.
        let tmp = tempfile::tempdir().unwrap();
        // A NAMED skill dir, not the tempdir root: `tempfile` names it `.tmpXXXX`, so the slug
        // would start with a dot — which materialize now refuses, and rightly so. A dot-named
        // skill is invisible to discovery (dot-dirs are skipped), so importing one would create
        // a skill nothing can ever see. Failing loudly beats writing an invisible skill.
        let repo = tmp.path().join("clone");
        write(&repo.join("SKILL.md"), "# s");
        write(&repo.join("refs/a.md"), "# a");
        let skills = import_repo(&repo).unwrap();
        let dest = tempfile::tempdir().unwrap();
        let dir =
            crate::materialize::materialize_fileset(dest.path(), &skills[0].slug, &skills[0].files)
                .unwrap();
        assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "# s");
        assert_eq!(fs::read_to_string(dir.join("refs/a.md")).unwrap(), "# a");
    }
}
