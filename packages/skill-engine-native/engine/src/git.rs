//! Hardened git subprocess layer — moved from `syncr-core::direct` (which re-exports it
//! unchanged) so the NAPI addon can drive git-repo collections without linking syncr-core.
//!
//! # Containment contract (read this before calling in)
//!
//! Every input here reaches a SUBPROCESS or a filesystem path, so all are validated at the
//! boundary and the host may pass them straight from its own config:
//!
//! | Input | Rule | Why |
//! |---|---|---|
//! | `repo_url` | known transport only (`https` `ssh` `git` `file` or `user@host:path`); never starts with `-` | a URL beginning `-` is parsed by git as an OPTION — verified: `--upload-pack=<cmd>` is consumed as a flag, and with a real repo argument git RUNS that command. `ext::` is a transport that executes a command by design; git blocks it by default, but that is a config default (`protocol.ext.allow`), not a guarantee we should lean on |
//! | `git_ref` | never starts with `-` | same option-injection shape |
//! | `subpath` | relative, ordinary components only, never starts with `-` | it becomes a path under the clone AND a `sparse-checkout set` argument |
//!
//! Positional arguments are additionally passed after `--`, so a value that slips the checks
//! still cannot be read as an option. Returned paths are verified to live under `dest`:
//! a symlinked or `..`-bearing checkout cannot hand back a path outside the clone.
//!
//! Failures are refusals, not sanitizations — we never rewrite a caller's URL into a "safe"
//! one, because a silently altered remote is worse than a rejected one.

use std::path::{Component, Path, PathBuf};

/// Transports we accept. An allowlist, because the hazard is the scheme nobody thought of:
/// git's `<helper>::<args>` form runs `git-remote-<helper>` as a command.
const ALLOWED_SCHEMES: &[&str] = &["https://", "ssh://", "git://", "file://", "http://"];

/// Reject a value git would read as an option rather than data.
fn reject_option_like(kind: &str, v: &str) -> Result<(), String> {
    if v.starts_with('-') {
        return Err(format!(
            "{kind} may not start with '-' (git would read it as an option): {v}"
        ));
    }
    if v.contains('\0') {
        return Err(format!("{kind} contains NUL: {v:?}"));
    }
    Ok(())
}

/// A repo URL git will treat as a remote, not as an option or a command-executing transport.
pub fn validate_repo_url(url: &str) -> Result<(), String> {
    reject_option_like("repo url", url)?;
    if url.is_empty() {
        return Err("repo url is empty".into());
    }
    // Schemes are case-INSENSITIVE in git and in URLs generally; matching exactly rejected
    // `HTTPS://…`, a valid spelling (review, Codex).
    let lower = url.to_ascii_lowercase();
    if ALLOWED_SCHEMES.iter().any(|s| lower.starts_with(s)) {
        return Ok(());
    }
    // Bracketed IPv6 scp-like (`git@[2001:db8::1]:o/r.git`) legitimately contains `::`
    // inside the brackets, so the transport-helper test must look OUTSIDE them.
    if let Some(rest) = url
        .strip_prefix(|c: char| c != '[')
        .and_then(|_| url.split_once(']'))
    {
        let (head, tail) = rest;
        if head.starts_with('[') || head.contains("@[") {
            if let Some(path) = tail.strip_prefix(':') {
                if !path.is_empty() {
                    return Ok(());
                }
            }
        }
    }
    // scp-like `user@host:path` — no scheme, exactly one `:` introducing the path, and the part
    // before it must look like a host, not a transport helper (`ext::…` has an EMPTY segment
    // between the colons, which is what distinguishes it).
    if !url.contains("::") {
        if let Some((host, path)) = url.split_once(':') {
            // The host must actually look like one — carry a `@` (user@host) or a dot. Accepting
            // any colon-bearing string made `javascript:x` "valid", which git reads as scp-like
            // and tries to ssh to a host named `javascript`: not code execution, but a remote the
            // caller never asked for, from a string that was obviously not a git URL.
            let host_shaped = host.contains('@') || host.contains('.');
            if host_shaped && !path.is_empty() && !host.contains('/') {
                return Ok(());
            }
        }
    }
    Err(format!(
        "unsupported transport (allowed: {}, or user@host:path): {url}",
        ALLOWED_SCHEMES.join(" ")
    ))
}

