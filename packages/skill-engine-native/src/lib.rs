//! NAPI binding for the shared skill engine — the surface agent-deck's `SkillStore` swaps onto.
//!
//! This is a THIN translation layer and nothing else: every decision (precedence, atomicity,
//! containment, error vocabulary) lives in `syncr-core`, so agent-deck and Syncr's own Tauri app
//! cannot drift. If a rule appears here that is not in the core, it is in the wrong place.
//!
//! Two deliberate shape choices, both from the contract (`agent-deck/docs/skill-store-contract.md`):
//!
//! * The host resolves `projectId` → project root and passes ROOTS. The engine has no idea what a
//!   project id is; that is the seam's own contract, not an omission.
//! * `disabled` is never populated. It is agent-deck's app-level disable list, layered on AFTER
//!   `listSkills`, and an engine that guessed at it would fight the app.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::{Path, PathBuf};

use skill_engine::repos;
use skill_engine::scope::Scope;
use skill_engine::store;

/// agent-deck's `SkillInfo` (contract §1).
#[napi(object)]
pub struct SkillInfo {
    /// Frontmatter `name`, falling back to the folder name. THE dedup identity.
    pub name: String,
    /// Frontmatter `description`; empty string when absent (agent-deck's field is not optional).
    pub description: String,
    /// `"global" | "project" | "library"`.
    pub scope: String,
    /// Absolute path to `<skillDir>/SKILL.md`.
    pub file_path: String,
    /// Absolute path to the skill directory.
    pub base_dir: String,
    /// Frontmatter flag: manual-only, never model-invoked.
    pub disable_model_invocation: bool,
    /// SKILL.md with the frontmatter stripped, trimmed.
    pub body: String,
}

/// A recoverable tree left by an interrupted write (contract §6).
#[napi(object)]
pub struct RecoveryInfo {
    pub token: String,
    pub slug: String,
    pub path: String,
}

/// Parse the host's scope string. FAILS CLOSED: an unknown scope is refused, never defaulted to
/// global — defaulting is how a library-scoped write ended up in the user's global catalog.
fn scope_of(s: &str) -> Result<Scope> {
    match s {
        "global" => Ok(Scope::Global),
        "project" => Ok(Scope::Project),
        "library" => Ok(Scope::Library),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("RESOURCE_INVALID_PATH: unknown scope {other}"),
        )),
    }
}

fn scope_str(s: Scope) -> &'static str {
    match s {
        Scope::Global => "global",
        Scope::Project => "project",
        Scope::Library => "library",
    }
}

fn to_info(s: skill_engine::scope::ScopedSkill) -> SkillInfo {
    SkillInfo {
        name: s.name.clone(),
        description: s.description.clone(),
        scope: scope_str(s.scope).to_string(),
        file_path: s.file_path().to_string_lossy().into_owned(),
        base_dir: s.path.to_string_lossy().into_owned(),
        disable_model_invocation: s.disable_model_invocation,
        body: s.body.clone(),
    }
}

/// Carry the core's stable error CODE across the boundary, not just a message.
///
/// agent-deck's routes map these codes to HTTP statuses, so flattening them to a generic error
/// would silently turn a permanent failure (invalid name) into one a client retries forever.
fn map_err(e: store::StoreError) -> Error {
    Error::new(Status::GenericFailure, format!("{}: {e}", e.code()))
}

/// RESOURCE_IO, not RESOURCE_BUSY. BUSY reads as transient and a client retries it, so mapping
/// every io error to it turned a permanent failure — a missing tool dir, a permission denial —
/// into an infinite retry loop. Matches `StoreError::Io`'s own mapping, which says the same thing.
fn io_err(e: std::io::Error) -> Error {
    Error::new(Status::GenericFailure, format!("RESOURCE_IO: {e}"))
}

/// Skills visible for a home + optional project, in contract scan order with project shadowing
/// global by parsed name. `library_roots` are collection roots the HOST resolves — the engine
/// ranks them but never discovers them.
#[napi]
pub fn list_skills(
    home: String,
    project_root: Option<String>,
    library_roots: Option<Vec<String>>,
) -> Result<Vec<SkillInfo>> {
    let home = PathBuf::from(home);
    let project = project_root.map(PathBuf::from);
    // Each library root names a SKILL directory the user picked in place, not a catalog of them.
    let collections: Vec<PathBuf> = library_roots
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let skills = store::list_catalog(&home, project.as_deref(), &collections).map_err(map_err)?;
    Ok(skills.into_iter().map(to_info).collect())
}

