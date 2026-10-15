//! Managed git-repo collections — the last capability agent-deck's legacy importer had and the
//! engine lacked (their P4 request, docs/skill-engine-git-import-request.md in agent-deck).
//!
//! A collection is a git repo imported as a set of skills that stays RE-SYNCABLE against its
//! upstream: import clones and materializes, `check` previews upstream drift, `sync` applies
//! clean changes and reports conflicts (never a silent overwrite), `resolve` settles one skill
//! as Take-Remote (the displaced local tree becomes a RECOVERY the existing recovery surface
//! reads) or Take-Local, and `forget` retires the collection.
//!
//! Design decisions, stated because they are the contract:
//!
//! * **State is a JSON file per collection** under `<home>/.agents/skill-repos/<id>/`, next to
//!   the engine-owned clone. The per-skill cursor is a fileset content hash recorded at the last
//!   applied sync — agent-deck's `skillHashes` idea, kept engine-internal exactly as requested.
//! * **Skills land in the ordinary catalogs** (`write_target`, same containment as every other
//!   write), so discovery/precedence/fan-out need no special casing and the host's own reader
//!   sees them like any other skill.
//! * **Conflict = both sides moved.** Upstream differs from the cursor AND the local tree differs
//!   from the cursor (edited or deleted). One-sided motion applies cleanly; a skill the user
//!   edited is never overwritten by `sync` — only by an explicit Take-Remote, which displaces the
//!   local tree into a recovery first.
//! * **Import is all-or-nothing.** Name collisions with existing skills, duplicate slugs inside
//!   the repo, or an unsafe tree fail the whole import with nothing written — matching
//!   `import_local_skill`'s refuse-clobber posture and `import.rs`'s fail-closed reads.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::entry::Fileset;
use crate::git;
use crate::import::{self, ImportError};
use crate::scope::Scope;
use crate::store::{self, Recovery, StoreError};

type Result<T> = std::result::Result<T, StoreError>;

/// `<home>/.agents/skill-repos` — sibling of the canonical catalog, engine-owned.
pub fn collections_root(home: &Path) -> PathBuf {
    home.join(".agents").join("skill-repos")
}

/// Persistent record of one imported collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionState {
    pub id: String,
    pub url: String,
    pub git_ref: Option<String>,
    pub subpath: Option<String>,
    pub scope: Scope,
    /// Per-skill cursor: fileset hash at the last APPLIED sync. The three-way comparison
    /// (upstream / cursor / local) is what makes "conflict" decidable without merge machinery.
    pub skills: BTreeMap<String, String>,
    /// Explicit user selection (SKL-04): when present, ONLY these skills belong to the
    /// collection — check/sync must never surface or materialize an upstream skill outside it.
    /// `None` = legacy full import: new upstream skills keep appearing as `Added`.
    pub selected: Option<BTreeSet<String>>,
}

#[derive(Debug)]
pub struct ImportOutcome {
    pub collection_id: String,
    pub skills: Vec<String>,
    /// Additive re-import only (SKL-13): selected names that were ALREADY in the
    /// collection and were left untouched.
    pub skipped: Vec<String>,
}

/// One discoverable skill in a repository preview (SKL-03). `skill_md` is the SKILL.md content,
/// capped, so the caller can derive display name/description with its own frontmatter parser.
#[derive(Debug)]
pub struct SkillPreview {
    pub name: String,
    pub file_count: u32,
    pub skill_md: Option<String>,
    /// Local-folder previews only: set when the entry is a symlink discovery followed, to the
    /// canonical directory the skill was read from. Lets a host show "linked" (and, when the
    /// target is inside its own catalog, "already imported") instead of dropping the entry.
    /// Always `None` for a repository preview.
    pub link_target: Option<String>,
}

