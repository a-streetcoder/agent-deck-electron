//! The scope-keyed skill store — the operations agent-deck's `SkillStore` seam needs.
//!
//! One implementation for both consumers (Syncr's Tauri app and agent-deck via NAPI), so the two
//! products cannot drift on what a skill is, where it lives, or which copy wins. Every op is
//! keyed by a **catalog root** (`$HOME` or a project root); the host resolves its own identifier
//! — agent-deck's `projectId` — to that root before calling in. That split is deliberate and is
//! the seam's own contract: the engine has no idea what a "project id" is.
//!
//! Writes go through `materialize::materialize_fileset`, so every one is whole-skill atomic.

use std::path::{Path, PathBuf};

use crate::materialize::materialize_fileset;
use crate::scope::{canonical_catalog, resolve_ordered, CatalogDir, Scope, ScopedSkill};

/// Why a store operation could not be performed. Maps onto agent-deck's
/// `ResourceCatalogCapabilityError` codes (contract spec §4) so its routes keep their HTTP
/// mapping — the engine must not invent a parallel error vocabulary.
#[derive(Debug)]
pub enum StoreError {
    /// `RESOURCE_INVALID_PATH` — the name is empty, absolute, or contains a separator.
    InvalidPath(String),
    /// `RESOURCE_UNSAFE_COMPONENT` — the name would escape the catalog.
    UnsafeComponent(String),
    /// `RESOURCE_NOT_FOUND`
    NotFound(String),
    /// `RESOURCE_ALREADY_EXISTS`
    AlreadyExists(String),
    /// `RESOURCE_INVALID_UTF8` — a PATH in the skill tree is not valid UTF-8, so it cannot be a
    /// fileset key. Since #206 non-UTF-8 CONTENT is fine (it is a binary entry), which leaves
    /// exactly one cause for an operator to look for.
    InvalidUtf8(String),
    /// `RESOURCE_RECONCILE_INCOMPLETE` — a write left the skill in a state needing recovery.
    ReconcileIncomplete(String),
    /// `RESOURCE_GIT` — a git subprocess or validation failure in the collection layer. Its own
    /// code (not RESOURCE_IO) because a bad URL/ref is PERMANENT and a client must not retry it.
    Git(String),
    /// `RESOURCE_STALE` — the state a caller decided on has moved since they read it (per-path
    /// conflict resolution against a refreshed clone). The remedy is re-read, then retry.
    Stale(String),
    Io(std::io::Error),
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl StoreError {
    /// The stable code agent-deck's routes map to a status.
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::InvalidPath(_) => "RESOURCE_INVALID_PATH",
            StoreError::UnsafeComponent(_) => "RESOURCE_UNSAFE_COMPONENT",
            StoreError::NotFound(_) => "RESOURCE_NOT_FOUND",
            StoreError::AlreadyExists(_) => "RESOURCE_ALREADY_EXISTS",
            StoreError::InvalidUtf8(_) => "RESOURCE_INVALID_UTF8",
            StoreError::ReconcileIncomplete(_) => "RESOURCE_RECONCILE_INCOMPLETE",
            StoreError::Git(_) => "RESOURCE_GIT",
            StoreError::Stale(_) => "RESOURCE_STALE",
            // RESOURCE_IO, not RESOURCE_BUSY: BUSY reads as transient and a client retries it.
            // Genuinely transient contention surfaces as ReconcileIncomplete from the swap path.
            StoreError::Io(_) => "RESOURCE_IO",
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::InvalidPath(s) => write!(f, "invalid path: {s}"),
            StoreError::UnsafeComponent(s) => write!(f, "unsafe path component: {s}"),
            StoreError::NotFound(s) => write!(f, "not found: {s}"),
            StoreError::AlreadyExists(s) => write!(f, "already exists: {s}"),
            StoreError::InvalidUtf8(s) => write!(f, "skill tree contains a non-UTF-8 path: {s}"),
            StoreError::ReconcileIncomplete(s) => write!(f, "write left work to reconcile: {s}"),
            StoreError::Git(s) => write!(f, "git: {s}"),
            StoreError::Stale(s) => write!(f, "stale: {s}"),
            StoreError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for StoreError {}

type Result<T> = std::result::Result<T, StoreError>;

/// A skill slug is exactly ONE path segment. Rejected: empty, `.`/`..`, anything containing a
/// separator, a drive/UNC prefix, or a NUL.
///
/// This is the containment boundary for every write. `import.rs` sanitizes untrusted repo trees;
/// this sanitizes untrusted *names* arriving through the API surface — the same class of check at
/// the other ingest point, which is where the equivalent check was missing on Syncr's own web
/// write path (see the fileset-path finding in docs/review-ledger.md).
/// Public because it is the containment boundary for EVERY surface, not just the store's own
/// writes — `fan_out` builds link paths from a caller-supplied slug and had no validation at all.
/// Longest accepted skill name, in BYTES. Derived names (`<slug> (conflicted copy) 999`,
/// `.<slug>.displaced.<pid>.<seq>`) must also fit within a filesystem component, so the
/// budget is the platform's 255 minus the longest suffix this engine appends.
pub const MAX_SLUG_BYTES: usize = 180;
/// The longest name derived from a slug must still be a legal name: 255 is the practical
/// per-component limit on every filesystem we target.
pub const MAX_DERIVED_BYTES: usize = 255;

/// Validate a name the ENGINE derived from an already-valid slug (`<slug> (conflicted copy)`).
/// It is judged against the derived budget: applying the BASE budget to a derived name meant a
/// perfectly legal 163-byte slug produced a 181-byte copy name that this very function then
/// rejected, so a conflict could not preserve the user's work — I reasoned the headroom out
/// correctly and then checked against the wrong limit (review, Codex).
pub fn check_derived_name(name: &str) -> Result<()> {
    check_slug_with_limit(name, MAX_DERIVED_BYTES)
}

pub fn check_slug(slug: &str) -> Result<()> {
    check_slug_with_limit(slug, MAX_SLUG_BYTES)
}

fn check_slug_with_limit(slug: &str, limit: usize) -> Result<()> {
    if slug.is_empty() {
        return Err(StoreError::InvalidPath("empty name".into()));
    }
    if slug == "." || slug == ".." {
        return Err(StoreError::UnsafeComponent(slug.into()));
    }
    if slug.contains('/') || slug.contains('\\') || slug.contains('\0') || slug.contains(':') {
        return Err(StoreError::UnsafeComponent(slug.into()));
    }
    // A leading dot would hide the skill from discovery, which reads direct children and skips
    // dot-dirs — so it would "succeed" and then be invisible.
    if slug.starts_with('.') {
        return Err(StoreError::InvalidPath(format!(
            "{slug} (leading dot is reserved)"
        )));
    }
    // Windows SILENTLY STRIPS trailing dots and spaces, so `deploy.` and `deploy ` both land on
    // disk as `deploy`. That is not a path escape, but it is worse in one way: creating `deploy.`
    // OVERWRITES an existing, differently-named skill — verified. Two API names must never alias
    // one directory.
    if slug.trim_end_matches([' ', '.']) != slug {
        return Err(StoreError::InvalidPath(format!(
            "{slug} (trailing dots/spaces are stripped by the filesystem and would alias another skill)"
        )));
    }
    // Windows reserved device names, with or without an extension and case-insensitively. Creating
    // one appears to succeed and then any tool opening <skill>/CON talks to the console device.
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = slug.split('.').next().unwrap_or(slug).to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(StoreError::InvalidPath(format!(
            "{slug} (reserved device name)"
        )));
    }
    // Characters no Windows filesystem accepts. Rejecting them here means a permanently-invalid
    // name returns RESOURCE_INVALID_PATH rather than surfacing as RESOURCE_BUSY, which a client
    // would treat as transient and retry forever.
    if slug.contains(['<', '>', '"', '|', '?', '*']) || slug.chars().any(|c| (c as u32) < 0x20) {
        return Err(StoreError::InvalidPath(format!(
            "{slug} (illegal character)"
        )));
    }
    // BYTES, not chars — the old message said "chars" and multibyte names hit it far sooner
    // than it read (review, Codex). The budget leaves room for the longest name this engine
    // DERIVES from a slug (`<slug> (conflicted copy) 999`), so a name we accept can never
    // produce a derived name we then reject — which stranded the conflict path mid-write.
    if slug.len() > limit {
        return Err(StoreError::InvalidPath(format!(
            "name too long ({} bytes, max {limit})",
            slug.len()
        )));
    }
    Ok(())
}

/// The effective catalog for a root pair, project shadowing global by parsed name.
///
/// `project_root` is `None` when no project is selected — the global catalog alone.
/// ONE reader. This used to scan only the canonical catalogs while `list_skills_ordered` — the one
/// the NAPI surface actually calls — also scanned the migration-window `.pi` catalogs. Two readers
/// that disagree about which catalogs exist is how a write can be "visible" to one and invisible to
/// the other; it fooled a test written to prove the opposite. Delegating keeps the convenience
/// signature without a second answer to the same question.
pub fn list_skills(home: &Path, project_root: Option<&Path>) -> Result<Vec<ScopedSkill>> {
    list_skills_ordered(&default_catalogs(home, project_root))
}

/// A recoverable tree left behind by an interrupted write.
///
/// Mirrors agent-deck's `ResourceRecovery` so its existing recovery UI keeps working across the
/// binding swap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
    /// Opaque handle the caller passes back to restore or acknowledge.
    pub token: String,
    /// The skill slug the tree belongs to.
    pub slug: String,
    /// Where the retained tree currently sits.
    pub path: PathBuf,
}

