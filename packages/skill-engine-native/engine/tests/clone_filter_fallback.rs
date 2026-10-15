//! Native parity (agent-deck SKL-18): a git server that rejects the partial-clone
//! filter must still import — the native app retries its discovery clone without
//! `--filter=blob:none` (keeping `--sparse`), and its update fetch passes no filter
//! flag at all, relying on the clone's own recorded partial-clone config.
//!
//! This lives in its OWN integration binary because the shim works by prepending a
//! fake `git` to PATH — process-global state that must not race the unit suite.
//! The shim is a tiny exe compiled with rustc at test time, so the interception
//! works on every platform (Windows resolves only .exe from PATH).

use std::path::Path;
use std::process::Command;

use skill_engine::git::{clone_repo, fetch_and_reset, sparse_clone};

const SHIM_SRC: &str = r#"
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a.starts_with("--filter=")) {
        std::process::exit(33);
    }
    let real = std::env::var("REAL_GIT").expect("REAL_GIT not set");
    let status = std::process::Command::new(real)
        .args(&args)
        .status()
        .expect("spawning the real git");
    std::process::exit(status.code().unwrap_or(1));
}
"#;

/// Resolve the real git binary BEFORE the shim shadows it on PATH.
fn real_git_path() -> String {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = Command::new(finder).arg("git").output().unwrap();
    assert!(out.status.success(), "could not locate the real git");
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .trim()
        .to_string()
}

/// Compile a `git` shim that hard-fails any invocation carrying `--filter=...` and
/// execs the real git otherwise — the deterministic stand-in for a server (or
/// transport) that rejects partial clones.
fn install_filter_rejecting_git(dir: &Path) {
    let src = dir.join("shim.rs");
    std::fs::write(&src, SHIM_SRC).unwrap();
    let exe = dir.join(if cfg!(windows) { "git.exe" } else { "git" });
    let out = Command::new("rustc")
        .args([
            src.to_str().unwrap(),
            "-o",
            exe.to_str().unwrap(),
            "--edition",
            "2021",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "shim compile failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn fixture_remote(dir: &Path) -> String {
    let repo = dir.join("repo");
    std::fs::create_dir_all(repo.join("skills/git-helper")).unwrap();
    std::fs::write(repo.join("skills/git-helper/SKILL.md"), "# Git\nfixture").unwrap();
    let r = repo.to_str().unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git").args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?} failed");
    };
    git(&["-C", r, "init", "-q"]);
    git(&["-C", r, "config", "user.email", "t@t.t"]);
    git(&["-C", r, "config", "user.name", "t"]);
    git(&["-C", r, "add", "-A"]);
    git(&["-C", r, "commit", "-q", "-m", "init"]);
    format!("file://{r}")
}

#[test]
fn filter_rejecting_server_still_clones_and_fetches() {
    let tmp = tempfile::tempdir().unwrap();
    let shim_dir = tmp.path().join("shim");
    std::fs::create_dir_all(&shim_dir).unwrap();
    let real = real_git_path();
    install_filter_rejecting_git(&shim_dir);
    let orig_path = std::env::var("PATH").unwrap();
    let sep = if cfg!(windows) { ";" } else { ":" };
    // Single #[test] in this binary — no other test races these process-global vars.
    std::env::set_var("REAL_GIT", &real);
    std::env::set_var(
        "PATH",
        format!("{}{sep}{orig_path}", shim_dir.to_str().unwrap()),
    );

    let url = fixture_remote(tmp.path());

    // The filtered attempt exits 33; the unfiltered retry must succeed (still sparse).
    let sparse_dest = tmp.path().join("sparse-clone");
    let root = sparse_clone(&url, "HEAD", "skills", &sparse_dest).expect("sparse fallback");
    assert!(root.join("git-helper/SKILL.md").is_file());

    let full_dest = tmp.path().join("full-clone");
    clone_repo(&url, None, None, &full_dest).expect("full fallback");
    assert!(full_dest.join("skills/git-helper/SKILL.md").is_file());
    // The fallback clone must be a PLAIN clone: no partial-clone filter recorded.
    let cfg = Command::new("git")
        .args([
            "-C",
            full_dest.to_str().unwrap(),
            "config",
            "remote.origin.partialclonefilter",
        ])
        .output()
        .unwrap();
    assert!(
        !cfg.status.success() || cfg.stdout.is_empty(),
        "fallback clone unexpectedly recorded a partial-clone filter"
    );

    // Upstream moves; the update fetch must work against the filter-rejecting server
    // (i.e. fetch passes no --filter flag — native fetches plain).
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(repo.join("skills/newer")).unwrap();
    std::fs::write(repo.join("skills/newer/SKILL.md"), "# newer").unwrap();
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
    fetch_and_reset(&full_dest, None).expect("fetch against filter-rejecting server");
    assert!(full_dest.join("skills/newer/SKILL.md").is_file());
}