/// Create or edit a skill. Returns the path to its SKILL.md (contract §4 returns a path; the file
/// is the addressable thing a caller opens, not the directory).
///
/// Takes the roots AND the scope. The scope bounds which catalogs may be touched — a project write
/// must never reach the user's global skill of the same name — while within that scope the write
/// still lands in the catalog the reader actually reads, including the migration-window `.pi` one.
#[napi]
pub fn write_skill(
    home: String,
    project_root: Option<String>,
    scope: String,
    name: String,
    description: Option<String>,
    body: Option<String>,
) -> Result<String> {
    let project = project_root.map(PathBuf::from);
    let dir = store::edit_skill(
        Path::new(&home),
        project.as_deref(),
        scope_of(&scope)?,
        &name,
        description.as_deref(),
        body.as_deref(),
    )
    .map_err(map_err)?;
    Ok(dir.join("SKILL.md").to_string_lossy().into_owned())
}

#[napi]
pub fn delete_skill(
    home: String,
    project_root: Option<String>,
    scope: String,
    name: String,
) -> Result<()> {
    let project = project_root.map(PathBuf::from);
    store::remove_skill(
        Path::new(&home),
        project.as_deref(),
        scope_of(&scope)?,
        &name,
    )
    .map_err(map_err)
}

#[napi]
pub fn rename_skill(
    home: String,
    project_root: Option<String>,
    scope: String,
    name: String,
    new_name: String,
) -> Result<String> {
    let project = project_root.map(PathBuf::from);
    let dir = store::move_skill(
        Path::new(&home),
        project.as_deref(),
        scope_of(&scope)?,
        &name,
        &new_name,
    )
    .map_err(map_err)?;
    Ok(dir.join("SKILL.md").to_string_lossy().into_owned())
}

/// Import a single local `.md` file as a skill.
///
/// The contract's `importLocalSkill(scope, sourcePath, projectId?)` supplies no name, so the core
/// derives it from the file's FRONTMATTER (falling back to the stem) — there, not here, so the name
/// the importer picks is the same one the reader will dedup on.
#[napi]
pub fn import_local_skill(
    home: String,
    project_root: Option<String>,
    scope: String,
    source_path: String,
) -> Result<String> {
    // The engine owns the source-kind gate (lone .md file, a skill directory, or its SKILL.md —
    // anything else refuses engine-side with RESOURCE_INVALID_PATH).
    let src = PathBuf::from(&source_path);
    let project = project_root.map(PathBuf::from);
    let dir = store::import_local_skill(
        Path::new(&home),
        project.as_deref(),
        scope_of(&scope)?,
        &src,
    )
    .map_err(map_err)?;
    Ok(dir.join("SKILL.md").to_string_lossy().into_owned())
}

#[napi]
pub fn list_recoveries(root: String) -> Result<Vec<RecoveryInfo>> {
    let out = store::list_recoveries(Path::new(&root)).map_err(map_err)?;
    Ok(out
        .into_iter()
        .map(|r| RecoveryInfo {
            token: r.token,
            slug: r.slug,
            path: r.path.to_string_lossy().into_owned(),
        })
        .collect())
}

#[napi]
pub fn restore_recovery(root: String, token: String) -> Result<String> {
    let p = store::restore_recovery(Path::new(&root), &token).map_err(map_err)?;
    Ok(p.to_string_lossy().into_owned())
}

#[napi]
pub fn acknowledge_recovery(root: String, token: String) -> Result<()> {
    store::acknowledge_recovery(Path::new(&root), &token).map_err(map_err)
}

// ── managed git-repo collections (agent-deck P4 request) ────────────────────────────────────────

#[napi(object)]
pub struct GitImportResult {
    pub collection_id: String,
    pub skills: Vec<String>,
    /// Additive re-import only (SKL-13): selected names already in the collection,
    /// left untouched.
    pub skipped: Vec<String>,
}

/// One skill's upstream drift: `kind` is `"added" | "changed" | "removed"`.
#[napi(object)]
pub struct GitDelta {
    pub name: String,
    pub kind: String,
}

#[napi(object)]
pub struct GitSyncResult {
    pub applied: Vec<String>,
    pub conflicts: Vec<String>,
}

#[napi(object)]
pub struct GitRepoInfo {
    pub collection_id: String,
    pub url: String,
    pub git_ref: Option<String>,
    pub subpath: Option<String>,
    pub scope: String,
    pub skills: Vec<String>,
}