/// A git ref that cannot be read as an option.
pub fn validate_git_ref(git_ref: &str) -> Result<(), String> {
    reject_option_like("git ref", git_ref)
}

/// A subpath that stays inside the clone and cannot be read as an option.
pub fn validate_subpath(subpath: &str) -> Result<(), String> {
    reject_option_like("subpath", subpath)?;
    if subpath.is_empty() {
        return Err("subpath is empty".into());
    }
    for c in Path::new(subpath).components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(format!("subpath escapes the clone: {subpath}"));
        }
    }
    Ok(())
}

/// Run git with the dangerous, configuration-selected behaviours turned OFF.
///
/// These are `-c` overrides rather than a cleared environment on purpose: the caller uses the
/// user's own git auth, so wiping their config would break the feature. What we can do is refuse
/// the knobs that turn a clone into code execution:
///
/// * `protocol.ext.allow=never` — `ext::` runs a command AS a transport, and an
///   `url.ext::<cmd>.insteadOf=https://…` rewrite can turn a URL we validated as HTTPS
///   into exactly that (review, Codex).
/// * `core.hooksPath` at a path that cannot exist — a locally configured hooksPath makes
///   an untrusted repo's committed hook the program `clone` runs at checkout.
/// * `core.symlinks=false` — the checkout writes symlinks as plain files, so untrusted
///   content cannot plant a link that escapes the clone.
///
/// RESIDUAL, documented rather than papered over: a `.gitattributes` in the repo can
/// still select a smudge filter the USER has configured, and `insteadOf` rewrites to
/// other ordinary transports still apply. Both require hostile local git config, which
/// is a machine already compromised for every other git command too — but a host that
/// clones genuinely untrusted repos should run this in a sandbox regardless.
pub(crate) fn git(args: &[&str]) -> Result<(), String> {
    const HARDEN: &[&str] = &[
        "-c",
        "protocol.ext.allow=never",
        "-c",
        "core.hooksPath=/nonexistent/syncr-no-hooks",
        "-c",
        "core.symlinks=false",
    ];
    let out = std::process::Command::new("git")
        .args(HARDEN)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

/// Refuse a destination that already exists (shared by both clone shapes).
///
/// `git clone --sparse` and `git sparse-checkout set` both rewrite a repository's sparse-checkout
/// configuration, so pointing either at an existing working tree reconfigures THAT repo — which
/// shows up as most of the tree silently disappearing while `git status` still reports clean.
/// (We hit exactly that state in this repo during development.) Refusing an existing dest makes
/// these functions unable to touch any repository they did not create.
fn refuse_existing(dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Err(format!(
            "clone destination already exists: {} — refusing, since the clone would \
             reconfigure whatever repository lives there",
            dest.display()
        ));
    }
    Ok(())
}

/// Run `git clone` preferring the partial-clone filter, retrying once WITHOUT it when
/// the filtered attempt fails — the native app's fallback for servers and transports
/// that reject `--filter` (it treats ANY first failure as potentially filter-related,
/// and surfaces the retry's error). The failed attempt's half-created destination is
/// removed before the retry.
fn clone_with_filter_fallback(base: &[&str], dest: &Path) -> Result<(), String> {
    // Claim the destination ourselves (refuse_existing already saw it absent): git
    // happily clones into an existing empty directory, and owning the dir from
    // creation means the between-attempts cleanup only ever deletes a directory THIS
    // call made — never one a concurrent process raced in (the claim-new-dir pattern
    // the store's import rollback uses).
    let claim = |what: &str| -> Result<(), String> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{what}: {e}"))?;
        }
        std::fs::create_dir(dest).map_err(|e| format!("{what}: {e}"))
    };
    claim("claiming the clone destination")?;
    let mut filtered: Vec<&str> = Vec::with_capacity(base.len() + 2);
    filtered.push("clone");
    filtered.push("--filter=blob:none");
    filtered.extend_from_slice(base);
    match git(&filtered) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::remove_dir_all(dest)
                .map_err(|e| format!("cleaning the failed clone attempt: {e}"))?;
            claim("re-claiming the clone destination for the unfiltered retry")?;
            let mut plain: Vec<&str> = Vec::with_capacity(base.len() + 1);
            plain.push("clone");
            plain.extend_from_slice(base);
            git(&plain)
        }
    }
}

