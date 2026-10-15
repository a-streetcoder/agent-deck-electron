//! Scope resolution: a PROJECT skill shadows a same-named GLOBAL one.
//!
//! agent-deck's native (Swift) semantics, which the electron port dropped and has now restored on
//! the display side — its scan orders project first. The write half is the engine's job
//! (ADR 0004, request 2), so resolution lives HERE rather than in either consumer: two products
//! independently deciding which copy wins is precisely how the same problem gets solved twice,
//! divergently, which is what this consolidation exists to stop.
//!
//! Note what this module does NOT do: it does not read or write the filesystem. It resolves an
//! ordering over already-discovered catalogs, so it is exhaustively testable without a temp dir,
//! and the effectful half (`materialize`, `fanout`) stays a simple function of the resolved set.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Which catalog a skill came from. Lives HERE, not in `tools.rs`: it describes catalog
/// precedence, not tool detection — and putting it beside the registry implied registry paths vary
/// by scope, which is false (review, both models).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// `$HOME/.agents/skills` (and, during migration, `~/.pi/agent/skills`).
    Global,
    /// `<project>/.agents/skills` (and, during migration, `<project>/.pi/skills`).
    /// Shadows a same-named global skill.
    Project,
    /// A collection root the host supplies. The engine never DISCOVERS these — agent-deck resolves
    /// its own collection roots — but the variant exists so a host-supplied skill can be carried
    /// through `resolve` with the right precedence instead of being dropped.
    Library,
}

/// One catalog to scan, and the scope its skills carry. The host may pass extras (library roots,
/// and the native `.pi` paths that exist during the migration window) so the ENGINE owns
/// precedence for every catalog rather than each consumer re-deriving it.
#[derive(Debug, Clone)]
pub struct CatalogDir {
    pub dir: PathBuf,
    pub scope: Scope,
}

/// One skill as discovered in one scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedSkill {
    /// Directory name under the catalog. NOT the shadowing identity — see `name`.
    pub slug: String,
    /// Parsed SKILL.md frontmatter `name`, falling back to the folder name.
    ///
    /// THIS is what precedence dedups on, not `slug` (contract spec section 2; both reviewers
    /// flagged the divergence). agent-deck keys `names.has(skill.name)` in its scanner, so a skill
    /// whose frontmatter name differs from its folder name would otherwise shadow differently in
    /// the two systems — double-listing or mis-shadowing.
    pub name: String,
    /// Frontmatter description; empty string when absent (agent-deck's field is not optional).
    pub description: String,
    /// The skill is manual-only, never model-invoked.
    pub disable_model_invocation: bool,
    /// SKILL.md with the frontmatter stripped, trimmed.
    pub body: String,
    pub scope: Scope,
    /// The skill's directory — agent-deck's `baseDir`.
    pub path: PathBuf,
}

impl ScopedSkill {
    /// agent-deck's `filePath`: the SKILL.md inside the skill directory.
    pub fn file_path(&self) -> PathBuf {
        self.path.join("SKILL.md")
    }

    /// Build from a skill directory, parsing SKILL.md for the identity fields. `name` falls back
    /// to the folder name exactly as agent-deck and pi both do.
    pub fn from_dir(slug: impl Into<String>, scope: Scope, path: impl Into<PathBuf>) -> Self {
        let slug = slug.into();
        let path = path.into();
        let text = std::fs::read_to_string(path.join("SKILL.md")).unwrap_or_default();
        let d = crate::agentdeck::skill_md_detail(&text, &slug);
        Self {
            slug,
            name: d.name,
            description: d.description,
            disable_model_invocation: d.disable_model_invocation,
            body: d.body,
            scope,
            path,
        }
    }
}

/// The effective catalog: project entries shadow same-slug global entries.
///
/// Deterministic by slug (BTreeMap) so two consumers listing the same catalogs agree on order —
/// agent-deck renders this list and Syncr syncs it; a HashMap's arbitrary order would make them
/// disagree about "the same" catalog for no reason.
pub fn resolve(global: &[ScopedSkill], project: &[ScopedSkill]) -> Vec<ScopedSkill> {
    let mut by_name: BTreeMap<&str, &ScopedSkill> = BTreeMap::new();
    for s in global {
        by_name.insert(s.name.as_str(), s);
    }
    // project last: same NAME overwrites, which IS the shadowing rule
    for s in project {
        by_name.insert(s.name.as_str(), s);
    }
    by_name.into_values().cloned().collect()
}