/// Preview a LOCAL folder of skills (SKL-05): the git-import discovery run on a plain path —
/// bounds-checked, materializing nothing. Refuses a folder overlapping the skill catalog itself.
/// A TOP-LEVEL symlinked skill is followed and reported with `linkTarget` (>=0.1.10); symlinks
/// inside a skill tree are still refused.
#[napi]
pub fn inspect_local_folder(home: String, root: String) -> Result<Vec<GitSkillPreview>> {
    let out = store::inspect_local_folder(Path::new(&home), Path::new(&root)).map_err(map_err)?;
    Ok(out
        .into_iter()
        .map(|s| GitSkillPreview {
            name: s.name,
            file_count: s.file_count,
            skill_md: s.skill_md,
            link_target: s.link_target,
        })
        .collect())
}

/// Import skills from a LOCAL folder (SKL-05): git-import semantics without the git — discover,
/// optionally filter by `selected`, collision-check everything, materialize each chosen skill's
/// FULL fileset. One-shot copy: no collection state. All-or-nothing.
#[napi]
pub fn import_local_folder(
    home: String,
    project_root: Option<String>,
    scope: String,
    root: String,
    selected: Option<Vec<String>>,
) -> Result<Vec<String>> {
    let project = project_root.map(PathBuf::from);
    store::import_local_folder(
        Path::new(&home),
        project.as_deref(),
        scope_of(&scope)?,
        Path::new(&root),
        selected.as_deref(),
    )
    .map_err(map_err)
}

#[napi(object)]
pub struct GitSkillPreview {
    pub name: String,
    pub file_count: u32,
    /// SKILL.md content (capped at 64 KB) so the host derives display name/description with
    /// its own frontmatter parser; absent when the skill has no SKILL.md at its root, AND (engine
    /// >=0.2.0) when SKILL.md exists but is not text — a binary SKILL.md is never stringified.
    pub skill_md: Option<String>,
    /// Local-folder previews only (engine >=0.1.10): the canonical directory a top-level
    /// symlinked skill was read from. Absent for a plain directory and for repository previews.
    pub link_target: Option<String>,
}

#[napi(object)]
pub struct GitInspectResult {
    pub collection_id: String,
    pub skills: Vec<GitSkillPreview>,
    /// Names already imported into this collection (SKL-13) — empty for a fresh
    /// preview; lets a re-import UI preselect only genuinely new skills.
    pub already_imported: Vec<String>,
}

/// Preview a repository BEFORE importing (SKL-03): clone, discover, return the skills without
/// materializing anything. The clone stays cached so a following `importGitRepo` imports
/// exactly what was shown. An empty `skills` means the repo has no SKILL.md anywhere (the
/// preview cleans itself up). An already-imported url/ref/subpath ANSWERS from the
/// collection's own clone (SKL-13), marking `alreadyImported`.
#[napi]
pub fn inspect_git_repo(
    home: String,
    url: String,
    git_ref: Option<String>,
    subpath: Option<String>,
) -> Result<GitInspectResult> {
    let out = repos::inspect_git_repo(
        Path::new(&home),
        &url,
        git_ref.as_deref(),
        subpath.as_deref(),
    )
    .map_err(map_err)?;
    Ok(GitInspectResult {
        collection_id: out.collection_id,
        skills: out
            .skills
            .into_iter()
            .map(|s| GitSkillPreview {
                name: s.name,
                file_count: s.file_count,
                skill_md: s.skill_md,
                link_target: s.link_target,
            })
            .collect(),
        already_imported: out.already_imported,
    })
}

/// Remove an unconfirmed preview (the user cancelled the import sheet). Idempotent; refuses a
/// genuinely imported collection (that is `forgetGitRepo`'s job).
#[napi]
pub fn discard_git_preview(home: String, collection_id: String) -> Result<()> {
    repos::discard_git_preview(Path::new(&home), &collection_id).map_err(map_err)
}

/// Import a git repo as a managed, re-syncable collection. Discovery matches the legacy
/// importer's contract (root `SKILL.md` = one skill, else every `SKILL.md`'s parent dir); the
/// skills land in the ordinary catalogs, so the host's reader sees them like any other skill.
/// All-or-nothing: collisions, duplicate slugs, or an unsafe tree import NOTHING.
/// `selected` (SKL-04): when present, only those skills are imported and the selection is
/// persisted — later check/sync never surface or materialize an upstream skill outside it.
#[napi]
pub fn import_git_repo(
    home: String,
    project_root: Option<String>,
    scope: String,
    url: String,
    git_ref: Option<String>,
    subpath: Option<String>,
    selected: Option<Vec<String>>,
) -> Result<GitImportResult> {
    let project = project_root.map(PathBuf::from);
    let out = repos::import_git_repo(
        Path::new(&home),
        project.as_deref(),
        scope_of(&scope)?,
        &url,
        git_ref.as_deref(),
        subpath.as_deref(),
        selected.as_deref(),
    )
    .map_err(map_err)?;
    Ok(GitImportResult {
        collection_id: out.collection_id,
        skills: out.skills,
        skipped: out.skipped,
    })
}