/// Blobless sparse clone of `repo_url` (at `git_ref`), materializing only `subpath`,
/// into `dest`. Returns `dest/subpath`. Uses the git partial-clone + sparse-checkout.
pub fn sparse_clone(
    repo_url: &str,
    git_ref: &str,
    subpath: &str,
    dest: &Path,
) -> Result<PathBuf, String> {
    // Validate BEFORE anything reaches the subprocess (see the module contract).
    validate_repo_url(repo_url)?;
    validate_git_ref(git_ref)?;
    validate_subpath(subpath)?;
    refuse_existing(dest)?;

    let dest_s = dest.to_str().ok_or("bad dest path")?;
    // `--` terminates option parsing: even if a value slipped the checks above, git reads what
    // follows as positional data. Belt and braces, because the cost of being wrong here is a
    // command executing with the user's git credentials.
    if git_ref.is_empty() || git_ref == "HEAD" {
        clone_with_filter_fallback(&["--sparse", "--", repo_url, dest_s], dest)?;
    } else {
        clone_with_filter_fallback(
            &["--sparse", "--branch", git_ref, "--", repo_url, dest_s],
            dest,
        )?;
    }
    git(&["-C", dest_s, "sparse-checkout", "set", "--", subpath])?;
    contained_subpath(dest, subpath)
}

/// Blobless FULL clone (no sparse filter on the tree) — the collection importer's shape: a repo
/// OF skills wants the whole working tree, optionally narrowed to `subpath`. Returns the import
/// root (`dest` or `dest/subpath`).
pub fn clone_repo(
    repo_url: &str,
    git_ref: Option<&str>,
    subpath: Option<&str>,
    dest: &Path,
) -> Result<PathBuf, String> {
    if let Some(sub) = subpath {
        // narrowed → the sparse machinery already does exactly this
        return sparse_clone(repo_url, git_ref.unwrap_or("HEAD"), sub, dest);
    }
    validate_repo_url(repo_url)?;
    if let Some(r) = git_ref {
        validate_git_ref(r)?;
    }
    refuse_existing(dest)?;
    let dest_s = dest.to_str().ok_or("bad dest path")?;
    match git_ref {
        None | Some("") | Some("HEAD") => {
            clone_with_filter_fallback(&["--", repo_url, dest_s], dest)?
        }
        Some(r) => clone_with_filter_fallback(&["--branch", r, "--", repo_url, dest_s], dest)?,
    }
    Ok(dest.to_path_buf())
}

/// Bring an existing collection clone up to its upstream: fetch the tracked ref and hard-reset
/// the working tree to it (plus `clean -fd`, so a file the upstream DELETED does not linger and
/// re-import as if it still existed). The clone dir is engine-created and engine-owned — this is
/// never pointed at a repository a user works in.
pub fn fetch_and_reset(clone_dir: &Path, git_ref: Option<&str>) -> Result<(), String> {
    if let Some(r) = git_ref {
        validate_git_ref(r)?;
    }
    let dir = clone_dir.to_str().ok_or("bad clone path")?;
    let r = match git_ref {
        None | Some("") => "HEAD",
        Some(r) => r,
    };
    // No --filter here: a blobless clone's recorded partial-clone config already
    // applies to its fetches, and a fallback (plain) clone's server would reject the
    // flag — native's update fetch passes none either.
    git(&["-C", dir, "fetch", "origin", "--", r])?;
    git(&["-C", dir, "reset", "--hard", "FETCH_HEAD"])?;
    git(&["-C", dir, "clean", "-fd"])?;
    Ok(())
}

