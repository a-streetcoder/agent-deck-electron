//! The shared skill engine — the half of Syncr that agent-deck links into its own process.
//!
//! Factored out of `syncr-core` (ADR 0004, handoff task 1) because the dependency list is the
//! contract: as one crate, the NAPI addon linked bundled SQLite, a filesystem watcher and a diff
//! library that no engine operation calls. Everything here is std + hashing + JSON (+ Windows
//! junctions), so agent-deck's Electron packaging carries nothing it does not use.
//!
//! **What belongs here:** deciding where a skill lives, what it is called, and putting it on disk
//! safely — catalog scope and precedence, frontmatter parsing, atomic whole-skill materialization,
//! name/path containment, and fan-out to the coding-agent tool directories.
//!
//! **What does NOT:** version history and the transaction log (SQLite), the local index (SQLite),
//! the filesystem watcher (`notify`), 3-way merge (`diffy`), sync orchestration and the git
//! provider. Those live in `syncr-core`, which depends on this crate. The arrow never points back.
//!
//! Syncr's own Tauri app and agent-deck both consume this, so the two products cannot drift on
//! what a skill is or which copy wins — the whole point of the consolidation.

pub mod agentdeck;
pub mod entry;
pub mod fanout;
pub mod fileset;
pub mod git;
pub mod import;
pub mod materialize;
pub mod repos;
pub mod scope;
pub mod store;
pub mod tools;

use sha2::{Digest, Sha256};

/// Normalize skill text to LF at the INGEST boundary.
///
/// `content_hash` is a raw byte hash, so text that differs only by line ending hashes
/// differently. Git on Windows checks out with `core.autocrlf=true` by DEFAULT, so the same
/// upstream skill arrives as CRLF on Windows and LF on macOS — and a content-addressed engine
/// then treats one skill as two, forever. Two users of the same skill would see permanent
/// spurious divergence, and every hash written into local history would be platform-dependent, so
/// "offline then connect Syncr is a push/pull, not a migration" would fail on the first exchange.
///
/// Normalizing HERE rather than inside `content_hash` is deliberate: the hash stays an honest hash
/// of the bytes it is given, and the platform quirk is corrected once, where content enters.
pub fn normalize_newlines(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_string()
    }
}

/// Content address of a skill blob: lowercase hex SHA-256.
/// Basis of R2 dedup and skill-version identity (see CONTEXT.md).
pub fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