/// Preview upstream drift (fetches; writes nothing to catalogs or state).
#[napi]
pub fn check_git_repo(home: String, collection_id: String) -> Result<Vec<GitDelta>> {
    let out = repos::check_git_repo(Path::new(&home), &collection_id).map_err(map_err)?;
    Ok(out
        .into_iter()
        .map(|d| GitDelta {
            name: d.name,
            kind: match d.kind {
                repos::DeltaKind::Added => "added",
                repos::DeltaKind::Changed => "changed",
                repos::DeltaKind::Removed => "removed",
            }
            .to_string(),
        })
        .collect())
}

/// Pull upstream and apply one-sided changes; both-sides motion is reported in `conflicts` and
/// touched by NOTHING except an explicit `resolveGitConflict`. An upstream removal of an
/// unedited skill is applied as a DISPLACEMENT (it lands on the recovery surface).
#[napi]
pub fn sync_git_repo(
    home: String,
    project_root: Option<String>,
    collection_id: String,
) -> Result<GitSyncResult> {
    let project = project_root.map(PathBuf::from);
    let out = repos::sync_git_repo(Path::new(&home), project.as_deref(), &collection_id)
        .map_err(map_err)?;
    Ok(GitSyncResult {
        applied: out.applied,
        conflicts: out.conflicts,
    })
}

/// One path both sides moved. `localKind`/`remoteKind` are `"file" | "directory" | "missing" | "binary"`,
/// so a host can render a `file → directory` transition and warn on a type change.
#[napi(object)]
pub struct GitPathConflict {
    pub path: String,
    pub local_kind: String,
    pub remote_kind: String,
}

/// The per-path conflict detail for one conflicted skill, plus the `mergeId` that identifies
/// this presentation of it.
#[napi(object)]
pub struct GitConflictDetail {
    pub merge_id: String,
    pub paths: Vec<GitPathConflict>,
}

/// One caller decision: take `path` from upstream (`"remote"`) or keep the local copy
/// (`"mine"`). Conflicted paths with no entry default to `"mine"`.
#[napi(object)]
pub struct GitPathChoice {
    pub path: String,
    pub resolution: String,
}

/// The overlapping paths of one conflicted skill — the both-sides-moved paths only; one-sided
/// path motion is auto-merged by `syncGitRepo` and never appears here. Reads; writes nothing.
///
/// Refuses with RESOURCE_NOT_FOUND when the skill is not actually conflicted, and when the
/// collection predates per-file merge (imported by 0.1.4: no base snapshot, so per-path is not
/// answerable — use the whole-skill `resolveGitConflict`, which re-establishes a base).
#[napi]
pub fn conflict_paths(
    home: String,
    project_root: Option<String>,
    collection_id: String,
    name: String,
) -> Result<GitConflictDetail> {
    let project = project_root.map(PathBuf::from);
    let (merge_id, paths) =
        repos::conflict_paths(Path::new(&home), project.as_deref(), &collection_id, &name)
            .map_err(map_err)?;
    Ok(GitConflictDetail {
        merge_id,
        paths: paths
            .into_iter()
            .map(|p| GitPathConflict {
                path: p.path,
                local_kind: p.local_kind,
                remote_kind: p.remote_kind,
            })
            .collect(),
    })
}