/// The canonical catalog dir for a scope root: `<root>/.agents/skills`.
///
/// The SAME layout at both scopes, which is the point — `.pi/skills` and every other tool dir are
/// fan-out targets of this, never a second canonical location (ADR 0004, request 2).
pub fn canonical_catalog(root: &Path) -> PathBuf {
    root.join(".agents").join("skills")
}

/// Resolve an ORDERED list of catalogs, first occurrence of a name winning.
///
/// This is the contract's precedence (skill-store-contract §2) expressed once: the caller passes
/// catalogs in scan order — project canonical, project native, global native, global canonical,
/// then library — and the engine dedups on the parsed frontmatter name. `resolve` remains for the
/// simple two-scope case; this is what the NAPI binding calls, because during the migration window
/// the `.pi` catalogs still hold real user skills and must not be invisible.
pub fn resolve_ordered(catalogs: &[CatalogDir]) -> std::io::Result<Vec<ScopedSkill>> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut out: Vec<ScopedSkill> = Vec::new();
    for c in catalogs {
        for skill in discover_dir(&c.dir, c.scope)? {
            // A skill with no description DOES NOT EXIST to pi — `loadSkillFromFile` returns
            // `skill: null` for a missing or blank one. Listing it made the engine advertise skills
            // no agent would ever load, and (worse) let one SHADOW a described skill of the same
            // name, hiding a working skill behind a broken one. Filtered here, at the precedence
            // boundary, so the shadowing order matches pi's; `discover_dir` stays total so writes
            // can still resolve a description-less skill's real location.
            if skill.description.trim().is_empty() {
                continue;
            }
            // FIRST in scan order wins — matches agent-deck's `names.has(skill.name)` scanner.
            if seen.insert(skill.name.clone()) {
                out.push(skill);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Discover skills in an EXPLICIT directory (not derived from a root). Used by `resolve_ordered`
/// for catalogs whose layout is not `<root>/.agents/skills` — the native `.pi` paths and library
/// roots the host supplies.
pub fn discover_dir(catalog: &Path, scope: Scope) -> std::io::Result<Vec<ScopedSkill>> {
    let mut out = Vec::new();
    walk_catalog(catalog, scope, &mut out, 0)?;
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Descend the way pi's `loadSkillsFromDir` descends (verified against
/// `@earendil-works/pi-coding-agent/dist/core/skills.js`):
///
/// * a directory containing `SKILL.md` IS a skill, and pi STOPS there — it never looks inside a
///   skill for more skills, which is what keeps a skill's own `scripts/` from being scanned;
/// * otherwise every non-dot, non-`node_modules` subdirectory is descended, to ANY depth.
///
/// Scanning direct children only meant a skill filed one folder deep — `~/.agents/skills/team/
/// deploy/SKILL.md`, which pi loads — did not exist as far as the engine was concerned. Listing it
/// was empty, so writing to that name created a SECOND skill in the catalog root rather than
/// editing the one already there (review, H5).
fn walk_catalog(
    dir: &Path,
    scope: Scope,
    out: &mut Vec<ScopedSkill>,
    depth: usize,
) -> std::io::Result<()> {
    // Depth bound rather than a visited set: O(1) state, and no legitimate catalog is near this
    // deep. Cheap insurance, because a Rust stack overflow aborts the whole host process — pi
    // survives its own unbounded recursion only because JS throws RangeError into a `catch {}`.
    const MAX_DEPTH: usize = 32;
    if depth > MAX_DEPTH || !dir.is_dir() {
        return Ok(());
    }
    if dir.join("SKILL.md").is_file() {
        let slug = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        out.push(ScopedSkill::from_dir(slug, scope, dir.to_path_buf()));
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(child) = name.to_str() else { continue };
        if child.starts_with('.') || child == "node_modules" {
            continue;
        }
        // Links are NOT followed, deliberately. Syncr's fan-out projects the canonical catalog into
        // tool dirs — including `~/.pi/agent/skills`, which this function also scans — so following
        // them would rediscover our own projection as if it were a source, and make a write resolve
        // to a link path. A skill's home is the canonical catalog; a link is an output, never an
        // input. (This is where the engine deliberately differs from pi, which does follow them.)
        if !entry.file_type()?.is_dir() {
            continue;
        }
        walk_catalog(&entry.path(), scope, out, depth + 1)?;
    }
    Ok(())
}

/// Read ONE skill directory — a dir that itself contains `SKILL.md`, not a catalog of them.
///
/// agent-deck's `collectionRoots` are individual skill dirs the user picked in place, which its
/// scanner handles by listing `dirname(root)` and keeping the entry that IS `root`. The engine
/// treated each one as a CATALOG, so `discover_dir` listed the skill's own subfolders (`scripts/`,
/// `assets/`) looking for skills, found none, and every library skill silently vanished from the
/// list (review, H3). Collections are the one input where the host names the skill, not its parent.
pub fn discover_skill_dir(dir: &Path, scope: Scope) -> std::io::Result<Option<ScopedSkill>> {
    if !dir.join("SKILL.md").is_file() {
        return Ok(None);
    }
    let Some(slug) = dir.file_name().and_then(|s| s.to_str()) else {
        return Ok(None);
    };
    Ok(Some(ScopedSkill::from_dir(
        slug.to_string(),
        scope,
        dir.to_path_buf(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(slug: &str, name: &str, scope: Scope, root: &str) -> ScopedSkill {
        ScopedSkill {
            slug: slug.into(),
            name: name.into(),
            description: String::new(),
            disable_model_invocation: false,
            body: String::new(),
            scope,
            path: PathBuf::from(format!("{root}/.agents/skills/{slug}")),
        }
    }
    fn g(slug: &str) -> ScopedSkill {
        mk(slug, slug, Scope::Global, "/home/u")
    }
    fn p(slug: &str) -> ScopedSkill {
        mk(slug, slug, Scope::Project, "/proj")
    }

    #[test]
    fn project_shadows_a_same_named_global_skill() {
        let out = resolve(&[g("deploy"), g("review")], &[p("deploy")]);
        let deploy = out.iter().find(|s| s.slug == "deploy").unwrap();
        assert_eq!(deploy.scope, Scope::Project, "the project copy must win");
        assert_eq!(deploy.path, PathBuf::from("/proj/.agents/skills/deploy"));
        // the unshadowed global one survives
        assert_eq!(
            out.iter().find(|s| s.slug == "review").unwrap().scope,
            Scope::Global
        );
        assert_eq!(out.len(), 2, "shadowing replaces, it does not duplicate");
    }

    #[test]
    fn scopes_are_unioned_not_intersected() {
        let out = resolve(&[g("only-global")], &[p("only-project")]);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn empty_project_scope_leaves_the_global_catalog_untouched() {
        let out = resolve(&[g("a"), g("b")], &[]);
        assert!(out.iter().all(|s| s.scope == Scope::Global));
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn ordering_is_deterministic_so_both_consumers_agree() {
        let a = resolve(&[g("z"), g("a")], &[p("m")]);
        let b = resolve(&[g("a"), g("z")], &[p("m")]);
        assert_eq!(a, b);
        assert_eq!(
            a.iter().map(|s| s.slug.as_str()).collect::<Vec<_>>(),
            ["a", "m", "z"]
        );
    }

    #[test]
    fn canonical_catalog_is_the_same_layout_at_both_scopes() {
        assert_eq!(
            canonical_catalog(Path::new("/home/u")),
            PathBuf::from("/home/u/.agents/skills")
        );
        assert_eq!(
            canonical_catalog(Path::new("/proj")),
            PathBuf::from("/proj/.agents/skills")
        );
    }
}

#[cfg(test)]
mod fs_tests {
    use super::*;
    use std::fs;

    fn seed(root: &Path, slug: &str) {
        let d = canonical_catalog(root).join(slug);
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("SKILL.md"),
            format!("---\nname: {slug}\n---\n# {slug}"),
        )
        .unwrap();
    }

    /// What `effective_catalog` used to be: global, then project shadowing it. Inlined into the
    /// tests that need it now that no production caller wants a second reader.
    fn effective(home: &Path, proj: &Path) -> Vec<ScopedSkill> {
        resolve(
            &discover_dir(&canonical_catalog(home), Scope::Global).unwrap(),
            &discover_dir(&canonical_catalog(proj), Scope::Project).unwrap(),
        )
    }

    #[test]
    fn a_project_catalog_shadows_the_global_one_on_disk() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        seed(home.path(), "deploy");
        seed(home.path(), "review");
        seed(proj.path(), "deploy");

        let eff = effective(home.path(), proj.path());
        let deploy = eff.iter().find(|s| s.slug == "deploy").unwrap();
        assert_eq!(deploy.scope, Scope::Project);
        assert!(
            deploy.path.starts_with(proj.path()),
            "the project copy must win on disk too"
        );
        assert_eq!(
            eff.iter().find(|s| s.slug == "review").unwrap().scope,
            Scope::Global
        );
        assert_eq!(eff.len(), 2);
    }

    // Contract spec section 2: dedup keys on the parsed frontmatter NAME, not the folder slug.
    // Both reviewers flagged this — agent-deck's scanner does `names.has(skill.name)`, so keying on
    // the slug would double-list a skill whose frontmatter name differs from its folder, and
    // mis-shadow two differently-named skills that happen to share a folder name.
    #[test]
    fn shadowing_keys_on_frontmatter_name_not_the_folder_slug() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        // same declared NAME, different folder slugs -> the project one must still shadow
        let g = canonical_catalog(home.path()).join("deploy-v1");
        fs::create_dir_all(&g).unwrap();
        fs::write(
            g.join("SKILL.md"),
            "---
name: deploy
---
# global",
        )
        .unwrap();
        let p = canonical_catalog(proj.path()).join("deploy-fork");
        fs::create_dir_all(&p).unwrap();
        fs::write(
            p.join("SKILL.md"),
            "---
name: deploy
---
# project",
        )
        .unwrap();

        let eff = effective(home.path(), proj.path());
        assert_eq!(
            eff.len(),
            1,
            "same declared name = one skill, despite different slugs"
        );
        assert_eq!(eff[0].scope, Scope::Project);
        assert_eq!(eff[0].slug, "deploy-fork");
        // the global copy is hidden: its folder is not the one that survived
        assert!(!eff.iter().any(|s| s.path.starts_with(home.path())));
    }

    #[test]
    #[allow(non_snake_case)] // the capitals are the point of the name
    fn same_slug_but_different_declared_names_do_NOT_shadow() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        for (root, name) in [(home.path(), "alpha"), (proj.path(), "beta")] {
            let d = canonical_catalog(root).join("shared-slug");
            fs::create_dir_all(&d).unwrap();
            fs::write(
                d.join("SKILL.md"),
                format!(
                    "---
name: {name}
---
# x"
                ),
            )
            .unwrap();
        }
        let eff = effective(home.path(), proj.path());
        assert_eq!(
            eff.len(),
            2,
            "different declared names are different skills"
        );
    }

    #[test]
    fn skill_detail_fields_match_the_contract_shape() {
        let home = tempfile::tempdir().unwrap();
        let d = canonical_catalog(home.path()).join("deploy");
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("SKILL.md"),
            "---
name: Deploy
description: Ship it
disable-model-invocation: true
---
# Body
text
",
        )
        .unwrap();
        let s = &discover_dir(&canonical_catalog(home.path()), Scope::Global).unwrap()[0];
        assert_eq!(s.name, "Deploy");
        assert_eq!(s.description, "Ship it");
        assert!(s.disable_model_invocation);
        assert_eq!(
            s.body,
            "# Body
text"
        );
        assert_eq!(s.file_path(), d.join("SKILL.md"));
        assert_eq!(s.path, d, "baseDir is the skill directory");
    }

    #[test]
    fn a_skill_without_frontmatter_falls_back_to_its_folder_name() {
        let home = tempfile::tempdir().unwrap();
        let d = canonical_catalog(home.path()).join("no-fm");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("SKILL.md"), "# just a body").unwrap();
        let s = &discover_dir(&canonical_catalog(home.path()), Scope::Global).unwrap()[0];
        assert_eq!(s.name, "no-fm");
        assert_eq!(s.description, "");
        assert!(!s.disable_model_invocation);
    }

    #[test]
    fn a_project_with_no_catalog_is_an_empty_scope_not_an_error() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        seed(home.path(), "deploy");
        assert!(
            discover_dir(&canonical_catalog(proj.path()), Scope::Project)
                .unwrap()
                .is_empty()
        );
        assert_eq!(effective(home.path(), proj.path()).len(), 1);
    }

    #[test]
    fn no_project_selected_yields_exactly_the_global_catalog() {
        let home = tempfile::tempdir().unwrap();
        seed(home.path(), "deploy");
        let eff = discover_dir(&canonical_catalog(home.path()), Scope::Global).unwrap();
        assert_eq!(eff.len(), 1);
        assert_eq!(eff[0].scope, Scope::Global);
    }
}