/// Recoverable trees under a catalog.
///
/// ADR 0004 originally planned to return `[]` here on the reasoning that atomic writes leave
/// nothing to recover. That reasoning was WRONG per-skill and the decision was reversed: the swap
/// retains a displaced tree, and a crash between the two renames — or a rollback that could not
/// complete — leaves it on disk. Those are exactly what this reports, so the recovery surface is
/// backed by something real rather than being empty by assertion.
pub fn list_recoveries(root: &Path) -> Result<Vec<Recovery>> {
    let catalog = canonical_catalog(root);
    if !catalog.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&catalog)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(n) = name.to_str() else { continue };
        // `.<slug>.displaced.<pid>.<seq>`
        if let Some(rest) = n.strip_prefix('.') {
            if let Some(idx) = rest.find(".displaced.") {
                out.push(Recovery {
                    token: n.to_string(),
                    slug: rest[..idx].to_string(),
                    path: entry.path(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.token.cmp(&b.token));
    Ok(out)
}

/// Restore a retained tree over the current skill. The CURRENT tree is displaced in turn rather
/// than deleted, so a mistaken restore is itself recoverable.
pub fn restore_recovery(root: &Path, token: &str) -> Result<PathBuf> {
    let catalog = canonical_catalog(root);
    let rec = list_recoveries(root)?
        .into_iter()
        .find(|r| r.token == token)
        .ok_or_else(|| StoreError::NotFound(token.into()))?;
    let target = catalog.join(&rec.slug);
    let files = crate::import::read_skill_fileset(&rec.path)
        .map_err(|e| StoreError::InvalidUtf8(format!("{token}: {e}")))?;
    materialize_fileset(&catalog, &rec.slug, &files)?;
    let _ = std::fs::remove_dir_all(&rec.path);
    Ok(target)
}

/// Discard a retained tree. Idempotent — acknowledging an unknown token is not an error, because a
/// client that crashed mid-acknowledge must be able to retry.
///
/// The token is RESOLVED against `list_recoveries`, never joined onto the catalog path. Joining an
/// attacker-supplied token was a recursive delete of anything on the filesystem: `Path::join` with
/// an absolute component DISCARDS the base, so a token of `C:\Users\me` (or `../../..`) deleted
/// that tree instead of a retained one. `restore_recovery` already resolved; this one did not, and
/// the two were written minutes apart — the sibling pattern again (review, verified).
pub fn acknowledge_recovery(root: &Path, token: &str) -> Result<()> {
    let Some(rec) = list_recoveries(root)?
        .into_iter()
        .find(|r| r.token == token)
    else {
        return Ok(()); // unknown token stays idempotent — but now it deletes NOTHING
    };
    match std::fs::remove_dir_all(&rec.path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(StoreError::Io(e)),
    }
}

/// List across an ORDERED set of catalogs (contract §2). The host supplies the full scan order,
/// including the native `.pi` paths that still hold real skills during the migration window and any
/// library/collection roots — so nothing a user owns is invisible through the engine mid-migration.
pub fn list_skills_ordered(catalogs: &[CatalogDir]) -> Result<Vec<ScopedSkill>> {
    Ok(resolve_ordered(catalogs)?)
}

/// THE contract reader (skill-store-contract §2): standard catalogs in scan order, then the host's
/// in-place collection roots, first name winning throughout.
///
/// Collections are handled separately from catalogs on purpose — each one names a SKILL directory,
/// not a directory of skills. Folding them into the catalog list made the engine scan a skill's own
/// `scripts/` and `assets/` subfolders for skills and drop the skill itself.
pub fn list_catalog(
    home: &Path,
    project_root: Option<&Path>,
    collections: &[PathBuf],
) -> Result<Vec<ScopedSkill>> {
    let mut out = list_skills_ordered(&default_catalogs(home, project_root))?;
    let mut seen: std::collections::BTreeSet<String> = out.iter().map(|s| s.name.clone()).collect();
    for dir in collections {
        if let Some(skill) = crate::scope::discover_skill_dir(dir, Scope::Library)? {
            // Same pi rule as the catalogs: no description, no skill. Applying it in
            // `resolve_ordered` alone let collections in through a side door.
            if skill.description.trim().is_empty() {
                continue;
            }
            // a standard catalog shadows a collection — agent-deck's scanner does the same
            if seen.insert(skill.name.clone()) {
                out.push(skill);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// The catalogs agent-deck scans, in contract order, for a given home + optional project.
/// Encoded HERE so the engine and the consumer cannot drift on precedence — the drift this whole
/// consolidation exists to prevent.
pub fn default_catalogs(home: &Path, project_root: Option<&Path>) -> Vec<CatalogDir> {
    let mut v = Vec::new();
    if let Some(p) = project_root {
        v.push(CatalogDir {
            dir: canonical_catalog(p),
            scope: Scope::Project,
        });
        v.push(CatalogDir {
            dir: p.join(".pi").join("skills"),
            scope: Scope::Project,
        });
    }
    // pi's GLOBAL layout is `~/.pi/agent/skills` — asymmetric with the project `<p>/.pi/skills`,
    // which is why a single relative tool-registry entry could never express it.
    v.push(CatalogDir {
        dir: home.join(".pi").join("agent").join("skills"),
        scope: Scope::Global,
    });
    v.push(CatalogDir {
        dir: canonical_catalog(home),
        scope: Scope::Global,
    });
    v
}

/// Apply a PARTIAL edit to a skill, preserving everything the edit does not mention.
///
/// The seam's payload is `{description?, body?}` — both optional. Composing a fresh SKILL.md from
/// them destroyed whatever was omitted: a description-only edit erased the body and the
/// `disable-model-invocation` flag; a body-only edit erased the description. agent-deck's own
/// writer merges, preserving even frontmatter keys it does not understand, and an engine that
/// silently drops a user's metadata on every edit is not a replacement for it.
pub fn apply_edit(
    existing: Option<&str>,
    name: &str,
    description: Option<&str>,
    body: Option<&str>,
) -> String {
    let Some(existing) = existing else {
        return compose_skill_md(name, description, body);
    };
    let detail = crate::agentdeck::skill_md_detail(existing, name);
    let normalized = existing.replace("\r\n", "\n");

    // Split the frontmatter into SPANS, one per top-level key, each owning all of its continuation
    // lines. Rewriting line-by-line treated a block scalar's indented lines as independent entries
    // and an indented `description:` inside a nested map as the top-level one — producing
    // `description: "|-"` with orphaned lines, or a duplicate key at column 0. Both make pi throw,
    // and a skill whose frontmatter throws does not exist (review, reproduced).
    let (fm, had_fm) = match split_frontmatter(&normalized) {
        Some(text) => (text, true),
        None => (String::new(), false),
    };
    let mut spans: Vec<(Option<String>, Vec<String>)> = Vec::new();
    for raw in fm.split('\n') {
        match top_level_key(raw) {
            Some(k) => spans.push((Some(k), vec![raw.to_string()])),
            None => match spans.last_mut() {
                // a continuation line (indented, a `- item`, or a blank) belongs to the key above
                Some(last) => last.1.push(raw.to_string()),
                None => spans.push((None, vec![raw.to_string()])),
            },
        }
    }

    let mut out_lines: Vec<String> = Vec::new();
    let mut seen_name = false;
    let mut seen_description = false;
    for (key, lines) in spans {
        match key.as_deref() {
            Some("name") => {
                seen_name = true;
                out_lines.push(format!("name: {}", yaml_scalar(name)));
            }
            Some("description") => {
                seen_description = true;
                // Replacing the WHOLE span is what collapses a block scalar safely: the value we
                // write is the parsed one, so a `>-` folded description survives a body-only edit
                // instead of becoming the literal string ">-".
                let d = description.unwrap_or(&detail.description);
                if !d.is_empty() {
                    out_lines.push(format!("description: {}", yaml_scalar(d)));
                }
            }
            // every other key, known or not, is carried through byte-for-byte
            _ => out_lines.extend(lines),
        }
    }
    if !seen_name {
        out_lines.insert(0, format!("name: {}", yaml_scalar(name)));
    }
    if !seen_description {
        if let Some(d) = description.filter(|d| !d.is_empty()) {
            out_lines.push(format!("description: {}", yaml_scalar(d)));
        }
    }
    // A file with no frontmatter at all is composed fresh, but its body must be preserved.
    let new_body = body.map(|b| b.to_string()).unwrap_or(detail.body);
    let _ = had_fm;
    while out_lines.last().is_some_and(|l| l.trim().is_empty()) {
        out_lines.pop();
    }
    format!(
        "---\n{}\n---\n{}\n",
        out_lines.join("\n"),
        new_body.trim_start_matches('\n')
    )
}

/// The frontmatter block's inner text, accepting BOTH closing forms a real reader accepts: a
/// `\n---\n` fence and a `\n---` that ends the file. Handling only the first meant a SKILL.md
/// without a trailing newline had no recognised frontmatter, so an edit silently dropped every
/// key — description, license, the flag — and wrote a file with just a regenerated name.
fn split_frontmatter(normalized: &str) -> Option<String> {
    let rest = normalized.strip_prefix("---\n")?;
    if let Some(idx) = rest.find("\n---\n") {
        return Some(rest[..idx].to_string());
    }
    rest.strip_suffix("\n---").map(|s| s.to_string())
}

/// Is this line a TOP-LEVEL `key:` — column 0, not a sequence entry, not a comment?
///
/// Column 0 is the whole point: an indented `description:` belongs to some other key's nested map,
/// and rewriting it at column 0 both changes its meaning and can duplicate a key.
fn top_level_key(line: &str) -> Option<String> {
    if line.is_empty() || line.starts_with([' ', '\t', '-', '#']) {
        return None;
    }
    let idx = line.find(':')?;
    let key = line[..idx].trim();
    if key.is_empty() || key.contains('#') {
        return None;
    }
    Some(key.to_string())
}

/// Compose a SKILL.md from the contract's `{description?, body?}` edit shape.
///
/// The seam passes description and body separately; the engine stores a file. Quoting the
/// description matters: an unquoted `description: a: b` would not round-trip through any YAML
/// reader, and agent-deck/pi parse this with a real one.
pub fn compose_skill_md(name: &str, description: Option<&str>, body: Option<&str>) -> String {
    let mut out = String::from(
        "---
",
    );
    out.push_str(&format!(
        "name: {}
",
        yaml_scalar(name)
    ));
    if let Some(d) = description.filter(|d| !d.is_empty()) {
        out.push_str(&format!(
            "description: {}
",
            yaml_scalar(d)
        ));
    }
    out.push_str(
        "---
",
    );
    if let Some(b) = body {
        out.push_str(b.trim_start_matches('\n'));
        if !b.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

/// Emit a scalar that a REAL YAML reader parses back as exactly this string.
///
/// `format!("{:?}", v)` was not the YAML double-quoted form, and the difference destroyed skills.
/// Rust's Debug escapes anything it considers non-printable as `\u{FE0F}`; YAML's double-quoted
/// escape is `️` — four hex digits, no braces — and `\u{` is an INVALID escape that fails the
/// whole frontmatter block. So a description containing ⚠️ ❤️ ✔️ (or a combining mark, NBSP, ZWJ)
/// that also needed quoting produced a SKILL.md pi refuses to parse: the skill disappears from pi
/// and from agent-deck, with nothing in the engine noticing (review, reproduced against pi).
///
/// It round-tripped in our own tests only because `unquote_scalar` spoke the same wrong dialect.
fn yaml_scalar(v: &str) -> String {
    if needs_quoting(v) {
        let mut out = String::with_capacity(v.len() + 2);
        out.push('"');
        for c in v.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\t' => out.push_str("\\t"),
                '\r' => out.push_str("\\r"),
                '\0' => out.push_str("\\0"),
                // C0/C1 controls and the two YAML-special separators must be escaped; everything
                // else — emoji, accents, CJK, variation selectors — is a legal double-quoted
                // character and goes out as ITSELF. Escaping it was the bug.
                c if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) => {
                    out.push_str(&format!("\\x{:02x}", c as u32));
                }
                '\u{2028}' => out.push_str("\\L"),
                '\u{2029}' => out.push_str("\\P"),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    } else {
        v.to_string()
    }
}

/// Would this scalar change meaning if written bare?
///
/// Covers the syntactic cases AND the IMPLICIT TYPES: a description of `true` written bare comes
/// back from a real YAML reader as a boolean, not the string — and pi then fails its description
/// validation and drops the skill.
fn needs_quoting(v: &str) -> bool {
    if v.is_empty() || v.trim() != v {
        return true;
    }
    if v.contains(": ") || v.contains(" #") || v.contains('\n') || v.contains('\r') {
        return true;
    }
    if v.ends_with(':') {
        return true;
    }
    if v.starts_with([
        '"', '\'', '[', ']', '{', '}', '&', '*', '!', '|', '>', '%', '@', '`', '-', '?', '#', ',',
        ':',
    ]) {
        return true;
    }
    if v.chars()
        .any(|c| (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)))
    {
        return true;
    }
    // Implicit non-string types (YAML 1.2 core schema, plus the 1.1 booleans a reader may still
    // fold). Cheaper and safer to quote than to reason about which reader is in play.
    let lower = v.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "true" | "false" | "null" | "~" | "yes" | "no" | "on" | "off" | "y" | "n"
    ) {
        return true;
    }
    if v.parse::<f64>().is_ok() || v.parse::<i64>().is_ok() {
        return true;
    }
    false
}

/// Which catalog does this skill ALREADY live in?
///
/// Writes must land where the reader will look, and the reader scans the migration-window `.pi`
/// catalogs BEFORE the canonical one. Resolving writes to the canonical catalog unconditionally
/// meant that editing any pre-existing user skill wrote a second copy to `.agents` while the
/// reader kept returning the `.pi` original — the edit invisible forever, the skill duplicated on
/// disk, delete a silent no-op and rename a NOT_FOUND (review, verified).
///
/// Making the `.pi` catalogs readable REMOVED THE SYMPTOM of the pending migration while leaving
/// writes pointed elsewhere, which is worse than leaving them invisible. So: find the skill first,
/// write where it is; only a genuinely new skill goes to the canonical catalog.
/// Returns the skill's actual DIRECTORY, not its catalog.
///
/// Returning the catalog and letting callers do `catalog.join(name)` was wrong twice over, because
/// a skill's folder name and its declared identity are independent: `skills/folder/SKILL.md`
/// declaring `name: public` lives at `folder`, and a nested skill lives at `team/deploy`. Both
/// would have been "found" and then written to `skills/public` / `skills/deploy` — a duplicate,
/// with delete a no-op and rename NOT_FOUND all over again, which is the very defect this function
/// was added to fix.
///
/// FAILS CLOSED on an unreadable catalog. `if let Ok(..)` made an I/O error indistinguishable from
/// "not here", so a momentarily unreadable higher-precedence catalog sent the write to a fresh
/// canonical copy that the reader would never return once permissions recovered.
pub fn dir_of_existing(catalogs: &[CatalogDir], name: &str) -> Result<Option<PathBuf>> {
    let mut invisible: Option<PathBuf> = None;
    for c in catalogs {
        for s in crate::scope::discover_dir(&c.dir, c.scope)? {
            if s.name != name && s.slug != name {
                continue;
            }
            // Target the copy the READER would actually return. Discovery is deliberately total
            // (so a description-less skill can still be repaired) while the reader drops
            // description-less skills — so a higher-ranked invisible copy would otherwise capture
            // every write, and a body-only edit, which adds no description, could never become
            // visible. It would be lost forever, and so would each one after it.
            if !s.description.trim().is_empty() {
                return Ok(Some(s.path));
            }
            if invisible.is_none() {
                invisible = Some(s.path);
            }
        }
    }
    Ok(invisible)
}

/// The catalogs a write in `scope` may touch — and ONLY those.
///
/// A write must never leave its scope. Searching every catalog for the name meant a project-scoped
/// create landed on the user's GLOBAL skill of that name and overwrote it, a project-scoped delete
/// deleted the global one, and a project-scoped rename renamed it. agent-deck's native store
/// resolves `skillDirPath(roots, scope, name)` and touches that catalog alone, so this was a
/// regression against the store being replaced, not just an engine quirk (review, verified).
///
/// Within a scope the `.pi` catalog is still included, because that is where the user's existing
/// skills actually live during the migration window — that part was right.
pub fn scope_catalogs(home: &Path, project_root: Option<&Path>, scope: Scope) -> Vec<CatalogDir> {
    match scope {
        Scope::Project => project_root
            .map(|p| {
                vec![
                    CatalogDir {
                        dir: canonical_catalog(p),
                        scope: Scope::Project,
                    },
                    CatalogDir {
                        dir: p.join(".pi").join("skills"),
                        scope: Scope::Project,
                    },
                ]
            })
            .unwrap_or_default(),
        Scope::Global => vec![
            CatalogDir {
                dir: home.join(".pi").join("agent").join("skills"),
                scope: Scope::Global,
            },
            CatalogDir {
                dir: canonical_catalog(home),
                scope: Scope::Global,
            },
        ],
        // Collections are read-only; there is no catalog to write into.
        Scope::Library => Vec::new(),
    }
}

/// The DIRECTORY a write should target: the skill's existing home WITHIN THE REQUESTED SCOPE, else
/// a new directory in that scope's canonical catalog.
pub fn write_target(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    name: &str,
) -> Result<PathBuf> {
    // Public, and it JOINS: a host composing `write_target(.., "../victim")` with
    // `write_skill_at` got a path outside the catalog whose final component then validated
    // fine (review, Codex). Validate where the name enters, not only where it lands.
    check_slug(name)?;
    let catalogs = scope_catalogs(home, project_root, scope);
    if let Some(dir) = dir_of_existing(&catalogs, name)? {
        return Ok(dir);
    }
    let root = match scope {
        Scope::Project => project_root.ok_or_else(|| {
            StoreError::InvalidPath("project scope requires a project root".into())
        })?,
        Scope::Global => home,
        Scope::Library => {
            return Err(StoreError::InvalidPath(
                "library scope is not writable".into(),
            ))
        }
    };
    Ok(canonical_catalog(root).join(name))
}

/// Create or replace a skill's SKILL.md under `root`'s canonical catalog. Returns its directory.
///
/// Replacement preserves the skill's OTHER files: the fileset is read back, `SKILL.md` swapped,
/// and the whole tree re-materialized. Writing only SKILL.md through the atomic swap would
/// otherwise delete every sibling file, because the swap replaces the directory wholesale — the
/// one place where whole-skill atomicity is a hazard rather than a safeguard, and worth stating
/// because it is not obvious from the call.
pub fn write_skill(root: &Path, slug: &str, skill_md: &str) -> Result<PathBuf> {
    write_skill_in(&canonical_catalog(root), slug, skill_md)
}

/// Write into an EXPLICIT catalog — used when the skill already lives somewhere other than the
/// canonical one (see `write_target`), so an edit lands where the reader looks.
pub fn write_skill_in(catalog: &Path, slug: &str, skill_md: &str) -> Result<PathBuf> {
    check_slug(slug)?;
    write_skill_at(&catalog.join(slug), skill_md)
}

/// Write into an EXACT skill directory, wherever it sits — including nested (`team/deploy`) and
/// folders whose name differs from the skill's declared identity.
pub fn write_skill_at(dir: &Path, skill_md: &str) -> Result<PathBuf> {
    let catalog = dir
        .parent()
        .ok_or_else(|| StoreError::InvalidPath(format!("{} has no parent", dir.display())))?
        .to_path_buf();
    let slug = dir
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| StoreError::InvalidPath(format!("{} has no name", dir.display())))?;
    check_slug(slug)?;
    let dir = dir.to_path_buf();
    // FAIL CLOSED on an unreadable existing tree. `unwrap_or_default()` here turned "I could not
    // read the current files" into "there are none", and since the swap replaces the directory
    // wholesale, editing SKILL.md then DELETED every other file. The fileset now CARRIES BYTES
    // (#206), so an icon.png is read like any other file and survives the swap; what remains a
    // refusal is a tree that genuinely cannot be read (a non-UTF-8 path, a symlink, a fifo).
    // ONE mapping for import errors — repos::import_err — so a fifo/socket is reported under
    // RESOURCE_UNSAFE_COMPONENT and only a non-UTF-8 path under RESOURCE_INVALID_UTF8. This site
    // used to collapse every cause into InvalidUtf8 (independent verification, round 43).
    let mut files: crate::entry::Fileset = if dir.is_dir() {
        crate::import::read_skill_fileset(&dir).map_err(|e| {
            let suffix = " — refusing to rewrite, it would drop unreadable files";
            match crate::repos::import_err(e) {
                StoreError::UnsafeComponent(m) => {
                    StoreError::UnsafeComponent(format!("{slug}: {m}{suffix}"))
                }
                StoreError::InvalidUtf8(m) => {
                    StoreError::InvalidUtf8(format!("{slug}: {m}{suffix}"))
                }
                other => other,
            }
        })?
    } else {
        crate::entry::Fileset::new()
    };
    // Normalize at THIS ingest point too. The host hands us whatever its editor produced, and on
    // Windows that is CRLF — which would hash differently from the identical skill saved on macOS.
    files.insert(
        "SKILL.md".to_string(),
        crate::entry::FileEntry::text(crate::normalize_newlines(skill_md)),
    );
    Ok(materialize_fileset(&catalog, slug, &files)?)
}

/// Delete a skill directory from `root`'s canonical catalog. Absent is NOT an error — delete is
/// idempotent, which is what a reconciling caller needs.
pub fn delete_skill(root: &Path, slug: &str) -> Result<()> {
    delete_skill_in(&canonical_catalog(root), slug)
}

/// Delete from an EXPLICIT catalog. Note idempotency makes "wrong catalog" indistinguishable from
/// "already gone", which is exactly how deleting a `.pi` skill silently succeeded while leaving the
/// file on disk (review) — so the caller must resolve the real catalog first.
pub fn delete_skill_in(catalog: &Path, slug: &str) -> Result<()> {
    check_slug(slug)?;
    let dir = catalog.join(slug);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(StoreError::Io(e)),
    }
}

/// Rename a skill directory. Returns the new directory.
///
/// Refuses to overwrite an existing target: a rename that silently replaced another skill would
/// destroy content the caller never named.
pub fn rename_skill(root: &Path, slug: &str, new_slug: &str) -> Result<PathBuf> {
    rename_skill_in(&canonical_catalog(root), slug, new_slug)
}

/// Rename within an EXPLICIT catalog.
pub fn rename_skill_in(catalog: &Path, slug: &str, new_slug: &str) -> Result<PathBuf> {
    check_slug(slug)?;
    check_slug(new_slug)?;
    let catalog = catalog.to_path_buf();
    let from = catalog.join(slug);
    let to = catalog.join(new_slug);
    // Renaming to the same name is a NO-OP, not a conflict — agent-deck treats it that way, and
    // reporting ALREADY_EXISTS for it would make an idempotent caller fail.
    if slug == new_slug {
        return if from.is_dir() {
            Ok(from)
        } else {
            Err(StoreError::NotFound(slug.into()))
        };
    }
    if !from.is_dir() {
        return Err(StoreError::NotFound(slug.into()));
    }
    if to.exists() {
        return Err(StoreError::AlreadyExists(new_slug.into()));
    }
    std::fs::rename(&from, &to)?;
    // The frontmatter `name` is the IDENTITY precedence dedups on, so a rename that left it stale
    // would list the skill under its OLD name — the rename would appear not to have happened.
    // Only rewrite when the old name tracked the folder; a deliberately different name is the
    // author's and is left alone.
    let md_path = to.join("SKILL.md");
    if let Ok(md) = std::fs::read_to_string(&md_path) {
        let detail = crate::agentdeck::skill_md_detail(&md, slug);
        if detail.name == slug {
            // Rewrite the frontmatter `name` key ONLY. `replacen("name: <slug>", …, 1)` hit the
            // first match ANYWHERE, so a body mentioning the skill was silently edited — and when
            // the frontmatter name differed from the folder name it matched nothing at all, leaving
            // the dedup identity pointing at the old name after a "successful" rename (review).
            let updated = apply_edit(Some(&md), new_slug, None, None);
            if updated != md {
                // NOT `let _ =`. If the directory moved but the identity write failed (a read-only
                // SKILL.md is enough), the rename is HALF applied: pi keeps calling the skill by its
                // old name, and reporting Ok told the caller otherwise.
                std::fs::write(&md_path, updated)?;
            }
        }
    }
    Ok(to)
}

/// Import a single local `.md` file as a NEW skill.
///
/// The name comes from the file's own frontmatter, falling back to the file stem. Deriving it from
/// the stem alone made `~/Downloads/skill (1).md` a skill called `skill (1)` while every reader
/// showed the frontmatter name — two identities for one skill, and precedence dedup keyed on the
/// one the importer never used.
///
/// Refuses an existing name. Import is a CREATE; silently overwriting a skill the user already had
/// because a downloaded file happened to share its name is data loss, not an import.
pub fn import_local_skill(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    source: &Path,
) -> Result<PathBuf> {
    // A skill is its TREE (SKL-06): a directory — or a path to its exactly-named SKILL.md —
    // imports the full fileset; only a LONE markdown file imports as a single-file skill.
    // Exact-name match on purpose: a lowercase `skill.md` keeps its PRIOR single-file behavior
    // (review, Codex — the dir form would fail its own `SKILL.md` lookup on that input).
    let dir_source = if source.is_dir() {
        Some(source.to_path_buf())
    } else if source.file_name().and_then(|f| f.to_str()) == Some("SKILL.md") {
        // a bare relative `SKILL.md` has an empty parent — that means the current directory
        source.parent().map(|p| {
            if p.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                p.to_path_buf()
            }
        })
    } else {
        None
    };
    if let Some(dir) = dir_source {
        // the same guard + metadata-first bounds the folder/git imports get — a single skill dir
        // can be a multi-GB tree just as easily (review, Codex)
        let dir = guard_local_root(home, &dir)?;
        crate::repos::check_repo_bounds(&dir)?;
        let files = crate::import::read_skill_fileset(&dir).map_err(local_import_err)?;
        let Some(entry) = files.get("SKILL.md") else {
            return Err(StoreError::InvalidPath(format!(
                "{}: no SKILL.md in that folder",
                dir.display()
            )));
        };
        // frontmatter is text by definition — a binary SKILL.md is refused, never stringified
        let Some(content) = entry.as_text() else {
            return Err(StoreError::InvalidPath(format!(
                "{}: SKILL.md is not text",
                dir.display()
            )));
        };
        let stem = dir.file_name().and_then(|s| s.to_str()).unwrap_or_default();
        let detail = crate::agentdeck::skill_md_detail(content, stem);
        check_slug(&detail.name)?;
        refuse_ghost(&detail)?;
        refuse_clobber(home, project_root, scope, &detail.name)?;
        let target = write_target(home, project_root, scope, &detail.name)?;
        let catalog = target
            .parent()
            .ok_or_else(|| StoreError::InvalidPath(detail.name.clone()))?
            .to_path_buf();
        claim_new_dir(&target)?;
        if let Err(e) = crate::materialize::materialize_fileset(&catalog, &detail.name, &files) {
            let _ = std::fs::remove_dir_all(&target);
            return Err(e.into());
        }
        return Ok(target);
    }
    // The engine owns the file-type gate (it used to live NAPI-side): text under a stem name is
    // not a skill import, it's an accident.
    if source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        != Some("md".into())
    {
        return Err(StoreError::InvalidPath(format!(
            "{}: not a .md file or a skill folder",
            source.display()
        )));
    }
    let content = std::fs::read_to_string(source)?;
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let detail = crate::agentdeck::skill_md_detail(&content, stem);
    check_slug(&detail.name)?;
    refuse_ghost(&detail)?;
    refuse_clobber(home, project_root, scope, &detail.name)?;
    let dir = write_target(home, project_root, scope, &detail.name)?;
    write_skill_at(&dir, &content)
}

/// A skill with no description is invisible to pi, so importing one reports success for
/// something that can never appear in listSkills. Refuse it instead of creating a ghost.
fn refuse_ghost(detail: &crate::agentdeck::SkillDetail) -> Result<()> {
    if detail.description.trim().is_empty() {
        return Err(StoreError::InvalidPath(format!(
            "{}: a skill needs a description or no agent will load it",
            detail.name
        )));
    }
    Ok(())
}

/// The clobber check must look wherever the READER looks — every catalog in scope, at any depth,
/// matching on declared name as well as folder. Checking one directory meant importing over a
/// nested skill, a `.pi` skill, or a folder whose declared name differs all "succeeded" while
/// shadowing the user's real skill with a duplicate.
fn refuse_clobber(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    name: &str,
) -> Result<()> {
    let catalogs = scope_catalogs(home, project_root, scope);
    if let Some(existing) = dir_of_existing(&catalogs, name)? {
        return Err(StoreError::AlreadyExists(format!(
            "{} (already at {})",
            name,
            existing.display()
        )));
    }
    Ok(())
}

fn local_import_err(e: crate::import::ImportError) -> StoreError {
    StoreError::InvalidPath(e.to_string())
}

/// Refuse a local-import root that overlaps `<home>/.agents` in either direction: importing the
/// catalog into the catalog self-copies (or recurses), and a user CAN pick exactly that folder in
/// a file dialog. Returns the CANONICAL root — callers must read through it, not the raw path, so
/// a junction retargeted after the check cannot redirect the walk (review, Codex). BOTH sides are
/// canonicalized (a `.agents` that is itself a junction must still match), and an existing-but-
/// unresolvable catalog fails CLOSED. A `.agents` that does not exist yet cannot contain anything
/// and discovery snapshots before any write, so that case is allowed.
fn guard_local_root(home: &Path, root: &Path) -> Result<PathBuf> {
    if !root.is_dir() {
        return Err(StoreError::InvalidPath(format!(
            "{}: not a folder",
            root.display()
        )));
    }
    let canonical_root = std::fs::canonicalize(root).map_err(StoreError::Io)?;
    let agents_lex = home.join(".agents");
    if agents_lex.exists() {
        let agents = std::fs::canonicalize(&agents_lex).map_err(StoreError::Io)?; // fail closed
        if canonical_root.starts_with(&agents) || agents.starts_with(&canonical_root) {
            return Err(StoreError::InvalidPath(format!(
                "{}: that folder overlaps the skill catalog itself",
                root.display()
            )));
        }
    }
    Ok(canonical_root)
}

/// Claim a target directory EXCLUSIVELY before materializing into it: `create_dir` losing the
/// race means someone else owns that name — refuse instead of replacing it, and cleanup may only
/// ever delete directories this import claimed (review, Codex).
pub(crate) fn claim_new_dir(target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?; // the catalog itself may not exist on a fresh home
    }
    match std::fs::create_dir(target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(StoreError::AlreadyExists(
            format!("{} (created concurrently)", target.display()),
        )),
        Err(e) => Err(StoreError::Io(e)),
    }
}

/// Preview a LOCAL folder of skills (SKL-05): the git-import discovery run on a plain path —
/// bounds-checked, materializing nothing. `home` is only for the self-import guard (a folder
/// inside `<home>/.agents` must refuse). Unlike a clone, a TOP-LEVEL symlinked skill is followed
/// and reported with its `link_target` (fan-out writes `~/.claude/skills/<name>` as exactly such
/// a link); symlinks inside any skill tree are still refused.
pub fn inspect_local_folder(home: &Path, root: &Path) -> Result<Vec<crate::repos::SkillPreview>> {
    let root = guard_local_root(home, root)?;
    let skills = crate::repos::upstream_local_skills(&root)?;
    Ok(skills
        .iter()
        .map(|(name, s)| crate::repos::SkillPreview {
            name: name.clone(),
            file_count: s.files.len() as u32,
            skill_md: s
                .files
                .get("SKILL.md")
                .and_then(|c| c.as_text())
                .map(crate::repos::cap_preview_md),
            link_target: s
                .link_target
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
        })
        .collect())
}

/// Import skills from a LOCAL folder (SKL-05): git-import semantics without the git — discover,
/// optionally filter by `selected`, collision-check everything first, then materialize each
/// chosen skill's FULL fileset. One-shot copy: no collection state, nothing to sync later.
pub fn import_local_folder(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    root: &Path,
    selected: Option<&[String]>,
) -> Result<Vec<String>> {
    let root = guard_local_root(home, root)?;
    let sel_set: Option<std::collections::BTreeSet<&str>> = match selected {
        None => None,
        Some(sel) => {
            if sel.is_empty() {
                return Err(StoreError::InvalidPath("empty skill selection".into()));
            }
            for name in sel {
                check_slug(name)?;
            }
            Some(sel.iter().map(String::as_str).collect())
        }
    };
    let upstream: std::collections::BTreeMap<String, crate::entry::Fileset> =
        crate::repos::upstream_local_skills(&root)?
            .into_iter()
            .map(|(name, s)| (name, s.files))
            .collect();
    if upstream.is_empty() {
        return Err(StoreError::InvalidPath(format!(
            "{}: no skills with a SKILL.md were found",
            root.display()
        )));
    }
    if let Some(sel) = &sel_set {
        let missing: Vec<&str> = sel
            .iter()
            .filter(|n| !upstream.contains_key(**n))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(StoreError::NotFound(format!(
                "skills not found in the folder: {}",
                missing.join(", ")
            )));
        }
    }
    let chosen: Vec<(&String, &crate::entry::Fileset)> = upstream
        .iter()
        .filter(|(name, _)| {
            sel_set
                .as_ref()
                .is_none_or(|sel| sel.contains(name.as_str()))
        })
        .collect();
    // collisions first, writes after — all-or-nothing
    for (name, _) in &chosen {
        refuse_clobber(home, project_root, scope, name)?;
    }
    let mut written: Vec<PathBuf> = Vec::new();
    let result = (|| -> Result<Vec<String>> {
        let mut names = Vec::new();
        for (name, files) in &chosen {
            let target = write_target(home, project_root, scope, name)?;
            let catalog = target
                .parent()
                .ok_or_else(|| StoreError::InvalidPath((*name).clone()))?
                .to_path_buf();
            // exclusive claim: a raced-in skill refuses instead of being replaced, and cleanup
            // below may only delete directories THIS import created (review, Codex)
            claim_new_dir(&target)?;
            written.push(target);
            crate::materialize::materialize_fileset(&catalog, name, files)?;
            names.push((*name).clone());
        }
        Ok(names)
    })();
    if result.is_err() {
        // each dir in `written` was claimed by create_dir above — provably ours to delete
        for dir in written {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    result
}

/// Create or edit a skill, resolving WHERE it lives first (C1) and merging a partial edit (C3).
///
/// This is the chokepoint the hosts call: resolve-then-write in one function, so no caller can
/// remember the write and forget the resolve. `prefer` is the root a NEW skill goes to (the scope
/// the caller picked); an EXISTING skill is edited in whichever catalog already holds it.
pub fn edit_skill(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    name: &str,
    description: Option<&str>,
    body: Option<&str>,
) -> Result<PathBuf> {
    check_slug(name)?;
    let dir = write_target(home, project_root, scope, name)?;
    let existing = std::fs::read_to_string(dir.join("SKILL.md")).ok();
    // Keep the DECLARED name. An edit addressed by folder name — legal, since lookup matches either
    // — would otherwise rewrite `name: public` to `name: folder`, silently renaming the skill as a
    // side effect of changing its description.
    let declared = existing
        .as_deref()
        .map(|md| crate::agentdeck::skill_md_frontmatter(md, name).name)
        .unwrap_or_else(|| name.to_string());
    let md = apply_edit(existing.as_deref(), &declared, description, body);
    write_skill_at(&dir, &md)
}

/// Delete a skill from wherever it actually lives.
pub fn remove_skill(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    name: &str,
) -> Result<()> {
    // Scoped: a project-scoped delete must never reach the user's global skill of the same name.
    let catalogs = scope_catalogs(home, project_root, scope);
    // Only delete a skill we actually located. Absent stays idempotent (parity with agent-deck's
    // `secureRemove(force = true)`), but we must not compute a speculative path and delete THAT.
    match dir_of_existing(&catalogs, name)? {
        None => Ok(()),
        Some(dir) => match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError::Io(e)),
        },
    }
}

/// Rename a skill in place — inside its own parent directory, wherever that is.
pub fn move_skill(
    home: &Path,
    project_root: Option<&Path>,
    scope: Scope,
    name: &str,
    new_name: &str,
) -> Result<PathBuf> {
    let catalogs = scope_catalogs(home, project_root, scope);
    let dir = dir_of_existing(&catalogs, name)?.ok_or_else(|| StoreError::NotFound(name.into()))?;
    let parent = dir
        .parent()
        .ok_or_else(|| StoreError::InvalidPath(format!("{} has no parent", dir.display())))?;
    rename_skill_in(
        parent,
        dir.file_name().and_then(|s| s.to_str()).unwrap_or(name),
        new_name,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn seed(root: &Path, slug: &str, md: &str) -> PathBuf {
        let d = canonical_catalog(root).join(slug);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("SKILL.md"), md).unwrap();
        d
    }

    #[test]
    fn write_then_list_round_trips_through_the_canonical_catalog() {
        let home = tempfile::tempdir().unwrap();
        write_skill(
            home.path(),
            "deploy",
            "---\nname: Deploy\ndescription: Ship\n---\n# body",
        )
        .unwrap();
        let out = list_skills(home.path(), None).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Deploy");
        assert_eq!(out[0].description, "Ship");
        assert_eq!(out[0].scope, Scope::Global);
    }

    // The atomic swap replaces the whole directory, so a naive "write just SKILL.md" would delete
    // every sibling file. This is the one place whole-skill atomicity can destroy data.
    #[test]
    fn rewriting_skill_md_preserves_the_skills_other_files() {
        let home = tempfile::tempdir().unwrap();
        let dir = seed(
            home.path(),
            "deploy",
            "---\nname: Deploy\ndescription: d\n---\n# v1",
        );
        fs::create_dir_all(dir.join("scripts")).unwrap();
        fs::write(dir.join("scripts/run.sh"), "echo hi").unwrap();

        write_skill(
            home.path(),
            "deploy",
            "---\nname: Deploy\ndescription: d\n---\n# v2",
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "---\nname: Deploy\ndescription: d\n---\n# v2"
        );
        assert_eq!(
            fs::read_to_string(dir.join("scripts/run.sh")).unwrap(),
            "echo hi",
            "sibling files must survive a SKILL.md rewrite"
        );
    }

    #[test]
    fn a_project_skill_shadows_a_global_one_through_the_store() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        write_skill(
            home.path(),
            "deploy",
            "---\nname: deploy\ndescription: d\n---\n# global",
        )
        .unwrap();
        write_skill(
            proj.path(),
            "deploy",
            "---\nname: deploy\ndescription: d\n---\n# project",
        )
        .unwrap();
        let out = list_skills(home.path(), Some(proj.path())).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].scope, Scope::Project);
        assert_eq!(out[0].body, "# project");
    }

    #[test]
    fn slugs_that_would_escape_the_catalog_are_refused() {
        let home = tempfile::tempdir().unwrap();
        for bad in ["..", ".", "a/b", "a\\b", "", "../evil", ".hidden", "C:evil"] {
            let e = write_skill(home.path(), bad, "x").unwrap_err();
            assert!(
                matches!(
                    e,
                    StoreError::InvalidPath(_) | StoreError::UnsafeComponent(_)
                ),
                "{bad} must be refused, got {e:?}"
            );
        }
        // nothing was created anywhere
        assert!(list_skills(home.path(), None).unwrap().is_empty());
    }

    // #206 INVERTED THIS TEST'S MECHANISM, NOT ITS GUARANTEE. Reviewers proved the original
    // code destroyed data: read_skill_fileset errored on the FIRST non-UTF-8 file,
    // unwrap_or_default() turned that into "no existing files", and the whole-directory swap
    // installed a tree containing only SKILL.md. The fix at the time was to REFUSE the rewrite —
    // "the only correct answer until the fileset carries bytes". The fileset now carries bytes,
    // so the refusal is gone and the guarantee is met directly: every sibling, binary included,
    // survives a SKILL.md rewrite byte-identically.
    /// #206 committer pass (independent verifier's OPEN item): `write_skill_at` mapped EVERY
    /// read error of the existing tree to RESOURCE_INVALID_UTF8, so a fifo/socket next to SKILL.md
    /// was reported as "non-UTF-8 path" — the same two-causes-one-message collapse this slice fixed
    /// for RESOURCE_UNSAFE_COMPONENT in repos.rs. The refusal itself is right; the CODE must name
    /// the real cause so a host can say what to remove.
    #[cfg(unix)]
    #[test]
    #[allow(non_snake_case)] // the capitals are the point of the name
    fn a_non_regular_sibling_refuses_the_rewrite_with_the_UNSAFE_code_not_the_utf8_one() {
        let home = tempfile::tempdir().unwrap();
        let dir = seed(
            home.path(),
            "deploy",
            "---
name: Deploy
description: d
---
# v1",
        );
        // a unix socket is a non-regular entry the engine must refuse to read as skill content
        let _sock = std::os::unix::net::UnixListener::bind(dir.join("agent.sock")).unwrap();
        let err = write_skill(
            home.path(),
            "deploy",
            "---
name: Deploy
description: d
---
# v2",
        )
        .expect_err("a socket in the tree must refuse the rewrite");
        assert_eq!(err.code(), "RESOURCE_UNSAFE_COMPONENT", "{err}");
        assert!(err.to_string().contains("non-regular entry"), "{err}");
        assert!(
            fs::read_to_string(dir.join("SKILL.md"))
                .unwrap()
                .contains("# v1"),
            "a refused rewrite leaves the tree untouched"
        );
    }

    #[test]
    #[allow(non_snake_case)] // the capitals are the point of the name
    fn a_binary_sibling_SURVIVES_a_rewrite_rather_than_blocking_or_being_deleted() {
        let home = tempfile::tempdir().unwrap();
        let dir = seed(
            home.path(),
            "deploy",
            "---
name: Deploy
description: d
---
# v1",
        );
        let png = [
            0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE,
        ];
        fs::create_dir_all(dir.join("references")).unwrap();
        fs::write(dir.join("references/logo.png"), png).unwrap();
        fs::write(dir.join("scripts.sh"), "echo hi").unwrap();

        write_skill(
            home.path(),
            "deploy",
            "---
name: Deploy
description: d
---
# v2",
        )
        .expect("a binary sibling must no longer block the rewrite");

        assert_eq!(
            fs::read(dir.join("references/logo.png")).unwrap(),
            png,
            "binary sibling must survive byte-identically"
        );
        assert_eq!(
            fs::read_to_string(dir.join("scripts.sh")).unwrap(),
            "echo hi"
        );
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "---
name: Deploy
description: d
---
# v2"
        );
    }

    // Windows strips trailing dots/spaces, so `deploy.` lands on disk as `deploy` — creating one
    // OVERWRITES a different, existing skill. Two API names must never alias one directory.
    #[test]
    fn names_that_alias_an_existing_skill_on_windows_are_refused() {
        let home = tempfile::tempdir().unwrap();
        write_skill(
            home.path(),
            "deploy",
            "---
name: deploy
description: d
---
# original",
        )
        .unwrap();
        for alias in ["deploy.", "deploy ", "deploy.."] {
            let e = write_skill(
                home.path(),
                alias,
                "---
name: x
description: d
---
# overwritten",
            )
            .unwrap_err();
            assert_eq!(e.code(), "RESOURCE_INVALID_PATH", "{alias} must be refused");
        }
        let out = list_skills(home.path(), None).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].body, "# original",
            "the existing skill must be untouched"
        );
    }

    #[test]
    fn windows_reserved_device_names_are_refused() {
        let home = tempfile::tempdir().unwrap();
        for bad in ["CON", "con", "nul", "COM1", "lpt9", "con.md", "PRN.txt"] {
            let e = write_skill(home.path(), bad, "x").unwrap_err();
            assert_eq!(e.code(), "RESOURCE_INVALID_PATH", "{bad} must be refused");
        }
    }

    // A permanently-invalid name must not look transient: RESOURCE_BUSY makes a client retry forever.
    #[test]
    fn illegal_names_report_invalid_path_not_a_retryable_busy() {
        let home = tempfile::tempdir().unwrap();
        for bad in ["a<b", "a|b", "a?b", "a*b", "a\"b"] {
            assert_eq!(
                write_skill(home.path(), bad, "x").unwrap_err().code(),
                "RESOURCE_INVALID_PATH"
            );
        }
        assert_eq!(
            write_skill(home.path(), &"x".repeat(300), "x")
                .unwrap_err()
                .code(),
            "RESOURCE_INVALID_PATH"
        );
    }

    #[test]
    fn delete_is_idempotent_and_rename_refuses_to_clobber() {
        let home = tempfile::tempdir().unwrap();
        write_skill(home.path(), "a", "---\nname: a\ndescription: d\n---\n#").unwrap();
        write_skill(home.path(), "b", "---\nname: b\ndescription: d\n---\n#").unwrap();

        assert!(matches!(
            rename_skill(home.path(), "a", "b").unwrap_err(),
            StoreError::AlreadyExists(_)
        ));
        rename_skill(home.path(), "a", "c").unwrap();
        assert!(matches!(
            rename_skill(home.path(), "a", "d").unwrap_err(),
            StoreError::NotFound(_)
        ));

        delete_skill(home.path(), "c").unwrap();
        delete_skill(home.path(), "c").unwrap(); // absent is not an error
        assert_eq!(list_skills(home.path(), None).unwrap().len(), 1);
    }

    // Contract §2: the FULL scan order, including the native .pi catalogs that still hold real
    // user skills during the migration window. Without these a user's existing skills are simply
    // invisible through the engine on the day of the swap.
    #[test]
    fn the_migration_window_pi_catalogs_are_visible_and_correctly_ranked() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let mk = |dir: std::path::PathBuf, slug: &str, name: &str, body: &str| {
            let d = dir.join(slug);
            fs::create_dir_all(&d).unwrap();
            fs::write(
                d.join("SKILL.md"),
                format!(
                    "---
name: {name}
description: d
---
{body}"
                ),
            )
            .unwrap();
        };
        // same declared name in all four catalogs; project canonical must win
        mk(
            canonical_catalog(proj.path()),
            "a",
            "dup",
            "# project-canonical",
        );
        mk(
            proj.path().join(".pi").join("skills"),
            "b",
            "dup",
            "# project-pi",
        );
        mk(
            home.path().join(".pi").join("agent").join("skills"),
            "c",
            "dup",
            "# global-pi",
        );
        mk(
            canonical_catalog(home.path()),
            "d",
            "dup",
            "# global-canonical",
        );
        // and a skill that ONLY exists in the native global catalog must still be listed
        mk(
            home.path().join(".pi").join("agent").join("skills"),
            "solo",
            "solo",
            "# only-native",
        );

        let out = list_skills_ordered(&default_catalogs(home.path(), Some(proj.path()))).unwrap();
        let dup = out.iter().find(|s| s.name == "dup").unwrap();
        assert_eq!(
            dup.body, "# project-canonical",
            "project canonical wins the scan order"
        );
        assert_eq!(dup.scope, Scope::Project);
        assert!(
            out.iter().any(|s| s.name == "solo"),
            "a native-only skill must not be invisible"
        );
    }

    #[test]
    fn compose_skill_md_round_trips_and_quotes_what_yaml_would_misread() {
        let md = compose_skill_md("Deploy", Some("Ship it"), Some("# Body"));
        let d = crate::agentdeck::skill_md_detail(&md, "fallback");
        assert_eq!(d.name, "Deploy");
        assert_eq!(d.description, "Ship it");
        assert_eq!(d.body, "# Body");
        // a colon-bearing description must be quoted or it changes meaning
        let tricky = compose_skill_md("x", Some("note: this matters"), None);
        assert!(
            tricky.contains(r#"description: "note: this matters""#),
            "got: {tricky}"
        );
    }

    #[test]
    fn rename_to_the_same_name_is_a_noop_and_a_real_rename_updates_the_identity() {
        let home = tempfile::tempdir().unwrap();
        write_skill(
            home.path(),
            "deploy",
            "---
name: deploy
description: d
---
# b",
        )
        .unwrap();
        // same-name is a no-op, not ALREADY_EXISTS
        rename_skill(home.path(), "deploy", "deploy").unwrap();
        rename_skill(home.path(), "deploy", "ship").unwrap();
        let out = list_skills(home.path(), None).unwrap();
        assert_eq!(out.len(), 1);
        // the frontmatter name tracked the folder, so it moved with it — otherwise the skill would
        // still list as `deploy` and the rename would look like it never happened
        assert_eq!(out[0].name, "ship");
    }

    #[test]
    fn a_deliberately_different_frontmatter_name_survives_a_rename() {
        let home = tempfile::tempdir().unwrap();
        write_skill(
            home.path(),
            "folder",
            "---
name: Deliberate Name
description: d
---
# b",
        )
        .unwrap();
        rename_skill(home.path(), "folder", "newfolder").unwrap();
        assert_eq!(
            list_skills(home.path(), None).unwrap()[0].name,
            "Deliberate Name"
        );
    }

    #[test]
    fn error_codes_match_the_contract_vocabulary() {
        assert_eq!(
            StoreError::NotFound("x".into()).code(),
            "RESOURCE_NOT_FOUND"
        );
        assert_eq!(
            StoreError::AlreadyExists("x".into()).code(),
            "RESOURCE_ALREADY_EXISTS"
        );
        assert_eq!(
            StoreError::UnsafeComponent("x".into()).code(),
            "RESOURCE_UNSAFE_COMPONENT"
        );
        assert_eq!(
            StoreError::InvalidPath("x".into()).code(),
            "RESOURCE_INVALID_PATH"
        );
    }

    #[test]
    fn import_local_skill_names_the_folder_after_the_frontmatter_not_the_file_stem() {
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        // A downloaded file whose stem is nothing like its declared name.
        let f = src.path().join("skill (1).md");
        fs::write(&f, "---\nname: Imported\ndescription: d\n---\n# hi").unwrap();
        let dir = import_local_skill(home.path(), None, Scope::Global, &f).unwrap();

        assert_eq!(dir.file_name().unwrap(), "Imported");
        let out = list_skills(home.path(), None).unwrap();
        assert_eq!(out[0].name, "Imported");
        // the folder the reader finds IS the folder the importer made — one identity, not two
        assert_eq!(out[0].path, dir);
    }

    /// A local folder with two importable skills (alpha carries siblings) and one decoy dir.
    fn skills_folder_fixture(root: &Path) {
        fs::create_dir_all(root.join("alpha").join("scripts")).unwrap();
        fs::write(
            root.join("alpha").join("SKILL.md"),
            "---\nname: Alpha Helper\ndescription: Helps\n---\n# alpha",
        )
        .unwrap();
        fs::write(root.join("alpha").join("reference.md"), "extra").unwrap();
        fs::write(
            root.join("alpha").join("scripts").join("run.txt"),
            "echo hi",
        )
        .unwrap();
        fs::create_dir_all(root.join("beta")).unwrap();
        fs::write(root.join("beta").join("SKILL.md"), "# beta, no frontmatter").unwrap();
        fs::create_dir_all(root.join("not-a-skill")).unwrap();
        fs::write(root.join("not-a-skill").join("notes.md"), "just notes").unwrap();
    }

    #[test]
    fn import_local_skill_from_a_directory_brings_the_whole_fileset() {
        // SKL-06: a skill is its TREE, not its SKILL.md — import(dir) must materialize every file
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        skills_folder_fixture(src.path());
        let dir = import_local_skill(home.path(), None, Scope::Global, &src.path().join("alpha"))
            .unwrap();
        assert!(dir.join("SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(dir.join("reference.md")).unwrap(),
            "extra"
        );
        assert_eq!(
            fs::read_to_string(dir.join("scripts").join("run.txt")).unwrap(),
            "echo hi"
        );
    }

    #[test]
    fn import_local_skill_pointed_at_a_skill_md_imports_its_directory() {
        // The user pastes .../alpha/SKILL.md — the siblings must not be silently dropped (SKL-06)
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        skills_folder_fixture(src.path());
        let dir = import_local_skill(
            home.path(),
            None,
            Scope::Global,
            &src.path().join("alpha").join("SKILL.md"),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("reference.md")).unwrap(),
            "extra"
        );
    }

    #[test]
    fn import_local_skill_refuses_a_non_markdown_file() {
        // The gate lives in the ENGINE now (the napi .md check moves down): a lone non-md file
        // must refuse, not import text under a stem name.
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("skill.txt");
        fs::write(&f, "---\nname: sneaky\ndescription: d\n---\nhi").unwrap();
        let e = import_local_skill(home.path(), None, Scope::Global, &f).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_INVALID_PATH");
    }

    #[test]
    fn inspect_local_folder_lists_roots_without_writing() {
        // SKL-05 preview: discover skill roots (git-import discovery on a plain folder),
        // materialize nothing
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        skills_folder_fixture(src.path());
        let out = inspect_local_folder(home.path(), src.path()).unwrap();
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert_eq!(out[0].file_count, 3);
        assert!(out[0].skill_md.as_deref().unwrap().contains("Alpha Helper"));
        assert!(list_skills(home.path(), None).unwrap().is_empty());
    }

    // SKL-05 follow-up: a known folder like `~/.claude/skills` holds fan-out SYMLINKS into the
    // catalog next to plain copies. Inspection must report the linked entries (with their target)
    // instead of silently dropping them, and import must read through a link to a foreign target
    // while a link into the catalog itself collides like any duplicate name.
    #[cfg(unix)]
    #[test]
    fn inspect_local_folder_reports_linked_skills_and_import_reads_through_them() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        skills_folder_fixture(src.path());
        // gamma: a link to a skill somewhere else on disk
        let gamma = elsewhere.path().join("gamma");
        fs::create_dir_all(gamma.join("scripts")).unwrap();
        fs::write(
            gamma.join("SKILL.md"),
            "---\nname: Gamma\ndescription: d\n---\n# g",
        )
        .unwrap();
        fs::write(gamma.join("scripts").join("go.txt"), "go").unwrap();
        symlink(&gamma, src.path().join("gamma")).unwrap();
        // delta: already in the catalog, fanned out into the source folder as a link
        let delta = canonical_catalog(home.path()).join("delta");
        fs::create_dir_all(&delta).unwrap();
        fs::write(delta.join("SKILL.md"), "# delta").unwrap();
        symlink(&delta, src.path().join("delta")).unwrap();

        let out = inspect_local_folder(home.path(), src.path()).unwrap();
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta", "delta", "gamma"]);
        let by = |n: &str| out.iter().find(|s| s.name == n).unwrap();
        assert!(by("alpha").link_target.is_none());
        assert_eq!(
            by("gamma").link_target.as_deref(),
            Some(fs::canonicalize(&gamma).unwrap().to_str().unwrap())
        );
        assert_eq!(by("gamma").file_count, 2);
        assert_eq!(
            by("delta").link_target.as_deref(),
            Some(fs::canonicalize(&delta).unwrap().to_str().unwrap())
        );

        // importing through the link copies the TARGET's full fileset
        let sel = vec!["gamma".to_string()];
        let names =
            import_local_folder(home.path(), None, Scope::Global, src.path(), Some(&sel)).unwrap();
        assert_eq!(names, vec!["gamma"]);
        let dest = canonical_catalog(home.path()).join("gamma");
        assert!(!fs::symlink_metadata(&dest)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(dest.join("scripts").join("go.txt")).unwrap(),
            "go"
        );
        // the fan-out link collides with the catalog entry it points at — refused, not clobbered
        let sel = vec!["delta".to_string()];
        let e = import_local_folder(home.path(), None, Scope::Global, src.path(), Some(&sel))
            .unwrap_err();
        assert_eq!(e.code(), "RESOURCE_ALREADY_EXISTS");
        assert!(fs::symlink_metadata(src.path().join("delta"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn import_local_folder_honors_selection_all_or_nothing() {
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        skills_folder_fixture(src.path());
        // selection honored, full fileset materialized
        let sel = vec!["alpha".to_string()];
        let names =
            import_local_folder(home.path(), None, Scope::Global, src.path(), Some(&sel)).unwrap();
        assert_eq!(names, vec!["alpha"]);
        let alpha = canonical_catalog(home.path()).join("alpha");
        assert_eq!(
            fs::read_to_string(alpha.join("scripts").join("run.txt")).unwrap(),
            "echo hi"
        );
        assert!(!canonical_catalog(home.path()).join("beta").exists());
        // unknown selection: fail closed, nothing written
        let bad = vec!["beta".to_string(), "nope".to_string()];
        let e = import_local_folder(home.path(), None, Scope::Global, src.path(), Some(&bad))
            .unwrap_err();
        assert_eq!(e.code(), "RESOURCE_NOT_FOUND");
        assert!(!canonical_catalog(home.path()).join("beta").exists());
        // collision on ONE chosen skill imports NOTHING (alpha already exists from above)
        let both = vec!["alpha".to_string(), "beta".to_string()];
        let e2 = import_local_folder(home.path(), None, Scope::Global, src.path(), Some(&both))
            .unwrap_err();
        assert_eq!(e2.code(), "RESOURCE_ALREADY_EXISTS");
        assert!(!canonical_catalog(home.path()).join("beta").exists());
        // empty selection is a caller bug
        let empty: Vec<String> = Vec::new();
        let e3 = import_local_folder(home.path(), None, Scope::Global, src.path(), Some(&empty))
            .unwrap_err();
        assert_eq!(e3.code(), "RESOURCE_INVALID_PATH");
    }

    #[test]
    fn import_local_skill_dir_form_applies_the_repo_bounds() {
        // A single skill directory is just as untrusted as a repo tree: an over-budget file
        // must refuse from METADATA, before content is buffered (review, Codex).
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let dir = src.path().join("big");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: big\ndescription: d\n---\n# big",
        )
        .unwrap();
        fs::write(dir.join("huge.bin"), vec![b'a'; 1_000_001]).unwrap();
        let e = import_local_skill(home.path(), None, Scope::Global, &dir).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_GIT");
        assert!(list_skills(home.path(), None).unwrap().is_empty());
    }

    #[test]
    fn a_lone_lowercase_skill_md_keeps_its_single_file_import_behavior() {
        // Only an exactly-named SKILL.md means "import my directory" — lowercase skill.md is an
        // ordinary markdown file and must import as before (review, Codex).
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        let f = src.path().join("skill.md");
        fs::write(&f, "---\nname: solo\ndescription: d\n---\n# solo").unwrap();
        fs::write(src.path().join("unrelated.txt"), "never imported").unwrap();
        let dir = import_local_skill(home.path(), None, Scope::Global, &f).unwrap();
        assert_eq!(dir.file_name().unwrap(), "solo");
        assert!(!dir.join("unrelated.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn the_catalog_guard_sees_through_a_junction() {
        // <home>/.agents as a junction to elsewhere: picking the TARGET folder must still refuse
        // — both sides canonicalize before comparing (review, Codex).
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let real_catalog = tmp.path().join("real-catalog");
        fs::create_dir_all(real_catalog.join("skills")).unwrap();
        fs::create_dir_all(&home).unwrap();
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(home.join(".agents"))
            .arg(&real_catalog)
            .output()
            .unwrap();
        assert!(ok.status.success(), "mklink /J failed");
        let e = inspect_local_folder(&home, &real_catalog).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_INVALID_PATH");
    }

    #[test]
    fn local_folder_import_refuses_the_catalog_itself() {
        // Importing the catalog into the catalog (or anything under <home>/.agents) would
        // self-copy or recurse — refuse, fail closed (a user CAN pick that folder in a dialog).
        let home = tempfile::tempdir().unwrap();
        seed(
            home.path(),
            "mine",
            "---\nname: mine\ndescription: d\n---\n# mine",
        );
        let catalog = canonical_catalog(home.path());
        let e = inspect_local_folder(home.path(), &catalog).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_INVALID_PATH");
        let e2 = import_local_folder(home.path(), None, Scope::Global, &catalog, None).unwrap_err();
        assert_eq!(e2.code(), "RESOURCE_INVALID_PATH");
    }

    #[test]
    fn import_local_skill_refuses_to_overwrite_an_existing_skill() {
        let home = tempfile::tempdir().unwrap();
        let src = tempfile::tempdir().unwrap();
        seed(
            home.path(),
            "deploy",
            "---\nname: deploy\ndescription: d\n---\n# MINE",
        );
        let f = src.path().join("deploy.md");
        fs::write(&f, "---\nname: deploy\ndescription: d\n---\n# THEIRS").unwrap();

        let e = import_local_skill(home.path(), None, Scope::Global, &f).unwrap_err();
        assert_eq!(e.code(), "RESOURCE_ALREADY_EXISTS");
        let kept = fs::read_to_string(
            canonical_catalog(home.path())
                .join("deploy")
                .join("SKILL.md"),
        )
        .unwrap();
        assert!(
            kept.contains("# MINE"),
            "import must not clobber an existing skill"
        );
    }

    #[test]
    #[allow(non_snake_case)] // the capitals are the point of the name
    fn an_edit_lands_in_the_catalog_the_skill_ALREADY_lives_in() {
        // C1: the reader ranks the migration-window `.pi` catalog above the canonical one, so a
        // write that always chose the canonical one was invisible to every read.
        let home = tempfile::tempdir().unwrap();
        let pi = home
            .path()
            .join(".pi")
            .join("agent")
            .join("skills")
            .join("deploy");
        fs::create_dir_all(&pi).unwrap();
        fs::write(
            pi.join("SKILL.md"),
            "---\nname: deploy\ndescription: old\n---\n# ORIGINAL",
        )
        .unwrap();

        edit_skill(
            home.path(),
            None,
            Scope::Global,
            "deploy",
            Some("new"),
            None,
        )
        .unwrap();

        let out = list_skills(home.path(), None).unwrap();
        assert_eq!(
            out.len(),
            1,
            "the edit must not fork the skill into two catalogs"
        );
        assert_eq!(
            out[0].description, "new",
            "the edit must be visible to the reader"
        );
        assert!(
            out[0].body.contains("ORIGINAL"),
            "a description-only edit must keep the body"
        );
        assert!(
            !canonical_catalog(home.path()).join("deploy").exists(),
            "no second copy in the canonical catalog"
        );
    }

    #[test]
    fn a_partial_edit_preserves_unmentioned_frontmatter_and_body() {
        // C3: `{description}` alone erased the body, the flag, and any key we do not model.
        let home = tempfile::tempdir().unwrap();
        seed(
            home.path(),
            "deploy",
            "---\nname: deploy\ndescription: old\ndisable-model-invocation: true\nlicense: MIT\n---\n# BODY",
        );

        edit_skill(
            home.path(),
            None,
            Scope::Global,
            "deploy",
            Some("new"),
            None,
        )
        .unwrap();

        let md = fs::read_to_string(
            canonical_catalog(home.path())
                .join("deploy")
                .join("SKILL.md"),
        )
        .unwrap();
        assert!(md.contains("description: new"));
        assert!(md.contains("# BODY"), "body survived");
        assert!(
            md.contains("disable-model-invocation: true"),
            "flag survived"
        );
        assert!(md.contains("license: MIT"), "unknown key survived");
    }

    #[test]
    fn acknowledging_a_traversal_token_deletes_nothing() {
        // C2: the token was joined onto the catalog path, and Path::join with an absolute
        // component DISCARDS the base — a recursive delete of anything the process could reach.
        let home = tempfile::tempdir().unwrap();
        let victim = tempfile::tempdir().unwrap();
        fs::write(victim.path().join("important.txt"), "keep me").unwrap();
        seed(
            home.path(),
            "deploy",
            "---\nname: deploy\ndescription: d\n---\n# x",
        );

        for token in [
            victim.path().to_string_lossy().into_owned(),
            "../".repeat(6) + "deploy",
            "deploy".to_string(),
        ] {
            acknowledge_recovery(home.path(), &token).unwrap();
        }

        assert!(
            victim.path().join("important.txt").exists(),
            "absolute token deleted a real tree"
        );
        assert!(
            canonical_catalog(home.path()).join("deploy").exists(),
            "a token naming a live skill deleted it"
        );
    }
}