/// Settle a conflicted skill PER PATH. `choices` names the paths to take from upstream; any
/// conflicted path left out keeps the local version. All-or-nothing per skill: one atomic swap,
/// the pre-resolve tree lands on the recovery surface, cursor and base advance together.
///
/// `mergeId` must be the one `conflictPaths` returned. If the conflict moved since (upstream
/// fetched again, local edited), this refuses with RESOURCE_STALE and the host re-reads
/// `conflictPaths` — the LEGACY_MERGE_STALE → refresh flow, preserved.
#[napi]
pub fn resolve_git_conflict_paths(
    home: String,
    project_root: Option<String>,
    collection_id: String,
    name: String,
    merge_id: String,
    choices: Vec<GitPathChoice>,
) -> Result<Vec<RecoveryInfo>> {
    // fail closed on the resolution word, exactly like scope_of — an unknown value must never be
    // read as "mine" and silently discard the upstream side the user asked for
    let mut parsed = Vec::with_capacity(choices.len());
    for c in choices {
        let res = match c.resolution.as_str() {
            "remote" => repos::Resolution::Remote,
            "mine" | "local" => repos::Resolution::Local,
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("RESOURCE_INVALID_PATH: unknown resolution {other} (mine|remote)"),
                ))
            }
        };
        parsed.push((c.path, res));
    }
    let project = project_root.map(PathBuf::from);
    let out = repos::resolve_git_conflict_paths(
        Path::new(&home),
        project.as_deref(),
        &collection_id,
        &name,
        &merge_id,
        &parsed,
    )
    .map_err(map_err)?;
    Ok(out
        .into_iter()
        .map(|r| RecoveryInfo {
            token: r.token,
            slug: r.slug,
            path: r.path.to_string_lossy().into_owned(),
        })
        .collect())
}

/// Settle one conflicted skill WHOLE: `"remote"` displaces the local tree into a recovery and
/// applies upstream; `"local"` keeps the edit and moves the cursor so the next sync is clean.
/// Kept beside the per-path form — it is the only resolve available for a collection with no
/// base snapshot, and it re-establishes one. Returns the recoveries now visible at the root.
#[napi]
pub fn resolve_git_conflict(
    home: String,
    project_root: Option<String>,
    collection_id: String,
    name: String,
    resolution: String,
) -> Result<Vec<RecoveryInfo>> {
    // fail closed, like scope_of: an unknown resolution is refused, never defaulted
    let res = match resolution.as_str() {
        "remote" => repos::Resolution::Remote,
        "local" => repos::Resolution::Local,
        other => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("RESOURCE_INVALID_PATH: unknown resolution {other} (remote|local)"),
            ))
        }
    };
    let project = project_root.map(PathBuf::from);
    let out = repos::resolve_git_conflict(
        Path::new(&home),
        project.as_deref(),
        &collection_id,
        &name,
        res,
    )
    .map_err(map_err)?;
    Ok(out
        .into_iter()
        .map(|r| RecoveryInfo {
            token: r.token,
            slug: r.slug,
            path: r.path.to_string_lossy().into_owned(),
        })
        .collect())
}

/// Forget a collection. With `remove_skills`, tracked skills are DISPLACED (recoverable), never
/// hard-deleted; without it they stay behind as ordinary unmanaged skills.
#[napi]
pub fn forget_git_repo(
    home: String,
    project_root: Option<String>,
    collection_id: String,
    remove_skills: bool,
) -> Result<()> {
    let project = project_root.map(PathBuf::from);
    repos::forget_git_repo(
        Path::new(&home),
        project.as_deref(),
        &collection_id,
        remove_skills,
    )
    .map_err(map_err)
}

/// Every imported collection under `home` — the listing `forget`/`sync` callers work from.
#[napi]
pub fn list_git_repos(home: String) -> Result<Vec<GitRepoInfo>> {
    let out = repos::list_git_repos(Path::new(&home)).map_err(map_err)?;
    Ok(out
        .into_iter()
        .map(|r| GitRepoInfo {
            collection_id: r.collection_id,
            url: r.url,
            git_ref: r.git_ref,
            subpath: r.subpath,
            scope: scope_str(r.scope).to_string(),
            skills: r.skills,
        })
        .collect())
}

/// Fan the canonical catalog out into every coding-agent tool dir detected under `root`.
///
/// Not part of `SkillStore` — agent-deck passes explicit `--skill` paths and needs no projection —
/// but the same engine serves Syncr's Tauri app, where eleven of twelve tools DO read their own
/// config dir. Exposed so a host can trigger it; the Windows junction ladder lives in the core.
#[napi]
pub fn fan_out(root: String, slug: String) -> Result<Vec<String>> {
    let root = PathBuf::from(root);
    // Validate the slug like every store write does. This path never did, so `../escape` traversed
    // out of the catalog and — on Windows — an absolute slug made `Path::join` discard the base
    // entirely, creating a junction at an arbitrary location. Same containment boundary, one
    // surface that had forgotten it.
    store::check_slug(&slug).map_err(map_err)?;
    let canonical = skill_engine::scope::canonical_catalog(&root).join(&slug);
    let mut linked = Vec::new();
    for tool in skill_engine::tools::detect(&root) {
        skill_engine::fanout::ensure_link(&tool.skills_dir, &slug, &canonical).map_err(io_err)?;
        linked.push(tool.id.to_string());
    }
    Ok(linked)
}