/// Verify `dest/subpath` resolves INSIDE the clone against the real paths — the checkout itself
/// is untrusted content, and a symlinked or `..`-bearing tree could make the joined path resolve
/// outside it.
fn contained_subpath(dest: &Path, subpath: &str) -> Result<PathBuf, String> {
    let joined = dest.join(subpath);
    let (root, inside) = (dest.canonicalize(), joined.canonicalize());
    match (root, inside) {
        (Ok(r), Ok(i)) if i.starts_with(&r) => Ok(joined),
        (Ok(_), Ok(i)) => Err(format!(
            "checkout resolved outside the clone: {}",
            i.display()
        )),
        // Not yet on disk (an empty sparse set) is not an escape — the caller's read will fail
        // with a plain not-found, which is the honest error.
        _ => Ok(joined),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    pub(crate) fn make_git_fixture(dir: &Path) -> String {
        let repo = dir.join("repo");
        std::fs::create_dir_all(repo.join("git-helper")).unwrap();
        std::fs::write(repo.join("git-helper/SKILL.md"), "# Git\nfrom git repo").unwrap();
        let r = repo.to_str().unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(args)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["-C", r, "init", "-q"]);
        git(&["-C", r, "config", "user.email", "t@t.t"]);
        git(&["-C", r, "config", "user.name", "t"]);
        git(&["-C", r, "add", "-A"]);
        git(&["-C", r, "commit", "-q", "-m", "init"]);
        format!("file://{r}")
    }

    #[test]
    fn a_repo_url_that_git_would_read_as_an_option_is_refused() {
        // Verified by running git: `git clone --filter=blob:none --sparse "--upload-pack=..." dest`
        // consumes the URL as an OPTION and treats `dest` as the repository. With a real repo
        // argument, --upload-pack runs an arbitrary command — subprocess argument injection.
        for bad in [
            "--upload-pack=touch /tmp/pwned",
            "-u",
            "--config=core.pager=sh",
        ] {
            assert!(
                validate_repo_url(bad).is_err(),
                "{bad} must be refused before it reaches git"
            );
        }
    }

    #[test]
    fn only_known_transports_are_allowed() {
        for ok in [
            "https://github.com/o/r.git",
            "ssh://git@github.com/o/r.git",
            "git://example.com/r.git",
            "file:///tmp/repo",
            "git@github.com:o/r.git",
        ] {
            assert!(validate_repo_url(ok).is_ok(), "{ok} should be allowed");
        }
        // `ext::` runs an arbitrary command as a transport. Git blocks it by default, but that is
        // a CONFIG default (protocol.ext.allow) — not something to depend on from our side.
        for bad in ["ext::sh -c 'id'", "unknownhelper::whatever", "javascript:x"] {
            assert!(validate_repo_url(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_traversing_or_option_like_subpath_is_refused() {
        for bad in ["../../etc", "/abs", "-x", "a/../../b"] {
            assert!(validate_subpath(bad).is_err(), "{bad} must be refused");
        }
        for ok in ["git-helper", "nested/skill", "a-b_c.d"] {
            assert!(validate_subpath(ok).is_ok(), "{ok} should be allowed");
        }
    }

    #[test]
    fn an_option_like_ref_is_refused() {
        assert!(validate_git_ref("--upload-pack=x").is_err());
        assert!(validate_git_ref("-x").is_err());
        assert!(validate_git_ref("main").is_ok());
        assert!(validate_git_ref("HEAD").is_ok());
        assert!(validate_git_ref("release/1.0").is_ok());
    }

    #[test]
    fn an_existing_destination_is_refused_so_we_cannot_reconfigure_someone_elses_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let existing = tmp.path().join("already-here");
        std::fs::create_dir_all(existing.join(".git")).unwrap();
        let e = sparse_clone("https://example.com/r.git", "HEAD", "s", &existing).unwrap_err();
        assert!(e.contains("already exists"), "expected a refusal, got: {e}");
        let e2 = clone_repo("https://example.com/r.git", None, None, &existing).unwrap_err();
        assert!(
            e2.contains("already exists"),
            "expected a refusal, got: {e2}"
        );
        // and the pre-existing directory is untouched
        assert!(existing.join(".git").is_dir());
    }

    #[test]
    fn full_clone_checks_out_the_whole_tree_and_fetch_reset_follows_upstream() {
        let tmp = tempfile::tempdir().unwrap();
        let url = make_git_fixture(tmp.path());
        let dest = tmp.path().join("clone");
        let root = clone_repo(&url, None, None, &dest).unwrap();
        assert_eq!(root, dest);
        assert!(dest.join("git-helper/SKILL.md").is_file());

        // upstream gains a commit (a new skill) — fetch_and_reset must pick it up
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join("newer")).unwrap();
        std::fs::write(repo.join("newer/SKILL.md"), "# newer").unwrap();
        let r = repo.to_str().unwrap();
        for args in [
            ["-C", r, "add", "-A"].as_slice(),
            ["-C", r, "commit", "-q", "-m", "add newer"].as_slice(),
        ] {
            assert!(Command::new("git")
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        }
        fetch_and_reset(&dest, None).unwrap();
        assert!(
            dest.join("newer/SKILL.md").is_file(),
            "reset did not follow upstream"
        );
    }
}
