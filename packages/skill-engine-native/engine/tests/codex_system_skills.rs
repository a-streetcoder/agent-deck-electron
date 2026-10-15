//! #206 acceptance criterion 1, run against the REAL fixture that produced the bug report:
//! `~/.codex/skills/.system`, whose six shipped skills carry `assets/*.png`.
//!
//! Read-only. It never writes into `~/.codex` (or `~/.claude`): `home` is a tempdir, so the
//! self-import guard resolves against a throwaway catalog and `inspect_local_folder`
//! materializes nothing. On a machine without Codex installed it prints a skip line and passes —
//! a fixture that is absent must not fail CI, and `#[ignore]` would hide it here too.

use std::path::PathBuf;

fn codex_system_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let p = PathBuf::from(home).join(".codex/skills/.system");
    p.is_dir().then_some(p)
}

#[test]
fn the_real_codex_system_skills_are_inspectable_with_their_binary_assets() {
    let Some(dir) = codex_system_dir() else {
        println!("skip: ~/.codex/skills/.system is not present on this machine");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();

    let previews = skill_engine::store::inspect_local_folder(&home, &dir).unwrap_or_else(|e| {
        panic!(
            "#206: five of these six skills ship a PNG under assets/, and one non-UTF-8 file \
             currently fails the WHOLE folder — this is the defect: {} ({})",
            e,
            e.code()
        )
    });

    let mut got: Vec<(String, u32)> = previews
        .iter()
        .map(|p| (p.name.clone(), p.file_count))
        .collect();
    got.sort();
    // Measured on this machine 2026-08-27 with `find <skill> -type f | wc -l`.
    // Expected counts are measured from the tree AT TEST TIME (regular files under each skill
    // root, `.git` excluded), not hardcoded: Codex updates its bundled skills, and a stale literal
    // would read as a #206 regression on the next update. The assertion that matters — every
    // skill listed, fileCount including the binary assets — is unchanged (committer, round 43).
    let mut expected: Vec<(String, u32)> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir() && e.path().join("SKILL.md").is_file())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            (name, count_regular_files(&e.path()))
        })
        .collect();
    expected.sort();
    assert!(
        expected.len() >= 6,
        "the fixture should hold the six Codex system skills, found {expected:?}"
    );
    assert!(
        expected.iter().any(|(n, _)| n == "skill-creator"),
        "skill-creator (ships assets/skill-creator.png) must be in the fixture"
    );
    assert_eq!(
        got, expected,
        "all six skills must be listed, and fileCount must include the binary assets"
    );

    // and nothing was written into the real Codex tree
    assert!(
        !dir.join(".syncr-staging").exists(),
        "inspect must materialize nothing"
    );
}

fn count_regular_files(root: &std::path::Path) -> u32 {
    let mut n = 0;
    for entry in std::fs::read_dir(root).unwrap().filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.is_dir() {
            if entry.file_name() != ".git" {
                n += count_regular_files(&p);
            }
        } else if p.is_file() {
            n += 1;
        }
    }
    n
}