#[derive(Debug)]
pub struct InspectOutcome {
    pub collection_id: String,
    pub skills: Vec<SkillPreview>,
    /// Names already imported into this collection (SKL-13) — empty for a fresh
    /// preview; lets a re-import UI preselect only genuinely new skills.
    pub already_imported: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeltaKind {
    Added,
    Changed,
    Removed,
}

#[derive(Debug)]
pub struct Delta {
    pub name: String,
    pub kind: DeltaKind,
}

#[derive(Debug)]
pub struct SyncOutcome {
    pub applied: Vec<String>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    Remote,
    Local,
}

/// Stable hash of a sanitized fileset: paths and contents in BTreeMap order, length-prefixed so
/// `("a", "bc")` and `("ab", "c")` cannot collide.
pub fn fileset_hash<V: crate::entry::AsEntry>(files: &BTreeMap<String, V>) -> String {
    let mut buf: Vec<u8> = Vec::new();
    for (path, content) in files {
        match content.entry_ref() {
            // UNCHANGED for text — hashes are identity here (the collection cursor, the base
            // snapshot, merge ids, and syncr-core's history all key off this), and every store
            // already on disk holds hashes computed by this exact record.
            crate::entry::EntryRef::Text(t) => buf.extend_from_slice(
                format!("{}\n{}\n{}\n{}\n", path.len(), path, t.len(), t).as_bytes(),
            ),
            // A binary record marks its length with `B`, which no text length's digit run can
            // produce — so the same bytes as text and as binary can never hash alike (#206).
            crate::entry::EntryRef::Binary(b) => {
                buf.extend_from_slice(
                    format!("{}\n{}\nB{}\n", path.len(), path, b.len()).as_bytes(),
                );
                buf.extend_from_slice(b);
                buf.push(b'\n');
            }
        }
    }
    crate::content_hash(&buf)
}

/// Deterministic collection id: `<repo-tail>-<hash8 of url|ref|subpath>`. Deterministic on
/// purpose — re-importing the same (url, ref, subpath) maps to the same id and is refused as
/// already-imported rather than silently duplicated.
fn derive_id(url: &str, git_ref: Option<&str>, subpath: Option<&str>) -> Result<String> {
    let tail = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git");
    let sanitized: String = tail
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('-');
    let base = if sanitized.is_empty() {
        "repo"
    } else {
        sanitized
    };
    let key = format!("{url}|{}|{}", git_ref.unwrap_or(""), subpath.unwrap_or(""));
    let id = format!("{base}-{}", &crate::content_hash(key.as_bytes())[..8]);
    store::check_slug(&id)?;
    Ok(id)
}

fn git_err(e: String) -> StoreError {
    StoreError::Git(e)
}

pub(crate) fn import_err(e: ImportError) -> StoreError {
    match e {
        // The two unsafe causes keep the same CODE and get their own message: collapsing them
        // reported a fifo/device node to the user in symlink wording, for a cause that has
        // nothing to do with links.
        ImportError::UnsafeSymlink(p) => {
            StoreError::UnsafeComponent(format!("symlink in skill tree: {}", p.display()))
        }
        ImportError::UnsafeEntry(p) => StoreError::UnsafeComponent(format!(
            "non-regular entry (fifo/socket/device): {}",
            p.display()
        )),
        ImportError::NonUtf8(p) => StoreError::InvalidUtf8(p.display().to_string()),
        ImportError::Io(s) => StoreError::Git(format!("reading clone: {s}")),
    }
}

/// The clone's import root (`clone` or `clone/<subpath>`, containment already proven at clone
/// time; re-joined here for reads).
fn import_root(state_dir: &Path, subpath: Option<&str>) -> PathBuf {
    let clone = state_dir.join("clone");
    match subpath {
        Some(s) => clone.join(s),
        None => clone,
    }
}

/// Read the clone into `{slug -> fileset}`, refusing duplicate slugs: two dirs at different
/// depths can share a name, and folding them silently would make "which one is the skill"
/// depend on walk order. Bounds are checked from metadata BEFORE any content is read.
pub(crate) fn upstream_skills(root: &Path) -> Result<BTreeMap<String, Fileset>> {
    Ok(upstream_skills_with(root, import::LinkPolicy::Ignore)?
        .into_iter()
        .map(|(name, s)| (name, s.files))
        .collect())
}

/// A skill read from an upstream tree, with where it was read from when discovery followed a
/// top-level symlink to reach it (local-folder policy only).
pub(crate) struct UpstreamSkill {
    pub files: Fileset,
    pub link_target: Option<PathBuf>,
}

/// `upstream_skills` for a folder the USER picked locally (SKL-05): top-level symlinked skills
/// are followed and reported, so a fan-out link in `~/.claude/skills` shows up as the skill it
/// points at rather than vanishing from the preview.
pub(crate) fn upstream_local_skills(root: &Path) -> Result<BTreeMap<String, UpstreamSkill>> {
    upstream_skills_with(root, import::LinkPolicy::FollowTopLevel)
}

fn upstream_skills_with(
    root: &Path,
    policy: import::LinkPolicy,
) -> Result<BTreeMap<String, UpstreamSkill>> {
    check_repo_bounds_with(root, policy)?;
    let skills = match policy {
        import::LinkPolicy::Ignore => import::import_repo(root),
        import::LinkPolicy::FollowTopLevel => import::import_local_tree(root),
    }
    .map_err(import_err)?;
    let mut out: BTreeMap<String, UpstreamSkill> = BTreeMap::new();
    let mut dupes: BTreeSet<String> = BTreeSet::new();
    for s in skills {
        let up = UpstreamSkill {
            files: s.files,
            link_target: s.link_target,
        };
        if out.insert(s.slug.clone(), up).is_some() {
            dupes.insert(s.slug);
        }
    }
    if !dupes.is_empty() {
        return Err(StoreError::Git(format!(
            "repo contains duplicate skill folder names (ambiguous import): {}",
            dupes.into_iter().collect::<Vec<_>>().join(", ")
        )));
    }
    Ok(out)
}

/// The local tree for a collection skill within its scope, if present: `(dir, fileset_hash)`.
fn local_tree(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    name: &str,
) -> Result<Option<(PathBuf, String)>> {
    let dir = store::write_target(home, project_root, scope, name)?;
    if !dir.is_dir() {
        return Ok(None);
    }
    let files = import::read_skill_fileset(&dir).map_err(import_err)?;
    Ok(Some((dir.clone(), fileset_hash(&files))))
}

/// Displace a skill directory into the recovery convention (`.<slug>.displaced.<pid>.<seq>`) in
/// its own catalog — the SAME naming `list_recoveries` parses, so a displaced tree is immediately
/// visible on the existing recovery surface. Returns the displaced path.
fn displace_to_recovery(dir: &Path, slug: &str) -> Result<PathBuf> {
    let catalog = dir
        .parent()
        .ok_or_else(|| StoreError::InvalidPath(slug.into()))?;
    let pid = std::process::id();
    for seq in 0..10_000u32 {
        let candidate = catalog.join(format!(".{slug}.displaced.{pid}.{seq}"));
        if candidate.exists() {
            continue;
        }
        std::fs::rename(dir, &candidate).map_err(StoreError::Io)?;
        return Ok(candidate);
    }
    Err(StoreError::ReconcileIncomplete(format!(
        "could not reserve a recovery name for {slug}"
    )))
}

/// Apply upstream content over a local tree WITHOUT a lost-update window: the local tree is
/// displaced first, the new content materialized, and the displaced copy deleted only if it
/// still hashes to what the sync DECIDED on. An edit that raced in between hashes differently,
/// so it survives as a recovery instead of vanishing (review, Codex: materialize's own
/// displacement is dropped on success, which closed the window for the OLD tree but not for a
/// concurrent edit of it).
fn apply_over_local(
    local_dir: Option<&Path>,
    catalog: &Path,
    name: &str,
    files: &Fileset,
    decided_hash: &str,
) -> Result<()> {
    let displaced = match local_dir {
        Some(dir) => Some(displace_to_recovery(dir, name)?),
        None => None,
    };
    crate::materialize::materialize_fileset(catalog, name, files)?;
    if let Some(d) = displaced {
        let still_matches = import::read_skill_fileset(&d)
            .map(|f| fileset_hash(&f) == decided_hash)
            .unwrap_or(false); // unreadable → keep it, recovery is the safe side
        if still_matches {
            let _ = std::fs::remove_dir_all(&d);
        }
    }
    Ok(())
}

/// One operation per collection at a time. The lock is a `create_new` file carrying the pid; a
/// stale lock (crashed process, older than 15 minutes) is stolen rather than wedging the
/// collection forever. Two interleaved syncs otherwise drift the catalogs from the recorded
/// cursor with no error anywhere (review, Codex).
struct OpLock {
    path: PathBuf,
    token: String,
}
impl OpLock {
    fn acquire(state_dir: &Path) -> Result<Self> {
        let path = state_dir.join(".op.lock");
        // a unique token, not just the pid: cleanup can delete a state dir (lock included)
        // while a guard is alive, and another operation — same process or not — can recreate
        // it; on drop we must remove OUR lock only, never theirs (review, Codex)
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let token = format!(
            "{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                use std::io::Write;
                let _ = write!(f, "{token}");
                Ok(Self { path, token })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|age| age.as_secs() > 15 * 60)
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_file(&path);
                    return Self::acquire(state_dir);
                }
                Err(StoreError::ReconcileIncomplete(
                    "another operation is running on this collection".into(),
                ))
            }
            Err(e) => Err(StoreError::Io(e)),
        }
    }
}
impl Drop for OpLock {
    fn drop(&mut self) {
        // remove only OUR lock file — after a cleanup deleted the dir, this path may now
        // belong to a NEWER operation's lock (review, Codex)
        let ours = std::fs::read_to_string(&self.path)
            .map(|s| s.trim() == self.token)
            .unwrap_or(false);
        if ours {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Bounds on what an UNTRUSTED repo may make the engine read into memory. Checked from metadata
/// BEFORE contents are read, so a multi-gigabyte file is refused, not buffered (review, Codex).
/// Values mirror the web surface's `validateFileset` where they overlap.
const MAX_SKILLS_PER_REPO: usize = 500;
const MAX_FILES_PER_SKILL: usize = 1_000;
const MAX_FILE_BYTES: u64 = 1_000_000;
const MAX_REPO_TOTAL_BYTES: u64 = 50_000_000;

/// Walk the discovered skill roots checking counts and sizes via metadata only.
pub(crate) fn check_repo_bounds(root: &Path) -> Result<()> {
    check_repo_bounds_with(root, import::LinkPolicy::Ignore)
}

/// Bounds are measured on the tree that will actually be READ — for a followed top-level link
/// that is the resolved target, not the link entry (a link has no size of its own).
fn check_repo_bounds_with(root: &Path, policy: import::LinkPolicy) -> Result<()> {
    let roots = import::discover_skill_roots_with(root, policy).map_err(import_err)?;
    if roots.len() > MAX_SKILLS_PER_REPO {
        return Err(StoreError::Git(format!(
            "repo contains {} skills (max {MAX_SKILLS_PER_REPO})",
            roots.len()
        )));
    }
    let mut total: u64 = 0;
    for root in roots {
        let skill_root = root.read_dir().to_path_buf();
        let mut files = 0usize;
        let mut stack = vec![skill_root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).map_err(StoreError::Io)? {
                let entry = entry.map_err(StoreError::Io)?;
                let ft = entry.file_type().map_err(StoreError::Io)?;
                if ft.is_dir() {
                    if entry.file_name() != ".git" {
                        stack.push(entry.path());
                    }
                } else if ft.is_file() {
                    files += 1;
                    let len = entry.metadata().map_err(StoreError::Io)?.len();
                    if len > MAX_FILE_BYTES {
                        return Err(StoreError::Git(format!(
                            "{} is {len} bytes (max {MAX_FILE_BYTES})",
                            entry.path().display()
                        )));
                    }
                    total += len;
                    if files > MAX_FILES_PER_SKILL {
                        return Err(StoreError::Git(format!(
                            "{} has more than {MAX_FILES_PER_SKILL} files",
                            skill_root.display()
                        )));
                    }
                    if total > MAX_REPO_TOTAL_BYTES {
                        return Err(StoreError::Git(format!(
                            "repo skill content exceeds {MAX_REPO_TOTAL_BYTES} bytes"
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}

/// `remove_dir_all` that first clears read-only attributes — git object files are read-only, and
/// on Windows `remove_dir_all` refuses read-only entries, so forgetting a collection would strand
/// its clone forever.
fn remove_tree_force(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    fn clear_readonly(p: &Path) -> std::io::Result<()> {
        for entry in std::fs::read_dir(p)? {
            let entry = entry?;
            let path = entry.path();
            let ft = entry.file_type()?;
            if ft.is_dir() {
                clear_readonly(&path)?;
            } else {
                let md = entry.metadata()?;
                let mut perms = md.permissions();
                if perms.readonly() {
                    #[allow(clippy::permissions_set_readonly_false)]
                    perms.set_readonly(false);
                    std::fs::set_permissions(&path, perms)?;
                }
            }
        }
        Ok(())
    }
    clear_readonly(dir)?;
    std::fs::remove_dir_all(dir)
}

// ── state (de)serialization — Value-based, matching fileset.rs's style ──────────────────────────

fn scope_tag(s: Scope) -> &'static str {
    match s {
        Scope::Global => "global",
        Scope::Project => "project",
        Scope::Library => "library",
    }
}

fn scope_from(tag: &str) -> Result<Scope> {
    match tag {
        "global" => Ok(Scope::Global),
        "project" => Ok(Scope::Project),
        // fail closed: an unknown stored scope must not default to Global — a state file can
        // arrive by copy or hand-edit, and Library was never a legal collection scope
        other => Err(StoreError::InvalidPath(format!(
            "collection scope: {other}"
        ))),
    }
}

fn save_state(state_dir: &Path, st: &CollectionState) -> Result<()> {
    let mut skills = serde_json::Map::new();
    for (k, v) in &st.skills {
        skills.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    let mut v = serde_json::json!({
        "version": 1,
        "id": st.id,
        "url": st.url,
        "ref": st.git_ref,
        "subpath": st.subpath,
        "scope": scope_tag(st.scope),
        "skills": serde_json::Value::Object(skills),
    });
    // optional, additive: a 0.1.5 reader ignores unknown keys, an old file loads as None
    if let Some(sel) = &st.selected {
        v["selected"] = serde_json::Value::Array(
            sel.iter()
                .map(|s| serde_json::Value::String(s.clone()))
                .collect(),
        );
    }
    // atomic: temp → rename, like every other engine write
    let tmp = state_dir.join(".collection.json.tmp");
    let dest = state_dir.join("collection.json");
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(&v).expect("static shape"),
    )?;
    std::fs::rename(&tmp, &dest).map_err(StoreError::Io)
}

/// Load and VALIDATE a collection's state. Fail closed on every field: this file can arrive by
/// copy, hand-edit or corruption, and an unvalidated `subpath` re-joins onto the clone while an
/// unvalidated skill name becomes a catalog path (review, Codex). A refused field refuses the
/// whole file — a half-trusted state is how a sync writes somewhere it shouldn't.
fn load_state(home: &Path, collection_id: &str) -> Result<(PathBuf, CollectionState)> {
    // the id is caller input and becomes a directory name — same containment as every slug
    store::check_slug(collection_id)?;
    let state_dir = collections_root(home).join(collection_id);
    let raw = std::fs::read_to_string(state_dir.join("collection.json"))
        .map_err(|_| StoreError::NotFound(format!("collection {collection_id}")))?;
    let v: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| StoreError::Git(format!("collection.json is not valid JSON: {e}")))?;
    if v.get("version").and_then(|x| x.as_u64()) != Some(1) {
        return Err(StoreError::Git(
            "collection.json: unknown or missing version".into(),
        ));
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let subpath = s("subpath");
    if let Some(sp) = &subpath {
        git::validate_subpath(sp).map_err(StoreError::Git)?;
    }
    let Some(map) = v.get("skills").and_then(|x| x.as_object()) else {
        return Err(StoreError::Git(
            "collection.json: missing skills object".into(),
        ));
    };
    let mut skills = BTreeMap::new();
    for (k, h) in map {
        store::check_slug(k)?; // a stored name becomes a catalog path at use time
        let Some(h) = h.as_str().filter(|h| !h.is_empty()) else {
            return Err(StoreError::Git(format!(
                "collection.json: bad hash for {k}"
            )));
        };
        skills.insert(k.clone(), h.to_string());
    }
    // optional selection — validated like every stored name: a selected entry is compared
    // against upstream names and gates materialization, so a bad one refuses the file
    let selected = match v.get("selected") {
        None => None,
        Some(serde_json::Value::Array(a)) => {
            let mut set = BTreeSet::new();
            for x in a {
                let Some(name) = x.as_str() else {
                    return Err(StoreError::Git(
                        "collection.json: bad selected entry".into(),
                    ));
                };
                store::check_slug(name)?;
                set.insert(name.to_string());
            }
            Some(set)
        }
        Some(_) => {
            return Err(StoreError::Git(
                "collection.json: bad selected field".into(),
            ))
        }
    };
    // re-assert the selection invariant at USE time: cursor ⊆ selected, and a present
    // selection is never empty — a crafted file must not smuggle an unselected skill into
    // collection ownership (review, Codex)
    if let Some(sel) = &selected {
        if sel.is_empty() {
            return Err(StoreError::Git("collection.json: empty selected".into()));
        }
        if let Some(bad) = skills.keys().find(|k| !sel.contains(*k)) {
            return Err(StoreError::Git(format!(
                "collection.json: cursor {bad} is outside the stored selection"
            )));
        }
    }
    let st = CollectionState {
        id: collection_id.to_string(),
        url: s("url").ok_or_else(|| StoreError::Git("collection.json missing url".into()))?,
        git_ref: s("ref"),
        subpath,
        scope: scope_from(v.get("scope").and_then(|x| x.as_str()).unwrap_or(""))?,
        skills,
        selected,
    };
    Ok((state_dir, st))
}

// ── per-path (3-way) merge ──────────────────────────────────────────────────────────────────────
//
// agent-deck resolves conflicts PER FILE, and that granularity is wired through their protocol and
// UI. Whole-skill remote/local would have been a visible regression on the swap, so the engine
// keeps a BASE SNAPSHOT per tracked skill — the fileset as of the last settlement — which is what
// makes "who moved this path" answerable at all. Without a base you can only compare two sides and
// every difference looks like a conflict; with it, one-sided motion auto-merges and only
// both-sides motion surfaces.
//
// The base lives at `<state>/base/<name>.json` in the canonical fileset envelope. Collections
// imported by 0.1.4 have none: those degrade to the old whole-skill conflict (never a wrong
// merge), and a base is written the first time they settle, so they self-heal.
//
// ACCEPTED LIMITATION, stated rather than implied: a settlement is three writes — the skill tree,
// the base, the cursor — and there is no transaction spanning the filesystem and the state file.
// A crash between them leaves base and disk disagreeing, and the next sync reads that as
// both-sides motion: a FALSE CONFLICT the user resolves once. Every ordering degrades that way;
// what matters is that none of them can silently discard the user's content, because a conflict
// never writes. Making it atomic means journalling the tree write, which is a bigger change than
// the risk justifies (review, Codex).

/// What a path IS on one side. `directory` means "not a file here, but paths live under it" —
/// that is the `file → directory` transition agent-deck's UI warns about.
fn kind_of(files: &Fileset, path: &str) -> &'static str {
    if let Some(entry) = files.get(path) {
        // a fourth kind next to file|directory|missing, so a host can label a binary conflict
        // instead of offering a text diff of a PNG (#206). A text file is still "file".
        return if entry.is_binary() { "binary" } else { "file" };
    }
    let prefix = format!("{path}/");
    if files.keys().any(|k| k.starts_with(&prefix)) {
        return "directory";
    }
    "missing"
}

/// One path both sides moved, with each side's kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathConflict {
    pub path: String,
    pub local_kind: String,
    pub remote_kind: String,
}

/// Three-way merge of one skill's fileset. Returns the merged result and the conflicted paths.
///
/// Per path: only one side moved → that side wins; both moved to the SAME content → agreement,
/// not a conflict; both moved differently → conflict (merged keeps the local side, so a caller
/// that ignores conflicts never silently loses the user's work).
fn three_way(base: &Fileset, local: &Fileset, upstream: &Fileset) -> (Fileset, Vec<PathConflict>) {
    let mut merged = Fileset::new();
    let mut conflicts = Vec::new();
    let paths: BTreeSet<&String> = base
        .keys()
        .chain(local.keys())
        .chain(upstream.keys())
        .collect();
    for path in paths {
        let b = base.get(path);
        let l = local.get(path);
        let u = upstream.get(path);
        let local_moved = l != b;
        let up_moved = u != b;
        let winner = match (local_moved, up_moved) {
            (false, false) => l,         // nobody moved
            (true, false) => l,          // local only
            (false, true) => u,          // upstream only
            (true, true) if l == u => l, // both landed on the same content
            (true, true) => {
                conflicts.push(PathConflict {
                    path: path.clone(),
                    local_kind: kind_of(local, path).to_string(),
                    remote_kind: kind_of(upstream, path).to_string(),
                });
                l // keep the user's version until they choose
            }
        };
        if let Some(w) = winner {
            merged.insert(path.clone(), w.clone());
        }
    }
    // A path that is a FILE while another path lives under it is a tree no filesystem can hold —
    // `materialize` fails with a raw OS error (verified: code 183 on Windows) that a user cannot
    // act on. It arises whenever the two sides disagree about a path's KIND, and it is a decision,
    // not a merge artifact: flag it as a conflict on the ancestor so the user chooses, rather than
    // silently dropping one side. `resolve` prunes the loser once they have.
    for ancestor in file_directory_collisions(&merged) {
        if !conflicts.iter().any(|c| c.path == ancestor) {
            conflicts.push(PathConflict {
                path: ancestor.clone(),
                local_kind: kind_of(local, &ancestor).to_string(),
                remote_kind: kind_of(upstream, &ancestor).to_string(),
            });
        }
    }
    conflicts.sort_by(|a, b| a.path.cmp(&b.path));
    (merged, conflicts)
}

/// File paths in `files` that also have descendants — i.e. the same name used as a file and as a
/// directory. Returns the FILE side (the ancestor), which is the path a user decides about.
fn file_directory_collisions(files: &Fileset) -> Vec<String> {
    let mut out = Vec::new();
    for path in files.keys() {
        let prefix = format!("{path}/");
        if files.keys().any(|k| k.starts_with(&prefix)) {
            out.push(path.clone());
        }
    }
    out
}

/// Drop any path whose ANCESTOR is present as a file — the file wins its own name. Called after
/// per-path choices are applied: keeping `notes` as a file means upstream's `notes/index.md`
/// cannot also be written, and taking remote (which removes `notes`) leaves the subtree intact.
fn prune_file_directory_collisions(files: &mut Fileset) {
    let paths: Vec<String> = files.keys().cloned().collect();
    for p in &paths {
        let mut idx = 0;
        while let Some(pos) = p[idx..].find('/') {
            let cut = idx + pos;
            if files.contains_key(&p[..cut]) {
                files.remove(p);
                break;
            }
            idx = cut + 1;
        }
    }
}

/// Identity of one conflict presentation: base + local + upstream + THE TARGET DIRECTORY. Any of
/// them moving invalidates a choice list made against it — that is the staleness guard
/// agent-deck's `LEGACY_MERGE_STALE` → refresh flow needs.
///
/// The target is in the hash because content alone does not identify WHERE a decision applies:
/// two project-scoped checkouts with identical conflicts produce identical content hashes, so
/// choices presented for project A would be accepted for project B and swap the wrong tree
/// (review, Codex).
fn merge_id_of(base: &Fileset, local: &Fileset, upstream: &Fileset, target: &Path) -> String {
    let combined = format!(
        "{}|{}|{}|{}",
        fileset_hash(base),
        fileset_hash(local),
        fileset_hash(upstream),
        target.to_string_lossy()
    );
    crate::content_hash(combined.as_bytes())[..16].to_string()
}

fn base_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("base")
}

/// The base snapshot for one tracked skill, or None when this collection predates base snapshots
/// (or the file is unreadable — which degrades to whole-skill, never to a wrong merge).
/// Ceiling on a base snapshot we will read back. It is engine-written and therefore already
/// bounded by the import limits — but it lives in the user's home, where anything can replace it,
/// and an unbounded `read_to_string` of a "base" is an allocation a hostile file chooses the size
/// of (review, Codex). Oversized ⇒ no base ⇒ whole-skill, which is the safe degradation.
const MAX_BASE_BYTES: u64 = MAX_REPO_TOTAL_BYTES;

fn read_base(state_dir: &Path, name: &str) -> Option<Fileset> {
    // the name becomes a filename; every caller already validates, but a path-building helper
    // that trusts its input is how the last three containment defects started
    store::check_slug(name).ok()?;
    let path = base_dir(state_dir).join(format!("{name}.json"));
    if std::fs::metadata(&path).ok()?.len() > MAX_BASE_BYTES {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    // ONE envelope parser (`fileset::parse_envelope`), not a second copy: it is strict — no legacy
    // raw-SKILL.md fallback, so a corrupt base cannot become a plausible-looking one-file base —
    // and it makes the same kind decision as every other ingest, so a base entry's Text/Binary tag
    // is always the one the bytes get when read back off disk. A base missing its PNG would read
    // as a deletion on the next merge; an unaccountable byte degrades to NO base (whole-skill
    // conflict), never to a partial one.
    crate::fileset::parse_envelope(&raw).ok()
}

fn write_base(state_dir: &Path, name: &str, files: &Fileset) -> Result<()> {
    store::check_slug(name)?; // it becomes a filename
    let dir = base_dir(state_dir);
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!(".{name}.json.tmp"));
    std::fs::write(&tmp, crate::fileset::serialize_fileset(files))?;
    std::fs::rename(&tmp, dir.join(format!("{name}.json"))).map_err(StoreError::Io)
}

fn remove_base(state_dir: &Path, name: &str) {
    if store::check_slug(name).is_err() {
        return; // never let an unvalidated name reach a delete
    }
    let _ = std::fs::remove_file(base_dir(state_dir).join(format!("{name}.json")));
}

/// Is (cursor, upstream, local) a conflict? ONE predicate, shared by `sync` (to report) and
/// `resolve` (to refuse settling a skill that is not actually conflicted — recording a cursor
/// for a never-materialized upstream skill would make every later sync skip it silently;
/// review, Codex).
fn is_conflicted(cursor: Option<&str>, up: Option<&str>, local: Option<&str>) -> bool {
    match (cursor, up) {
        (Some(cur), Some(u)) => u != cur && local != Some(cur),
        (None, Some(_)) => local.is_some(),
        (Some(cur), None) => matches!(local, Some(l) if l != cur),
        (None, None) => false,
    }
}

// ── the five operations ─────────────────────────────────────────────────────────────────────────

/// Import a git repo as a managed collection: clone (hardened, blobless), discover skills
/// (`import.rs`'s contract: root SKILL.md = one skill, else every SKILL.md parent), materialize
/// each into the scope's catalog, record the cursor. All-or-nothing.
pub fn import_git_repo(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    url: &str,
    git_ref: Option<&str>,
    subpath: Option<&str>,
    selected: Option<&[String]>,
) -> Result<ImportOutcome> {
    if scope == Scope::Library {
        return Err(StoreError::InvalidPath(
            "library scope is not writable".into(),
        ));
    }
    // SKL-04: a selection is validated BEFORE any filesystem work — empty is a caller bug
    // (native disables Import on empty selection), and every name is slug-checked because a
    // selected name is compared against upstream names and gates materialization.
    let sel_set: Option<BTreeSet<&str>> = match selected {
        None => None,
        Some(sel) => {
            if sel.is_empty() {
                return Err(StoreError::InvalidPath("empty skill selection".into()));
            }
            for name in sel {
                store::check_slug(name)?;
            }
            Some(sel.iter().map(String::as_str).collect())
        }
    };
    let id = derive_id(url, git_ref, subpath)?;
    let root_dir = collections_root(home);
    std::fs::create_dir_all(&root_dir)?;
    let state_dir = root_dir.join(&id);
    // `create_dir` (not `create_dir_all`) is the import lock: a concurrent import of the same
    // repo loses the create and gets AlreadyExists, same as a repeat import. A state dir
    // WITHOUT collection.json is an unconfirmed preview (SKL-03): reuse its clone so the user
    // imports exactly what they were shown, serialized under the collection's op lock.
    let mut reused_preview = false;
    let _op_lock: OpLock;
    match std::fs::create_dir(&state_dir) {
        Ok(()) => {
            // the fresh path holds the op lock too: without it, a concurrent inspect sees
            // "state dir, no collection.json" and wipes the clone mid-import (review, Codex)
            _op_lock = OpLock::acquire(&state_dir)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if state_dir.join("collection.json").exists() {
                // SKL-13: additive widening — but ONLY with an explicit selection; an
                // unselected re-import stays refused so widening always names what it adds.
                if let Some(sel) = &sel_set {
                    let lock = OpLock::acquire(&state_dir)?;
                    return import_additive(
                        home,
                        project_root,
                        scope,
                        &state_dir,
                        &id,
                        subpath,
                        sel,
                        lock,
                    );
                }
                return Err(StoreError::AlreadyExists(format!(
                    "collection {id} (this url/ref/subpath is already imported)"
                )));
            }
            _op_lock = OpLock::acquire(&state_dir)?;
            reused_preview = true;
        }
        Err(e) => return Err(StoreError::Io(e)),
    }
    // From here on, any failure must remove the state dir AND any skill this import already
    // materialized — a partial import that survives its own error is unmanaged residue the
    // user never asked for (review, Codex).
    let mut written: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<ImportOutcome> {
        // reuse ONLY a preview whose inspect demonstrably completed (marker present) — a
        // crashed inspect leaves residue that must be re-cloned, not trusted
        let complete_preview = reused_preview && state_dir.join(PREVIEW_MARKER).exists();
        if !complete_preview {
            remove_tree_force(&state_dir.join("clone"))?;
            git::clone_repo(url, git_ref, subpath, &state_dir.join("clone")).map_err(git_err)?;
        }
        let root = import_root(&state_dir, subpath);
        let upstream = upstream_skills(&root)?;
        if upstream.is_empty() {
            return Err(StoreError::Git(
                "no skills found (no SKILL.md in the repo)".into(),
            ));
        }
        // every selected name must exist upstream — a miss imports NOTHING (fail closed)
        if let Some(sel) = &sel_set {
            let missing: Vec<&str> = sel
                .iter()
                .filter(|n| !upstream.contains_key(**n))
                .copied()
                .collect();
            if !missing.is_empty() {
                return Err(StoreError::NotFound(format!(
                    "skills not found in the repository: {}",
                    missing.join(", ")
                )));
            }
        }
        let chosen: BTreeMap<&String, &Fileset> = upstream
            .iter()
            .filter(|(name, _)| {
                sel_set
                    .as_ref()
                    .is_none_or(|sel| sel.contains(name.as_str()))
            })
            .collect();
        // collisions first, writes after — all-or-nothing (checked on the CHOSEN set only:
        // an unselected upstream skill colliding with a user's skill is not our business)
        let mut collisions = Vec::new();
        for name in chosen.keys() {
            if local_tree(home, project_root, scope, name)?.is_some() {
                collisions.push((*name).clone());
            }
        }
        if !collisions.is_empty() {
            return Err(StoreError::AlreadyExists(format!(
                "skills already exist in this scope: {}",
                collisions.join(", ")
            )));
        }
        let mut cursor = BTreeMap::new();
        let mut names = Vec::new();
        for (&name, &files) in &chosen {
            let dir = store::write_target(home, project_root, scope, name)?;
            let catalog = dir
                .parent()
                .ok_or_else(|| StoreError::InvalidPath(name.clone()))?;
            // tracked BEFORE materializing: a mid-write failure must roll this skill back too,
            // not leave a partial tree outside the cleanup list (review, Codex)
            written.push(dir.clone());
            crate::materialize::materialize_fileset(catalog, name, files)?;
            cursor.insert(name.clone(), fileset_hash(files));
            // the base a later 3-way merge measures both sides against
            write_base(&state_dir, name, files)?;
            names.push(name.clone());
        }
        let st = CollectionState {
            id: id.clone(),
            url: url.to_string(),
            git_ref: git_ref.map(str::to_string),
            subpath: subpath.map(str::to_string),
            scope,
            skills: cursor,
            selected: sel_set
                .as_ref()
                .map(|sel| sel.iter().map(|s| s.to_string()).collect()),
        };
        save_state(&state_dir, &st)?;
        // imported now — the preview marker's job is done
        let _ = std::fs::remove_file(state_dir.join(PREVIEW_MARKER));
        Ok(ImportOutcome {
            collection_id: id.clone(),
            skills: names,
            skipped: Vec::new(),
        })
    })();
    if result.is_err() {
        // safe to delete outright: the collision check proved these names did not exist before
        for dir in written {
            let _ = std::fs::remove_dir_all(&dir);
        }
        let _ = remove_tree_force(&state_dir);
    }
    result
}

/// SKL-13: widen an EXISTING collection's selection from its own clone. Reads the
/// clone as-is (the synced cursor — updates flow through sync, never through import),
/// skips names already in the collection, fail-closes on unknown names and local
/// collisions, and rolls back ONLY its own writes — the collection itself is never
/// deleted on this path.
#[allow(clippy::too_many_arguments)]
fn import_additive(
    home: &Path,
    project_root: Option<&Path>,
    caller_scope: Scope,
    state_dir: &Path,
    id: &str,
    subpath: Option<&str>,
    sel: &BTreeSet<&str>,
    _lock: OpLock,
) -> Result<ImportOutcome> {
    let (_, mut st) = load_state(home, id)?;
    // a widening must target the collection's OWN scope — silently writing into a
    // different scope than the caller asked for would be worse than refusing (review, Codex)
    if caller_scope != st.scope {
        return Err(StoreError::InvalidPath(format!(
            "collection {id} belongs to the {:?} scope, not {:?}",
            st.scope, caller_scope
        )));
    }
    let root = import_root(state_dir, subpath);
    if !root.exists() {
        return Err(StoreError::Git(
            "the collection's clone is missing; run a sync first".into(),
        ));
    }
    let upstream = upstream_skills(&root)?;
    // every selected name must exist upstream — a miss imports NOTHING (fail closed)
    let missing: Vec<&str> = sel
        .iter()
        .filter(|n| !upstream.contains_key(**n))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(StoreError::NotFound(format!(
            "skills not found in the repository: {}",
            missing.join(", ")
        )));
    }
    let mut skipped = Vec::new();
    let mut fresh = Vec::new();
    let mut adopt = Vec::new();
    for name in sel {
        if st.skills.contains_key(*name) {
            skipped.push((*name).to_string());
            continue;
        }
        // a crash between materialize and save_state leaves an IDENTICAL untracked
        // tree: adopt it instead of refusing forever (review, Codex); a DIFFERING
        // tree is a genuine collision
        match local_tree(home, project_root, st.scope, name)? {
            Some((_, local_hash)) if local_hash == fileset_hash(&upstream[*name]) => {
                adopt.push(*name);
            }
            Some(_) => {
                return Err(StoreError::AlreadyExists(format!(
                    "skills already exist in this scope: {name}"
                )));
            }
            None => fresh.push(*name),
        }
    }
    let mut written: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<Vec<String>> {
        let mut names = Vec::new();
        for name in &adopt {
            let files = &upstream[*name];
            st.skills.insert((*name).to_string(), fileset_hash(files));
            write_base(state_dir, name, files)?;
            names.push((*name).to_string());
        }
        for name in &fresh {
            let files = &upstream[*name];
            let dir = store::write_target(home, project_root, st.scope, name)?;
            let catalog = dir
                .parent()
                .ok_or_else(|| StoreError::InvalidPath((*name).to_string()))?;
            // ATOMIC create: the rollback below may only ever delete a dir WE created —
            // a concurrently created user skill loses the claim, never its files (review, Codex)
            store::claim_new_dir(&dir)?;
            written.push(dir.clone());
            crate::materialize::materialize_fileset(catalog, name, files)?;
            st.skills.insert((*name).to_string(), fileset_hash(files));
            write_base(state_dir, name, files)?;
            names.push((*name).to_string());
        }
        if let Some(selected) = &mut st.selected {
            for name in &names {
                selected.insert(name.clone());
            }
        }
        save_state(state_dir, &st)?;
        Ok(names)
    })();
    match result {
        Ok(names) => Ok(ImportOutcome {
            collection_id: id.to_string(),
            skills: names,
            skipped,
        }),
        Err(e) => {
            // roll back ONLY this widening's writes; the collection stays intact
            for dir in written {
                let _ = std::fs::remove_dir_all(&dir);
            }
            Err(e)
        }
    }
}

/// Preview upstream drift against the cursor — fetches (which mutates the engine-owned clone,
/// hence the lock), but writes NOTHING to catalogs or state.
/// Preview a repository BEFORE importing (SKL-03): clone it, discover its skills, and return
/// them without materializing anything. The clone is left in place as the preview cache —
/// `collection.json`'s absence is what marks the state dir as an unconfirmed preview.
pub fn inspect_git_repo(
    home: &Path,
    url: &str,
    git_ref: Option<&str>,
    subpath: Option<&str>,
) -> Result<InspectOutcome> {
    let id = derive_id(url, git_ref, subpath)?;
    let root_dir = collections_root(home);
    std::fs::create_dir_all(&root_dir)?;
    let state_dir = root_dir.join(&id);
    let mut _op_lock: Option<OpLock> = None;
    match std::fs::create_dir(&state_dir) {
        Ok(()) => {
            // hold the op lock for the WHOLE preview build: a concurrent import-reuse must not
            // see a half-cloned dir as reusable (it also requires the completion marker, but
            // the lock makes the exclusion explicit rather than incidental)
            _op_lock = Some(OpLock::acquire(&state_dir)?);
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if state_dir.join("collection.json").exists() {
                // SKL-13: an IMPORTED collection previews from its own clone — no re-clone,
                // no fetch, so the listing is coherent with the synced cursor (updates flow
                // through sync). The state dir is never destroyed on this path.
                let _lock = OpLock::acquire(&state_dir)?;
                let (_, st) = load_state(home, &id)?;
                let root = import_root(&state_dir, subpath);
                if !root.exists() {
                    return Err(StoreError::Git(
                        "the collection's clone is missing; run a sync first".into(),
                    ));
                }
                let upstream = upstream_skills(&root)?;
                let skills = upstream
                    .iter()
                    .map(|(name, files)| SkillPreview {
                        name: name.clone(),
                        file_count: files.len() as u32,
                        skill_md: files
                            .get("SKILL.md")
                            .and_then(|c| c.as_text())
                            .map(cap_preview_md),
                        link_target: None,
                    })
                    .collect();
                return Ok(InspectOutcome {
                    collection_id: id,
                    skills,
                    already_imported: st.skills.keys().cloned().collect(),
                });
            }
            // an abandoned/in-flight preview: serialize on the collection's op lock, then
            // rebuild the clone fresh so the preview always shows CURRENT upstream
            _op_lock = Some(OpLock::acquire(&state_dir)?);
            let _ = std::fs::remove_file(state_dir.join(PREVIEW_MARKER));
            remove_tree_force(&state_dir.join("clone"))?;
        }
        Err(e) => return Err(StoreError::Io(e)),
    }
    let result = (|| -> Result<Vec<SkillPreview>> {
        git::clone_repo(url, git_ref, subpath, &state_dir.join("clone")).map_err(git_err)?;
        let upstream = upstream_skills(&import_root(&state_dir, subpath))?;
        Ok(upstream
            .iter()
            .map(|(name, files)| SkillPreview {
                name: name.clone(),
                file_count: files.len() as u32,
                skill_md: files
                    .get("SKILL.md")
                    .and_then(|c| c.as_text())
                    .map(cap_preview_md),
                link_target: None,
            })
            .collect())
    })();
    match result {
        Ok(skills) => {
            if skills.is_empty() {
                // nothing to import, nothing worth caching — native shows "0 skills" and the
                // abandoned discovery clone is cleaned up
                let _ = remove_tree_force(&state_dir);
            } else {
                // the marker is what makes this preview REUSABLE: import trusts the cached
                // clone only when the inspect that built it demonstrably completed
                std::fs::write(state_dir.join(PREVIEW_MARKER), b"")?;
            }
            Ok(InspectOutcome {
                collection_id: id,
                skills,
                already_imported: Vec::new(),
            })
        }
        Err(e) => {
            let _ = remove_tree_force(&state_dir);
            Err(e)
        }
    }
}

/// Marks a preview state dir whose clone + discovery COMPLETED — the only previews import may
/// reuse. A crashed inspect leaves no marker, so import re-clones instead of trusting residue.
const PREVIEW_MARKER: &str = ".preview-ok";

/// SKILL.md content is returned for display (name/description derivation) — cap it like the
/// native 64 KB head read so a pathological file cannot balloon the preview payload.
pub(crate) fn cap_preview_md(s: &str) -> String {
    const CAP: usize = 64 * 1024;
    if s.len() <= CAP {
        return s.to_string();
    }
    let mut end = CAP;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Remove an unconfirmed preview (the user cancelled). Refuses a genuinely imported
/// collection (that is `forget_git_repo`'s job); a missing preview is Ok — cancel is idempotent.
pub fn discard_git_preview(home: &Path, collection_id: &str) -> Result<()> {
    // the id is caller input and becomes a directory name — same containment as every slug
    store::check_slug(collection_id)?;
    let state_dir = collections_root(home).join(collection_id);
    if !state_dir.exists() {
        return Ok(());
    }
    // serialize against an in-flight inspect/import, and only THEN decide: an unlocked check
    // is a TOCTOU that can delete a collection the racing import just saved (review, Codex)
    let _lock = OpLock::acquire(&state_dir)?;
    if state_dir.join("collection.json").exists() {
        return Err(StoreError::AlreadyExists(format!(
            "collection {collection_id} is imported — remove it with forget, not discard"
        )));
    }
    remove_tree_force(&state_dir).map_err(StoreError::Io)
}

pub fn check_git_repo(home: &Path, collection_id: &str) -> Result<Vec<Delta>> {
    let (state_dir, st) = load_state(home, collection_id)?;
    let _lock = OpLock::acquire(&state_dir)?;
    git::fetch_and_reset(&state_dir.join("clone"), st.git_ref.as_deref()).map_err(git_err)?;
    let upstream = upstream_skills(&import_root(&state_dir, st.subpath.as_deref()))?;
    let mut out = Vec::new();
    for (name, files) in &upstream {
        // SKL-04: an upstream skill outside the user's explicit selection is not this
        // collection's business — never surfaced, never materialized
        if st
            .selected
            .as_ref()
            .is_some_and(|sel| !sel.contains(name.as_str()))
        {
            continue;
        }
        match st.skills.get(name) {
            None => out.push(Delta {
                name: name.clone(),
                kind: DeltaKind::Added,
            }),
            Some(cursor) if *cursor != fileset_hash(files) => out.push(Delta {
                name: name.clone(),
                kind: DeltaKind::Changed,
            }),
            Some(_) => {}
        }
    }
    for name in st.skills.keys() {
        if !upstream.contains_key(name) {
            out.push(Delta {
                name: name.clone(),
                kind: DeltaKind::Removed,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Pull upstream and apply everything that moved on ONE side only; both-sides motion is a
/// conflict and touches nothing. Never a silent overwrite.
pub fn sync_git_repo(
    home: &Path,
    project_root: Option<&Path>,
    collection_id: &str,
) -> Result<SyncOutcome> {
    let (state_dir, mut st) = load_state(home, collection_id)?;
    let _lock = OpLock::acquire(&state_dir)?;
    git::fetch_and_reset(&state_dir.join("clone"), st.git_ref.as_deref()).map_err(git_err)?;
    let upstream = upstream_skills(&import_root(&state_dir, st.subpath.as_deref()))?;
    let scope = st.scope;
    let mut applied = Vec::new();
    let mut conflicts = Vec::new();

    // SKL-04: upstream names outside an explicit selection never enter the reconciliation —
    // the (None cursor, Some upstream) "new skill" branch must not fire for them. Cursor names
    // always flow (they are the collection's own skills, ⊆ selection by construction).
    let names: BTreeSet<String> = st
        .skills
        .keys()
        .cloned()
        .chain(
            upstream
                .keys()
                .filter(|n| {
                    st.selected
                        .as_ref()
                        .is_none_or(|sel| sel.contains(n.as_str()))
                })
                .cloned(),
        )
        .collect();
    for name in names {
        let cursor = st.skills.get(&name).cloned();
        let up = upstream.get(&name);
        let local = local_tree(home, project_root, scope, &name)?;
        match (cursor, up) {
            // tracked, still upstream
            (Some(cur), Some(files)) => {
                let up_hash = fileset_hash(files);
                let base = read_base(&state_dir, &name);
                match (&base, &local) {
                    // THE BASE GOVERNS whenever there is one. The cursor cannot: after an
                    // auto-merge the cursor is the MERGED tree, so "local matches the cursor"
                    // reads as "local is untouched" and a wholesale apply then deletes the very
                    // local edits the merge preserved — one sync later, silently (review, Codex).
                    // A three-way against the base gets the untouched case right anyway: every
                    // path where only upstream moved simply takes upstream.
                    (Some(base), Some((dir, local_hash))) => {
                        if up_hash == fileset_hash(base) {
                            continue; // upstream unmoved since the base — local edits are the user's
                        }
                        let local_files = import::read_skill_fileset(dir).map_err(import_err)?;
                        let (merged, path_conflicts) = three_way(base, &local_files, files);
                        if !path_conflicts.is_empty() {
                            conflicts.push(name);
                            continue;
                        }
                        let merged_hash = fileset_hash(&merged);
                        if merged_hash != *local_hash {
                            let catalog = dir
                                .parent()
                                .ok_or_else(|| StoreError::InvalidPath(name.clone()))?;
                            // displace-then-verify: a local edit racing this apply survives as a
                            // recovery instead of being silently replaced
                            apply_over_local(Some(dir), catalog, &name, &merged, local_hash)?;
                        }
                        st.skills.insert(name.clone(), merged_hash);
                        // base advances to UPSTREAM: it is the shared ancestor for the next
                        // round, not the merged result (which carries local-only edits that must
                        // keep counting as local motion).
                        write_base(&state_dir, &name, files)?;
                        // saved PER MUTATION: a crash after some applies must not leave every
                        // applied skill re-reported as a conflict on retry (review, Codex)
                        save_state(&state_dir, &st)?;
                        applied.push(name);
                    }
                    // deleted locally while upstream moved → both sides moved
                    (Some(_), None) => conflicts.push(name),
                    // NO BASE (a 0.1.4 collection): per-path is not answerable, so the original
                    // cursor-based rule stands — apply only an untouched local, else whole-skill
                    // conflict. Never a wrong merge, and the base is written the moment it settles.
                    (None, _) => {
                        if up_hash == cur {
                            continue;
                        }
                        match &local {
                            Some((dir, local_hash)) if *local_hash == cur => {
                                let catalog = dir
                                    .parent()
                                    .ok_or_else(|| StoreError::InvalidPath(name.clone()))?;
                                apply_over_local(Some(dir), catalog, &name, files, &cur)?;
                                st.skills.insert(name.clone(), up_hash);
                                write_base(&state_dir, &name, files)?;
                                save_state(&state_dir, &st)?;
                                applied.push(name);
                            }
                            _ => conflicts.push(name),
                        }
                    }
                }
            }
            // new upstream skill
            (None, Some(files)) => {
                if local.is_some() {
                    // an unrelated user skill already owns this name in scope
                    conflicts.push(name);
                } else {
                    let dir = store::write_target(home, project_root, scope, &name)?;
                    let catalog = dir
                        .parent()
                        .ok_or_else(|| StoreError::InvalidPath(name.clone()))?;
                    crate::materialize::materialize_fileset(catalog, &name, files)?;
                    st.skills.insert(name.clone(), fileset_hash(files));
                    write_base(&state_dir, &name, files)?;
                    save_state(&state_dir, &st)?;
                    applied.push(name);
                }
            }
            // removed upstream
            (Some(cur), None) => match &local {
                None => {
                    st.skills.remove(&name); // both sides gone — just drop the cursor
                    remove_base(&state_dir, &name);
                    save_state(&state_dir, &st)?;
                }
                Some((dir, local_hash)) if *local_hash == cur => {
                    // unedited local copy of a skill the upstream deleted: remove it, but as a
                    // DISPLACEMENT — the removal is recoverable, never a silent destroy
                    displace_to_recovery(dir, &name)?;
                    st.skills.remove(&name);
                    remove_base(&state_dir, &name);
                    save_state(&state_dir, &st)?;
                    applied.push(name);
                }
                Some(_) => conflicts.push(name), // edited locally, deleted upstream
            },
            (None, None) => unreachable!("name came from one of the two maps"),
        }
    }
    save_state(&state_dir, &st)?;
    applied.sort();
    conflicts.sort();
    Ok(SyncOutcome { applied, conflicts })
}

/// Settle one conflicted skill against the clone AS LAST FETCHED (by `sync` or `check`) — no
/// implicit re-fetch, so what the user reviewed is what gets applied.
///
/// `Remote`: the local tree is displaced into a recovery, upstream content (or upstream's
/// deletion) is applied, and the cursor moves. `Local`: the local tree stays; only the cursor
/// moves, so the next sync is clean. Returns the recoveries now visible at the affected root.
pub fn resolve_git_conflict(
    home: &Path,
    project_root: Option<&Path>,
    collection_id: &str,
    name: &str,
    resolution: Resolution,
) -> Result<Vec<Recovery>> {
    let (state_dir, mut st) = load_state(home, collection_id)?;
    let _lock = OpLock::acquire(&state_dir)?;
    store::check_slug(name)?;
    // a skill outside the stored selection is not collection-owned — the conflict surface must
    // never displace the user's unrelated skill with unselected upstream (review, Codex)
    if st.selected.as_ref().is_some_and(|sel| !sel.contains(name)) {
        return Err(StoreError::NotFound(format!(
            "{name} is not part of this collection's selection"
        )));
    }
    let upstream = upstream_skills(&import_root(&state_dir, st.subpath.as_deref()))?;
    let up = upstream.get(name);
    let scope = st.scope;
    let recovery_root = match scope {
        Scope::Project => project_root.ok_or_else(|| {
            StoreError::InvalidPath("project scope requires a project root".into())
        })?,
        _ => home,
    };
    let local = local_tree(home, project_root, scope, name)?;
    // Only a skill that IS conflicted may be settled. Resolving an arbitrary name would record a
    // cursor for content that was never materialized, and every later sync would skip it as
    // "already settled" — silently and forever (review, Codex).
    let up_hash = up.map(fileset_hash);
    if !is_conflicted(
        st.skills.get(name).map(String::as_str),
        up_hash.as_deref(),
        local.as_ref().map(|(_, h)| h.as_str()),
    ) {
        return Err(StoreError::NotFound(format!(
            "no conflict to resolve for {name}"
        )));
    }
    match resolution {
        Resolution::Remote => {
            match up {
                Some(files) => {
                    let dir = store::write_target(home, project_root, scope, name)?;
                    let catalog = dir
                        .parent()
                        .ok_or_else(|| StoreError::InvalidPath(name.into()))?;
                    let local_dir = local.as_ref().map(|(d, _)| d.as_path());
                    // displace-then-verify against the LOCAL hash we just observed — the
                    // displaced tree is kept unless it still matches it exactly... and here the
                    // local side is by definition divergent, so it is ALWAYS kept as a recovery
                    let observed = local.as_ref().map(|(_, h)| h.clone()).unwrap_or_default();
                    let keep_marker = format!("{observed}-conflicted"); // never equal → always kept
                    apply_over_local(local_dir, catalog, name, files, &keep_marker)?;
                    st.skills.insert(name.to_string(), fileset_hash(files));
                    write_base(&state_dir, name, files)?;
                }
                None => {
                    if let Some((dir, _)) = &local {
                        displace_to_recovery(dir, name)?;
                    }
                    st.skills.remove(name);
                    remove_base(&state_dir, name);
                }
            }
        }
        Resolution::Local => match up {
            // cursor moves to upstream's position so the settled state stops re-flagging
            Some(files) => {
                st.skills.insert(name.to_string(), fileset_hash(files));
                // base advances to upstream too: the user KEPT their version, so their content is
                // local motion measured from here, and the same divergence stops re-conflicting
                write_base(&state_dir, name, files)?;
            }
            None => {
                st.skills.remove(name);
                remove_base(&state_dir, name);
            }
        },
    }
    save_state(&state_dir, &st)?;
    store::list_recoveries(recovery_root)
}

/// Gather the three sides for one conflicted skill: (base, local, upstream) + the local dir.
/// Reads only; the clone is used AS LAST FETCHED so what the user reviewed is what they settle.
type ThreeSides = (Fileset, Fileset, Fileset, PathBuf);
fn three_sides(
    home: &Path,
    project_root: Option<&Path>,
    state_dir: &Path,
    st: &CollectionState,
    name: &str,
) -> Result<ThreeSides> {
    store::check_slug(name)?;
    if !st.skills.contains_key(name) {
        return Err(StoreError::NotFound(format!(
            "{name} is not tracked by this collection"
        )));
    }
    let base = read_base(state_dir, name).ok_or_else(|| {
        // an honest refusal beats inventing a base: without one, per-path is not answerable
        StoreError::NotFound(format!(
            "{name} has no base snapshot (imported before per-file merge) — resolve whole-skill"
        ))
    })?;
    let upstream = upstream_skills(&import_root(state_dir, st.subpath.as_deref()))?;
    let up = upstream
        .get(name)
        .cloned()
        .ok_or_else(|| StoreError::NotFound(format!("{name} is not in the upstream repo")))?;
    let (dir, _) = local_tree(home, project_root, st.scope, name)?
        .ok_or_else(|| StoreError::NotFound(format!("{name} is not present locally")))?;
    let local = import::read_skill_fileset(&dir).map_err(import_err)?;
    Ok((base, local, up, dir))
}

/// The overlapping paths of one conflicted skill, with each side's kind, plus a `mergeId` the
/// caller passes back to `resolve_git_conflict_paths`. Reads state; writes nothing.
///
/// Empty conflicts ⇒ the skill is not actually conflicted, and this refuses (`RESOURCE_NOT_FOUND`)
/// exactly like the whole-skill resolve — a host must never present a settle UI for a non-conflict.
pub fn conflict_paths(
    home: &Path,
    project_root: Option<&Path>,
    collection_id: &str,
    name: &str,
) -> Result<(String, Vec<PathConflict>)> {
    let (state_dir, st) = load_state(home, collection_id)?;
    // read-only, but it reads the CLONE, which `sync` rewrites mid-fetch — a presentation built
    // from a half-fetched tree would hand the user a mergeId for a state that never existed
    let _lock = OpLock::acquire(&state_dir)?;
    let (base, local, up, dir) = three_sides(home, project_root, &state_dir, &st, name)?;
    let (_, conflicts) = three_way(&base, &local, &up);
    if conflicts.is_empty() {
        return Err(StoreError::NotFound(format!(
            "no conflict to resolve for {name}"
        )));
    }
    Ok((merge_id_of(&base, &local, &up, &dir), conflicts))
}

/// Settle a conflicted skill PER PATH. `choices` names the paths to take from upstream; every
/// conflicted path not named keeps the local version ("mine"), which is agent-deck's default.
///
/// All-or-nothing per skill: the merged fileset is materialized in one atomic swap, the
/// pre-resolve tree lands on the recovery surface, and the cursor+base advance together. A
/// `merge_id` that no longer matches is refused with `RESOURCE_STALE` — the host re-reads
/// `conflict_paths` and asks again, which is exactly today's `LEGACY_MERGE_STALE` → refresh flow.
pub fn resolve_git_conflict_paths(
    home: &Path,
    project_root: Option<&Path>,
    collection_id: &str,
    name: &str,
    merge_id: &str,
    choices: &[(String, Resolution)],
) -> Result<Vec<Recovery>> {
    let (state_dir, mut st) = load_state(home, collection_id)?;
    let _lock = OpLock::acquire(&state_dir)?;
    let (base, local, up, dir) = three_sides(home, project_root, &state_dir, &st, name)?;
    let (merged, conflicts) = three_way(&base, &local, &up);
    if conflicts.is_empty() {
        return Err(StoreError::NotFound(format!(
            "no conflict to resolve for {name}"
        )));
    }
    // STALE CHECK FIRST: applying a choice list against a moved target is the failure this guard
    // exists to prevent, so it runs before any validation that could mask it with a different error.
    let current = merge_id_of(&base, &local, &up, &dir);
    if current != merge_id {
        return Err(StoreError::Stale(format!(
            "the conflict for {name} moved (expected {merge_id}, now {current}) — re-read conflictPaths"
        )));
    }
    // A choice for a path that is not conflicted is a caller BUG, not a no-op: it means the host's
    // view and the engine's disagree, and silently ignoring it would apply a merge the user did not
    // see. (The stale guard catches the drift case; this catches the wrong-path case.)
    let conflicted: BTreeSet<&str> = conflicts.iter().map(|c| c.path.as_str()).collect();
    for (path, _) in choices {
        if !conflicted.contains(path.as_str()) {
            return Err(StoreError::InvalidPath(format!(
                "{path} is not a conflicted path of {name}"
            )));
        }
    }
    // `three_way` already put the LOCAL side in `merged` for every conflicted path — the "mine"
    // default. Apply only the paths chosen as remote.
    let mut settled = merged;
    for (path, res) in choices {
        if *res != Resolution::Remote {
            continue;
        }
        match up.get(path) {
            Some(content) => {
                settled.insert(path.clone(), content.clone());
            }
            // upstream DELETED this path and the user chose remote → the deletion is the choice
            None => {
                settled.remove(path);
                // a file → directory transition: upstream's children were already merged in, and
                // removing the file lets them survive the prune below
            }
        }
    }
    // the chosen kind now decides its own subtree, so the result is always writable
    prune_file_directory_collisions(&mut settled);
    let catalog = dir
        .parent()
        .ok_or_else(|| StoreError::InvalidPath(name.into()))?;
    // the pre-resolve tree always survives as a recovery (the marker can never match the tree we
    // just hashed, so `apply_over_local` keeps it) — a per-path settle is exactly when a user is
    // most likely to want their original back
    let keep_marker = format!("{}-conflicted", fileset_hash(&local));
    apply_over_local(Some(&dir), catalog, name, &settled, &keep_marker)?;
    st.skills.insert(name.to_string(), fileset_hash(&settled));
    // base advances to UPSTREAM (the new shared ancestor), never to the settled result: content
    // the user kept must keep counting as local motion in the next round.
    write_base(&state_dir, name, &up)?;
    save_state(&state_dir, &st)?;
    let recovery_root = match st.scope {
        Scope::Project => project_root.ok_or_else(|| {
            StoreError::InvalidPath("project scope requires a project root".into())
        })?,
        _ => home,
    };
    store::list_recoveries(recovery_root)
}

/// Forget a collection. With `remove_skills`, each tracked skill is DISPLACED (recoverable),
/// never hard-deleted; without it, the skills stay as ordinary unmanaged skills.
pub fn forget_git_repo(
    home: &Path,
    project_root: Option<&Path>,
    collection_id: &str,
    remove_skills: bool,
) -> Result<()> {
    let (state_dir, st) = load_state(home, collection_id)?;
    let _lock = OpLock::acquire(&state_dir)?;
    if remove_skills {
        for name in st.skills.keys() {
            if let Some((dir, _)) = local_tree(home, project_root, st.scope, name)? {
                displace_to_recovery(&dir, name)?;
            }
        }
    }
    remove_tree_force(&state_dir).map_err(StoreError::Io)
}

#[derive(Debug)]
pub struct RepoInfo {
    pub collection_id: String,
    pub url: String,
    pub git_ref: Option<String>,
    pub subpath: Option<String>,
    pub scope: Scope,
    pub skills: Vec<String>,
}

/// Every imported collection under `home`. A dir whose state file is unreadable is reported by
/// id with an empty skill list rather than hidden — `forget` must stay able to remove it.
pub fn list_git_repos(home: &Path) -> Result<Vec<RepoInfo>> {
    let root = collections_root(home);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        // no collection.json at all = an unconfirmed PREVIEW (SKL-03), not a corrupt
        // collection — invisible here; a present-but-unloadable file stays surfaced below
        if !entry.path().join("collection.json").exists() {
            continue;
        }
        match load_state(home, &id) {
            Ok((_, st)) => out.push(RepoInfo {
                collection_id: st.id,
                url: st.url,
                git_ref: st.git_ref,
                subpath: st.subpath,
                scope: st.scope,
                skills: st.skills.keys().cloned().collect(),
            }),
            Err(_) => out.push(RepoInfo {
                collection_id: id,
                url: String::new(),
                git_ref: None,
                subpath: None,
                scope: Scope::Global,
                skills: Vec::new(),
            }),
        }
    }
    out.sort_by(|a, b| a.collection_id.cmp(&b.collection_id));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A git fixture with two skills; returns (url, repo_workdir).
    fn fixture(dir: &Path) -> (String, PathBuf) {
        let repo = dir.join("upstream");
        std::fs::create_dir_all(repo.join("alpha")).unwrap();
        std::fs::create_dir_all(repo.join("beta")).unwrap();
        std::fs::write(repo.join("alpha/SKILL.md"), "# alpha v1").unwrap();
        std::fs::write(repo.join("beta/SKILL.md"), "# beta v1").unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        (format!("file://{}", repo.to_str().unwrap()), repo)
    }

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

    fn skill_md(home: &Path, name: &str) -> PathBuf {
        crate::scope::canonical_catalog(home)
            .join(name)
            .join("SKILL.md")
    }

    #[test]
    fn import_materializes_every_skill_and_records_the_collection() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        assert_eq!(out.skills, vec!["alpha", "beta"]);
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            "# alpha v1"
        );
        let repos = list_git_repos(&home).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].collection_id, out.collection_id);
        assert_eq!(repos[0].skills, vec!["alpha", "beta"]);
    }

    #[test]
    fn reimporting_the_same_repo_is_refused_not_duplicated() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        let e = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_ALREADY_EXISTS");
    }

    // ── SKL-13: additive re-import of an imported collection ────────────────────────────────

    #[test]
    fn inspect_on_an_imported_collection_reports_already_selected_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();

        // inspect no longer refuses: the full upstream is listed, imported names marked
        let out = inspect_git_repo(&home, &url, None, None).unwrap();
        let mut names: Vec<&str> = out.skills.iter().map(|s| s.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert_eq!(out.already_imported, vec!["alpha"]);

        // the collection survives untouched, and a SECOND inspect still answers
        let repos = list_git_repos(&home).unwrap();
        assert_eq!(repos[0].skills, vec!["alpha"]);
        let again = inspect_git_repo(&home, &url, None, None).unwrap();
        assert_eq!(again.already_imported, vec!["alpha"]);
    }

    #[test]
    fn additive_import_widens_the_selection_without_touching_existing_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        let alpha_before = std::fs::read_to_string(skill_md(&home, "alpha")).unwrap();

        let add = vec!["beta".to_string()];
        let out =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&add)).unwrap();
        assert_eq!(out.skills, vec!["beta"]);
        assert!(out.skipped.is_empty());
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "beta")).unwrap(),
            "# beta v1"
        );
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            alpha_before
        );
        let repos = list_git_repos(&home).unwrap();
        assert_eq!(repos[0].skills, vec!["alpha", "beta"]);
    }

    #[test]
    fn additive_import_skips_already_imported_names_and_full_reimport_stays_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();

        // selecting an already-imported name SKIPS it — idempotent, never an error
        let both = vec!["alpha".to_string(), "beta".to_string()];
        let out =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&both)).unwrap();
        assert_eq!(out.skills, vec!["beta"]);
        assert_eq!(out.skipped, vec!["alpha"]);

        // an UNSELECTED re-import keeps the explicit refusal — additive widening
        // must always name what it adds
        let e = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_ALREADY_EXISTS");
    }

    #[test]
    fn additive_import_collision_leaves_the_collection_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        // a user skill occupies the name the additive import wants
        let beta_dir = crate::scope::canonical_catalog(&home).join("beta");
        std::fs::create_dir_all(&beta_dir).unwrap();
        std::fs::write(beta_dir.join("SKILL.md"), "# the user's own beta").unwrap();

        let add = vec!["beta".to_string()];
        let e =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&add)).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_ALREADY_EXISTS");
        // nothing changed: the user's file survives, the collection still tracks only alpha
        assert_eq!(
            std::fs::read_to_string(beta_dir.join("SKILL.md")).unwrap(),
            "# the user's own beta"
        );
        let repos = list_git_repos(&home).unwrap();
        assert_eq!(repos[0].skills, vec!["alpha"]);
    }

    #[test]
    fn additive_import_refuses_a_scope_mismatch_loudly() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let project = tmp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let sel = vec!["alpha".to_string()];
        import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();

        // the caller asks for PROJECT scope on a GLOBAL collection: refuse, never
        // silently write into the collection's scope instead (review, Codex)
        let add = vec!["beta".to_string()];
        let e = import_git_repo(
            &home,
            Some(&project),
            Scope::Project,
            &url,
            None,
            None,
            Some(&add),
        )
        .unwrap_err();
        assert!(e.to_string().contains("scope"), "unexpected error: {e}");
        let repos = list_git_repos(&home).unwrap();
        assert_eq!(repos[0].skills, vec!["alpha"]);
    }

    #[test]
    fn additive_import_adopts_an_identical_partial_widening_after_a_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        // simulate a crash between materialize and save_state: beta exists on disk with
        // EXACTLY the upstream content, but the collection does not track it
        let beta_dir = crate::scope::canonical_catalog(&home).join("beta");
        std::fs::create_dir_all(&beta_dir).unwrap();
        std::fs::write(beta_dir.join("SKILL.md"), "# beta v1").unwrap();

        // retrying the widening ADOPTS the identical tree instead of refusing forever
        let add = vec!["beta".to_string()];
        let out =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&add)).unwrap();
        assert_eq!(out.skills, vec!["beta"]);
        let repos = list_git_repos(&home).unwrap();
        assert_eq!(repos[0].skills, vec!["alpha", "beta"]);
    }

    // ── SKL-03/04: inspect (preview) + per-skill selection ──────────────────────────────────

    #[test]
    fn inspect_lists_skills_without_materializing_and_import_reuses_the_preview_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = inspect_git_repo(&home, &url, None, None).unwrap();
        // preview contract: both skills, SKILL.md content included, nothing materialized
        let names: Vec<&str> = out.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert_eq!(out.skills[0].skill_md.as_deref(), Some("# alpha v1"));
        assert_eq!(out.skills[0].file_count, 1);
        assert!(!skill_md(&home, "alpha").exists());
        assert!(!skill_md(&home, "beta").exists());
        // the state dir is an unconfirmed preview: clone cached, no collection.json
        let state_dir = collections_root(&home).join(&out.collection_id);
        assert!(state_dir.join("clone").is_dir());
        assert!(!state_dir.join("collection.json").exists());
        assert!(list_git_repos(&home).unwrap().is_empty());
        // upstream moves AFTER the preview…
        std::fs::write(repo.join("alpha/SKILL.md"), "# alpha v2").unwrap();
        commit_all(&repo, "v2");
        // …but import materializes exactly what was previewed (clone reuse, no re-clone)
        let sel = vec!["alpha".to_string()];
        let out2 =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        assert_eq!(out2.collection_id, out.collection_id);
        assert_eq!(out2.skills, vec!["alpha"]);
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            "# alpha v1"
        );
    }

    #[test]
    fn import_with_selection_materializes_only_selected_and_check_sync_ignore_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        let out =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        assert_eq!(out.skills, vec!["alpha"]);
        assert!(!skill_md(&home, "beta").exists());
        assert_eq!(list_git_repos(&home).unwrap()[0].skills, vec!["alpha"]);
        // upstream: beta changes, gamma appears — neither is the user's business
        std::fs::write(repo.join("beta/SKILL.md"), "# beta v2").unwrap();
        std::fs::create_dir_all(repo.join("gamma")).unwrap();
        std::fs::write(repo.join("gamma/SKILL.md"), "# gamma v1").unwrap();
        commit_all(&repo, "beta v2 + gamma");
        assert!(check_git_repo(&home, &out.collection_id)
            .unwrap()
            .is_empty());
        let sync = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert!(sync.applied.is_empty() && sync.conflicts.is_empty());
        assert!(!skill_md(&home, "beta").exists());
        assert!(!skill_md(&home, "gamma").exists());
        // …while the SELECTED skill still updates normally
        std::fs::write(repo.join("alpha/SKILL.md"), "# alpha v2").unwrap();
        commit_all(&repo, "alpha v2");
        let deltas = check_git_repo(&home, &out.collection_id).unwrap();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].name, "alpha");
        let sync2 = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(sync2.applied, vec!["alpha"]);
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            "# alpha v2"
        );
    }

    #[test]
    fn import_with_unknown_or_empty_selection_fails_closed_writing_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string(), "nope".to_string()];
        let e =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_NOT_FOUND");
        assert!(!skill_md(&home, "alpha").exists());
        assert!(list_git_repos(&home).unwrap().is_empty());
        let leftover = std::fs::read_dir(collections_root(&home))
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        assert!(!leftover, "a failed selected import must leave no state");
        let empty: Vec<String> = Vec::new();
        let e2 = import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&empty))
            .unwrap_err();
        assert_eq!(e2.code(), "RESOURCE_INVALID_PATH");
    }

    #[test]
    fn discard_git_preview_removes_a_preview_and_refuses_an_imported_collection() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = inspect_git_repo(&home, &url, None, None).unwrap();
        let state_dir = collections_root(&home).join(&out.collection_id);
        assert!(state_dir.is_dir());
        discard_git_preview(&home, &out.collection_id).unwrap();
        assert!(!state_dir.exists());
        // cancel is idempotent
        discard_git_preview(&home, &out.collection_id).unwrap();
        // an IMPORTED collection is not a preview and must be refused
        let out2 = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        let e = discard_git_preview(&home, &out2.collection_id).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_ALREADY_EXISTS");
        assert!(skill_md(&home, "alpha").exists());
    }

    #[test]
    fn inspect_reclaims_a_stale_preview_and_answers_for_an_imported_collection() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        // a stale/abandoned preview is reclaimed by the next inspect (fresh clone)
        inspect_git_repo(&home, &url, None, None).unwrap();
        std::fs::write(repo.join("alpha/SKILL.md"), "# alpha v2").unwrap();
        commit_all(&repo, "v2");
        let out = inspect_git_repo(&home, &url, None, None).unwrap();
        assert_eq!(out.skills[0].skill_md.as_deref(), Some("# alpha v2"));
        // an imported collection now ANSWERS from its own clone (SKL-13) instead of
        // refusing, marking what is already imported
        import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        let answered = inspect_git_repo(&home, &url, None, None).unwrap();
        assert_eq!(answered.already_imported, vec!["alpha", "beta"]);
    }

    #[test]
    fn import_after_a_crashed_inspect_reclones_instead_of_trusting_the_partial_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        // simulate an inspect that died mid-clone: a state dir with a junk clone and NO
        // completion marker — reusing it would import garbage or fail confusingly
        let id = derive_id(&url, None, None).unwrap();
        let state_dir = collections_root(&home).join(&id);
        std::fs::create_dir_all(state_dir.join("clone")).unwrap();
        std::fs::write(state_dir.join("clone").join("junk.txt"), "not a git repo").unwrap();
        let sel = vec!["alpha".to_string()];
        let out =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        assert_eq!(out.skills, vec!["alpha"]);
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            "# alpha v1"
        );
    }

    #[test]
    fn inspect_of_a_repo_with_no_skills_returns_empty_and_leaves_no_residue() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("upstream2");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join("README.md"), "hi").unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        let url = format!("file://{}", repo.to_str().unwrap());
        let home = tmp.path().join("home");
        let out = inspect_git_repo(&home, &url, None, None).unwrap();
        assert!(out.skills.is_empty());
        assert!(!collections_root(&home).join(&out.collection_id).exists());
    }

    #[test]
    fn a_state_file_whose_cursor_escapes_its_selection_is_refused() {
        // Re-assert at USE time: a collection.json can arrive by copy or hand-edit. A cursor
        // name OUTSIDE the stored selection would make check/sync/forget treat that skill as
        // collection-owned — the file is refused whole (review, Codex).
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        let out =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        let state = collections_root(&home)
            .join(&out.collection_id)
            .join("collection.json");
        let raw = std::fs::read_to_string(&state).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v["skills"]["beta"] = serde_json::Value::String("0".repeat(64));
        std::fs::write(&state, serde_json::to_string(&v).unwrap()).unwrap();
        let e = check_git_repo(&home, &out.collection_id).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_GIT");
        // an empty selected array is meaningless (import forbids it) and refused on load too
        let mut v2: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v2["selected"] = serde_json::json!([]);
        std::fs::write(&state, serde_json::to_string(&v2).unwrap()).unwrap();
        let e2 = check_git_repo(&home, &out.collection_id).unwrap_err();
        assert_eq!(e2.code(), "RESOURCE_GIT");
    }

    #[test]
    fn conflict_resolution_refuses_a_skill_outside_the_selection() {
        // With selected=[alpha], the user's own unrelated `beta` must be untouchable through
        // the conflict surface — Remote would displace it with upstream beta (review, Codex).
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let sel = vec!["alpha".to_string()];
        let out =
            import_git_repo(&home, None, Scope::Global, &url, None, None, Some(&sel)).unwrap();
        store::write_skill(&home, "beta", "# mine").unwrap();
        let e = resolve_git_conflict(&home, None, &out.collection_id, "beta", Resolution::Remote)
            .unwrap_err();
        assert_eq!(e.code(), "RESOURCE_NOT_FOUND");
        let e2 = conflict_paths(&home, None, &out.collection_id, "beta").unwrap_err();
        assert_eq!(e2.code(), "RESOURCE_NOT_FOUND");
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "beta")).unwrap(),
            "# mine"
        );
    }

    #[test]
    fn discard_git_preview_refuses_while_an_operation_holds_the_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = inspect_git_repo(&home, &url, None, None).unwrap();
        let state_dir = collections_root(&home).join(&out.collection_id);
        let _held = OpLock::acquire(&state_dir).unwrap();
        let e = discard_git_preview(&home, &out.collection_id).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_RECONCILE_INCOMPLETE");
        // preview still intact — nothing was deleted under the in-flight operation
        assert!(state_dir.join("clone").is_dir());
    }

    #[test]
    fn a_full_import_without_selection_keeps_reporting_new_upstream_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        std::fs::create_dir_all(repo.join("gamma")).unwrap();
        std::fs::write(repo.join("gamma/SKILL.md"), "# gamma v1").unwrap();
        commit_all(&repo, "gamma");
        let deltas = check_git_repo(&home, &out.collection_id).unwrap();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0].name, "gamma");
        assert_eq!(deltas[0].kind, DeltaKind::Added);
    }

    #[test]
    fn import_refuses_a_name_collision_with_an_existing_skill_writing_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        // the user already has a skill named `alpha`
        store::write_skill(&home, "alpha", "# mine").unwrap();
        let e = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_ALREADY_EXISTS");
        // all-or-nothing: beta was NOT written, the user's alpha is untouched, no state remains
        assert!(!skill_md(&home, "beta").exists());
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            "# mine"
        );
        assert!(list_git_repos(&home).unwrap().is_empty());
    }

    #[test]
    fn check_previews_added_changed_removed_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        // upstream: change alpha, remove beta, add gamma
        std::fs::write(repo.join("alpha/SKILL.md"), "# alpha v2").unwrap();
        std::fs::remove_dir_all(repo.join("beta")).unwrap();
        std::fs::create_dir_all(repo.join("gamma")).unwrap();
        std::fs::write(repo.join("gamma/SKILL.md"), "# gamma v1").unwrap();
        commit_all(&repo, "drift");

        let deltas = check_git_repo(&home, &out.collection_id).unwrap();
        let as_pairs: Vec<(String, DeltaKind)> =
            deltas.into_iter().map(|d| (d.name, d.kind)).collect();
        assert_eq!(
            as_pairs,
            vec![
                ("alpha".into(), DeltaKind::Changed),
                ("beta".into(), DeltaKind::Removed),
                ("gamma".into(), DeltaKind::Added),
            ]
        );
        // preview wrote nothing
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            "# alpha v1"
        );
        assert!(skill_md(&home, "beta").exists());
        assert!(!skill_md(&home, "gamma").exists());
    }

    #[test]
    fn sync_applies_clean_changes_and_reports_conflicts_without_touching_them() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        // the user edits beta locally…
        store::write_skill(&home, "beta", "# beta EDITED LOCALLY").unwrap();
        // …while upstream changes BOTH skills and adds gamma
        std::fs::write(repo.join("alpha/SKILL.md"), "# alpha v2").unwrap();
        std::fs::write(repo.join("beta/SKILL.md"), "# beta v2").unwrap();
        std::fs::create_dir_all(repo.join("gamma")).unwrap();
        std::fs::write(repo.join("gamma/SKILL.md"), "# gamma v1").unwrap();
        commit_all(&repo, "drift");

        let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(r.applied, vec!["alpha", "gamma"]);
        assert_eq!(r.conflicts, vec!["beta"]);
        // clean change applied, new skill materialized, conflicted skill NOT overwritten
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "alpha")).unwrap(),
            "# alpha v2"
        );
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "gamma")).unwrap(),
            "# gamma v1"
        );
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "beta")).unwrap(),
            "# beta EDITED LOCALLY"
        );
        // and the conflict is stable: syncing again reports it again, still without writing
        let r2 = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(r2.applied, Vec::<String>::new());
        assert_eq!(r2.conflicts, vec!["beta"]);
    }

    #[test]
    fn resolve_remote_displaces_the_local_tree_into_a_recovery_then_applies_upstream() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        store::write_skill(&home, "beta", "# beta EDITED LOCALLY").unwrap();
        std::fs::write(repo.join("beta/SKILL.md"), "# beta v2").unwrap();
        commit_all(&repo, "drift");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            vec!["beta"]
        );

        let recoveries =
            resolve_git_conflict(&home, None, &out.collection_id, "beta", Resolution::Remote)
                .unwrap();
        // upstream content applied…
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "beta")).unwrap(),
            "# beta v2"
        );
        // …and the displaced local edit is a real recovery the existing surface can restore
        assert_eq!(recoveries.len(), 1);
        assert_eq!(recoveries[0].slug, "beta");
        let restored = store::restore_recovery(&home, &recoveries[0].token).unwrap();
        assert_eq!(
            std::fs::read_to_string(restored.join("SKILL.md")).unwrap(),
            "# beta EDITED LOCALLY"
        );
        // next sync is clean (the restore re-created a local edit — that is the USER's new state)
    }

    #[test]
    fn resolve_local_keeps_the_edit_and_stops_reflagging() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        store::write_skill(&home, "beta", "# beta EDITED LOCALLY").unwrap();
        std::fs::write(repo.join("beta/SKILL.md"), "# beta v2").unwrap();
        commit_all(&repo, "drift");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            vec!["beta"]
        );

        let recoveries =
            resolve_git_conflict(&home, None, &out.collection_id, "beta", Resolution::Local)
                .unwrap();
        assert!(recoveries.is_empty(), "take-local displaces nothing");
        assert_eq!(
            std::fs::read_to_string(skill_md(&home, "beta")).unwrap(),
            "# beta EDITED LOCALLY"
        );
        // settled: the same divergence no longer reports a conflict
        let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(r.conflicts, Vec::<String>::new());
    }

    #[test]
    fn upstream_removal_of_an_unedited_skill_is_a_recoverable_displacement() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        std::fs::remove_dir_all(repo.join("beta")).unwrap();
        commit_all(&repo, "remove beta");

        let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(r.applied, vec!["beta"]);
        assert!(!skill_md(&home, "beta").exists(), "beta should be removed");
        // …but recoverably
        let recs = store::list_recoveries(&home).unwrap();
        assert!(
            recs.iter().any(|r| r.slug == "beta"),
            "removal must leave a recovery"
        );
    }

    #[test]
    fn forget_with_remove_skills_displaces_rather_than_destroys() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        forget_git_repo(&home, None, &out.collection_id, true).unwrap();
        assert!(!skill_md(&home, "alpha").exists());
        assert!(
            list_git_repos(&home).unwrap().is_empty(),
            "state dir must be gone"
        );
        let recs = store::list_recoveries(&home).unwrap();
        assert!(recs.iter().any(|r| r.slug == "alpha"));
        assert!(recs.iter().any(|r| r.slug == "beta"));
    }

    #[test]
    fn forget_without_remove_skills_leaves_them_as_ordinary_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        forget_git_repo(&home, None, &out.collection_id, false).unwrap();
        assert!(skill_md(&home, "alpha").exists(), "skills stay");
        assert!(list_git_repos(&home).unwrap().is_empty());
    }

    #[test]
    fn a_repo_with_duplicate_skill_folder_names_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("upstream");
        std::fs::create_dir_all(repo.join("a/tools/helper")).unwrap();
        std::fs::create_dir_all(repo.join("b/tools/helper")).unwrap();
        std::fs::write(repo.join("a/tools/helper/SKILL.md"), "# one").unwrap();
        std::fs::write(repo.join("b/tools/helper/SKILL.md"), "# two").unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        let url = format!("file://{}", repo.to_str().unwrap());
        let home = tmp.path().join("home");
        let e = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_GIT");
        assert!(e.to_string().contains("helper"), "{e}");
        assert!(
            list_git_repos(&home).unwrap().is_empty(),
            "failed import leaves no state"
        );
    }

    /// Multi-file fixture for the per-path tests: one skill, three files.
    fn multi_file_fixture(dir: &Path) -> (String, PathBuf) {
        let repo = dir.join("upstream");
        std::fs::create_dir_all(repo.join("kit/scripts")).unwrap();
        std::fs::write(
            repo.join("kit/SKILL.md"),
            "---\nname: kit\ndescription: Kit skill\n---\n# kit v1",
        )
        .unwrap();
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v1").unwrap();
        std::fs::write(repo.join("kit/scripts/b.sh"), "echo b-v1").unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        (format!("file://{}", repo.to_str().unwrap()), repo)
    }

    fn write_local(home: &Path, name: &str, rel: &str, content: &str) {
        let p = crate::scope::canonical_catalog(home).join(name).join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn sync_auto_merges_non_overlapping_path_changes() {
        // agent-deck's UX: only paths BOTH sides moved are conflicts; one-sided path motion
        // auto-applies even when the skill as a whole diverged on both sides.
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL"); // local edits a.sh
        std::fs::write(repo.join("kit/scripts/b.sh"), "echo b-v2").unwrap(); // upstream edits b.sh
        commit_all(&repo, "drift");

        let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(
            r.applied,
            vec!["kit"],
            "non-overlapping drift must auto-merge"
        );
        assert_eq!(r.conflicts, Vec::<String>::new());
        let read = |rel: &str| {
            std::fs::read_to_string(crate::scope::canonical_catalog(&home).join("kit").join(rel))
                .unwrap()
        };
        assert_eq!(
            read("scripts/a.sh"),
            "echo a-LOCAL",
            "local one-sided edit survives"
        );
        assert_eq!(
            read("scripts/b.sh"),
            "echo b-v2",
            "upstream one-sided edit applies"
        );
    }

    #[test]
    #[allow(non_snake_case)] // the capitals are the point of the name
    fn a_merged_local_edit_survives_the_NEXT_sync() {
        // The cursor after an auto-merge is the MERGED tree, but the base is upstream — so the
        // fast path ("local matches the cursor ⇒ untouched ⇒ apply upstream wholesale") was true
        // and wrong: it would replace the merged tree with upstream and silently delete the local
        // edit the merge had just preserved (review, Codex). Data loss, one sync later.
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL");
        std::fs::write(repo.join("kit/scripts/b.sh"), "echo b-v2").unwrap();
        commit_all(&repo, "drift");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .applied,
            vec!["kit"]
        );

        // …and again, with NOTHING new upstream
        let r2 = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(
            r2.applied,
            Vec::<String>::new(),
            "an unchanged upstream must apply nothing"
        );
        let read = |rel: &str| {
            std::fs::read_to_string(crate::scope::canonical_catalog(&home).join("kit").join(rel))
                .unwrap()
        };
        assert_eq!(
            read("scripts/a.sh"),
            "echo a-LOCAL",
            "the merged local edit must SURVIVE"
        );
        assert_eq!(read("scripts/b.sh"), "echo b-v2");
    }

    #[test]
    fn a_kept_local_file_survives_the_next_sync_after_a_per_path_resolve() {
        // Same shape via the per-path settle: "keep mine" then sync must not undo the choice.
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL");
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v2").unwrap();
        commit_all(&repo, "drift");
        sync_git_repo(&home, None, &out.collection_id).unwrap();
        let (merge_id, _) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();
        resolve_git_conflict_paths(&home, None, &out.collection_id, "kit", &merge_id, &[]).unwrap();

        let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(r.applied, Vec::<String>::new());
        assert_eq!(
            std::fs::read_to_string(
                crate::scope::canonical_catalog(&home).join("kit/scripts/a.sh")
            )
            .unwrap(),
            "echo a-LOCAL",
            "the settled choice must not be undone by the next sync"
        );
    }

    #[test]
    fn conflict_paths_reports_only_the_overlapping_paths_with_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL"); // both move a.sh
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v2").unwrap();
        std::fs::write(repo.join("kit/scripts/b.sh"), "echo b-v2").unwrap(); // upstream-only b.sh
        commit_all(&repo, "drift");

        let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(r.conflicts, vec!["kit"]);

        let (merge_id, paths) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();
        assert!(!merge_id.is_empty());
        assert_eq!(
            paths.len(),
            1,
            "only the both-sides path is a conflict: {paths:?}"
        );
        assert_eq!(paths[0].path, "scripts/a.sh");
        assert_eq!(paths[0].local_kind, "file");
        assert_eq!(paths[0].remote_kind, "file");
    }

    #[test]
    fn per_path_resolve_mixes_mine_and_remote_and_settles_the_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        // both sides move BOTH scripts → two conflicted paths
        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL");
        write_local(&home, "kit", "scripts/b.sh", "echo b-LOCAL");
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v2").unwrap();
        std::fs::write(repo.join("kit/scripts/b.sh"), "echo b-v2").unwrap();
        commit_all(&repo, "drift");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            vec!["kit"]
        );

        let (merge_id, paths) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();
        assert_eq!(paths.len(), 2);
        // keep my a.sh, take their b.sh; the displaced pre-resolve tree lands as a recovery
        let recs = resolve_git_conflict_paths(
            &home,
            None,
            &out.collection_id,
            "kit",
            &merge_id,
            &[("scripts/b.sh".to_string(), Resolution::Remote)],
        )
        .unwrap();
        assert!(
            recs.iter().any(|r| r.slug == "kit"),
            "pre-resolve tree must be recoverable"
        );
        let read = |rel: &str| {
            std::fs::read_to_string(crate::scope::canonical_catalog(&home).join("kit").join(rel))
                .unwrap()
        };
        assert_eq!(
            read("scripts/a.sh"),
            "echo a-LOCAL",
            "omitted path defaults to mine"
        );
        assert_eq!(
            read("scripts/b.sh"),
            "echo b-v2",
            "chosen path takes remote"
        );
        // settled: the same divergence no longer conflicts
        let r2 = sync_git_repo(&home, None, &out.collection_id).unwrap();
        assert_eq!(r2.conflicts, Vec::<String>::new());
    }

    #[test]
    fn per_path_resolve_refuses_a_stale_merge_id() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL");
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v2").unwrap();
        commit_all(&repo, "drift");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            vec!["kit"]
        );
        let (merge_id, _) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();

        // upstream moves AGAIN and a sync refreshes the clone — the user's view is now stale
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v3").unwrap();
        commit_all(&repo, "more drift");
        let _ = sync_git_repo(&home, None, &out.collection_id).unwrap();

        let e = resolve_git_conflict_paths(
            &home,
            None,
            &out.collection_id,
            "kit",
            &merge_id,
            &[("scripts/a.sh".to_string(), Resolution::Remote)],
        )
        .unwrap_err();
        assert_eq!(e.code(), "RESOURCE_STALE", "{e}");
    }

    #[test]
    fn per_path_resolve_refuses_a_choice_for_a_path_that_is_not_conflicted() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL");
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v2").unwrap();
        commit_all(&repo, "drift");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            vec!["kit"]
        );
        let (merge_id, _) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();
        let e = resolve_git_conflict_paths(
            &home,
            None,
            &out.collection_id,
            "kit",
            &merge_id,
            &[("scripts/zzz.sh".to_string(), Resolution::Remote)],
        )
        .unwrap_err();
        assert_eq!(e.code(), "RESOURCE_INVALID_PATH", "{e}");
    }

    #[test]
    fn keeping_mine_on_a_file_that_upstream_turned_into_a_directory_stays_writable() {
        // The nastiest shape in the request: upstream replaces file `notes` with directory
        // `notes/`, local edits the file. If "keep mine" leaves BOTH `notes` (file) and
        // `notes/index.md` in the settled fileset, that tree cannot exist on disk — the resolve
        // would fail with an io error the user cannot act on, or write something half-formed.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("upstream");
        std::fs::create_dir_all(repo.join("kit")).unwrap();
        std::fs::write(
            repo.join("kit/SKILL.md"),
            "---\nname: kit\ndescription: Kit skill\n---\n# kit",
        )
        .unwrap();
        std::fs::write(repo.join("kit/notes"), "flat notes v1").unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        let url = format!("file://{}", repo.to_str().unwrap());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        write_local(&home, "kit", "notes", "flat notes LOCAL"); // local edits the FILE
        std::fs::remove_file(repo.join("kit/notes")).unwrap(); // upstream makes it a DIRECTORY
        std::fs::create_dir_all(repo.join("kit/notes")).unwrap();
        std::fs::write(repo.join("kit/notes/index.md"), "# nested").unwrap();
        commit_all(&repo, "file becomes a directory");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            vec!["kit"]
        );

        let (merge_id, paths) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();
        let notes = paths
            .iter()
            .find(|p| p.path == "notes")
            .expect("notes must be conflicted");
        assert_eq!(notes.local_kind, "file");
        assert_eq!(
            notes.remote_kind, "directory",
            "the UI needs the type change"
        );

        // keep mine → the file survives and upstream's children are NOT also written
        resolve_git_conflict_paths(&home, None, &out.collection_id, "kit", &merge_id, &[]).unwrap();
        let kit = crate::scope::canonical_catalog(&home).join("kit");
        assert!(
            kit.join("notes").is_file(),
            "the local file must survive as a FILE"
        );
        assert!(
            !kit.join("notes/index.md").exists(),
            "its subtree cannot coexist"
        );
        // and the skill is genuinely settled, not stuck re-conflicting
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            Vec::<String>::new()
        );
    }

    #[test]
    fn taking_remote_on_a_file_upstream_turned_into_a_directory_writes_the_subtree() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("upstream");
        std::fs::create_dir_all(repo.join("kit")).unwrap();
        std::fs::write(
            repo.join("kit/SKILL.md"),
            "---\nname: kit\ndescription: Kit skill\n---\n# kit",
        )
        .unwrap();
        std::fs::write(repo.join("kit/notes"), "flat notes v1").unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        let url = format!("file://{}", repo.to_str().unwrap());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();

        write_local(&home, "kit", "notes", "flat notes LOCAL");
        std::fs::remove_file(repo.join("kit/notes")).unwrap();
        std::fs::create_dir_all(repo.join("kit/notes")).unwrap();
        std::fs::write(repo.join("kit/notes/index.md"), "# nested").unwrap();
        commit_all(&repo, "file becomes a directory");
        sync_git_repo(&home, None, &out.collection_id).unwrap();
        let (merge_id, _) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();

        resolve_git_conflict_paths(
            &home,
            None,
            &out.collection_id,
            "kit",
            &merge_id,
            &[("notes".to_string(), Resolution::Remote)],
        )
        .unwrap();
        let kit = crate::scope::canonical_catalog(&home).join("kit");
        assert!(
            kit.join("notes").is_dir(),
            "taking remote accepts the directory"
        );
        assert_eq!(
            std::fs::read_to_string(kit.join("notes/index.md")).unwrap(),
            "# nested"
        );
    }

    #[test]
    fn convergent_edits_and_add_add_divergence_behave_as_a_three_way_merge_should() {
        // the VALUE type moved to FileEntry in #206; the merge algebra is unchanged
        let text = |v: &str| crate::entry::FileEntry::text(v);
        let base: Fileset = [("k".to_string(), text("v0"))].into_iter().collect();
        // both sides made the SAME edit — agreement, not a conflict
        let same: Fileset = [("k".to_string(), text("v1"))].into_iter().collect();
        let (merged, c) = three_way(&base, &same, &same);
        assert!(c.is_empty());
        assert_eq!(merged["k"], "v1");
        // both ADDED the same new path with different content — a conflict, local kept
        let l: Fileset = [("n".to_string(), text("mine"))].into_iter().collect();
        let u: Fileset = [("n".to_string(), text("theirs"))].into_iter().collect();
        let (merged, c) = three_way(&Fileset::new(), &l, &u);
        assert_eq!(c.len(), 1);
        assert_eq!(
            merged["n"], "mine",
            "the user's work is never dropped by the merge itself"
        );
        // local DELETED what upstream edited
        let (merged, c) = three_way(&base, &Fileset::new(), &same);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].local_kind, "missing");
        assert!(!merged.contains_key("k"));
    }

    #[test]
    fn a_deleted_local_file_against_an_upstream_edit_is_a_conflict_with_kind_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        std::fs::remove_file(crate::scope::canonical_catalog(&home).join("kit/scripts/a.sh"))
            .unwrap();
        std::fs::write(repo.join("kit/scripts/a.sh"), "echo a-v2").unwrap();
        commit_all(&repo, "drift");
        assert_eq!(
            sync_git_repo(&home, None, &out.collection_id)
                .unwrap()
                .conflicts,
            vec!["kit"]
        );
        let (_, paths) = conflict_paths(&home, None, &out.collection_id, "kit").unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].path, "scripts/a.sh");
        assert_eq!(paths[0].local_kind, "missing");
        assert_eq!(paths[0].remote_kind, "file");
    }

    #[test]
    fn a_collection_without_a_base_snapshot_degrades_to_whole_skill_conflicts() {
        // 0.1.4 collections predate base snapshots: per-path needs a base, so sync falls back to
        // the old whole-skill conflict and the base self-heals at the next settlement.
        let tmp = tempfile::tempdir().unwrap();
        let (url, repo) = multi_file_fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        // simulate a pre-base collection
        let _ = std::fs::remove_dir_all(
            collections_root(&home)
                .join(&out.collection_id)
                .join("base"),
        );

        write_local(&home, "kit", "scripts/a.sh", "echo a-LOCAL"); // non-overlapping drift…
        std::fs::write(repo.join("kit/scripts/b.sh"), "echo b-v2").unwrap();
        commit_all(&repo, "drift");
        let r = sync_git_repo(&home, None, &out.collection_id).unwrap();
        // …but with no base to 3-way against, it must stay a (whole-skill) conflict, not merge
        assert_eq!(r.conflicts, vec!["kit"]);
    }

    #[test]
    fn resolve_refuses_a_skill_that_is_not_conflicted() {
        // Settling a non-conflict records a cursor for content never materialized, and every
        // later sync then skips it as "already settled" — silently, forever (review, Codex).
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        let e = resolve_git_conflict(&home, None, &out.collection_id, "alpha", Resolution::Local)
            .unwrap_err();
        assert_eq!(e.code(), "RESOURCE_NOT_FOUND");
    }

    #[test]
    fn a_corrupt_state_file_is_refused_not_half_trusted() {
        // A stored subpath re-joins onto the clone at use time; a state file can arrive by copy
        // or hand-edit, so validated-on-save is not enough (review, Codex).
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        let state = collections_root(&home)
            .join(&out.collection_id)
            .join("collection.json");
        let doctored = std::fs::read_to_string(&state)
            .unwrap()
            .replace("\"subpath\": null", "\"subpath\": \"../../escape\"");
        std::fs::write(&state, doctored).unwrap();
        let e = sync_git_repo(&home, None, &out.collection_id).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_GIT");
    }

    #[test]
    fn a_second_operation_on_a_locked_collection_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let (url, _) = fixture(tmp.path());
        let home = tmp.path().join("home");
        let out = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        // simulate an in-flight operation
        let lock = collections_root(&home)
            .join(&out.collection_id)
            .join(".op.lock");
        std::fs::write(&lock, "12345").unwrap();
        let e = sync_git_repo(&home, None, &out.collection_id).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_RECONCILE_INCOMPLETE");
    }

    #[test]
    fn an_oversized_file_in_the_repo_is_refused_before_import() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("upstream");
        std::fs::create_dir_all(repo.join("big")).unwrap();
        std::fs::write(repo.join("big/SKILL.md"), "# big").unwrap();
        std::fs::write(repo.join("big/blob.bin"), vec![b'x'; 1_000_001]).unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        let url = format!("file://{}", repo.to_str().unwrap());
        let home = tmp.path().join("home");
        let e = import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_GIT");
        assert!(e.to_string().contains("bytes"), "{e}");
        assert!(
            !skill_md(&home, "big").exists(),
            "nothing may be materialized"
        );
    }

    #[test]
    fn imported_skills_with_real_frontmatter_are_visible_to_the_reader() {
        // pi hides a skill with no description (`loadSkillFromFile` → null), and the engine's
        // list matches that rule — so the OTHER fixtures in this module, which use bare bodies,
        // are exact-content-friendly but reader-invisible. This one pins the integration that
        // matters to a host: a properly-frontmattered imported skill surfaces through
        // `list_skills` like any other.
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("upstream");
        std::fs::create_dir_all(repo.join("alpha")).unwrap();
        std::fs::write(
            repo.join("alpha/SKILL.md"),
            "---\nname: alpha\ndescription: Alpha skill\n---\n# alpha v1",
        )
        .unwrap();
        git_in(&repo, &["init", "-q"]);
        git_in(&repo, &["config", "user.email", "t@t.t"]);
        git_in(&repo, &["config", "user.name", "t"]);
        commit_all(&repo, "init");
        let url = format!("file://{}", repo.to_str().unwrap());
        let home = tmp.path().join("home");
        import_git_repo(&home, None, Scope::Global, &url, None, None, None).unwrap();
        let listed = store::list_skills(&home, None).unwrap();
        assert!(
            listed
                .iter()
                .any(|s| s.name == "alpha" && s.description == "Alpha skill"),
            "imported skill must be visible to the reader: {listed:?}"
        );
    }

    #[test]
    fn an_option_like_url_never_reaches_git_and_library_scope_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let e = import_git_repo(
            &home,
            None,
            Scope::Global,
            "--upload-pack=evil",
            None,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(e.code(), "RESOURCE_GIT");
        let e2 = import_git_repo(
            &home,
            None,
            Scope::Library,
            "https://x.test/r.git",
            None,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(e2.code(), "RESOURCE_INVALID_PATH");
    }

    #[test]
    fn a_base_snapshot_reads_back_with_the_kind_its_bytes_will_have_on_disk() {
        // Round 43 (review, Codex): `read_base` was a SECOND hand-rolled envelope parser, and it
        // tagged every `bin` entry Binary regardless of its bytes. A base whose entry is Binary
        // while the same bytes on disk read back as Text is a base that never matches local —
        // `three_way` sees phantom local movement and reports the wrong conflict kind. The kind is
        // a function of the BYTES; there is now one parser that decides it.
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        std::fs::create_dir_all(base_dir(state)).unwrap();
        std::fs::write(
            base_dir(state).join("c.json"),
            r##"{"files":{"a/SKILL.md":"# a"},"bin":{"a/nul":"AAAA","a/png":"iVA="}}"##,
        )
        .unwrap();
        let base = read_base(state, "c").expect("readable");
        assert_eq!(base["a/nul"].as_bytes(), &[0u8, 0, 0]);
        assert!(
            base["a/nul"].is_binary(),
            "a NUL is what makes a file binary"
        );
        assert!(base["a/png"].is_binary(), "0x89 0x50 is not UTF-8");
        for (path, e) in &base {
            assert_eq!(
                *e,
                crate::entry::FileEntry::from_bytes(e.as_bytes().to_vec()),
                "kind of {path}"
            );
        }
        // and the strictness that made it a separate parser is kept: no legacy fallback, and any
        // unaccountable byte degrades to NO base (whole-skill conflict), never a partial one.
        std::fs::write(base_dir(state).join("d.json"), "# not an envelope at all").unwrap();
        assert!(read_base(state, "d").is_none());
        std::fs::write(
            base_dir(state).join("e.json"),
            r##"{"files":{},"bin":{"a":"%%%"}}"##,
        )
        .unwrap();
        assert!(read_base(state, "e").is_none());
        std::fs::write(
            base_dir(state).join("f.json"),
            r##"{"files":{"a":"x"},"bin":{"a":"AAAA"}}"##,
        )
        .unwrap();
        assert!(read_base(state, "f").is_none(), "a path in both maps");
        // A `bin` value whose bytes are NOT binary is a malformed envelope (round 43, fix round 2):
        // it is refused, so the base degrades to NONE — a whole-skill conflict the user resolves —
        // rather than becoming an entry whose kind disagrees with the bytes on disk, or one whose
        // declared-binary bytes would be newline-rewritten on the way back out.
        std::fs::write(
            base_dir(state).join("g.json"),
            r##"{"files":{},"bin":{"a":"YQ0KYg=="}}"##,
        )
        .unwrap();
        assert!(read_base(state, "g").is_none(), "text bytes under `bin`");
    }

    #[test]
    fn every_base_the_engine_writes_reads_back_identical() {
        // Round 43, fix round 3 (validator): the base is where the closure defect bit — a fileset
        // `write_base` could write but `read_base` then refused degraded to NO base, i.e. a
        // whole-skill conflict on a skill nobody had touched. The pairing is asserted directly, on
        // the byte shapes that used to divide the producer and the consumer.
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path();
        for (i, bytes) in [
            b"a\r\nb".to_vec(),
            b"QQ".to_vec(),
            b"".to_vec(),
            b"# hi\n".to_vec(),
            vec![0x00, 0x00, 0x00],
            b"a\0b".to_vec(),
            vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF],
            vec![0xFF, 0xFE, 0x0D, 0x0A],
        ]
        .into_iter()
        .enumerate()
        {
            let name = format!("s{i}");
            let files: Fileset = [
                (
                    "SKILL.md".to_string(),
                    crate::entry::FileEntry::text("# s\n"),
                ),
                (
                    "assets/x".to_string(),
                    crate::entry::FileEntry::from_bytes(bytes.clone()),
                ),
            ]
            .into_iter()
            .collect();
            write_base(state, &name, &files).unwrap();
            let back = read_base(state, &name)
                .unwrap_or_else(|| panic!("base for {bytes:?} written but not readable"));
            assert_eq!(back, files, "base round-trip for {bytes:?}");
            assert_eq!(back["assets/x"].as_bytes(), &bytes[..]);
            assert_eq!(fileset_hash(&back), fileset_hash(&files));
        }
    }
}
