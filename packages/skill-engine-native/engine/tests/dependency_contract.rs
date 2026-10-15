//! The dependency list IS the contract (ADR 0004, task 1).
//!
//! This crate is linked into agent-deck's Electron process as a NAPI addon, so every dependency
//! becomes something their packaging carries and ships to users. Before the factoring it lived
//! inside `syncr-core`, and the addon linked BUNDLED SQLITE, a filesystem watcher and a diff
//! library that no engine operation calls.
//!
//! A grep-guard rather than a comment, because the failure mode is silent: `cargo add` in the
//! wrong crate re-links megabytes into someone else's app and nothing fails. This is the same
//! convention as the web guard tests — when you add an invariant, add its rule.

use std::path::Path;

/// Everything this crate is allowed to depend on. Adding an entry is a deliberate act: it means
/// agent-deck's addon now carries it too.
const ALLOWED: &[&str] = &[
    "sha2",       // content addressing
    "hex",        // ditto
    "serde_json", // the fileset envelope
    "junction",   // Windows fan-out without elevation
    "tempfile",   // dev only
];

/// Things that must NEVER reach the addon, named so the failure message explains itself.
const BANNED: &[(&str, &str)] = &[
    (
        "rusqlite",
        "the version store and index are syncr-core's; the addon must not link SQLite",
    ),
    (
        "notify",
        "agent-deck has its own watcher; the addon must not link a filesystem watcher",
    ),
    ("diffy", "3-way merge lives in syncr-core::conflict"),
    ("ureq", "the engine performs no network I/O"),
    ("reqwest", "the engine performs no network I/O"),
    ("tokio", "the engine is synchronous by design"),
    ("git2", "the git provider is syncr-core's"),
    ("gix", "the git provider is syncr-core's"),
];

fn manifest() -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    std::fs::read_to_string(p).expect("read own Cargo.toml")
}

/// Every package this crate pulls in, by REAL package identity.
///
/// The alias is not the identity: `hex = { package = "rusqlite" }` declares a dependency named
/// `hex` that links SQLite, and a check comparing only the left-hand side waves it straight
/// through (review, Codex — a guard that can be bypassed by the thing it guards against). So a
/// `package = "…"` rename contributes the RENAMED-TO name, which is what actually gets linked.
fn declared_dependencies(toml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_deps = false;
    for raw in toml.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_deps = line.contains("dependencies");
            continue;
        }
        if !in_deps || line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `[dependencies.foo]` section header — the name is in the header, not a line.
        let Some((alias, rest)) = line.split_once('=') else {
            continue;
        };
        let alias = alias.trim().trim_matches('"');
        if alias.is_empty() {
            continue;
        }
        // `package = "real-name"` inside an inline table renames; the real package is what ships.
        let real = rest
            .split_once("package")
            .and_then(|(_, after)| after.split_once('='))
            .map(|(_, v)| v.trim().trim_start_matches('"'))
            .and_then(|v| v.split('"').next())
            .filter(|v| !v.is_empty());
        // Workspace inheritance hides the real package in ANOTHER manifest, which this
        // parser does not read. Rather than report the alias and pass, surface a sentinel
        // so the test FAILS: a guard that cannot see the answer must not report success
        // (review, Codex).
        if rest.contains("workspace") && rest.contains("true") && real.is_none() {
            out.push(format!("<workspace-inherited:{alias}>"));
            continue;
        }
        out.push(real.unwrap_or(alias).to_string());
    }
    out
}

#[test]
fn the_engine_depends_only_on_what_the_addon_should_carry() {
    let deps = declared_dependencies(&manifest());
    assert!(
        !deps.is_empty(),
        "parsed no dependencies — the parser is broken, not the manifest"
    );
    let unexpected: Vec<&String> = deps
        .iter()
        .filter(|d| !ALLOWED.contains(&d.as_str()))
        .collect();
    assert!(
        unexpected.is_empty(),
        "skill-engine gained {unexpected:?}, which agent-deck's Electron addon would now ship. \
         If that is intended, add it to ALLOWED with a reason; if it is only needed for history, \
         sync, watching or merging, it belongs in syncr-core."
    );
}

#[test]
fn the_engine_never_links_the_heavy_crates_that_prompted_the_factoring() {
    let toml = manifest();
    for (crate_name, why) in BANNED {
        assert!(
            !declared_dependencies(&toml).iter().any(|d| d == crate_name),
            "skill-engine must not depend on `{crate_name}`: {why}"
        );
    }
}

#[test]
fn the_dependency_parser_actually_sees_the_declared_deps() {
    // Guards the guard: a parser that silently matches nothing would make both tests vacuous —
    // exactly how a grep-style rule goes green while enforcing nothing.
    let deps = declared_dependencies(&manifest());
    for expected in ["sha2", "hex", "serde_json", "junction", "tempfile"] {
        assert!(
            deps.iter().any(|d| d == expected),
            "parser missed `{expected}`: {deps:?}"
        );
    }
    let fake = "[dependencies]\nrusqlite = { version = \"0.31\" }\n";
    assert_eq!(declared_dependencies(fake), vec!["rusqlite".to_string()]);
}

#[test]
fn a_workspace_inherited_dependency_fails_the_guard_rather_than_passing_blind() {
    // The real package lives in ANOTHER manifest this parser does not read. Reporting the alias
    // would let `hex = { workspace = true }` (aliasing rusqlite upstream) sail through — a guard
    // reporting success about something it cannot see (review, Codex).
    let inherited = "[dependencies]
hex = { workspace = true }
";
    let deps = declared_dependencies(inherited);
    assert_eq!(deps, vec!["<workspace-inherited:hex>".to_string()]);
    assert!(
        !ALLOWED.contains(&deps[0].as_str()),
        "an unresolvable form must fail the allowlist, not pass it"
    );
}

#[test]
fn a_renamed_dependency_is_judged_by_its_real_package_not_its_alias() {
    // The bypass this guard was blind to: an allowlisted ALIAS hiding a banned package.
    let sneaky = "[dependencies]\nhex = { version = \"0.31\", package = \"rusqlite\" }\n";
    assert_eq!(
        declared_dependencies(sneaky),
        vec!["rusqlite".to_string()],
        "a `package =` rename must report what actually links, not the name it was given"
    );
    // and an ordinary entry is unaffected
    assert_eq!(
        declared_dependencies("[dependencies]\nserde_json = \"1\"\n"),
        vec!["serde_json".to_string()]
    );
}
