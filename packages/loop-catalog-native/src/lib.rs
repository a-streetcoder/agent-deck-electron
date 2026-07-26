use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
#[cfg(windows)]
use cap_fs_ext::{MetadataExt as _, OsMetadataExt as _};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
#[cfg(unix)]
use cap_std::fs::{MetadataExt as _, OpenOptionsExt};
use napi::bindgen_prelude::{AbortSignal, AsyncTask};
use napi::{Error, Result, Status, Task};
use napi_derive::napi;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as _;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle as _;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);
const LOOP_SUFFIX: &str = ".loop.md";
const TEMP_PREFIX: &str = ".agent-deck-loop-tmp-";

#[napi(object)]
pub struct LoopCatalogEntry {
    pub basename: String,
    pub content: String,
}

fn napi_error(code: &'static str, detail: impl AsRef<str>) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("{code}: {}", detail.as_ref()),
    )
}

fn map_io(error: std::io::Error) -> Error {
    let code = match error.kind() {
        ErrorKind::NotFound => "LOOP_CATALOG_NOT_FOUND",
        ErrorKind::AlreadyExists => "LOOP_CATALOG_ALREADY_EXISTS",
        _ => "LOOP_CATALOG_IO",
    };
    napi_error(code, error.kind().to_string())
}

fn valid_catalog_basename(name: &str) -> bool {
    if name.is_empty()
        || !name.ends_with(LOOP_SUFFIX)
        || name.contains(['/', '\\', '\0', ':'])
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.starts_with(TEMP_PREFIX)
    {
        return false;
    }
    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
}

fn nofollow_open(
    dir: &Dir,
    name: &str,
    write: bool,
    maybe_dir: bool,
) -> std::io::Result<cap_std::fs::File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(maybe_dir);
    if write {
        options.write(true);
    }
    dir.open_with(name, &options)
}

#[cfg(windows)]
fn metadata_is_link_or_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(unix)]
fn metadata_is_link_or_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn open_child_dir(parent: &Dir, name: &str, create: bool) -> std::io::Result<Option<Dir>> {
    match parent.symlink_metadata(name) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata_is_link_or_reparse(&metadata) {
                return Err(std::io::Error::new(
                    ErrorKind::PermissionDenied,
                    "unsafe directory component",
                ));
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound && create => {
            match parent.create_dir(name) {
                Ok(()) => {}
                Err(race) if race.kind() == ErrorKind::AlreadyExists => {}
                Err(race) => return Err(race),
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let opened = nofollow_open(parent, name, false, true)?;
    let metadata = opened.metadata()?;
    if !metadata.is_dir() || metadata_is_link_or_reparse(&metadata) {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "unsafe directory component",
        ));
    }
    Ok(Some(Dir::from_std_file(opened.into_std())))
}

fn open_catalog(home: &str, create: bool) -> Result<Option<Dir>> {
    let home = Dir::open_ambient_dir(home, ambient_authority()).map_err(map_io)?;
    let Some(pi) = open_child_dir(&home, ".pi", create)
        .map_err(|error| napi_error("LOOP_CATALOG_UNSAFE_COMPONENT", error.kind().to_string()))?
    else {
        return Ok(None);
    };
    let Some(agent) = open_child_dir(&pi, "agent", create)
        .map_err(|error| napi_error("LOOP_CATALOG_UNSAFE_COMPONENT", error.kind().to_string()))?
    else {
        return Ok(None);
    };
    open_child_dir(&agent, "loops", create)
        .map_err(|error| napi_error("LOOP_CATALOG_UNSAFE_COMPONENT", error.kind().to_string()))
}

#[cfg(unix)]
fn sync_dir(dir: &Dir) -> std::io::Result<()> {
    // cap-std may hold a Linux directory as O_PATH, which cannot be fsync'd.
    // Re-open the captured directory itself descriptor-relatively for flushing.
    nofollow_open(dir, ".", false, true)?.sync_all()
}

#[cfg(windows)]
fn sync_dir(_dir: &Dir) -> std::io::Result<()> {
    // Windows does not support flushing directory handles. The temporary file
    // itself is flushed before the atomic directory-entry operation.
    Ok(())
}

fn private_nonce() -> std::io::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| std::io::Error::other("OS randomness unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn unique_temp(dir: &Dir, content: &str) -> std::io::Result<(String, cap_std::fs::File)> {
    for _ in 0..128 {
        let name = format!("{TEMP_PREFIX}{}", private_nonce()?);
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No)
            .maybe_dir(false);
        #[cfg(unix)]
        options.mode(0o600);
        match dir.open_with(&name, &options) {
            Ok(mut file) => {
                if let Err(error) = file
                    .write_all(content.as_bytes())
                    .and_then(|()| file.sync_all())
                {
                    drop(file);
                    let _ = dir.remove_file(&name);
                    return Err(error);
                }
                return Ok((name, file));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "could not allocate private temporary file",
    ))
}

#[napi]
pub fn scan_loop_catalog(home: String) -> Result<Vec<LoopCatalogEntry>> {
    let Some(dir) = open_catalog(&home, false)? else {
        return Ok(Vec::new());
    };
    let mut output = Vec::new();
    let entries = dir.entries().map_err(map_io)?;
    for entry in entries {
        let entry = entry.map_err(map_io)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_catalog_basename(&name) {
            continue;
        }
        let metadata = match dir.symlink_metadata(&name) {
            Ok(value) => value,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(map_io(error)),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let mut file = match nofollow_open(&dir, &name, false, false) {
            Ok(value) => value,
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::PermissionDenied
                ) =>
            {
                continue;
            }
            Err(error) => return Err(map_io(error)),
        };
        if !file.metadata().map_err(map_io)?.is_file() {
            continue;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(map_io)?;
        let content = String::from_utf8(bytes)
            .map_err(|_| napi_error("LOOP_CATALOG_INVALID_UTF8", "catalog entry is not UTF-8"))?;
        output.push(LoopCatalogEntry {
            basename: name,
            content,
        });
    }
    output.sort_by(|left, right| left.basename.cmp(&right.basename));
    Ok(output)
}

#[napi]
pub fn create_loop_catalog_file(home: String, basename: String, content: String) -> Result<()> {
    if !valid_catalog_basename(&basename) {
        return Err(napi_error(
            "LOOP_CATALOG_INVALID_BASENAME",
            "invalid Loop filename",
        ));
    }
    let dir = open_catalog(&home, true)?.ok_or_else(|| {
        napi_error(
            "LOOP_CATALOG_UNSAFE_COMPONENT",
            "catalog could not be established",
        )
    })?;
    let (temp, file) = unique_temp(&dir, &content).map_err(map_io)?;
    drop(file);
    let result = dir.hard_link(&temp, &dir, &basename);
    let _ = dir.remove_file(&temp);
    result.map_err(map_io)?;
    sync_dir(&dir).map_err(map_io)?;
    Ok(())
}

#[napi]
pub fn replace_loop_catalog_file(home: String, basename: String, content: String) -> Result<()> {
    if !valid_catalog_basename(&basename) {
        return Err(napi_error(
            "LOOP_CATALOG_INVALID_BASENAME",
            "invalid Loop filename",
        ));
    }
    let dir = open_catalog(&home, false)?
        .ok_or_else(|| napi_error("LOOP_CATALOG_NOT_FOUND", "Loop catalog does not exist"))?;
    let metadata = dir.symlink_metadata(&basename).map_err(map_io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(napi_error(
            "LOOP_CATALOG_UNSAFE_COMPONENT",
            "target is not a regular file",
        ));
    }
    let (temp, file) = unique_temp(&dir, &content).map_err(map_io)?;
    drop(file);
    let result = dir.rename(&temp, &dir, &basename);
    if result.is_err() {
        let _ = dir.remove_file(&temp);
    }
    result.map_err(map_io)?;
    sync_dir(&dir).map_err(map_io)?;
    Ok(())
}

#[napi]
pub fn delete_loop_catalog_file(home: String, basename: String) -> Result<()> {
    if !valid_catalog_basename(&basename) {
        return Err(napi_error(
            "LOOP_CATALOG_INVALID_BASENAME",
            "invalid Loop filename",
        ));
    }
    let dir = open_catalog(&home, false)?
        .ok_or_else(|| napi_error("LOOP_CATALOG_NOT_FOUND", "Loop catalog does not exist"))?;
    let metadata = dir.symlink_metadata(&basename).map_err(map_io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(napi_error(
            "LOOP_CATALOG_UNSAFE_COMPONENT",
            "target is not a regular file",
        ));
    }
    dir.remove_file(&basename).map_err(map_io)?;
    sync_dir(&dir).map_err(map_io)?;
    Ok(())
}

const RESOURCE_TEMP_PREFIX: &str = ".agent-deck-resource-tmp-";
const RESOURCE_BACKUP_PREFIX: &str = ".agent-deck-resource-backup-";

fn resource_error(code: &'static str, detail: impl AsRef<str>) -> Error {
    napi_error(code, detail)
}

fn map_resource_io(error: std::io::Error) -> Error {
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return resource_error("RESOURCE_BUSY", "resource is in use by another process");
    }
    let code = match error.kind() {
        ErrorKind::NotFound => "RESOURCE_NOT_FOUND",
        ErrorKind::AlreadyExists => "RESOURCE_ALREADY_EXISTS",
        ErrorKind::PermissionDenied => "RESOURCE_UNSAFE_COMPONENT",
        _ => "RESOURCE_IO",
    };
    resource_error(code, error.kind().to_string())
}

fn map_validated_resource_mutation_io(error: std::io::Error) -> Error {
    // Windows may report a sharing conflict from rename as ERROR_ACCESS_DENIED
    // rather than ERROR_SHARING_VIOLATION. This mapper is intentionally used
    // only after the named target was validated as a regular, non-reparse file;
    // validation and traversal permission failures remain unsafe-component
    // errors through map_resource_io.
    #[cfg(windows)]
    if error.kind() == ErrorKind::PermissionDenied {
        return resource_error("RESOURCE_BUSY", "resource is in use by another process");
    }
    map_resource_io(error)
}

fn valid_resource_component(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0', ':'])
        || name.ends_with(['.', ' '])
        || name.starts_with(RESOURCE_TEMP_PREFIX)
        || name.starts_with(RESOURCE_BACKUP_PREFIX)
    {
        return false;
    }
    let device = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    !matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'))
}

fn validate_resource_path(components: &[String]) -> Result<()> {
    if components.is_empty()
        || components
            .iter()
            .any(|part| !valid_resource_component(part))
    {
        return Err(resource_error(
            "RESOURCE_INVALID_PATH",
            "invalid portable catalog-relative path",
        ));
    }
    Ok(())
}

fn resource_catalog_parts(catalog: &str) -> Option<&'static [&'static str]> {
    match catalog {
        "legacy-agents" => Some(&[".agents"]),
        "global-agents" => Some(&[".pi", "agent", "agents"]),
        "library-agents" => Some(&[".pi", "agent", "agent-library", "agents"]),
        "global-prompts" => Some(&[".pi", "agent", "prompts"]),
        "library-prompts" => Some(&[".pi", "agent", "prompt-library"]),
        "global-skills" => Some(&[".pi", "agent", "skills"]),
        _ => None,
    }
}

fn open_resource_catalog(home: &str, catalog: &str, create: bool) -> Result<Option<Dir>> {
    let parts = resource_catalog_parts(catalog)
        .ok_or_else(|| resource_error("RESOURCE_INVALID_PATH", "unknown resource catalog"))?;
    let mut current = Dir::open_ambient_dir(home, ambient_authority()).map_err(map_resource_io)?;
    for part in parts {
        let Some(next) = open_child_dir(&current, part, create).map_err(map_resource_io)? else {
            return Ok(None);
        };
        current = next;
    }
    Ok(Some(current))
}

fn open_resource_parent(
    catalog: &Dir,
    components: &[String],
    create: bool,
) -> Result<(Dir, String)> {
    validate_resource_path(components)?;
    let mut current = catalog.try_clone().map_err(map_resource_io)?;
    for part in &components[..components.len() - 1] {
        let Some(next) = open_child_dir(&current, part, create).map_err(map_resource_io)? else {
            return Err(resource_error(
                "RESOURCE_NOT_FOUND",
                "parent does not exist",
            ));
        };
        current = next;
    }
    Ok((current, components.last().unwrap().clone()))
}

fn regular_metadata(dir: &Dir, name: &str) -> Result<cap_std::fs::Metadata> {
    let metadata = dir.symlink_metadata(name).map_err(map_resource_io)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "target is not a regular file",
        ));
    }
    Ok(metadata)
}

#[cfg(unix)]
fn rename_noreplace(from_dir: &Dir, from: &str, to_dir: &Dir, to: &str) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;

    let from = CString::new(from)
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "invalid source name"))?;
    let to = CString::new(to)
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "invalid target name"))?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            from_dir.as_raw_fd(),
            from.as_ptr(),
            to_dir.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        ) as libc::c_int
    };
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            from_dir.as_raw_fd(),
            from.as_ptr(),
            to_dir.as_raw_fd(),
            to.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn exchange_entries(
    left_dir: &Dir,
    left: &str,
    right_dir: &Dir,
    right: &str,
) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;

    let left = CString::new(left)
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "invalid left name"))?;
    let right = CString::new(right)
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "invalid right name"))?;
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            left_dir.as_raw_fd(),
            left.as_ptr(),
            right_dir.as_raw_fd(),
            right.as_ptr(),
            libc::RENAME_EXCHANGE,
        ) as libc::c_int
    };
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            left_dir.as_raw_fd(),
            left.as_ptr(),
            right_dir.as_raw_fd(),
            right.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_noreplace(from_dir: &Dir, from: &str, to_dir: &Dir, to: &str) -> std::io::Result<()> {
    if to_dir.symlink_metadata(to).is_ok() {
        return Err(std::io::Error::new(
            ErrorKind::AlreadyExists,
            "target exists",
        ));
    }
    // cap-std's Windows rename is descriptor-relative and does not request
    // replacement. A destination which appears after the check makes the
    // operation fail rather than being overwritten.
    from_dir.rename(from, to_dir, to)
}

fn open_managed_repositories(data_dir: &str) -> Result<Dir> {
    let data = Dir::open_ambient_dir(data_dir, ambient_authority()).map_err(map_resource_io)?;
    open_child_dir(&data, "SkillRepositories", false)
        .map_err(map_resource_io)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "SkillRepositories does not exist"))
}

/// Publish a private, direct-child clone stage without replacing a destination
/// that appeared after the caller's validation.
#[cfg(test)]
fn publish_managed_skill_repository(
    data_dir: String,
    stage_leaf: String,
    destination_leaf: String,
) -> Result<()> {
    if !valid_resource_component(&stage_leaf)
        || !valid_resource_component(&destination_leaf)
        || !stage_leaf.starts_with(".agent-deck-clone-")
    {
        return Err(resource_error(
            "RESOURCE_INVALID_PATH",
            "invalid managed repository leaf",
        ));
    }
    let repositories = open_managed_repositories(&data_dir)?;
    let source = repositories
        .symlink_metadata(&stage_leaf)
        .map_err(map_resource_io)?;
    if !source.is_dir() || source.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "clone stage is not a real directory",
        ));
    }
    rename_noreplace(&repositories, &stage_leaf, &repositories, &destination_leaf)
        .map_err(map_resource_io)?;
    sync_dir(&repositories).map_err(map_resource_io)
}

/// Quarantine then recursively remove one direct-child managed repository.
/// Traversal stays descriptor-relative and rejects links/reparse points.
#[cfg(test)]
fn delete_managed_skill_repository(data_dir: String, repository_leaf: String) -> Result<()> {
    if !valid_resource_component(&repository_leaf) {
        return Err(resource_error(
            "RESOURCE_INVALID_PATH",
            "invalid managed repository leaf",
        ));
    }
    let repositories = open_managed_repositories(&data_dir)?;
    let metadata = repositories
        .symlink_metadata(&repository_leaf)
        .map_err(map_resource_io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "repository is not a real directory",
        ));
    }
    let quarantine = format!(
        "{RESOURCE_TEMP_PREFIX}managed-delete-{}",
        private_nonce().map_err(map_resource_io)?
    );
    rename_noreplace(&repositories, &repository_leaf, &repositories, &quarantine)
        .map_err(map_resource_io)?;
    if let Err(error) = remove_tree_entry(&repositories, &quarantine) {
        if rename_noreplace(&repositories, &quarantine, &repositories, &repository_leaf).is_err() {
            return Err(resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "managed repository quarantine could not be rolled back",
            ));
        }
        return Err(error);
    }
    sync_dir(&repositories).map_err(map_resource_io)
}

const MANAGED_GIT_OUTPUT_LIMIT: usize = 8_000_000;
const MANAGED_SNAPSHOT_PREFIX: &str = ".agent-deck-snapshot-";
const MANAGED_SNAPSHOT_STAGE_PREFIX: &str = ".agent-deck-snapshot-stage-";
const MANAGED_SNAPSHOT_MAX_FILES: usize = 10_000;
const MANAGED_SNAPSHOT_MAX_BYTES: u64 = 128 * 1024 * 1024;
const MANAGED_SNAPSHOT_MAX_DEPTH: usize = 64;
const MANAGED_GIT_TIMEOUT: Duration = Duration::from_secs(180);
const MANAGED_STAGE_PREFIX: &str = ".agent-deck-clone-";

#[napi(object)]
pub struct ManagedGitRepositoryResult {
    pub head: String,
    pub origin: String,
    pub clean: bool,
    pub ref_matches: bool,
}

#[derive(Clone)]
enum ManagedGitOperation {
    Clone {
        remote: String,
        reference: Option<String>,
        destination: String,
    },
    Inspect {
        leaf: String,
        reference: Option<String>,
    },
    Update {
        leaf: String,
        reference: Option<String>,
    },
}

pub struct ManagedGitTask {
    root: Dir,
    root_path: String,
    operation: ManagedGitOperation,
    cancelled: Arc<AtomicBool>,
}

impl Task for ManagedGitTask {
    type Output = ManagedGitRepositoryResult;
    type JsValue = ManagedGitRepositoryResult;

    fn compute(&mut self) -> Result<Self::Output> {
        match &self.operation {
            ManagedGitOperation::Clone {
                remote,
                reference,
                destination,
            } => managed_clone(
                &self.root,
                &self.root_path,
                remote,
                reference.as_deref(),
                destination,
                &self.cancelled,
            ),
            ManagedGitOperation::Inspect { leaf, reference } => managed_inspect(
                &self.root,
                &self.root_path,
                leaf,
                reference.as_deref(),
                &self.cancelled,
            ),
            ManagedGitOperation::Update { leaf, reference } => managed_update(
                &self.root,
                &self.root_path,
                leaf,
                reference.as_deref(),
                &self.cancelled,
            ),
        }
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(object)]
pub struct ManagedSkillSnapshotResult {
    pub generation: String,
    pub skill_roots: Vec<String>,
}

pub struct ManagedSnapshotTask {
    root: Dir,
    snapshots: Dir,
    snapshots_path: String,
    snapshots_identity: SnapshotIdentity,
    snapshot_identities: Arc<Mutex<HashMap<String, ManagedSnapshotIdentity>>>,
    repository_leaf: String,
    repository_id: String,
    selected_roots: Vec<Vec<String>>,
}

impl Task for ManagedSnapshotTask {
    type Output = ManagedSkillSnapshotResult;
    type JsValue = ManagedSkillSnapshotResult;

    fn compute(&mut self) -> Result<Self::Output> {
        materialize_managed_snapshot(
            &self.root,
            SnapshotAuthority {
                root: &self.snapshots,
                path: &self.snapshots_path,
                identity: &self.snapshots_identity,
                active: &self.snapshot_identities,
            },
            &self.repository_leaf,
            &self.repository_id,
            &self.selected_roots,
        )
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(any(windows, test))]
fn normalize_windows_namespace_path(path: &str) -> Result<String> {
    if path.is_empty() || path.contains('\0') {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "managed root check failed: Windows path is empty or contains NUL",
        ));
    }
    let separators = path.replace('/', "\\");
    let upper = separators.to_ascii_uppercase();
    let normalized_prefix = if upper.starts_with(r"\\?\UNC\") || upper.starts_with(r"\??\UNC\") {
        format!(r"\\{}", &separators[8..])
    } else if upper.starts_with(r"\\?\") || upper.starts_with(r"\??\") {
        separators[4..].to_owned()
    } else {
        separators
    };

    let (prefix, remainder) = if let Some(unc) = normalized_prefix.strip_prefix(r"\\") {
        let mut parts = unc.split('\\');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        if server.is_empty()
            || share.is_empty()
            || server == "."
            || share == "."
            || server == ".."
            || share == ".."
            || server.contains(':')
            || share.contains(':')
        {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "managed root check failed: Windows UNC path is incomplete",
            ));
        }
        (
            format!(r"\\{}\{}", server.to_lowercase(), share.to_lowercase()),
            parts.collect::<Vec<_>>(),
        )
    } else {
        let bytes = normalized_prefix.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || bytes[2] != b'\\'
        {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "managed root check failed: Windows path is not absolute",
            ));
        }
        (
            normalized_prefix[..2].to_ascii_lowercase(),
            normalized_prefix[3..].split('\\').collect::<Vec<_>>(),
        )
    };

    let mut components = Vec::new();
    for component in remainder {
        if component.is_empty() {
            continue;
        }
        if component == "." || component == ".." || component.contains(':') {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "managed root check failed: Windows path contains traversal or ADS",
            ));
        }
        components.push(component.to_lowercase());
    }
    if components.is_empty() {
        Ok(format!(r"{prefix}\"))
    } else {
        Ok(format!(r"{}\{}", prefix, components.join(r"\")))
    }
}

#[cfg(windows)]
fn held_windows_final_path(dir: &Dir) -> Result<String> {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let handle = dir.as_raw_handle();
    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0)
        };
        if length == 0 {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "managed root check failed: held Windows final path unavailable",
            ));
        }
        if (length as usize) < buffer.len() {
            let path = std::ffi::OsString::from_wide(&buffer[..length as usize]);
            return path.into_string().map_err(|_| {
                resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: held Windows final path is invalid Unicode",
                )
            });
        }
        buffer.resize(length as usize + 1, 0);
    }
}

#[derive(Clone, PartialEq, Eq)]
struct StableFileIdentity {
    volume: u64,
    file: u64,
}

#[cfg(unix)]
fn cap_file_identity(metadata: &cap_std::fs::Metadata) -> Result<StableFileIdentity> {
    Ok(StableFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn cap_file_identity(metadata: &cap_std::fs::Metadata) -> Result<StableFileIdentity> {
    // cap-fs-ext obtains these from the opened handle. Catch its documented
    // unavailable-handle panic and fail closed rather than inventing identity.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| StableFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    }))
    .map_err(|_| resource_error("RESOURCE_UNSAFE_COMPONENT", "file identity unavailable"))
}

#[cfg(unix)]
fn ambient_file_identity(path: &std::path::Path) -> Result<StableFileIdentity> {
    let metadata = std::fs::metadata(path).map_err(map_resource_io)?;
    Ok(StableFileIdentity {
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn ambient_file_identity(path: &std::path::Path) -> Result<StableFileIdentity> {
    // Rust 1.88 does not yet expose stable std Metadata file-index methods.
    // Open the directory as a cap-std handle, whose pinned cap-fs-ext identity
    // obtains volume serial + file index by handle and supports directories.
    let captured = Dir::open_ambient_dir(path, ambient_authority()).map_err(map_resource_io)?;
    let metadata = captured.dir_metadata().map_err(map_resource_io)?;
    cap_file_identity(&metadata)
}

fn same_cap_file(left: &cap_std::fs::Metadata, right: &cap_std::fs::Metadata) -> Result<bool> {
    Ok(cap_file_identity(left)? == cap_file_identity(right)?)
}

#[derive(Clone)]
struct SnapshotIdentity(StableFileIdentity);

#[derive(Clone)]
struct ManagedSnapshotIdentity {
    leaf: SnapshotIdentity,
    skill_count: usize,
}

#[napi]
pub struct ManagedSkillRepositoryStore {
    root: Dir,
    root_path: String,
    snapshots: Dir,
    snapshots_path: String,
    snapshots_identity: SnapshotIdentity,
    snapshot_identities: Arc<Mutex<HashMap<String, ManagedSnapshotIdentity>>>,
}

#[napi]
impl ManagedSkillRepositoryStore {
    #[napi(constructor)]
    pub fn new(
        data_dir: String,
        expected_realpath: String,
        expected_dev: String,
        expected_ino: String,
    ) -> Result<Self> {
        // Capture the trusted direct child first. On Windows this handle denies
        // delete sharing and remains the authority even if namespace spelling
        // differs between Node and Win32.
        let root = open_managed_repositories(&data_dir)?;
        let metadata = root.dir_metadata().map_err(map_resource_io)?;
        #[cfg(unix)]
        let root_path = {
            let canonical =
                std::fs::canonicalize(std::path::Path::new(&data_dir).join("SkillRepositories"))
                    .map_err(map_resource_io)?;
            if canonical != std::path::Path::new(&expected_realpath) {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: Unix canonical path changed",
                ));
            }
            if metadata.dev().to_string() != expected_dev
                || metadata.ino().to_string() != expected_ino
            {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: Unix identity changed",
                ));
            }
            expected_realpath.clone()
        };
        #[cfg(windows)]
        let root_path = {
            // Node's bigint stat identity is not a cross-runtime contract on
            // Windows. Require a safe absolute candidate, then compare its
            // opened native identity with the already-held direct child.
            let _node_identity = (expected_dev, expected_ino);
            let expected_normalized = normalize_windows_namespace_path(&expected_realpath)?;
            let held_final = held_windows_final_path(&root)?;
            let held_normalized = normalize_windows_namespace_path(&held_final)?;
            let candidate_path = std::path::Path::new(&expected_realpath);
            let before = std::fs::symlink_metadata(candidate_path).map_err(|_| {
                resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: Windows candidate metadata unavailable",
                )
            })?;
            if !before.is_dir()
                || before.file_type().is_symlink()
                || before.file_attributes() & 0x400 != 0
            {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: Windows candidate is a reparse point",
                ));
            }
            let candidate =
                Dir::open_ambient_dir(candidate_path, ambient_authority()).map_err(|_| {
                    resource_error(
                        "RESOURCE_UNSAFE_COMPONENT",
                        "managed root check failed: Windows candidate handle unavailable",
                    )
                })?;
            let candidate_metadata = candidate.dir_metadata().map_err(|_| {
                resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: Windows candidate handle metadata unavailable",
                )
            })?;
            if cap_file_identity(&candidate_metadata)? != cap_file_identity(&metadata)? {
                let context = if expected_normalized == held_normalized {
                    "equivalent spelling resolved to a different identity"
                } else {
                    "different spelling resolved to a different identity"
                };
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    format!("managed root check failed: {context}"),
                ));
            }
            let after = std::fs::symlink_metadata(candidate_path).map_err(|_| {
                resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: Windows candidate post-check unavailable",
                )
            })?;
            if !after.is_dir()
                || after.file_type().is_symlink()
                || after.file_attributes() & 0x400 != 0
            {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed root check failed: Windows candidate changed to a reparse point",
                ));
            }
            held_final
        };
        let data =
            Dir::open_ambient_dir(&data_dir, ambient_authority()).map_err(map_resource_io)?;
        let snapshots = open_child_dir(&data, "SkillRepositorySnapshots", true)
            .map_err(map_resource_io)?
            .ok_or_else(|| {
                resource_error("RESOURCE_UNSAFE_COMPONENT", "snapshot root unavailable")
            })?;
        #[cfg(unix)]
        snapshots
            .set_permissions(
                ".",
                cap_std::fs::Permissions::from_std(std::fs::Permissions::from_mode(0o700)),
            )
            .map_err(map_resource_io)?;
        cleanup_stale_snapshot_generations(&snapshots)?;
        let snapshots_path =
            std::fs::canonicalize(std::path::Path::new(&data_dir).join("SkillRepositorySnapshots"))
                .map_err(map_resource_io)?
                .to_string_lossy()
                .into_owned();
        let snapshot_metadata = snapshots.dir_metadata().map_err(map_resource_io)?;
        Ok(Self {
            root,
            root_path,
            snapshots,
            snapshots_path,
            snapshots_identity: SnapshotIdentity(cap_file_identity(&snapshot_metadata)?),
            snapshot_identities: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    #[napi]
    pub fn clone_repository(
        &self,
        remote: String,
        reference: Option<String>,
        destination_leaf: String,
        signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<ManagedGitTask>> {
        validate_managed_leaf(&destination_leaf)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(abort) = &signal {
            let cancelled = Arc::clone(&cancelled);
            abort.on_abort(move || cancelled.store(true, Ordering::Release));
        }
        Ok(AsyncTask::with_optional_signal(
            ManagedGitTask {
                root: self.root.try_clone().map_err(map_resource_io)?,
                root_path: self.root_path.clone(),
                operation: ManagedGitOperation::Clone {
                    remote,
                    reference,
                    destination: destination_leaf,
                },
                cancelled,
            },
            signal,
        ))
    }

    #[napi]
    pub fn inspect_repository(
        &self,
        leaf: String,
        reference: Option<String>,
        signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<ManagedGitTask>> {
        validate_managed_leaf(&leaf)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(abort) = &signal {
            let cancelled = Arc::clone(&cancelled);
            abort.on_abort(move || cancelled.store(true, Ordering::Release));
        }
        Ok(AsyncTask::with_optional_signal(
            ManagedGitTask {
                root: self.root.try_clone().map_err(map_resource_io)?,
                root_path: self.root_path.clone(),
                operation: ManagedGitOperation::Inspect { leaf, reference },
                cancelled,
            },
            signal,
        ))
    }

    #[napi]
    pub fn update_repository(
        &self,
        leaf: String,
        reference: Option<String>,
        signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<ManagedGitTask>> {
        validate_managed_leaf(&leaf)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(abort) = &signal {
            let cancelled = Arc::clone(&cancelled);
            abort.on_abort(move || cancelled.store(true, Ordering::Release));
        }
        Ok(AsyncTask::with_optional_signal(
            ManagedGitTask {
                root: self.root.try_clone().map_err(map_resource_io)?,
                root_path: self.root_path.clone(),
                operation: ManagedGitOperation::Update { leaf, reference },
                cancelled,
            },
            signal,
        ))
    }

    #[napi]
    pub fn materialize_snapshot(
        &self,
        repository_leaf: String,
        repository_id: String,
        selected_roots: Vec<Vec<String>>,
    ) -> Result<AsyncTask<ManagedSnapshotTask>> {
        validate_managed_leaf(&repository_leaf)?;
        validate_repository_id(&repository_id)?;
        if selected_roots.len() > 1_000 {
            return Err(resource_error(
                "RESOURCE_INVALID_PATH",
                "too many selected roots",
            ));
        }
        for components in &selected_roots {
            if components.len() > MANAGED_SNAPSHOT_MAX_DEPTH
                || components
                    .iter()
                    .any(|component| !valid_resource_component(component))
            {
                return Err(resource_error(
                    "RESOURCE_INVALID_PATH",
                    "invalid selected root",
                ));
            }
        }
        Ok(AsyncTask::new(ManagedSnapshotTask {
            root: self.root.try_clone().map_err(map_resource_io)?,
            snapshots: self.snapshots.try_clone().map_err(map_resource_io)?,
            snapshots_path: self.snapshots_path.clone(),
            snapshots_identity: self.snapshots_identity.clone(),
            snapshot_identities: Arc::clone(&self.snapshot_identities),
            repository_leaf,
            repository_id,
            selected_roots,
        }))
    }

    #[napi]
    pub fn validate_snapshot(&self, repository_id: String) -> Result<ManagedSkillSnapshotResult> {
        validate_repository_id(&repository_id)?;
        let identity = self
            .snapshot_identities
            .lock()
            .map_err(|_| resource_error("RESOURCE_IO", "snapshot identity lock poisoned"))?
            .get(&repository_id)
            .cloned()
            .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "snapshot is not active"))?;
        validate_managed_snapshot(
            &self.snapshots,
            &self.snapshots_path,
            &self.snapshots_identity,
            &repository_id,
            &identity,
        )
    }

    #[napi]
    pub fn delete_snapshot(&self, repository_id: String) -> Result<()> {
        validate_repository_id(&repository_id)?;
        validate_snapshot_root_namespace(
            &self.snapshots,
            &self.snapshots_path,
            &self.snapshots_identity,
        )?;
        let leaf = snapshot_leaf(&repository_id);
        if self.snapshots.symlink_metadata(&leaf).is_ok() {
            remove_tree_entry(&self.snapshots, &leaf)?;
            sync_dir(&self.snapshots).map_err(map_resource_io)?;
        }
        self.snapshot_identities
            .lock()
            .map_err(|_| resource_error("RESOURCE_IO", "snapshot identity lock poisoned"))?
            .remove(&repository_id);
        Ok(())
    }

    #[napi]
    pub fn delete_repository(&self, repository_leaf: String) -> Result<()> {
        validate_managed_leaf(&repository_leaf)?;
        delete_managed_from_root(&self.root, &repository_leaf)
    }
}

const SESSION_WORKTREE_ROOT: &str = "session-worktrees";
const SESSION_WORKTREE_QUARANTINE_PREFIX: &str = ".agent-deck-session-delete-";
const SESSION_WORKTREE_MAX_QUARANTINES: usize = 32;

fn session_worktree_error(code: &'static str, detail: impl AsRef<str>) -> Error {
    napi_error(code, detail)
}

fn map_session_worktree_io(error: std::io::Error) -> Error {
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) || error.kind() == ErrorKind::PermissionDenied
    {
        return session_worktree_error(
            "SESSION_WORKTREE_BUSY",
            "session worktree is still in use; retry",
        );
    }
    let code = match error.kind() {
        ErrorKind::NotFound => "SESSION_WORKTREE_NOT_FOUND",
        ErrorKind::PermissionDenied => "SESSION_WORKTREE_UNSAFE",
        _ => "SESSION_WORKTREE_IO",
    };
    session_worktree_error(code, error.kind().to_string())
}

fn valid_session_worktree_leaf(leaf: &str) -> bool {
    leaf.len() == 8
        && leaf
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(windows)]
fn session_entry_is_link(metadata: &cap_std::fs::Metadata) -> bool {
    metadata_is_link_or_reparse(metadata)
}

#[cfg(unix)]
fn session_entry_is_link(metadata: &cap_std::fs::Metadata) -> bool {
    metadata_is_link_or_reparse(metadata)
}

fn validate_session_worktree_target(root_path: &str, target_path: &str) -> Result<String> {
    let target = std::path::Path::new(target_path);
    let leaf = target
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| valid_session_worktree_leaf(name))
        .ok_or_else(|| {
            session_worktree_error(
                "SESSION_WORKTREE_INVALID_PATH",
                "target must have a generated eight-lowerhex leaf",
            )
        })?;
    if !target.is_absolute() {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_INVALID_PATH",
            "target must be absolute",
        ));
    }
    let expected = std::path::Path::new(root_path).join(leaf);
    #[cfg(unix)]
    if target != expected {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_INVALID_PATH",
            "target must be a direct child of the held root",
        ));
    }
    #[cfg(windows)]
    if normalize_windows_namespace_path(target_path)?
        != normalize_windows_namespace_path(&expected.to_string_lossy())?
    {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_INVALID_PATH",
            "target must be a direct child of the held root",
        ));
    }
    Ok(leaf.to_owned())
}

fn validate_session_worktree_root(
    root: &Dir,
    root_path: &str,
    expected: &StableFileIdentity,
) -> Result<()> {
    let path = std::path::Path::new(root_path);
    let namespace = std::fs::symlink_metadata(path).map_err(map_session_worktree_io)?;
    if !namespace.is_dir() || session_entry_is_link_from_std(&namespace) {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "session worktree root namespace is not a real directory",
        ));
    }
    #[cfg(unix)]
    let canonical = std::fs::canonicalize(path).map_err(map_session_worktree_io)?;
    #[cfg(unix)]
    if canonical != path {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "session worktree root namespace changed",
        ));
    }
    let ambient = ambient_file_identity(path).map_err(|_| {
        session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "session worktree root identity unavailable",
        )
    })?;
    let held = cap_file_identity(&root.dir_metadata().map_err(map_session_worktree_io)?)
        .map_err(|_| session_worktree_error("SESSION_WORKTREE_UNSAFE", "held root changed"))?;
    if &ambient != expected || &held != expected {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "session worktree root identity changed",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn session_entry_is_link_from_std(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(unix)]
fn session_entry_is_link_from_std(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

enum SessionWorktreeEntryKind {
    Directory,
    DirectoryLink,
    FileOrLink,
}

fn remove_session_worktree_entry(parent: &Dir, name: &str) -> Result<()> {
    // On Windows, no-follow metadata inspection opens a reparse point with no
    // delete sharing. Finish classification and release every inspection value
    // before unlinking it. Also use FILE_ATTRIBUTE_DIRECTORY: FileType::is_dir
    // is false for directory links/junctions, which must use remove_dir rather
    // than remove_file.
    let kind = {
        let metadata = parent
            .symlink_metadata(name)
            .map_err(map_session_worktree_io)?;
        if session_entry_is_link(&metadata) {
            #[cfg(windows)]
            let is_directory = metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0;
            #[cfg(unix)]
            let is_directory = metadata.is_dir();
            if is_directory {
                SessionWorktreeEntryKind::DirectoryLink
            } else {
                SessionWorktreeEntryKind::FileOrLink
            }
        } else if metadata.is_file() {
            SessionWorktreeEntryKind::FileOrLink
        } else if metadata.is_dir() {
            SessionWorktreeEntryKind::Directory
        } else {
            return Err(session_worktree_error(
                "SESSION_WORKTREE_UNSAFE",
                "session worktree contains a special entry",
            ));
        }
    };
    match kind {
        SessionWorktreeEntryKind::DirectoryLink => {
            return parent.remove_dir(name).map_err(map_session_worktree_io);
        }
        SessionWorktreeEntryKind::FileOrLink => {
            return parent.remove_file(name).map_err(map_session_worktree_io);
        }
        SessionWorktreeEntryKind::Directory => {}
    }
    let child = open_child_dir(parent, name, false)
        .map_err(map_session_worktree_io)?
        .ok_or_else(|| {
            session_worktree_error("SESSION_WORKTREE_NOT_FOUND", "directory disappeared")
        })?;
    let names = child
        .entries()
        .map_err(map_session_worktree_io)?
        .map(|entry| {
            entry
                .map_err(map_session_worktree_io)?
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    session_worktree_error(
                        "SESSION_WORKTREE_UNSAFE",
                        "session worktree contains a non-UTF-8 entry",
                    )
                })
        })
        .collect::<Result<Vec<_>>>()?;
    for child_name in names {
        remove_session_worktree_entry(&child, &child_name)?;
    }
    drop(child);
    parent.remove_dir(name).map_err(map_session_worktree_io)
}

fn rename_session_worktree_to_quarantine(root: &Dir, leaf: &str, quarantine: &str) -> Result<()> {
    #[cfg(windows)]
    {
        for attempt in 0..=10 {
            match rename_noreplace(root, leaf, root, quarantine) {
                Ok(()) => return Ok(()),
                Err(error)
                    if matches!(error.raw_os_error(), Some(32 | 33))
                        || error.kind() == ErrorKind::PermissionDenied =>
                {
                    if attempt == 10 {
                        return Err(session_worktree_error(
                            "SESSION_WORKTREE_BUSY",
                            "session worktree is still in use; retry",
                        ));
                    }
                    thread::sleep(Duration::from_millis(300));
                }
                Err(error) => return Err(map_session_worktree_io(error)),
            }
        }
        unreachable!()
    }
    #[cfg(unix)]
    rename_noreplace(root, leaf, root, quarantine).map_err(map_session_worktree_io)
}

fn remove_quarantined_session_worktree(root: &Dir, quarantine: &str) -> Result<()> {
    #[cfg(windows)]
    {
        for attempt in 0..=10 {
            match remove_session_worktree_entry(root, quarantine) {
                Ok(()) => return Ok(()),
                Err(error) if error.reason.starts_with("SESSION_WORKTREE_BUSY:") => {
                    if attempt == 10 {
                        return Err(error);
                    }
                    thread::sleep(Duration::from_millis(300));
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!()
    }
    #[cfg(unix)]
    remove_session_worktree_entry(root, quarantine)
}

fn valid_session_quarantine_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn session_worktree_identity_token(identity: &StableFileIdentity) -> String {
    format!("v1:{:016x}:{:016x}", identity.volume, identity.file)
}

fn parse_session_worktree_identity_token(token: &str) -> Result<StableFileIdentity> {
    let mut parts = token.split(':');
    if parts.next() != Some("v1") {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "invalid session worktree identity token",
        ));
    }
    let volume = parts.next();
    let file = parts.next();
    if parts.next().is_some()
        || volume.is_none_or(|part| part.len() != 16)
        || file.is_none_or(|part| part.len() != 16)
    {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "invalid session worktree identity token",
        ));
    }
    let volume = u64::from_str_radix(volume.unwrap(), 16).map_err(|_| {
        session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "invalid worktree volume identity",
        )
    })?;
    let file = u64::from_str_radix(file.unwrap(), 16).map_err(|_| {
        session_worktree_error("SESSION_WORKTREE_UNSAFE", "invalid worktree file identity")
    })?;
    Ok(StableFileIdentity { volume, file })
}

fn capture_session_worktree_identity(
    root: &Dir,
    root_path: &str,
    root_identity: &StableFileIdentity,
    target_path: &str,
) -> Result<String> {
    let leaf = validate_session_worktree_target(root_path, target_path)?;
    validate_session_worktree_root(root, root_path, root_identity)?;
    let expected = root
        .symlink_metadata(&leaf)
        .map_err(map_session_worktree_io)?;
    if !expected.is_dir() || session_entry_is_link(&expected) {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "final target is not a real directory",
        ));
    }
    let opened = nofollow_open(root, &leaf, false, true).map_err(map_session_worktree_io)?;
    let opened_metadata = opened.metadata().map_err(map_session_worktree_io)?;
    let identity = cap_file_identity(&opened_metadata)?;
    if !opened_metadata.is_dir()
        || session_entry_is_link(&opened_metadata)
        || identity != cap_file_identity(&expected)?
    {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "final target changed during identity capture",
        ));
    }
    Ok(session_worktree_identity_token(&identity))
}

fn reconcile_session_worktree_quarantines(
    root: &Dir,
    leaf: &str,
    expected_identity: &StableFileIdentity,
) -> Result<()> {
    let candidate_prefix = format!("{SESSION_WORKTREE_QUARANTINE_PREFIX}{leaf}-");
    let mut matching = root
        .entries()
        .map_err(map_session_worktree_io)?
        .map(|entry| {
            entry
                .map_err(map_session_worktree_io)?
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    session_worktree_error(
                        "SESSION_WORKTREE_UNSAFE",
                        "session worktree root contains a non-UTF-8 entry",
                    )
                })
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|name| {
            name.strip_prefix(&candidate_prefix)
                .is_some_and(valid_session_quarantine_nonce)
        })
        .collect::<Vec<_>>();
    matching.sort();
    if matching.len() > SESSION_WORKTREE_MAX_QUARANTINES {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_IO",
            "too many interrupted deletes require reconciliation",
        ));
    }
    for quarantine in matching {
        let metadata = root
            .symlink_metadata(&quarantine)
            .map_err(map_session_worktree_io)?;
        if !metadata.is_dir()
            || session_entry_is_link(&metadata)
            || cap_file_identity(&metadata)? != *expected_identity
        {
            return Err(session_worktree_error(
                "SESSION_WORKTREE_UNSAFE",
                "interrupted delete quarantine is not a real directory",
            ));
        }
        remove_quarantined_session_worktree(root, &quarantine)?;
    }
    if root
        .entries()
        .map_err(map_session_worktree_io)?
        .map(|entry| {
            entry
                .map_err(map_session_worktree_io)?
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    session_worktree_error(
                        "SESSION_WORKTREE_UNSAFE",
                        "session worktree root contains a non-UTF-8 entry",
                    )
                })
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .any(|name| {
            name.strip_prefix(&candidate_prefix)
                .is_some_and(valid_session_quarantine_nonce)
        })
    {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_IO",
            "interrupted delete quarantine remains",
        ));
    }
    Ok(())
}

fn delete_session_worktree(
    root: &Dir,
    root_path: &str,
    root_identity: &StableFileIdentity,
    target_path: &str,
    identity_token: &str,
) -> Result<()> {
    let leaf = validate_session_worktree_target(root_path, target_path)?;
    let expected_identity = parse_session_worktree_identity_token(identity_token)?;
    validate_session_worktree_root(root, root_path, root_identity)?;
    // Reconcile only private quarantines encoding this validated leaf. This must
    // precede the missing-target success path: an interrupted recursive removal
    // is still a failed delete and persisted metadata must survive until it is
    // actually completed.
    reconcile_session_worktree_quarantines(root, &leaf, &expected_identity)?;
    let expected = match root.symlink_metadata(&leaf) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(map_session_worktree_io(error)),
    };
    if !expected.is_dir()
        || session_entry_is_link(&expected)
        || cap_file_identity(&expected)? != expected_identity
    {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "final target is not a real directory",
        ));
    }
    let opened = nofollow_open(root, &leaf, false, true).map_err(map_session_worktree_io)?;
    let opened_metadata = opened.metadata().map_err(map_session_worktree_io)?;
    if !opened_metadata.is_dir()
        || session_entry_is_link(&opened_metadata)
        || cap_file_identity(&opened_metadata)? != cap_file_identity(&expected)?
    {
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "final target changed during validation",
        ));
    }
    // Windows directory handles deny delete sharing. Consume the validation
    // handle before the descriptor-relative quarantine rename.
    drop(opened);
    let quarantine = format!(
        "{SESSION_WORKTREE_QUARANTINE_PREFIX}{leaf}-{}",
        private_nonce().map_err(map_session_worktree_io)?
    );
    rename_session_worktree_to_quarantine(root, &leaf, &quarantine)?;
    let quarantined = root
        .symlink_metadata(&quarantine)
        .map_err(map_session_worktree_io)?;
    if cap_file_identity(&quarantined)? != cap_file_identity(&expected)? {
        let _ = rename_noreplace(root, &quarantine, root, &leaf);
        return Err(session_worktree_error(
            "SESSION_WORKTREE_UNSAFE",
            "target identity changed during quarantine",
        ));
    }
    remove_quarantined_session_worktree(root, &quarantine)?;
    sync_dir(root).map_err(map_session_worktree_io)
}

pub struct SessionWorktreeDeleteTask {
    root: Dir,
    root_path: String,
    root_identity: StableFileIdentity,
    target_path: String,
    identity_token: String,
}

impl Task for SessionWorktreeDeleteTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        delete_session_worktree(
            &self.root,
            &self.root_path,
            &self.root_identity,
            &self.target_path,
            &self.identity_token,
        )
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub struct SessionWorktreeStore {
    root: Dir,
    root_path: String,
    root_identity: StableFileIdentity,
}

#[napi]
impl SessionWorktreeStore {
    #[napi(constructor)]
    pub fn new(data_dir: String) -> Result<Self> {
        if !std::path::Path::new(&data_dir).is_absolute() {
            return Err(session_worktree_error(
                "SESSION_WORKTREE_UNSAFE",
                "app data directory must be absolute",
            ));
        }
        let data = Dir::open_ambient_dir(&data_dir, ambient_authority())
            .map_err(map_session_worktree_io)?;
        let root = open_child_dir(&data, SESSION_WORKTREE_ROOT, true)
            .map_err(map_session_worktree_io)?
            .ok_or_else(|| {
                session_worktree_error("SESSION_WORKTREE_UNSAFE", "root could not be established")
            })?;
        #[cfg(unix)]
        root.set_permissions(
            ".",
            cap_std::fs::Permissions::from_std(std::fs::Permissions::from_mode(0o700)),
        )
        .map_err(map_session_worktree_io)?;
        let root_path = {
            #[cfg(unix)]
            {
                std::fs::canonicalize(std::path::Path::new(&data_dir).join(SESSION_WORKTREE_ROOT))
                    .map_err(map_session_worktree_io)?
                    .to_string_lossy()
                    .into_owned()
            }
            #[cfg(windows)]
            {
                held_windows_final_path(&root).map_err(|_| {
                    session_worktree_error(
                        "SESSION_WORKTREE_UNSAFE",
                        "held root final path unavailable",
                    )
                })?
            }
        };
        let root_identity =
            cap_file_identity(&root.dir_metadata().map_err(map_session_worktree_io)?).map_err(
                |_| session_worktree_error("SESSION_WORKTREE_UNSAFE", "root identity unavailable"),
            )?;
        validate_session_worktree_root(&root, &root_path, &root_identity)?;
        Ok(Self {
            root,
            root_path,
            root_identity,
        })
    }

    #[napi(getter)]
    pub fn root_path(&self) -> String {
        self.root_path.clone()
    }

    #[napi]
    pub fn capture_worktree_identity(&self, target_path: String) -> Result<String> {
        capture_session_worktree_identity(
            &self.root,
            &self.root_path,
            &self.root_identity,
            &target_path,
        )
    }

    #[napi]
    pub fn delete_worktree(
        &self,
        target_path: String,
        identity_token: String,
    ) -> Result<AsyncTask<SessionWorktreeDeleteTask>> {
        // Validate synchronously so malformed persisted paths never enter the
        // worker queue, while deletion itself remains off the Node event loop.
        validate_session_worktree_target(&self.root_path, &target_path)?;
        Ok(AsyncTask::new(SessionWorktreeDeleteTask {
            root: self.root.try_clone().map_err(map_session_worktree_io)?,
            root_path: self.root_path.clone(),
            root_identity: self.root_identity.clone(),
            target_path,
            identity_token,
        }))
    }
}

fn validate_repository_id(repository_id: &str) -> Result<()> {
    if repository_id.is_empty()
        || repository_id.len() > 200
        || !repository_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(resource_error(
            "RESOURCE_INVALID_PATH",
            "invalid repository id",
        ));
    }
    Ok(())
}

fn snapshot_leaf(repository_id: &str) -> String {
    format!("{MANAGED_SNAPSHOT_PREFIX}{repository_id}")
}

fn cleanup_stale_snapshot_generations(snapshots: &Dir) -> Result<()> {
    let names = snapshots
        .entries()
        .map_err(map_resource_io)?
        .map(|entry| {
            entry
                .map_err(map_resource_io)?
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 snapshot entry")
                })
        })
        .collect::<Result<Vec<_>>>()?;
    for name in names {
        // Snapshot leaves are process-owned capabilities. On startup there are
        // no active Pi consumers, so clear prior-process leaves before rebuilding
        // the persisted records. Within a process each record has one stable leaf.
        if name.starts_with(MANAGED_SNAPSHOT_PREFIX)
            || name.starts_with(MANAGED_SNAPSHOT_STAGE_PREFIX)
        {
            remove_owned_managed_stage(snapshots, &name)?;
        }
    }
    Ok(())
}

#[derive(Default)]
struct SnapshotBounds {
    files: usize,
    bytes: u64,
}

fn create_private_dir(parent: &Dir, name: &str) -> Result<Dir> {
    parent.create_dir(name).map_err(map_resource_io)?;
    let child = open_child_dir(parent, name, false)
        .map_err(map_resource_io)?
        .ok_or_else(|| resource_error("RESOURCE_IO", "private directory disappeared"))?;
    #[cfg(unix)]
    child
        .set_permissions(
            ".",
            cap_std::fs::Permissions::from_std(std::fs::Permissions::from_mode(0o700)),
        )
        .map_err(map_resource_io)?;
    Ok(child)
}

fn copy_snapshot_tree(
    source: &Dir,
    destination: &Dir,
    depth: usize,
    bounds: &mut SnapshotBounds,
) -> Result<()> {
    if depth > MANAGED_SNAPSHOT_MAX_DEPTH {
        return Err(resource_error(
            "RESOURCE_INVALID_PATH",
            "snapshot tree is too deep",
        ));
    }
    let entries = source
        .entries()
        .map_err(map_resource_io)?
        .map(|entry| {
            entry
                .map_err(map_resource_io)?
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 skill entry"))
        })
        .collect::<Result<Vec<_>>>()?;
    for name in entries {
        if name == ".git" {
            continue;
        }
        if !valid_resource_component(&name) {
            return Err(resource_error(
                "RESOURCE_INVALID_PATH",
                "non-portable skill entry",
            ));
        }
        let metadata = source.symlink_metadata(&name).map_err(map_resource_io)?;
        if metadata.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "skill snapshot source contains a link",
            ));
        }
        if metadata.is_dir() {
            let source_child = open_child_dir(source, &name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| {
                    resource_error("RESOURCE_NOT_FOUND", "skill directory disappeared")
                })?;
            let destination_child = create_private_dir(destination, &name)?;
            copy_snapshot_tree(&source_child, &destination_child, depth + 1, bounds)?;
        } else if metadata.is_file() {
            if metadata.nlink() > 1 {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "skill file has multiple hard links",
                ));
            }
            bounds.files += 1;
            bounds.bytes = bounds.bytes.saturating_add(metadata.len());
            if bounds.files > MANAGED_SNAPSHOT_MAX_FILES
                || bounds.bytes > MANAGED_SNAPSHOT_MAX_BYTES
            {
                return Err(resource_error(
                    "RESOURCE_INVALID_PATH",
                    "skill snapshot exceeds safety bounds",
                ));
            }
            let mut input = nofollow_open(source, &name, false, false).map_err(map_resource_io)?;
            let opened = input.metadata().map_err(map_resource_io)?;
            if !opened.is_file()
                || opened.file_type().is_symlink()
                || !same_cap_file(&opened, &metadata)?
                || opened.nlink() > 1
            {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "skill file changed during snapshot",
                ));
            }
            let mut options = OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(FollowSymlinks::No)
                .maybe_dir(false);
            #[cfg(unix)]
            options.mode(0o600);
            let mut output = destination
                .open_with(&name, &options)
                .map_err(map_resource_io)?;
            std::io::copy(&mut input, &mut output).map_err(map_resource_io)?;
            output.sync_all().map_err(map_resource_io)?;
        } else {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "skill snapshot source is special",
            ));
        }
    }
    Ok(())
}

fn open_selected_skill_root(clone: &Dir, components: &[String]) -> Result<Dir> {
    let mut current = clone.try_clone().map_err(map_resource_io)?;
    for component in components {
        let next = open_child_dir(&current, component, false)
            .map_err(map_resource_io)?
            .ok_or_else(|| {
                resource_error("RESOURCE_NOT_FOUND", "selected skill root is missing")
            })?;
        current = next;
    }
    let manifest = current
        .symlink_metadata("SKILL.md")
        .map_err(map_resource_io)?;
    if !manifest.is_file() || manifest.file_type().is_symlink() || manifest.nlink() > 1 {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "SKILL.md is not a safe regular file",
        ));
    }
    Ok(current)
}

fn validate_snapshot_root_namespace(
    snapshots: &Dir,
    snapshots_path: &str,
    expected: &SnapshotIdentity,
) -> Result<()> {
    let canonical = std::fs::canonicalize(snapshots_path).map_err(map_resource_io)?;
    if canonical != std::path::Path::new(snapshots_path) {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "snapshot root namespace changed",
        ));
    }
    let ambient = std::fs::symlink_metadata(snapshots_path).map_err(map_resource_io)?;
    let held = snapshots.dir_metadata().map_err(map_resource_io)?;
    if ambient.file_type().is_symlink()
        || !ambient.is_dir()
        || ambient_file_identity(std::path::Path::new(snapshots_path))? != expected.0
        || cap_file_identity(&held)? != expected.0
    {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "snapshot root identity changed",
        ));
    }
    Ok(())
}

fn snapshot_result(
    snapshots_path: &str,
    repository_id: &str,
    skill_count: usize,
) -> ManagedSkillSnapshotResult {
    let generation = snapshot_leaf(repository_id);
    let skill_roots = (0..skill_count)
        .map(|index| {
            std::path::Path::new(snapshots_path)
                .join(&generation)
                .join("skills")
                .join(index.to_string())
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    ManagedSkillSnapshotResult {
        generation,
        skill_roots,
    }
}

fn validate_snapshot_tree(
    directory: &Dir,
    depth: usize,
    bounds: &mut SnapshotBounds,
) -> Result<()> {
    if depth > MANAGED_SNAPSHOT_MAX_DEPTH {
        return Err(resource_error(
            "RESOURCE_INVALID_PATH",
            "snapshot tree is too deep",
        ));
    }
    let names = directory
        .entries()
        .map_err(map_resource_io)?
        .map(|entry| {
            entry
                .map_err(map_resource_io)?
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 snapshot entry")
                })
        })
        .collect::<Result<Vec<_>>>()?;

    for name in names {
        if !valid_resource_component(&name) {
            return Err(resource_error(
                "RESOURCE_INVALID_PATH",
                "non-portable snapshot entry",
            ));
        }
        let expected = directory.symlink_metadata(&name).map_err(map_resource_io)?;
        if expected.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "snapshot tree contains a link or reparse point",
            ));
        }
        if expected.is_dir() {
            let child = open_child_dir(directory, &name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| {
                    resource_error("RESOURCE_NOT_FOUND", "snapshot entry disappeared")
                })?;
            let opened = child.dir_metadata().map_err(map_resource_io)?;
            if !same_cap_file(&opened, &expected)? {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "snapshot directory changed during validation",
                ));
            }
            validate_snapshot_tree(&child, depth + 1, bounds)?;
            let after = directory.symlink_metadata(&name).map_err(map_resource_io)?;
            if after.file_type().is_symlink()
                || !after.is_dir()
                || !same_cap_file(&after, &expected)?
            {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "snapshot directory changed during validation",
                ));
            }
        } else if expected.is_file() {
            if expected.nlink() > 1 {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "snapshot file is hard-linked",
                ));
            }
            bounds.files += 1;
            if bounds.files > MANAGED_SNAPSHOT_MAX_FILES {
                return Err(resource_error(
                    "RESOURCE_INVALID_PATH",
                    "skill snapshot exceeds safety bounds",
                ));
            }
            let mut file =
                nofollow_open(directory, &name, false, false).map_err(map_resource_io)?;
            let opened = file.metadata().map_err(map_resource_io)?;
            if opened.file_type().is_symlink()
                || !opened.is_file()
                || opened.nlink() > 1
                || !same_cap_file(&opened, &expected)?
                || opened.len() != expected.len()
            {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "snapshot file changed or is hard-linked",
                ));
            }
            let mut actual_len = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer).map_err(map_resource_io)?;
                if read == 0 {
                    break;
                }
                actual_len = actual_len.saturating_add(read as u64);
                if bounds.bytes.saturating_add(actual_len) > MANAGED_SNAPSHOT_MAX_BYTES {
                    return Err(resource_error(
                        "RESOURCE_INVALID_PATH",
                        "skill snapshot exceeds safety bounds",
                    ));
                }
            }
            let after_open = file.metadata().map_err(map_resource_io)?;
            let after_name = directory.symlink_metadata(&name).map_err(map_resource_io)?;
            if actual_len != opened.len()
                || !same_cap_file(&after_open, &opened)?
                || after_open.len() != opened.len()
                || after_open.nlink() > 1
                || after_name.file_type().is_symlink()
                || !after_name.is_file()
                || !same_cap_file(&after_name, &opened)?
                || after_name.len() != opened.len()
                || after_name.nlink() > 1
            {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "snapshot file changed during validation",
                ));
            }
            bounds.bytes += actual_len;
        } else {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "snapshot tree contains a special file",
            ));
        }
    }
    Ok(())
}

fn validate_snapshot_manifest(root: &Dir) -> Result<()> {
    let expected = root.symlink_metadata("SKILL.md").map_err(map_resource_io)?;
    if expected.file_type().is_symlink() || !expected.is_file() || expected.nlink() > 1 {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "snapshot SKILL.md is unsafe",
        ));
    }
    let opened = nofollow_open(root, "SKILL.md", false, false).map_err(map_resource_io)?;
    let metadata = opened.metadata().map_err(map_resource_io)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() > 1
        || !same_cap_file(&metadata, &expected)?
    {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "snapshot SKILL.md changed during validation",
        ));
    }
    Ok(())
}

fn validate_managed_snapshot(
    snapshots: &Dir,
    snapshots_path: &str,
    snapshots_identity: &SnapshotIdentity,
    repository_id: &str,
    identity: &ManagedSnapshotIdentity,
) -> Result<ManagedSkillSnapshotResult> {
    validate_snapshot_root_namespace(snapshots, snapshots_path, snapshots_identity)?;
    let leaf = snapshot_leaf(repository_id);
    let metadata = snapshots.symlink_metadata(&leaf).map_err(map_resource_io)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || cap_file_identity(&metadata)? != identity.leaf.0
    {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "active snapshot leaf identity changed",
        ));
    }
    let repository = open_child_dir(snapshots, &leaf, false)
        .map_err(map_resource_io)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "snapshot leaf disappeared"))?;
    let expected_skills = repository
        .symlink_metadata("skills")
        .map_err(map_resource_io)?;
    let skills = open_child_dir(&repository, "skills", false)
        .map_err(map_resource_io)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "snapshot skills disappeared"))?;
    let opened_skills = skills.dir_metadata().map_err(map_resource_io)?;
    if !same_cap_file(&opened_skills, &expected_skills)? {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "snapshot skills identity changed",
        ));
    }
    let mut bounds = SnapshotBounds::default();
    for index in 0..identity.skill_count {
        let name = index.to_string();
        let expected_root = skills.symlink_metadata(&name).map_err(map_resource_io)?;
        let root = open_child_dir(&skills, &name, false)
            .map_err(map_resource_io)?
            .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "snapshot skill disappeared"))?;
        let opened_root = root.dir_metadata().map_err(map_resource_io)?;
        if !same_cap_file(&opened_root, &expected_root)? {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "snapshot skill identity changed",
            ));
        }
        validate_snapshot_manifest(&root)?;
        validate_snapshot_tree(&root, 0, &mut bounds)?;
        // Re-open the required manifest after the full traversal so a concurrent
        // replacement cannot hide behind validation of an earlier handle.
        validate_snapshot_manifest(&root)?;
        let after_root = skills.symlink_metadata(&name).map_err(map_resource_io)?;
        if after_root.file_type().is_symlink()
            || !after_root.is_dir()
            || !same_cap_file(&after_root, &expected_root)?
        {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "snapshot skill changed during validation",
            ));
        }
    }
    let after_skills = repository
        .symlink_metadata("skills")
        .map_err(map_resource_io)?;
    if after_skills.file_type().is_symlink()
        || !after_skills.is_dir()
        || !same_cap_file(&after_skills, &expected_skills)?
    {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "snapshot skills changed during validation",
        ));
    }
    Ok(snapshot_result(
        snapshots_path,
        repository_id,
        identity.skill_count,
    ))
}

struct SnapshotAuthority<'a> {
    root: &'a Dir,
    path: &'a str,
    identity: &'a SnapshotIdentity,
    active: &'a Arc<Mutex<HashMap<String, ManagedSnapshotIdentity>>>,
}

fn materialize_managed_snapshot(
    root: &Dir,
    authority: SnapshotAuthority<'_>,
    repository_leaf: &str,
    repository_id: &str,
    selected_roots: &[Vec<String>],
) -> Result<ManagedSkillSnapshotResult> {
    let snapshots = authority.root;
    let snapshots_path = authority.path;
    let snapshots_identity = authority.identity;
    let snapshot_identities = authority.active;
    validate_snapshot_root_namespace(snapshots, snapshots_path, snapshots_identity)?;
    let (_identity, clone) = capture_managed_clone(root, repository_leaf)?;
    let nonce = private_nonce().map_err(map_resource_io)?;
    let stage_leaf = format!("{MANAGED_SNAPSHOT_STAGE_PREFIX}{nonce}");
    let stage = create_private_dir(snapshots, &stage_leaf)?;
    let build_result = (|| -> Result<()> {
        // Keep every child capability inside this construction scope. Windows
        // opens these without delete sharing, so none may survive publication.
        let skills = create_private_dir(&stage, "skills")?;
        let mut bounds = SnapshotBounds::default();
        for (index, components) in selected_roots.iter().enumerate() {
            let source = open_selected_skill_root(&clone, components)?;
            let destination = create_private_dir(&skills, &index.to_string())?;
            copy_snapshot_tree(&source, &destination, 0, &mut bounds)?;
            // `source` and `destination` are dropped at the end of each loop
            // iteration, before the `skills` capability is dropped here.
        }
        Ok(())
    })();
    // The clone and every selected source capability are no longer needed once
    // staging is complete; close them before any Windows rename or cleanup.
    drop(clone);
    if let Err(error) = build_result {
        // The stage itself must also close before recursive cleanup on Windows.
        drop(stage);
        return Err(cleanup_owned_managed_stage_error(
            snapshots,
            &stage_leaf,
            error,
        ));
    }

    let leaf = snapshot_leaf(repository_id);
    let repository = match open_child_dir(snapshots, &leaf, false).map_err(map_resource_io)? {
        Some(repository) => repository,
        None => create_private_dir(snapshots, &leaf)?,
    };
    let leaf_metadata = repository.dir_metadata().map_err(map_resource_io)?;
    if let Some(expected) = snapshot_identities
        .lock()
        .map_err(|_| resource_error("RESOURCE_IO", "snapshot identity lock poisoned"))?
        .get(repository_id)
        .cloned()
    {
        if cap_file_identity(&leaf_metadata)? != expected.leaf.0 {
            drop(repository);
            drop(stage);
            return Err(cleanup_owned_managed_stage_error(
                snapshots,
                &stage_leaf,
                resource_error("RESOURCE_UNSAFE_COMPONENT", "active snapshot leaf changed"),
            ));
        }
    }

    match repository.symlink_metadata("skills") {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                drop(repository);
                drop(stage);
                return Err(cleanup_owned_managed_stage_error(
                    snapshots,
                    &stage_leaf,
                    resource_error(
                        "RESOURCE_UNSAFE_COMPONENT",
                        "active snapshot skills changed",
                    ),
                ));
            }
            #[cfg(unix)]
            {
                exchange_entries(&stage, "skills", &repository, "skills")
                    .map_err(map_resource_io)?;
                remove_tree_entry(&stage, "skills")?;
            }
            #[cfg(windows)]
            {
                let old = format!("old-{nonce}");
                rename_noreplace(&repository, "skills", &repository, &old)
                    .map_err(map_resource_io)?;
                if let Err(error) = rename_noreplace(&stage, "skills", &repository, "skills") {
                    let _ = rename_noreplace(&repository, &old, &repository, "skills");
                    drop(repository);
                    drop(stage);
                    return Err(cleanup_owned_managed_stage_error(
                        snapshots,
                        &stage_leaf,
                        map_resource_io(error),
                    ));
                }
                remove_tree_entry(&repository, &old)?;
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if let Err(error) = rename_noreplace(&stage, "skills", &repository, "skills") {
                drop(repository);
                drop(stage);
                return Err(cleanup_owned_managed_stage_error(
                    snapshots,
                    &stage_leaf,
                    map_resource_io(error),
                ));
            }
        }
        Err(error) => {
            drop(repository);
            drop(stage);
            return Err(cleanup_owned_managed_stage_error(
                snapshots,
                &stage_leaf,
                map_resource_io(error),
            ));
        }
    }
    // Publication moved `skills` out; close the now-empty stage handle before
    // deleting its directory on Windows.
    drop(stage);
    remove_owned_managed_stage(snapshots, &stage_leaf)?;
    sync_dir(&repository).map_err(map_resource_io)?;
    sync_dir(snapshots).map_err(map_resource_io)?;
    validate_snapshot_root_namespace(snapshots, snapshots_path, snapshots_identity)?;
    let identity = ManagedSnapshotIdentity {
        leaf: SnapshotIdentity(cap_file_identity(&leaf_metadata)?),
        skill_count: selected_roots.len(),
    };
    snapshot_identities
        .lock()
        .map_err(|_| resource_error("RESOURCE_IO", "snapshot identity lock poisoned"))?
        .insert(repository_id.to_owned(), identity.clone());
    validate_managed_snapshot(
        snapshots,
        snapshots_path,
        snapshots_identity,
        repository_id,
        &identity,
    )
}

fn validate_managed_leaf(leaf: &str) -> Result<()> {
    if !valid_resource_component(leaf) || leaf.starts_with(MANAGED_STAGE_PREFIX) {
        return Err(resource_error(
            "RESOURCE_INVALID_PATH",
            "invalid managed repository leaf",
        ));
    }
    Ok(())
}

fn allocate_managed_stage(root: &Dir) -> Result<(String, Dir)> {
    for _ in 0..128 {
        let leaf = format!(
            "{MANAGED_STAGE_PREFIX}{}",
            private_nonce().map_err(map_resource_io)?
        );
        match root.create_dir(&leaf) {
            Ok(()) => {
                let stage = open_child_dir(root, &leaf, false)
                    .map_err(map_resource_io)?
                    .ok_or_else(|| {
                        resource_error("RESOURCE_UNSAFE_COMPONENT", "stage disappeared")
                    })?;
                return Ok((leaf, stage));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(map_resource_io(error)),
        }
    }
    Err(resource_error(
        "RESOURCE_ALREADY_EXISTS",
        "could not allocate managed stage",
    ))
}

fn capture_managed_clone(root: &Dir, leaf: &str) -> Result<(cap_std::fs::Metadata, Dir)> {
    validate_managed_leaf(leaf)?;
    let expected = root.symlink_metadata(leaf).map_err(map_resource_io)?;
    if !expected.is_dir() || expected.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "managed clone is not a real directory",
        ));
    }
    let clone = open_child_dir(root, leaf, false)
        .map_err(map_resource_io)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "managed clone disappeared"))?;
    let opened = clone.dir_metadata().map_err(map_resource_io)?;
    if opened.dev() != expected.dev() || opened.ino() != expected.ino() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "managed clone identity changed",
        ));
    }
    Ok((expected, clone))
}

fn read_bounded(mut stream: impl Read) -> std::io::Result<(Vec<u8>, bool)> {
    let mut retained = Vec::new();
    let mut overflow = false;
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        let remaining = MANAGED_GIT_OUTPUT_LIMIT.saturating_sub(retained.len());
        let keep = remaining.min(read);
        retained.extend_from_slice(&chunk[..keep]);
        if keep < read {
            overflow = true;
        }
        // Always continue draining. Stopping at the retention bound can fill the
        // pipe and deadlock the child before it exits.
    }
    Ok((retained, overflow))
}

fn managed_git_timeout() -> Duration {
    std::env::var("AGENT_DECK_MANAGED_GIT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(MANAGED_GIT_TIMEOUT)
}

fn run_managed_git(
    dir: &Dir,
    current_path: &str,
    args: &[&str],
    cancelled: &AtomicBool,
) -> Result<String> {
    let binary = std::env::var("AGENT_DECK_GIT_BIN").unwrap_or_else(|_| "git".into());
    let mut command = Command::new(binary);
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd as _;
        use std::os::unix::process::CommandExt as _;
        let fd = dir.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fchdir(fd) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }
    #[cfg(windows)]
    {
        let _ = dir;
        command.current_dir(current_path);
    }
    #[cfg(unix)]
    let _ = current_path;

    let mut child = command.spawn().map_err(map_resource_io)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| resource_error("RESOURCE_IO", "missing git stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| resource_error("RESOURCE_IO", "missing git stderr"))?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));
    let started = Instant::now();
    let timeout = managed_git_timeout();
    let mut timed_out = false;
    let mut wait_error = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < timeout && !cancelled.load(Ordering::Acquire) => {
                thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                timed_out = !cancelled.load(Ordering::Acquire);
                #[cfg(unix)]
                unsafe {
                    // The child established its own process group in pre_exec;
                    // kill descendants before reaping the group leader.
                    libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
                }
                #[cfg(windows)]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                    let _ = child.kill();
                }
                break child.wait().ok();
            }
            Err(error) => {
                wait_error = Some(error);
                #[cfg(unix)]
                unsafe {
                    libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
                }
                #[cfg(windows)]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                    let _ = child.kill();
                }
                let _ = child.wait();
                break None;
            }
        }
    };
    // Join both readers exactly once on every exit path, after the child and its
    // descendants no longer hold inherited pipe handles.
    let stdout_result = stdout_reader
        .join()
        .map_err(|_| resource_error("RESOURCE_IO", "git stdout reader failed"))?;
    let stderr_result = stderr_reader
        .join()
        .map_err(|_| resource_error("RESOURCE_IO", "git stderr reader failed"))?;
    let (stdout, stdout_overflow) = stdout_result.map_err(map_resource_io)?;
    let (stderr, stderr_overflow) = stderr_result.map_err(map_resource_io)?;
    if let Some(error) = wait_error {
        return Err(map_resource_io(error));
    }
    if stdout_overflow || stderr_overflow {
        return Err(resource_error(
            "RESOURCE_OUTPUT_LIMIT",
            "managed git output exceeded limit",
        ));
    }
    if timed_out {
        return Err(resource_error("RESOURCE_BUSY", "managed git timed out"));
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(resource_error("RESOURCE_BUSY", "managed git was cancelled"));
    }
    let status =
        status.ok_or_else(|| resource_error("RESOURCE_IO", "managed git was not reaped"))?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let redacted = detail.lines().next().unwrap_or("git failed");
        return Err(resource_error(
            "RESOURCE_IO",
            format!("managed git failed: {redacted}"),
        ));
    }
    String::from_utf8(stdout)
        .map_err(|_| resource_error("RESOURCE_INVALID_UTF8", "managed git emitted invalid UTF-8"))
}

fn inspect_stage(
    stage: &Dir,
    stage_path: &str,
    reference: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<ManagedGitRepositoryResult> {
    let status = run_managed_git(
        stage,
        stage_path,
        &["status", "--porcelain=v1", "--branch"],
        cancelled,
    )?;
    let head = run_managed_git(stage, stage_path, &["rev-parse", "HEAD"], cancelled)?
        .trim()
        .to_owned();
    let origin = run_managed_git(
        stage,
        stage_path,
        &["remote", "get-url", "origin"],
        cancelled,
    )?
    .trim()
    .to_owned();
    let ref_matches = if let Some(reference) = reference {
        [
            reference.to_owned(),
            format!("refs/heads/{reference}"),
            format!("refs/remotes/origin/{reference}"),
        ]
        .iter()
        .any(|candidate| {
            run_managed_git(
                stage,
                stage_path,
                &["rev-parse", "--verify", &format!("{candidate}^{{commit}}")],
                cancelled,
            )
            .is_ok_and(|commit| commit.trim() == head)
        })
    } else {
        true
    };
    Ok(ManagedGitRepositoryResult {
        head,
        origin,
        clean: status.lines().all(|line| line.starts_with("## ")),
        ref_matches,
    })
}

fn validate_managed_git_tree(dir: &Dir) -> Result<()> {
    for entry in dir.entries().map_err(map_resource_io)? {
        let entry = entry.map_err(map_resource_io)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 git entry"))?;
        if !valid_resource_component(&name) {
            return Err(resource_error(
                "RESOURCE_INVALID_PATH",
                "non-portable git entry",
            ));
        }
        let metadata = dir.symlink_metadata(&name).map_err(map_resource_io)?;
        if metadata.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "managed clone contains a link",
            ));
        }
        if metadata.is_dir() {
            let child = open_child_dir(dir, &name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "git directory disappeared"))?;
            validate_managed_git_tree(&child)?;
        } else if !metadata.is_file() || metadata.nlink() > 1 {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "managed clone contains a special or aliased file",
            ));
        }
    }
    Ok(())
}

fn remove_owned_managed_stage(root: &Dir, stage_leaf: &str) -> Result<()> {
    fn remove_owned_entry(parent: &Dir, name: &str) -> Result<()> {
        let metadata = parent.symlink_metadata(name).map_err(map_resource_io)?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            let child = open_child_dir(parent, name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "owned stage disappeared"))?;
            let names = child
                .entries()
                .map_err(map_resource_io)?
                .map(|entry| {
                    entry
                        .map_err(map_resource_io)?
                        .file_name()
                        .to_str()
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 stage entry")
                        })
                })
                .collect::<Result<Vec<_>>>()?;
            for child_name in names {
                remove_owned_entry(&child, &child_name)?;
            }
            drop(child);
            parent.remove_dir(name).map_err(map_resource_io)
        } else {
            parent.remove_file(name).map_err(map_resource_io)
        }
    }
    remove_owned_entry(root, stage_leaf)
}

fn cleanup_owned_managed_stage_error(root: &Dir, stage_leaf: &str, original: Error) -> Error {
    if remove_owned_managed_stage(root, stage_leaf).is_err() {
        resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "managed clone failed and private-stage cleanup was interrupted",
        )
    } else {
        original
    }
}

/// Consume the stage capability before cleanup. Windows opens directory
/// capabilities without delete sharing, so cleanup while `stage` is alive
/// self-blocks and masks the operation's original typed error.
fn finish_managed_stage<T>(
    root: &Dir,
    stage_leaf: &str,
    stage: Dir,
    result: Result<T>,
) -> Result<T> {
    drop(stage);
    match remove_owned_managed_stage(root, stage_leaf) {
        Ok(()) => result,
        Err(_) => Err(resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "managed operation finished but private-stage cleanup was interrupted",
        )),
    }
}

fn publish_managed_stage(
    root: &Dir,
    stage_leaf: &str,
    stage: Dir,
    destination: &str,
    replace: bool,
    expected_identity: Option<ExpectedEntryIdentity>,
) -> Result<()> {
    drop(stage);
    publish_staged_tree_with_identity(root, stage_leaf, destination, replace, expected_identity)
}

fn managed_clone(
    root: &Dir,
    root_path: &str,
    remote: &str,
    reference: Option<&str>,
    destination: &str,
    cancelled: &AtomicBool,
) -> Result<ManagedGitRepositoryResult> {
    validate_managed_leaf(destination)?;
    let (stage_leaf, stage) = allocate_managed_stage(root)?;
    let stage_path = std::path::Path::new(root_path)
        .join(&stage_leaf)
        .to_string_lossy()
        .into_owned();
    let mut args = vec!["clone", "--no-hardlinks"];
    if let Some(reference) = reference {
        args.extend(["--branch", reference, "--single-branch"]);
    }
    args.extend([remote, "."]);
    let operation = (|| -> Result<ManagedGitRepositoryResult> {
        run_managed_git(&stage, &stage_path, &args, cancelled)?;
        validate_managed_git_tree(&stage)?;
        inspect_stage(&stage, &stage_path, reference, cancelled)
    })();
    let result = match operation {
        Ok(result) => result,
        Err(error) => return finish_managed_stage(root, &stage_leaf, stage, Err(error)),
    };
    // Publishing consumes the stage capability before renaming its directory.
    publish_managed_stage(root, &stage_leaf, stage, destination, false, None)?;
    Ok(result)
}

fn copy_clone_to_stage(root: &Dir, leaf: &str) -> Result<(String, Dir, cap_std::fs::Metadata)> {
    let (identity, source) = capture_managed_clone(root, leaf)?;
    let (stage_leaf, stage) = allocate_managed_stage(root)?;
    let copy_result = copy_tree_inner(&source, &stage, true);
    drop(source);
    if let Err(error) = copy_result {
        return finish_managed_stage(root, &stage_leaf, stage, Err(error));
    }
    Ok((stage_leaf, stage, identity))
}

fn managed_inspect(
    root: &Dir,
    root_path: &str,
    leaf: &str,
    reference: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<ManagedGitRepositoryResult> {
    let (stage_leaf, stage, _) = copy_clone_to_stage(root, leaf)?;
    let stage_path = std::path::Path::new(root_path)
        .join(&stage_leaf)
        .to_string_lossy()
        .into_owned();
    let result = inspect_stage(&stage, &stage_path, reference, cancelled);
    finish_managed_stage(root, &stage_leaf, stage, result)
}

fn managed_update(
    root: &Dir,
    root_path: &str,
    leaf: &str,
    reference: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<ManagedGitRepositoryResult> {
    #[cfg(windows)]
    return managed_update_windows(root, root_path, leaf, reference, cancelled);

    #[cfg(unix)]
    {
        let (stage_leaf, stage, expected) = copy_clone_to_stage(root, leaf)?;
        let stage_path = std::path::Path::new(root_path)
            .join(&stage_leaf)
            .to_string_lossy()
            .into_owned();
        let operation = (|| -> Result<ManagedGitRepositoryResult> {
            let before = inspect_stage(&stage, &stage_path, reference, cancelled)?;
            if !before.clean {
                return Err(resource_error(
                    "RESOURCE_BUSY",
                    "managed repository is dirty",
                ));
            }
            let branch = if let Some(reference) = reference {
                reference.to_owned()
            } else {
                run_managed_git(
                    &stage,
                    &stage_path,
                    &["rev-parse", "--abbrev-ref", "HEAD"],
                    cancelled,
                )?
                .trim()
                .to_owned()
            };
            run_managed_git(
                &stage,
                &stage_path,
                &["fetch", "origin", &branch],
                cancelled,
            )?;
            run_managed_git(
                &stage,
                &stage_path,
                &["reset", "--hard", "FETCH_HEAD"],
                cancelled,
            )?;
            let result = inspect_stage(&stage, &stage_path, reference, cancelled)?;
            validate_managed_git_tree(&stage)?;
            let current = root.symlink_metadata(leaf).map_err(map_resource_io)?;
            if current.dev() != expected.dev() || current.ino() != expected.ino() {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "managed clone changed during update",
                ));
            }
            Ok(result)
        })();
        let result = match operation {
            Ok(result) => result,
            Err(error) => return finish_managed_stage(root, &stage_leaf, stage, Err(error)),
        };
        let expected_identity = (expected.dev(), expected.ino());
        publish_managed_stage(
            root,
            &stage_leaf,
            stage,
            leaf,
            true,
            Some(expected_identity),
        )?;
        Ok(result)
    }
}

#[cfg(windows)]
fn managed_update_windows(
    root: &Dir,
    root_path: &str,
    leaf: &str,
    reference: Option<&str>,
    cancelled: &AtomicBool,
) -> Result<ManagedGitRepositoryResult> {
    let (_expected, clone) = capture_managed_clone(root, leaf)?;
    let clone_path = std::path::Path::new(root_path)
        .join(leaf)
        .to_string_lossy()
        .into_owned();
    let before = inspect_stage(&clone, &clone_path, reference, cancelled)?;
    if !before.clean {
        return Err(resource_error(
            "RESOURCE_BUSY",
            "managed repository is dirty",
        ));
    }
    let branch = if let Some(reference) = reference {
        reference.to_owned()
    } else {
        run_managed_git(
            &clone,
            &clone_path,
            &["rev-parse", "--abbrev-ref", "HEAD"],
            cancelled,
        )?
        .trim()
        .to_owned()
    };
    run_managed_git(
        &clone,
        &clone_path,
        &["fetch", "origin", &branch],
        cancelled,
    )?;
    run_managed_git(
        &clone,
        &clone_path,
        &["reset", "--hard", "FETCH_HEAD"],
        cancelled,
    )?;
    inspect_stage(&clone, &clone_path, reference, cancelled)
}

fn delete_managed_from_root(root: &Dir, repository_leaf: &str) -> Result<()> {
    let (expected, held) = capture_managed_clone(root, repository_leaf)?;
    #[cfg(windows)]
    drop(held);
    #[cfg(unix)]
    let _held = held;
    let quarantine = format!(
        "{RESOURCE_TEMP_PREFIX}managed-delete-{}",
        private_nonce().map_err(map_resource_io)?
    );
    rename_noreplace(root, repository_leaf, root, &quarantine).map_err(map_resource_io)?;
    let exchanged = root
        .symlink_metadata(&quarantine)
        .map_err(map_resource_io)?;
    if exchanged.dev() != expected.dev() || exchanged.ino() != expected.ino() {
        let _ = rename_noreplace(root, &quarantine, root, repository_leaf);
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "managed clone changed during delete",
        ));
    }
    if let Err(error) = remove_tree_entry(root, &quarantine) {
        if rename_noreplace(root, &quarantine, root, repository_leaf).is_err() {
            return Err(resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "managed repository quarantine could not be rolled back",
            ));
        }
        return Err(error);
    }
    sync_dir(root).map_err(map_resource_io)
}

fn open_source_root(source_path: &str) -> Result<Dir> {
    let source = std::path::Path::new(source_path);
    let parent_path = source
        .parent()
        .ok_or_else(|| resource_error("RESOURCE_INVALID_PATH", "source has no parent"))?;
    let leaf = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| resource_error("RESOURCE_INVALID_PATH", "invalid source name"))?;
    let parent =
        Dir::open_ambient_dir(parent_path, ambient_authority()).map_err(map_resource_io)?;
    let metadata = parent.symlink_metadata(leaf).map_err(map_resource_io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "source is not a regular directory",
        ));
    }
    let opened = nofollow_open(&parent, leaf, false, true).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            map_resource_io(error)
        } else {
            resource_error("RESOURCE_UNSAFE_COMPONENT", error.kind().to_string())
        }
    })?;
    let metadata = opened.metadata().map_err(map_resource_io)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "source is not a regular directory",
        ));
    }
    Ok(Dir::from_std_file(opened.into_std()))
}

fn unique_resource_temp(
    dir: &Dir,
    prefix: &str,
    content: &str,
) -> Result<(String, cap_std::fs::File)> {
    for _ in 0..128 {
        let name = format!("{prefix}{}", private_nonce().map_err(map_resource_io)?);
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No)
            .maybe_dir(false);
        #[cfg(unix)]
        options.mode(0o600);

        match dir.open_with(&name, &options) {
            Ok(mut file) => {
                if let Err(error) = file
                    .write_all(content.as_bytes())
                    .and_then(|()| file.sync_all())
                {
                    drop(file);
                    let cleanup = dir.remove_file(&name).map_err(map_resource_io);
                    if cleanup.is_err() {
                        return Err(resource_error(
                            "RESOURCE_RECONCILE_INCOMPLETE",
                            "private-temporary write cleanup was interrupted; retry",
                        ));
                    }
                    return Err(map_resource_io(error));
                }
                return Ok((name, file));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(map_resource_io(error)),
        }
    }
    Err(resource_error(
        "RESOURCE_ALREADY_EXISTS",
        "could not allocate private resource temporary file",
    ))
}

#[napi]
pub fn read_resource_catalog_file(
    home: String,
    catalog: String,
    components: Vec<String>,
) -> Result<String> {
    let dir = open_resource_catalog(&home, &catalog, false)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "catalog does not exist"))?;
    let (parent, leaf) = open_resource_parent(&dir, &components, false)?;
    regular_metadata(&parent, &leaf)?;
    let mut file = nofollow_open(&parent, &leaf, false, false).map_err(map_resource_io)?;
    if !file.metadata().map_err(map_resource_io)?.is_file() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "target changed type",
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(map_resource_io)?;
    String::from_utf8(bytes)
        .map_err(|_| resource_error("RESOURCE_INVALID_UTF8", "resource is not UTF-8"))
}

#[napi]
pub fn write_resource_catalog_file(
    home: String,
    catalog: String,
    components: Vec<String>,
    content: String,
    create_only: bool,
) -> Result<()> {
    let dir = open_resource_catalog(&home, &catalog, true)?
        .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "catalog unavailable"))?;
    let (parent, leaf) = open_resource_parent(&dir, &components, true)?;
    let replace_existing = if create_only {
        if parent.symlink_metadata(&leaf).is_ok() {
            return Err(resource_error("RESOURCE_ALREADY_EXISTS", "target exists"));
        }
        false
    } else if parent.symlink_metadata(&leaf).is_ok() {
        regular_metadata(&parent, &leaf)?;
        true
    } else {
        false
    };
    let (temp, file) = unique_resource_temp(&parent, RESOURCE_TEMP_PREFIX, &content)?;
    drop(file);
    let result = if replace_existing {
        parent.rename(&temp, &parent, &leaf)
    } else {
        parent.hard_link(&temp, &parent, &leaf)
    };
    if let Err(error) = result {
        if parent.remove_file(&temp).is_err() {
            return Err(resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "resource write failed and private-temporary cleanup was interrupted; retry",
            ));
        }
        return Err(if replace_existing {
            map_validated_resource_mutation_io(error)
        } else {
            map_resource_io(error)
        });
    }
    if !replace_existing && parent.remove_file(&temp).is_err() {
        return Err(resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "resource write succeeded but private-temporary cleanup was interrupted; retry",
        ));
    }
    sync_dir(&parent).map_err(map_resource_io)
}

fn remove_tree_entry(parent: &Dir, name: &str) -> Result<()> {
    let metadata = parent.symlink_metadata(name).map_err(map_resource_io)?;
    if metadata.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "links are not resource mutation targets",
        ));
    }
    if metadata.is_file() {
        return parent.remove_file(name).map_err(map_resource_io);
    }
    if !metadata.is_dir() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "unsupported file type",
        ));
    }
    let child = open_child_dir(parent, name, false)
        .map_err(map_resource_io)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "directory disappeared"))?;
    let mut names = Vec::new();
    for entry in child.entries().map_err(map_resource_io)? {
        names.push(
            entry
                .map_err(map_resource_io)?
                .file_name()
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 resource name")
                })?,
        );
    }
    names.sort();
    for entry_name in names {
        remove_tree_entry(&child, &entry_name)?;
    }
    drop(child);
    parent.remove_dir(name).map_err(map_resource_io)
}

#[napi]
pub fn remove_resource_catalog_entry(
    home: String,
    catalog: String,
    components: Vec<String>,
) -> Result<()> {
    let dir = open_resource_catalog(&home, &catalog, false)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "catalog does not exist"))?;
    let (parent, leaf) = open_resource_parent(&dir, &components, false)?;
    remove_tree_entry(&parent, &leaf)?;
    sync_dir(&parent).map_err(map_resource_io)
}

#[napi]
pub fn rename_resource_catalog_entry(
    home: String,
    catalog: String,
    from_components: Vec<String>,
    to_components: Vec<String>,
    replacement_content: Option<String>,
) -> Result<()> {
    let dir = open_resource_catalog(&home, &catalog, false)?
        .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "catalog does not exist"))?;
    let (from_parent, from_leaf) = open_resource_parent(&dir, &from_components, false)?;
    let (to_parent, to_leaf) = open_resource_parent(&dir, &to_components, true)?;
    let source = from_parent
        .symlink_metadata(&from_leaf)
        .map_err(map_resource_io)?;
    if source.file_type().is_symlink() || (!source.is_file() && !source.is_dir()) {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "source is not a regular file or directory",
        ));
    }
    let case_only = from_components.len() == to_components.len()
        && from_components
            .iter()
            .zip(&to_components)
            .all(|(left, right)| left.eq_ignore_ascii_case(right));
    if replacement_content.is_some() && !source.is_file() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "replacement content requires a regular file",
        ));
    }
    let replacement = if let Some(content) = replacement_content.as_deref() {
        let (name, file) = unique_resource_temp(&to_parent, RESOURCE_TEMP_PREFIX, content)?;
        drop(file);
        Some(name)
    } else {
        None
    };
    if case_only && to_parent.symlink_metadata(&to_leaf).is_ok() {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = format!(
            "{RESOURCE_BACKUP_PREFIX}rename-{}-{sequence:016x}",
            std::process::id()
        );
        if let Err(error) = from_parent.rename(&from_leaf, &from_parent, &temporary) {
            if replacement
                .as_ref()
                .is_some_and(|replacement| to_parent.remove_file(replacement).is_err())
            {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource rename failed and private-temporary cleanup was interrupted; retry",
                ));
            }
            return Err(map_resource_io(error));
        }
        if to_parent.symlink_metadata(&to_leaf).is_ok() {
            let rollback = rename_noreplace(&from_parent, &temporary, &from_parent, &from_leaf);
            let cleanup = replacement
                .as_ref()
                .map(|replacement| to_parent.remove_file(replacement));
            if rollback.is_err() || cleanup.is_some_and(|result| result.is_err()) {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource rename rollback or private-temporary cleanup was interrupted; retry",
                ));
            }
            return Err(resource_error("RESOURCE_ALREADY_EXISTS", "target exists"));
        }
        let result = if let Some(replacement) = &replacement {
            rename_noreplace(&to_parent, replacement, &to_parent, &to_leaf)
        } else {
            rename_noreplace(&from_parent, &temporary, &to_parent, &to_leaf)
        };
        if let Err(error) = result {
            let rollback = rename_noreplace(&from_parent, &temporary, &from_parent, &from_leaf);
            let cleanup = replacement
                .as_ref()
                .map(|replacement| to_parent.remove_file(replacement));
            if rollback.is_err() || cleanup.is_some_and(|result| result.is_err()) {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource rename rollback or private-temporary cleanup was interrupted; retry",
                ));
            }
            return Err(map_resource_io(error));
        }
        if replacement.is_some() {
            if let Err(_error) = from_parent.remove_file(&temporary) {
                // The old source is still recoverable under `temporary`.
                // Remove the new publication and restore it when possible.
                let rollback = to_parent.remove_file(&to_leaf).and_then(|()| {
                    rename_noreplace(&from_parent, &temporary, &from_parent, &from_leaf)
                });
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    if rollback.is_ok() {
                        "resource rename cleanup was interrupted and the operation was rolled back; retry"
                    } else {
                        "resource rename cleanup and rollback were interrupted; retry"
                    },
                ));
            }
        }
    } else if source.is_file() {
        let source_name = replacement.as_deref().unwrap_or(&from_leaf);
        let source_parent = if replacement.is_some() {
            &to_parent
        } else {
            &from_parent
        };
        if let Err(error) = source_parent.hard_link(source_name, &to_parent, &to_leaf) {
            if replacement
                .as_ref()
                .is_some_and(|replacement| to_parent.remove_file(replacement).is_err())
            {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource rename failed and private-temporary cleanup was interrupted; retry",
                ));
            }
            return Err(map_resource_io(error));
        }
        if let Err(error) = from_parent.remove_file(&from_leaf) {
            let publication_cleanup = to_parent.remove_file(&to_leaf);
            let temporary_cleanup = replacement
                .as_ref()
                .map(|replacement| to_parent.remove_file(replacement));
            if publication_cleanup.is_err()
                || temporary_cleanup.is_some_and(|result| result.is_err())
            {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource rename rollback or private-temporary cleanup was interrupted; retry",
                ));
            }
            return Err(map_resource_io(error));
        }
        if let Some(replacement) = &replacement {
            if to_parent.remove_file(replacement).is_err() {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource was renamed but private-temporary cleanup was interrupted; retry",
                ));
            }
        }
    } else {
        if to_parent.symlink_metadata(&to_leaf).is_ok() {
            return Err(resource_error("RESOURCE_ALREADY_EXISTS", "target exists"));
        }
        rename_noreplace(&from_parent, &from_leaf, &to_parent, &to_leaf)
            .map_err(map_resource_io)?;
    }
    sync_dir(&from_parent).map_err(map_resource_io)?;
    sync_dir(&to_parent).map_err(map_resource_io)
}

fn copy_tree(source: &Dir, destination: &Dir) -> Result<()> {
    copy_tree_inner(source, destination, false)
}

fn copy_tree_inner(source: &Dir, destination: &Dir, include_git: bool) -> Result<()> {
    for entry in source.entries().map_err(map_resource_io)? {
        let entry = entry.map_err(map_resource_io)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 source name"))?;
        if name == ".git" && !include_git {
            continue;
        }
        if !valid_resource_component(&name) {
            return Err(resource_error(
                "RESOURCE_INVALID_PATH",
                "non-portable source name",
            ));
        }
        let metadata = source.symlink_metadata(&name).map_err(map_resource_io)?;
        if metadata.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "source tree contains a link",
            ));
        }
        if metadata.is_dir() {
            destination.create_dir(&name).map_err(map_resource_io)?;
            let source_child = open_child_dir(source, &name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| resource_error("RESOURCE_NOT_FOUND", "source disappeared"))?;
            let destination_child = open_child_dir(destination, &name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| resource_error("RESOURCE_IO", "staging directory disappeared"))?;
            copy_tree_inner(&source_child, &destination_child, include_git)?;
        } else if metadata.is_file() {
            let mut input = nofollow_open(source, &name, false, false).map_err(|error| {
                if error.kind() == ErrorKind::NotFound {
                    map_resource_io(error)
                } else {
                    resource_error("RESOURCE_UNSAFE_COMPONENT", error.kind().to_string())
                }
            })?;
            let opened_metadata = input.metadata().map_err(map_resource_io)?;
            if !opened_metadata.is_file() || opened_metadata.file_type().is_symlink() {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "opened source is not a regular file",
                ));
            }
            let mut options = OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(FollowSymlinks::No)
                .maybe_dir(false);
            #[cfg(unix)]
            options.mode(0o600);
            let mut output = destination
                .open_with(&name, &options)
                .map_err(map_resource_io)?;
            std::io::copy(&mut input, &mut output).map_err(map_resource_io)?;
            output.sync_all().map_err(map_resource_io)?;
        } else {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "unsupported source type",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static RECONCILE_TEST_ORDER: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    static RECONCILE_TEST_FAIL_AT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(any(windows, test))]
fn reconcile_capability_error(error: Error, mutated: bool) -> Error {
    if error.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:") {
        return error;
    }
    if !mutated && error.reason.starts_with("RESOURCE_BUSY:") {
        return error;
    }
    if mutated {
        return resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "resource reconciliation was interrupted; retry the operation",
        );
    }
    error
}

#[cfg(any(windows, test))]
fn reconcile_io(error: std::io::Error, mutated: bool) -> Error {
    if mutated {
        return resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "resource reconciliation was interrupted; retry the operation",
        );
    }
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return resource_error(
            "RESOURCE_BUSY",
            "resource is in use by another process; close it and retry",
        );
    }
    map_resource_io(error)
}

#[cfg(any(windows, test))]
fn validate_reconcile_tree(dir: &Dir) -> Result<()> {
    for entry in dir.entries().map_err(map_resource_io)? {
        let entry = entry.map_err(map_resource_io)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 tree entry"))?;
        if !valid_resource_component(&name) {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "tree contains a non-portable entry",
            ));
        }
        let metadata = dir.symlink_metadata(&name).map_err(map_resource_io)?;
        if metadata.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "tree contains a link or reparse point",
            ));
        }
        if metadata.is_dir() {
            let child = open_child_dir(dir, &name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "directory changed"))?;
            validate_reconcile_tree(&child)?;
        } else if metadata.is_file() {
            let file = nofollow_open(dir, &name, false, false).map_err(map_resource_io)?;
            if !file.metadata().map_err(map_resource_io)?.is_file() {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "file changed type",
                ));
            }
        } else {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "tree contains an unsupported entry",
            ));
        }
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn staged_file_temp(
    source: &Dir,
    name: &str,
    destination: &Dir,
) -> Result<(String, cap_std::fs::File)> {
    let mut input = nofollow_open(source, name, false, false).map_err(map_resource_io)?;
    if !input.metadata().map_err(map_resource_io)?.is_file() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "staged file changed type",
        ));
    }
    for _ in 0..128 {
        let temporary = format!(
            "{RESOURCE_TEMP_PREFIX}reconcile-{}",
            private_nonce().map_err(map_resource_io)?
        );
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No)
            .maybe_dir(false);
        #[cfg(unix)]
        options.mode(0o600);

        match destination.open_with(&temporary, &options) {
            Ok(mut output) => {
                if let Err(error) =
                    std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all())
                {
                    drop(output);
                    let cleanup = destination.remove_file(&temporary).map_err(map_resource_io);
                    if cleanup.is_err() {
                        return Err(resource_error(
                            "RESOURCE_RECONCILE_INCOMPLETE",
                            "reconcile-temporary write cleanup was interrupted; retry",
                        ));
                    }
                    return Err(map_resource_io(error));
                }
                return Ok((temporary, output));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(map_resource_io(error)),
        }
    }
    Err(resource_error(
        "RESOURCE_IO",
        "could not allocate reconcile temporary",
    ))
}

#[cfg(any(windows, test))]
fn reconcile_staged_entry(
    staged: &Dir,
    destination: &Dir,
    name: &str,
    mutated: &mut bool,
) -> Result<()> {
    #[cfg(test)]
    {
        RECONCILE_TEST_ORDER.with(|order| order.borrow_mut().push(name.to_owned()));
        let injected =
            RECONCILE_TEST_FAIL_AT.with(|failure| failure.borrow().as_deref() == Some(name));
        if injected {
            return Err(if *mutated {
                resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "injected reconciliation interruption",
                )
            } else {
                resource_error("RESOURCE_BUSY", "injected pre-mutation interruption")
            });
        }
    }
    let source = staged.symlink_metadata(name).map_err(map_resource_io)?;
    if source.file_type().is_symlink() || (!source.is_file() && !source.is_dir()) {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "unsafe staged entry",
        ));
    }
    let target = match destination.symlink_metadata(name) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(reconcile_io(error, *mutated)),
    };

    if source.is_dir()
        && target
            .as_ref()
            .is_some_and(|entry| entry.is_dir() && !entry.file_type().is_symlink())
    {
        let source_child = open_child_dir(staged, name, false)
            .map_err(|error| reconcile_io(error, *mutated))?
            .ok_or_else(|| {
                resource_error("RESOURCE_UNSAFE_COMPONENT", "staged directory changed")
            })?;
        let target_child = open_child_dir(destination, name, false)
            .map_err(|error| reconcile_io(error, *mutated))?
            .ok_or_else(|| {
                resource_error("RESOURCE_UNSAFE_COMPONENT", "target directory changed")
            })?;
        return reconcile_staged_dir(&source_child, &target_child, mutated);
    }

    if source.is_file()
        && target
            .as_ref()
            .is_some_and(|entry| entry.is_file() && !entry.file_type().is_symlink())
    {
        let (temporary, file) = staged_file_temp(staged, name, destination)?;
        drop(file);
        let result = destination.rename(&temporary, destination, name);
        if let Err(error) = result {
            let cleanup = destination.remove_file(&temporary).map_err(map_resource_io);
            if cleanup.is_err() {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "file reconciliation failed and private-temporary cleanup was interrupted; retry",
                ));
            }
            return Err(reconcile_io(error, *mutated));
        }
        *mutated = true;
        return Ok(());
    }

    if let Some(target) = target.as_ref() {
        if target.file_type().is_symlink() || (!target.is_file() && !target.is_dir()) {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "unsafe target entry",
            ));
        }
        remove_tree_entry(destination, name)
            .map_err(|error| reconcile_capability_error(error, *mutated))?;
        *mutated = true;
    }

    if source.is_dir() {
        destination
            .create_dir(name)
            .map_err(|error| reconcile_io(error, *mutated))?;
        *mutated = true;
        let source_child = open_child_dir(staged, name, false)
            .map_err(|error| reconcile_io(error, *mutated))?
            .ok_or_else(|| {
                resource_error("RESOURCE_UNSAFE_COMPONENT", "staged directory changed")
            })?;
        let target_child = open_child_dir(destination, name, false)
            .map_err(|error| reconcile_io(error, *mutated))?
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "new directory changed"))?;
        reconcile_staged_dir(&source_child, &target_child, mutated)
    } else {
        let (temporary, file) = staged_file_temp(staged, name, destination)?;
        drop(file);
        let result = destination.hard_link(&temporary, destination, name);
        let cleanup = destination.remove_file(&temporary).map_err(map_resource_io);
        if let Err(error) = result {
            if cleanup.is_err() {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "file reconciliation failed and private-temporary cleanup was interrupted; retry",
                ));
            }
            return Err(reconcile_io(error, *mutated));
        }
        if cleanup.is_err() {
            return Err(resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "file reconciliation succeeded but private-temporary cleanup was interrupted; retry",
            ));
        }
        *mutated = true;
        Ok(())
    }
}

#[cfg(any(windows, test))]
fn reconcile_staged_dir(staged: &Dir, destination: &Dir, mutated: &mut bool) -> Result<()> {
    let mut staged_names = Vec::new();
    for entry in staged.entries().map_err(map_resource_io)? {
        let entry = entry.map_err(map_resource_io)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 staged entry"))?;
        staged_names.push(name);
    }
    staged_names.sort();
    for name in staged_names
        .iter()
        .filter(|name| name.as_str() != "SKILL.md")
    {
        reconcile_staged_entry(staged, destination, name, mutated)?;
    }

    let mut stale = Vec::new();
    for entry in destination
        .entries()
        .map_err(|error| reconcile_io(error, *mutated))?
    {
        let entry = entry.map_err(|error| reconcile_io(error, *mutated))?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 target entry"))?;
        if !name.starts_with(RESOURCE_TEMP_PREFIX)
            && name != "SKILL.md"
            && !staged_names.iter().any(|staged_name| staged_name == &name)
        {
            stale.push(name);
        }
    }
    stale.sort();
    for name in stale {
        remove_tree_entry(destination, &name)
            .map_err(|error| reconcile_capability_error(error, *mutated))?;
        *mutated = true;
    }

    if staged_names.iter().any(|name| name == "SKILL.md") {
        reconcile_staged_entry(staged, destination, "SKILL.md", mutated)?;
    } else if destination.symlink_metadata("SKILL.md").is_ok() {
        remove_tree_entry(destination, "SKILL.md")
            .map_err(|error| reconcile_capability_error(error, *mutated))?;
        *mutated = true;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_exact_tree(staged: &Dir, destination: &Dir) -> Result<()> {
    let mut staged_names = Vec::new();
    let mut destination_names = Vec::new();
    for entry in staged.entries().map_err(map_resource_io)? {
        staged_names.push(entry.map_err(map_resource_io)?.file_name());
    }
    for entry in destination.entries().map_err(map_resource_io)? {
        let name = entry.map_err(map_resource_io)?.file_name();
        if name.to_string_lossy().starts_with(RESOURCE_TEMP_PREFIX) {
            return Err(resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "owned temporary entry remained after reconciliation; retry",
            ));
        }
        destination_names.push(name);
    }
    staged_names.sort();
    destination_names.sort();
    if staged_names != destination_names {
        return Err(resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "tree validation failed; retry",
        ));
    }
    for name in staged_names {
        let name = name
            .to_str()
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 entry"))?;
        let source = staged.symlink_metadata(name).map_err(map_resource_io)?;
        let target = destination
            .symlink_metadata(name)
            .map_err(map_resource_io)?;
        if source.file_type().is_symlink() || target.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "link appeared during validation",
            ));
        }
        if source.is_dir() && target.is_dir() {
            let source_child = open_child_dir(staged, name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "source changed"))?;
            let target_child = open_child_dir(destination, name, false)
                .map_err(map_resource_io)?
                .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "target changed"))?;
            validate_exact_tree(&source_child, &target_child)?;
        } else if source.is_file() && target.is_file() {
            let mut source_file =
                nofollow_open(staged, name, false, false).map_err(map_resource_io)?;
            let mut target_file =
                nofollow_open(destination, name, false, false).map_err(map_resource_io)?;
            let mut source_bytes = Vec::new();
            let mut target_bytes = Vec::new();
            source_file
                .read_to_end(&mut source_bytes)
                .map_err(map_resource_io)?;
            target_file
                .read_to_end(&mut target_bytes)
                .map_err(map_resource_io)?;
            if source_bytes != target_bytes {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "file validation failed; retry",
                ));
            }
        } else {
            return Err(resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "entry type validation failed; retry",
            ));
        }
    }
    Ok(())
}

fn cleanup_owned_stage(parent: &Dir, stage: &str) -> Result<()> {
    remove_tree_entry(parent, stage)
}

fn cleanup_owned_stage_error(parent: &Dir, stage: &str, original: Error) -> Error {
    if cleanup_owned_stage(parent, stage).is_err() {
        resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "resource operation failed and private-stage cleanup was interrupted; retry",
        )
    } else {
        original
    }
}

type ExpectedEntryIdentity = (u64, u64);

fn publish_staged_tree(parent: &Dir, stage: &str, leaf: &str, replace: bool) -> Result<()> {
    publish_staged_tree_with_identity(parent, stage, leaf, replace, None)
}

fn publish_staged_tree_with_identity(
    parent: &Dir,
    stage: &str,
    leaf: &str,
    replace: bool,
    expected_identity: Option<ExpectedEntryIdentity>,
) -> Result<()> {
    #[cfg(unix)]
    if !replace {
        if let Err(error) = rename_noreplace(parent, stage, parent, leaf) {
            return Err(cleanup_owned_stage_error(
                parent,
                stage,
                map_resource_io(error),
            ));
        }
        return sync_dir(parent).map_err(map_resource_io);
    }

    let target = match parent.symlink_metadata(leaf) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(cleanup_owned_stage_error(
                    parent,
                    stage,
                    resource_error(
                        "RESOURCE_UNSAFE_COMPONENT",
                        "target changed to an unsafe entry",
                    ),
                ));
            }
            Some(metadata)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            return Err(cleanup_owned_stage_error(
                parent,
                stage,
                map_resource_io(error),
            ));
        }
    };
    #[cfg(unix)]
    if let (Some((expected_dev, expected_ino)), Some(target)) = (expected_identity, target.as_ref())
    {
        if target.dev() != expected_dev || target.ino() != expected_ino {
            return Err(cleanup_owned_stage_error(
                parent,
                stage,
                resource_error("RESOURCE_UNSAFE_COMPONENT", "target identity changed"),
            ));
        }
    }

    #[cfg(windows)]
    {
        if let (Some((expected_dev, expected_ino)), Some(target)) =
            (expected_identity, target.as_ref())
        {
            if target.dev() != expected_dev || target.ino() != expected_ino {
                return Err(cleanup_owned_stage_error(
                    parent,
                    stage,
                    resource_error("RESOURCE_UNSAFE_COMPONENT", "target identity changed"),
                ));
            }
        }
        reconcile_staged_tree_windows(parent, stage, leaf, replace, target.is_some())
    }

    #[cfg(unix)]
    let Some(target) = target else {
        if let Err(error) = rename_noreplace(parent, stage, parent, leaf) {
            return Err(cleanup_owned_stage_error(
                parent,
                stage,
                map_resource_io(error),
            ));
        }
        return sync_dir(parent).map_err(map_resource_io);
    };

    #[cfg(unix)]
    {
        // Exchange keeps `leaf` occupied for the entire commit. An attacker can
        // therefore never wedge an entry into the old backup/publication gap.
        // The prior target lands at `stage`, where its identity is verified
        // before it is removed. A raced replacement is exchanged back intact.
        if let Err(error) = exchange_entries(parent, stage, parent, leaf) {
            if remove_tree_entry(parent, stage).is_err() {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource replacement failed and private-stage cleanup was interrupted; retry",
                ));
            }
            return Err(map_resource_io(error));
        }
        let exchanged = match parent.symlink_metadata(stage) {
            Ok(metadata) => metadata,
            Err(error) => {
                let rollback = exchange_entries(parent, stage, parent, leaf);
                let cleanup = if rollback.is_ok() {
                    remove_tree_entry(parent, stage)
                } else {
                    Err(resource_error(
                        "RESOURCE_RECONCILE_INCOMPLETE",
                        "resource replacement rollback was interrupted; retry",
                    ))
                };
                if rollback.is_err() || cleanup.is_err() {
                    return Err(resource_error(
                        "RESOURCE_RECONCILE_INCOMPLETE",
                        "resource replacement rollback or private-stage cleanup was interrupted; retry",
                    ));
                }
                return Err(map_resource_io(error));
            }
        };
        let (expected_dev, expected_ino) =
            expected_identity.unwrap_or_else(|| (target.dev(), target.ino()));
        if !exchanged.is_dir()
            || exchanged.file_type().is_symlink()
            || exchanged.dev() != expected_dev
            || exchanged.ino() != expected_ino
        {
            let rollback = exchange_entries(parent, stage, parent, leaf);
            let cleanup = if rollback.is_ok() {
                remove_tree_entry(parent, stage)
            } else {
                Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource replacement rollback was interrupted; retry",
                ))
            };
            if rollback.is_err() || cleanup.is_err() {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "unsafe replacement rollback or private-stage cleanup was interrupted; retry",
                ));
            }
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "target changed during replacement",
            ));
        }
        if let Err(error) = remove_tree_entry(parent, stage) {
            // Publication succeeded and the original remains recoverable under
            // the owned stage name. Attempt an atomic rollback before failing.
            let rollback = exchange_entries(parent, stage, parent, leaf);
            let cleanup = if rollback.is_ok() {
                remove_tree_entry(parent, stage)
            } else {
                Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource replacement rollback was interrupted; retry",
                ))
            };
            if rollback.is_err() || cleanup.is_err() {
                return Err(resource_error(
                    "RESOURCE_RECONCILE_INCOMPLETE",
                    "resource replacement cleanup and rollback were interrupted; retry",
                ));
            }
            return Err(error);
        }
        sync_dir(parent).map_err(map_resource_io)
    }
}

#[cfg(windows)]
fn reconcile_staged_tree_windows(
    parent: &Dir,
    stage: &str,
    leaf: &str,
    replace: bool,
    mut target_exists: bool,
) -> Result<()> {
    if target_exists && !replace {
        return Err(cleanup_owned_stage_error(
            parent,
            stage,
            resource_error("RESOURCE_ALREADY_EXISTS", "target exists"),
        ));
    }

    let mut mutated = false;
    if !target_exists {
        match parent.create_dir(leaf) {
            Ok(()) => {
                target_exists = true;
                mutated = true;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists && replace => {
                target_exists = true;
            }
            Err(error) => {
                return Err(cleanup_owned_stage_error(
                    parent,
                    stage,
                    map_resource_io(error),
                ));
            }
        }
    }
    debug_assert!(target_exists);

    let result = (|| {
        // open_child_dir converts the exact no-follow File into a Dir. Keeping
        // these capabilities alive pins both directory identities throughout
        // validation and reconciliation; never reopen either handle.
        let staged = open_child_dir(parent, stage, false)
            .map_err(|error| reconcile_io(error, mutated))?
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "staging changed"))?;
        let destination = open_child_dir(parent, leaf, false)
            .map_err(|error| reconcile_io(error, mutated))?
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "target changed"))?;
        validate_reconcile_tree(&staged)?;
        validate_reconcile_tree(&destination)?;
        reconcile_staged_dir(&staged, &destination, &mut mutated)?;
        validate_exact_tree(&staged, &destination)
    })();
    let cleanup = cleanup_owned_stage(parent, stage);
    if let Err(error) = result {
        return Err(if cleanup.is_err() {
            resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "reconciliation and private-stage cleanup were interrupted; retry",
            )
        } else if mutated && !error.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:") {
            resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "resource reconciliation was interrupted; retry the operation",
            )
        } else {
            error
        });
    }
    if cleanup.is_err() {
        return Err(resource_error(
            "RESOURCE_RECONCILE_INCOMPLETE",
            "resource was reconciled but private-stage cleanup was interrupted; retry",
        ));
    }
    sync_dir(parent).map_err(map_resource_io)
}

#[napi]
pub fn copy_resource_tree(
    home: String,
    catalog: String,
    destination_components: Vec<String>,
    source_path: String,
    replace: bool,
) -> Result<()> {
    validate_resource_path(&destination_components)?;
    let source = open_source_root(&source_path)?;
    let dir = open_resource_catalog(&home, &catalog, true)?
        .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "catalog unavailable"))?;
    let (parent, leaf) = open_resource_parent(&dir, &destination_components, true)?;
    if let Ok(metadata) = parent.symlink_metadata(&leaf) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "target is not a regular directory",
            ));
        }
        if !replace {
            return Err(resource_error("RESOURCE_ALREADY_EXISTS", "target exists"));
        }
    }
    let stage = format!(
        "{RESOURCE_TEMP_PREFIX}{}",
        private_nonce().map_err(map_resource_io)?
    );
    parent.create_dir(&stage).map_err(map_resource_io)?;
    let stage_dir = match open_child_dir(&parent, &stage, false) {
        Ok(Some(dir)) => dir,
        Ok(None) => {
            return Err(cleanup_owned_stage_error(
                &parent,
                &stage,
                resource_error("RESOURCE_UNSAFE_COMPONENT", "staging disappeared"),
            ));
        }
        Err(error) => {
            return Err(cleanup_owned_stage_error(
                &parent,
                &stage,
                map_resource_io(error),
            ));
        }
    };
    if let Err(error) = copy_tree(&source, &stage_dir) {
        drop(stage_dir);
        return Err(cleanup_owned_stage_error(&parent, &stage, error));
    }
    // Drop the pinned stage view before capability-relative publication or
    // recursive cleanup by its reserved name.
    drop(stage_dir);
    publish_staged_tree(&parent, &stage, &leaf, replace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn home() -> TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn windows_namespace_normalization_accepts_equivalent_spellings() {
        let drive = normalize_windows_namespace_path(r"C:\Users\Agent\SkillRepositories").unwrap();
        let extended =
            normalize_windows_namespace_path(r"\\?\c:/users/AGENT/SkillRepositories\").unwrap();
        assert_eq!(drive, extended);

        let unc = normalize_windows_namespace_path(r"\\Server\Share\Skills").unwrap();
        let extended_unc =
            normalize_windows_namespace_path(r"\\?\UNC\server\share\SKILLS\").unwrap();
        assert_eq!(unc, extended_unc);
    }

    #[test]
    fn windows_namespace_normalization_rejects_unsafe_or_different_paths() {
        for unsafe_path in [
            r"C:relative\Skills",
            r"C:\safe\..\outside",
            r"C:\safe\file:stream",
            r"\\server",
            r"\\server\share:stream\Skills",
            r"\\server\..\Skills",
            r"relative\Skills",
        ] {
            assert!(
                normalize_windows_namespace_path(unsafe_path).is_err(),
                "accepted {unsafe_path}"
            );
        }
        assert_ne!(
            normalize_windows_namespace_path(r"C:\safe\one").unwrap(),
            normalize_windows_namespace_path(r"C:\safe\two").unwrap()
        );
    }

    #[test]
    fn basename_policy_rejects_cross_platform_ambiguity() {
        for invalid in [
            "../x.loop.md",
            "x/y.loop.md",
            "x\\y.loop.md",
            "x:stream.loop.md",
            "CON.loop.md",
            "com1.loop.md",
            "x.loop.md ",
            "x.md",
            ".agent-deck-loop-tmp-x.loop.md",
        ] {
            assert!(!valid_catalog_basename(invalid), "accepted {invalid}");
        }
        assert!(valid_catalog_basename("native name.loop.md"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_snapshot_child_handle_must_close_before_publication() {
        let home = home();
        let snapshots = Dir::open_ambient_dir(home.path(), ambient_authority()).unwrap();
        let stage = create_private_dir(&snapshots, "stage").unwrap();
        let skills = create_private_dir(&stage, "skills").unwrap();
        let repository = create_private_dir(&snapshots, "repository").unwrap();

        let blocked = rename_noreplace(&stage, "skills", &repository, "skills").unwrap_err();
        assert!(
            matches!(blocked.raw_os_error(), Some(5 | 32 | 33)),
            "unexpected rename error: {blocked:?}"
        );
        drop(skills);
        rename_noreplace(&stage, "skills", &repository, "skills").unwrap();

        drop(repository);
        drop(stage);
        drop(snapshots);
    }

    #[cfg(windows)]
    #[test]
    fn windows_managed_clone_stage_is_closed_before_publication() {
        let home = home();
        let root = Dir::open_ambient_dir(home.path(), ambient_authority()).unwrap();
        let (stage_leaf, stage) = allocate_managed_stage(&root).unwrap();
        stage.write("owned", b"content").unwrap();

        publish_managed_stage(&root, &stage_leaf, stage, "repository", false, None).unwrap();
        assert!(root.symlink_metadata(&stage_leaf).is_err());
        assert!(root.symlink_metadata("repository").unwrap().is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn windows_failed_managed_inspect_cleanup_preserves_typed_error() {
        let home = home();
        let root = Dir::open_ambient_dir(home.path(), ambient_authority()).unwrap();
        let (stage_leaf, stage) = allocate_managed_stage(&root).unwrap();
        stage.write("owned", b"content").unwrap();
        let original = resource_error("RESOURCE_OUTPUT_LIMIT", "managed git output exceeded limit");

        let error =
            finish_managed_stage::<()>(&root, &stage_leaf, stage, Err(original)).unwrap_err();
        assert!(
            error.reason.starts_with("RESOURCE_OUTPUT_LIMIT:"),
            "{error:?}"
        );
        assert!(root.symlink_metadata(&stage_leaf).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_access_denied_is_busy_only_at_validated_mutation_boundary() {
        let validation = map_resource_io(std::io::Error::from_raw_os_error(5));
        assert!(
            validation.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:"),
            "{validation:?}"
        );
        let mutation = map_validated_resource_mutation_io(std::io::Error::from_raw_os_error(5));
        assert!(
            mutation.reason.starts_with("RESOURCE_BUSY:"),
            "{mutation:?}"
        );
    }

    #[test]
    fn resource_component_policy_is_portable() {
        for invalid in [
            "..",
            "a/b",
            "a\\b",
            "a:stream",
            "NUL.md",
            "com1.txt",
            "trailing.",
            "space ",
        ] {
            assert!(!valid_resource_component(invalid), "accepted {invalid}");
        }
        assert!(valid_resource_component("nested agent.md"));
    }

    #[test]
    fn resource_file_and_tree_round_trip() {
        let root = home();
        let home = root.path().to_string_lossy().into_owned();
        let file = vec!["nested".into(), "agent.md".into()];
        write_resource_catalog_file(
            home.clone(),
            "global-agents".into(),
            file.clone(),
            "one".into(),
            true,
        )
        .unwrap();
        assert_eq!(
            read_resource_catalog_file(home.clone(), "global-agents".into(), file.clone()).unwrap(),
            "one"
        );
        write_resource_catalog_file(
            home.clone(),
            "global-agents".into(),
            file.clone(),
            "two".into(),
            false,
        )
        .unwrap();
        rename_resource_catalog_entry(
            home.clone(),
            "global-agents".into(),
            file,
            vec!["nested".into(), "renamed.md".into()],
            None,
        )
        .unwrap();

        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "skill").unwrap();
        fs::write(source.join("asset.txt"), "asset").unwrap();
        copy_resource_tree(
            home.clone(),
            "global-skills".into(),
            vec!["safe-skill".into()],
            source.to_string_lossy().into_owned(),
            false,
        )
        .unwrap();
        assert_eq!(
            read_resource_catalog_file(
                home.clone(),
                "global-skills".into(),
                vec!["safe-skill".into(), "asset.txt".into()]
            )
            .unwrap(),
            "asset"
        );
        fs::write(source.join("SKILL.md"), "replaced skill").unwrap();
        fs::remove_file(source.join("asset.txt")).unwrap();
        fs::write(source.join("replacement.txt"), "replacement").unwrap();
        copy_resource_tree(
            home.clone(),
            "global-skills".into(),
            vec!["safe-skill".into()],
            source.to_string_lossy().into_owned(),
            true,
        )
        .unwrap();
        assert_eq!(
            read_resource_catalog_file(
                home.clone(),
                "global-skills".into(),
                vec!["safe-skill".into(), "SKILL.md".into()]
            )
            .unwrap(),
            "replaced skill"
        );
        assert!(
            !root
                .path()
                .join(".pi/agent/skills/safe-skill/asset.txt")
                .exists()
        );
        remove_resource_catalog_entry(home, "global-skills".into(), vec!["safe-skill".into()])
            .unwrap();
    }

    #[test]
    fn create_replace_scan_delete_round_trip() {
        let root = home();
        let home = root.path().to_string_lossy().into_owned();
        create_loop_catalog_file(home.clone(), "a.loop.md".into(), "one".into()).unwrap();
        assert_eq!(scan_loop_catalog(home.clone()).unwrap()[0].content, "one");
        assert!(create_loop_catalog_file(home.clone(), "a.loop.md".into(), "x".into()).is_err());
        replace_loop_catalog_file(home.clone(), "a.loop.md".into(), "two".into()).unwrap();
        assert_eq!(scan_loop_catalog(home.clone()).unwrap()[0].content, "two");
        delete_loop_catalog_file(home.clone(), "a.loop.md".into()).unwrap();
        assert!(scan_loop_catalog(home).unwrap().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_loop_crud_and_resource_pinning_coexist() {
        let root = home();
        let home = root.path().to_string_lossy().into_owned();
        create_loop_catalog_file(home.clone(), "windows.loop.md".into(), "one".into()).unwrap();
        replace_loop_catalog_file(home.clone(), "windows.loop.md".into(), "two".into()).unwrap();
        assert_eq!(scan_loop_catalog(home.clone()).unwrap()[0].content, "two");
        write_resource_catalog_file(
            home.clone(),
            "global-prompts".into(),
            vec!["windows.md".into()],
            "resource".into(),
            true,
        )
        .unwrap();
        assert_eq!(
            read_resource_catalog_file(
                home.clone(),
                "global-prompts".into(),
                vec!["windows.md".into()]
            )
            .unwrap(),
            "resource"
        );
        write_resource_catalog_file(
            home.clone(),
            "global-prompts".into(),
            vec!["windows.md".into()],
            "replaced".into(),
            false,
        )
        .unwrap();
        remove_resource_catalog_entry(
            home.clone(),
            "global-prompts".into(),
            vec!["windows.md".into()],
        )
        .unwrap();
        let prompts = root.path().join(".pi/agent/prompts");
        assert!(fs::read_dir(prompts).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(RESOURCE_TEMP_PREFIX)
        }));
        delete_loop_catalog_file(home, "windows.loop.md".into()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn catalog_component_and_final_symlinks_never_touch_victim() {
        use std::os::unix::fs::symlink;
        let root = home();
        let victim = root.path().join("victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "safe").unwrap();
        symlink(&victim, root.path().join(".pi")).unwrap();
        let home = root.path().to_string_lossy().into_owned();
        assert!(create_loop_catalog_file(home, "a.loop.md".into(), "bad".into()).is_err());
        assert_eq!(fs::read_to_string(victim.join("sentinel")).unwrap(), "safe");

        fs::remove_file(root.path().join(".pi")).unwrap();
        let loops = root.path().join(".pi/agent/loops");
        fs::create_dir_all(&loops).unwrap();
        symlink(victim.join("sentinel"), loops.join("a.loop.md")).unwrap();
        let home = root.path().to_string_lossy().into_owned();
        assert!(replace_loop_catalog_file(home.clone(), "a.loop.md".into(), "bad".into()).is_err());
        assert!(delete_loop_catalog_file(home, "a.loop.md".into()).is_err());
        assert_eq!(fs::read_to_string(victim.join("sentinel")).unwrap(), "safe");
    }

    #[test]
    fn staged_copy_never_replaces_a_destination_that_appeared_late() {
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("stage").unwrap();
        fs::write(root.path().join("stage/SKILL.md"), "staged").unwrap();
        // Models a destination created after copy_resource_tree's initial check
        // but before publication.
        parent.create_dir("raced").unwrap();
        fs::write(root.path().join("raced/sentinel"), "keep").unwrap();

        let error = publish_staged_tree(&parent, "stage", "raced", false).unwrap_err();
        assert!(
            error.reason.starts_with("RESOURCE_ALREADY_EXISTS:"),
            "{error:?}"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("raced/sentinel")).unwrap(),
            "keep"
        );
        assert!(!root.path().join("stage").exists());
        parent.create_dir("stage").unwrap();
        parent.remove_dir("stage").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_publication_reports_interrupted_private_stage_cleanup() {
        use std::os::unix::fs::symlink;

        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("stage-with-link").unwrap();
        fs::write(root.path().join("victim"), "safe").unwrap();
        symlink(
            root.path().join("victim"),
            root.path().join("stage-with-link/link"),
        )
        .unwrap();
        parent.create_dir("target").unwrap();

        let error = publish_staged_tree(&parent, "stage-with-link", "target", false).unwrap_err();
        assert!(
            error.reason.starts_with("RESOURCE_RECONCILE_INCOMPLETE:"),
            "{error:?}"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("victim")).unwrap(),
            "safe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn replacement_exchange_has_no_leaf_gap_for_a_raced_entry() {
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("stage").unwrap();
        fs::write(root.path().join("stage/new"), "new").unwrap();
        parent.create_dir("target").unwrap();
        fs::write(root.path().join("target/original"), "original").unwrap();

        exchange_entries(&parent, "stage", &parent, "target").unwrap();
        // This is the exact old interleaving point after target -> backup. With
        // exchange, target was never absent, so the raced publication fails.
        assert_eq!(
            parent.create_dir("target").unwrap_err().kind(),
            ErrorKind::AlreadyExists
        );
        assert_eq!(
            fs::read_to_string(root.path().join("target/new")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("stage/original")).unwrap(),
            "original"
        );
        exchange_entries(&parent, "stage", &parent, "target").unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("target/original")).unwrap(),
            "original"
        );
    }

    #[test]
    fn directory_rename_publication_never_replaces_an_existing_target() {
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("source").unwrap();
        fs::write(root.path().join("source/source"), "source").unwrap();
        parent.create_dir("target").unwrap();
        fs::write(root.path().join("target/sentinel"), "keep").unwrap();

        let error = rename_noreplace(&parent, "source", &parent, "target").unwrap_err();
        assert_eq!(error.kind(), ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read_to_string(root.path().join("target/sentinel")).unwrap(),
            "keep"
        );
        assert!(root.path().join("source/source").exists());
    }

    #[cfg(unix)]
    #[test]
    fn resource_links_are_rejected_and_staging_is_cleaned() {
        use std::os::unix::fs::symlink;
        let root = home();
        let home = root.path().to_string_lossy().into_owned();
        let victim = root.path().join("victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "outside-safe").unwrap();
        let skills = root.path().join(".pi/agent/skills");
        fs::create_dir_all(&skills).unwrap();
        symlink(&victim, skills.join("linked")).unwrap();
        let skills_dir = Dir::open_ambient_dir(&skills, ambient_authority()).unwrap();
        skills_dir.create_dir("late-stage").unwrap();
        fs::write(skills.join("late-stage/SKILL.md"), "staged").unwrap();
        let late_error =
            publish_staged_tree(&skills_dir, "late-stage", "linked", true).unwrap_err();
        assert!(late_error.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:"));
        assert!(!skills.join("late-stage").exists());
        assert!(
            write_resource_catalog_file(
                home.clone(),
                "global-skills".into(),
                vec!["linked".into(), "SKILL.md".into()],
                "bad".into(),
                false,
            )
            .is_err()
        );
        assert!(
            remove_resource_catalog_entry(
                home.clone(),
                "global-skills".into(),
                vec!["linked".into()],
            )
            .is_err()
        );

        let source_root_link = root.path().join("source-root-link");
        symlink(&victim, &source_root_link).unwrap();
        assert!(
            copy_resource_tree(
                home.clone(),
                "global-skills".into(),
                vec!["root-linked".into()],
                source_root_link.to_string_lossy().into_owned(),
                false,
            )
            .is_err()
        );

        let source = root.path().join("source-linked");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "skill").unwrap();
        symlink(&victim, source.join("asset-link")).unwrap();
        assert!(
            copy_resource_tree(
                home,
                "global-skills".into(),
                vec!["copied".into()],
                source.to_string_lossy().into_owned(),
                false,
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(victim.join("sentinel")).unwrap(),
            "outside-safe"
        );
        assert!(fs::read_dir(skills).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(RESOURCE_TEMP_PREFIX)
        }));
    }

    #[cfg(unix)]
    #[test]
    fn recursive_resource_delete_rejects_nested_link_without_touching_outside() {
        use std::os::unix::fs::symlink;
        let root = home();
        let victim = root.path().join("nested-delete-victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "outside-safe").unwrap();
        let skill = root.path().join(".pi/agent/skills/nested-link-skill");
        fs::create_dir_all(skill.join("assets")).unwrap();
        fs::write(skill.join("SKILL.md"), "skill").unwrap();
        symlink(victim.join("sentinel"), skill.join("assets/link")).unwrap();
        let error = remove_resource_catalog_entry(
            root.path().to_string_lossy().into_owned(),
            "global-skills".into(),
            vec!["nested-link-skill".into()],
        )
        .unwrap_err();
        assert!(error.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:"));
        assert_eq!(
            fs::read_to_string(victim.join("sentinel")).unwrap(),
            "outside-safe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_root_swap_never_copies_through_a_symlink() {
        use std::os::unix::fs::symlink;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Barrier};

        let root = home();
        let home_string = root.path().to_string_lossy().into_owned();
        let source = root.path().join("swap-source");
        let held = root.path().join("swap-source-held");
        let victim = root.path().join("swap-victim");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "safe-source").unwrap();
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("SKILL.md"), "outside-secret").unwrap();
        fs::create_dir_all(root.path().join(".pi/agent/skills")).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));
        let attacker_stop = Arc::clone(&stop);
        let attacker_barrier = Arc::clone(&barrier);
        let attacker_source = source.clone();
        let attacker_held = held.clone();
        let attacker_victim = victim.clone();
        let attacker = std::thread::spawn(move || {
            attacker_barrier.wait();
            while !attacker_stop.load(Ordering::Relaxed) {
                if fs::rename(&attacker_source, &attacker_held).is_ok() {
                    let _ = symlink(&attacker_victim, &attacker_source);
                    std::thread::yield_now();
                    let _ = fs::remove_file(&attacker_source);
                    let _ = fs::rename(&attacker_held, &attacker_source);
                }
            }
        });
        barrier.wait();
        for index in 0..100 {
            let _ = copy_resource_tree(
                home_string.clone(),
                "global-skills".into(),
                vec![format!("copied-{index}")],
                source.to_string_lossy().into_owned(),
                false,
            );
        }
        stop.store(true, Ordering::Relaxed);
        attacker.join().unwrap();
        for entry in fs::read_dir(root.path().join(".pi/agent/skills")).unwrap() {
            let skill = entry.unwrap().path();
            if skill.is_dir() {
                assert_eq!(
                    fs::read_to_string(skill.join("SKILL.md")).unwrap(),
                    "safe-source"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn special_source_files_are_rejected_without_leaking_staging() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let root = home();
        let source = root.path().join("special-source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("SKILL.md"), "safe").unwrap();
        let fifo = source.join("pipe");
        let fifo_name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        let result = copy_resource_tree(
            root.path().to_string_lossy().into_owned(),
            "global-skills".into(),
            vec!["special".into()],
            source.to_string_lossy().into_owned(),
            false,
        );
        assert!(result.is_err());
        assert!(!root.path().join(".pi/agent/skills/special").exists());
    }

    #[cfg(unix)]
    #[test]
    fn final_entry_swap_stress_never_modifies_outside_sentinel_or_leaks_temps() {
        use std::os::unix::fs::symlink;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Barrier};

        let root = home();
        let home_path = root.path().to_path_buf();
        let home_string = home_path.to_string_lossy().into_owned();
        create_loop_catalog_file(home_string.clone(), "race.loop.md".into(), "safe".into())
            .unwrap();
        let loops = home_path.join(".pi/agent/loops");
        let victim = home_path.join("victim");
        fs::write(&victim, "outside-safe").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));
        let attacker_barrier = Arc::clone(&barrier);
        let attacker_stop = Arc::clone(&stop);
        let attacker_loops = loops.clone();
        let attacker_victim = victim.clone();
        let attacker = std::thread::spawn(move || {
            attacker_barrier.wait();
            while !attacker_stop.load(Ordering::Relaxed) {
                let target = attacker_loops.join("race.loop.md");
                let _ = fs::remove_file(&target);
                let _ = symlink(&attacker_victim, &target);
                std::thread::yield_now();
                let _ = fs::remove_file(&target);
                let _ = fs::write(&target, "owned");
            }
        });
        barrier.wait();
        for index in 0..200 {
            let _ = replace_loop_catalog_file(
                home_string.clone(),
                "race.loop.md".into(),
                format!("owned-{index}"),
            );
            let _ = scan_loop_catalog(home_string.clone());
            let _ = delete_loop_catalog_file(home_string.clone(), "race.loop.md".into());
            let _ = create_loop_catalog_file(
                home_string.clone(),
                "race.loop.md".into(),
                "recreated".into(),
            );
        }
        stop.store(true, Ordering::Relaxed);
        attacker.join().unwrap();
        assert_eq!(fs::read_to_string(victim).unwrap(), "outside-safe");
        assert!(fs::read_dir(loops).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(TEMP_PREFIX)
        }));
    }

    #[cfg(unix)]
    #[test]
    fn resource_catalog_component_swap_stays_with_captured_capability() {
        use std::os::unix::fs::symlink;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Barrier};

        let root = home();
        let home_path = root.path().to_path_buf();
        let home_string = home_path.to_string_lossy().into_owned();
        write_resource_catalog_file(
            home_string.clone(),
            "global-prompts".into(),
            vec!["seed.md".into()],
            "safe".into(),
            false,
        )
        .unwrap();
        let victim = home_path.join("resource-component-victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "outside-safe").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));
        let attacker_stop = Arc::clone(&stop);
        let attacker_barrier = Arc::clone(&barrier);
        let attacker_home = home_path.clone();
        let attacker_victim = victim.clone();
        let attacker = std::thread::spawn(move || {
            attacker_barrier.wait();
            while !attacker_stop.load(Ordering::Relaxed) {
                let pi = attacker_home.join(".pi");
                let held = attacker_home.join(".pi-resource-held");
                if fs::rename(&pi, &held).is_ok() {
                    let _ = symlink(&attacker_victim, &pi);
                    std::thread::yield_now();
                    let _ = fs::remove_file(&pi);
                    let _ = fs::rename(&held, &pi);
                }
            }
        });
        barrier.wait();
        for index in 0..100 {
            let _ = write_resource_catalog_file(
                home_string.clone(),
                "global-prompts".into(),
                vec![format!("race-{index}.md")],
                "owned".into(),
                false,
            );
        }
        stop.store(true, Ordering::Relaxed);
        attacker.join().unwrap();
        assert_eq!(
            fs::read_to_string(victim.join("sentinel")).unwrap(),
            "outside-safe"
        );
    }

    #[cfg(unix)]
    #[test]
    fn catalog_component_swap_stress_stays_with_captured_capability() {
        use std::os::unix::fs::symlink;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Barrier};

        let root = home();
        let home_path = root.path().to_path_buf();
        let home_string = home_path.to_string_lossy().into_owned();
        create_loop_catalog_file(home_string.clone(), "seed.loop.md".into(), "safe".into())
            .unwrap();
        let victim = home_path.join("victim-component");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "outside-safe").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(2));
        let attacker_barrier = Arc::clone(&barrier);
        let attacker_stop = Arc::clone(&stop);
        let attacker_home = home_path.clone();
        let attacker_victim = victim.clone();
        let attacker = std::thread::spawn(move || {
            attacker_barrier.wait();
            while !attacker_stop.load(Ordering::Relaxed) {
                let pi = attacker_home.join(".pi");
                let held = attacker_home.join(".pi-held");
                if fs::rename(&pi, &held).is_ok() {
                    let _ = symlink(&attacker_victim, &pi);
                    std::thread::yield_now();
                    let _ = fs::remove_file(&pi);
                    let _ = fs::rename(&held, &pi);
                }
            }
            let pi = attacker_home.join(".pi");
            let held = attacker_home.join(".pi-held");
            if held.exists() {
                let _ = fs::remove_file(&pi);
                let _ = fs::rename(&held, &pi);
            }
        });
        barrier.wait();
        for index in 0..200 {
            let _ = scan_loop_catalog(home_string.clone());
            let _ = create_loop_catalog_file(
                home_string.clone(),
                format!("component-{index}.loop.md"),
                "owned".into(),
            );
        }
        stop.store(true, Ordering::Relaxed);
        attacker.join().unwrap();
        assert_eq!(
            fs::read_to_string(victim.join("sentinel")).unwrap(),
            "outside-safe"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_component_fails_without_symlink_privilege() {
        use std::process::Command;
        let root = home();
        let victim = root.path().join("victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "safe").unwrap();
        let link = root.path().join(".pi");
        let status = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&victim)
            .status()
            .unwrap();
        assert!(status.success());
        let home = root.path().to_string_lossy().into_owned();
        assert!(create_loop_catalog_file(home.clone(), "a.loop.md".into(), "bad".into()).is_err());
        assert!(
            write_resource_catalog_file(
                home,
                "global-prompts".into(),
                vec!["unsafe.md".into()],
                "bad".into(),
                false,
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(victim.join("sentinel")).unwrap(), "safe");
        assert!(
            Command::new("cmd")
                .args(["/c", "rmdir"])
                .arg(&link)
                .status()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn windows_reconciler_converges_exactly_with_stale_and_type_changes() {
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("stage").unwrap();
        parent.create_dir("target").unwrap();
        let stage_path = root.path().join("stage");
        let target_path = root.path().join("target");
        fs::create_dir(stage_path.join("nested")).unwrap();
        fs::write(stage_path.join("nested/asset"), "new asset").unwrap();
        fs::write(stage_path.join("was-dir"), "now file").unwrap();
        fs::create_dir(stage_path.join("was-file")).unwrap();
        fs::write(stage_path.join("was-file/child"), "child").unwrap();
        fs::write(stage_path.join("SKILL.md"), "new manifest").unwrap();
        fs::create_dir(target_path.join("was-dir")).unwrap();
        fs::write(target_path.join("was-dir/old"), "old").unwrap();
        fs::write(target_path.join("was-file"), "old file").unwrap();
        fs::write(target_path.join("stale"), "stale").unwrap();
        fs::write(target_path.join("SKILL.md"), "old manifest").unwrap();
        let staged = open_child_dir(&parent, "stage", false).unwrap().unwrap();
        let destination = open_child_dir(&parent, "target", false).unwrap().unwrap();

        validate_reconcile_tree(&staged).unwrap();
        validate_reconcile_tree(&destination).unwrap();
        let mut mutated = false;
        reconcile_staged_dir(&staged, &destination, &mut mutated).unwrap();
        assert!(mutated);
        validate_exact_tree(&staged, &destination).unwrap();
        assert_eq!(
            fs::read_to_string(target_path.join("SKILL.md")).unwrap(),
            "new manifest"
        );
        assert_eq!(
            fs::read_to_string(target_path.join("nested/asset")).unwrap(),
            "new asset"
        );
        assert_eq!(
            fs::read_to_string(target_path.join("was-dir")).unwrap(),
            "now file"
        );
        assert_eq!(
            fs::read_to_string(target_path.join("was-file/child")).unwrap(),
            "child"
        );
        assert!(!target_path.join("stale").exists());
        assert!(fs::read_dir(&target_path).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(RESOURCE_TEMP_PREFIX)
        }));
    }

    #[test]
    fn windows_reconciler_processes_manifest_last() {
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("stage").unwrap();
        parent.create_dir("target").unwrap();
        fs::write(root.path().join("stage/asset"), "asset").unwrap();
        fs::write(root.path().join("stage/SKILL.md"), "manifest").unwrap();
        let staged = open_child_dir(&parent, "stage", false).unwrap().unwrap();
        let destination = open_child_dir(&parent, "target", false).unwrap().unwrap();
        RECONCILE_TEST_ORDER.with(|order| order.borrow_mut().clear());
        let mut mutated = false;
        reconcile_staged_dir(&staged, &destination, &mut mutated).unwrap();
        let order = RECONCILE_TEST_ORDER.with(|order| order.borrow().clone());
        assert_eq!(order.last().map(String::as_str), Some("SKILL.md"));
    }

    #[test]
    fn windows_reconciler_partial_failure_then_retry_converges_exactly() {
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("stage").unwrap();
        parent.create_dir("target").unwrap();
        fs::write(root.path().join("stage/a"), "new-a").unwrap();
        fs::write(root.path().join("stage/z"), "new-z").unwrap();
        fs::write(root.path().join("stage/SKILL.md"), "new-manifest").unwrap();
        fs::write(root.path().join("target/a"), "old-a").unwrap();
        fs::write(root.path().join("target/z"), "old-z").unwrap();
        fs::write(root.path().join("target/SKILL.md"), "old-manifest").unwrap();
        let staged = open_child_dir(&parent, "stage", false).unwrap().unwrap();
        let destination = open_child_dir(&parent, "target", false).unwrap().unwrap();
        RECONCILE_TEST_FAIL_AT.with(|failure| *failure.borrow_mut() = Some("z".into()));
        let mut mutated = false;
        let error = reconcile_staged_dir(&staged, &destination, &mut mutated).unwrap_err();
        assert!(error.reason.starts_with("RESOURCE_RECONCILE_INCOMPLETE:"));
        assert_eq!(
            fs::read_to_string(root.path().join("target/a")).unwrap(),
            "new-a"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("target/z")).unwrap(),
            "old-z"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("target/SKILL.md")).unwrap(),
            "old-manifest"
        );
        RECONCILE_TEST_FAIL_AT.with(|failure| *failure.borrow_mut() = None);
        reconcile_staged_dir(&staged, &destination, &mut mutated).unwrap();
        validate_exact_tree(&staged, &destination).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn windows_reconciler_rejects_swapped_child_link_without_touching_outside() {
        use std::os::unix::fs::symlink;
        let root = home();
        let victim = root.path().join("victim-reconcile");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "outside-safe").unwrap();
        fs::create_dir(root.path().join("stage-reconcile")).unwrap();
        fs::create_dir(root.path().join("stage-reconcile/child")).unwrap();
        fs::write(root.path().join("stage-reconcile/child/file"), "new").unwrap();
        fs::create_dir(root.path().join("target-reconcile")).unwrap();
        symlink(&victim, root.path().join("target-reconcile/child")).unwrap();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        let staged = open_child_dir(&parent, "stage-reconcile", false)
            .unwrap()
            .unwrap();
        let destination = open_child_dir(&parent, "target-reconcile", false)
            .unwrap()
            .unwrap();
        let mut mutated = false;
        let error = reconcile_staged_dir(&staged, &destination, &mut mutated).unwrap_err();
        assert!(error.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:"));
        assert_eq!(
            fs::read_to_string(victim.join("sentinel")).unwrap(),
            "outside-safe"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_exact_child_dir_capability_pins_identity_until_drop() {
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("pinned-child").unwrap();
        fs::write(root.path().join("pinned-child/file"), "owned").unwrap();

        let child = open_child_dir(&parent, "pinned-child", false)
            .unwrap()
            .unwrap();
        assert_eq!(child.entries().unwrap().count(), 1);
        assert!(
            fs::rename(
                root.path().join("pinned-child"),
                root.path().join("renamed-child")
            )
            .is_err()
        );
        assert!(fs::remove_dir(root.path().join("pinned-child")).is_err());

        drop(child);
        remove_tree_entry(&parent, "pinned-child").unwrap();
        parent.create_dir("pinned-child").unwrap();
        fs::write(root.path().join("pinned-child/reused"), "safe reuse").unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("pinned-child/reused")).unwrap(),
            "safe reuse"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_resource_junction_target_is_rejected() {
        use std::process::Command;
        let root = home();
        let victim = root.path().join("resource-victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("SKILL.md"), "outside-safe").unwrap();
        let skills = root.path().join(".pi").join("agent").join("skills");
        fs::create_dir_all(&skills).unwrap();
        let link = skills.join("linked");
        let status = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&victim)
            .status()
            .unwrap();
        assert!(status.success());
        let home = root.path().to_string_lossy().into_owned();
        let source_link = root.path().join("source-junction");
        assert!(
            Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&source_link)
                .arg(&victim)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            copy_resource_tree(
                home.clone(),
                "global-skills".into(),
                vec!["copied-link".into()],
                source_link.to_string_lossy().into_owned(),
                false,
            )
            .is_err()
        );
        assert!(
            Command::new("cmd")
                .args(["/c", "rmdir"])
                .arg(&source_link)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            write_resource_catalog_file(
                home.clone(),
                "global-skills".into(),
                vec!["linked".into(), "SKILL.md".into()],
                "bad".into(),
                false,
            )
            .is_err()
        );
        assert!(
            remove_resource_catalog_entry(home, "global-skills".into(), vec!["linked".into()],)
                .is_err()
        );
        let skills_dir = Dir::open_ambient_dir(&skills, ambient_authority()).unwrap();
        skills_dir.create_dir("junction-stage").unwrap();
        fs::write(skills.join("junction-stage/SKILL.md"), "staged").unwrap();
        let error = publish_staged_tree(&skills_dir, "junction-stage", "linked", true).unwrap_err();
        assert!(error.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:"));
        assert!(!skills.join("junction-stage").exists());
        assert_eq!(
            fs::read_to_string(victim.join("SKILL.md")).unwrap(),
            "outside-safe"
        );
        assert!(
            Command::new("cmd")
                .args(["/c", "rmdir"])
                .arg(&link)
                .status()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn managed_repository_publish_is_noreplace_and_delete_is_direct_child_scoped() {
        let root = home();
        let repositories = root.path().join("SkillRepositories");
        fs::create_dir(&repositories).unwrap();
        fs::create_dir(repositories.join(".agent-deck-clone-first")).unwrap();
        fs::write(repositories.join(".agent-deck-clone-first/file"), "owned").unwrap();
        fs::create_dir(repositories.join("collision")).unwrap();
        fs::write(repositories.join("collision/sentinel"), "safe").unwrap();
        assert!(
            publish_managed_skill_repository(
                root.path().to_string_lossy().into_owned(),
                ".agent-deck-clone-first".into(),
                "collision".into(),
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(repositories.join("collision/sentinel")).unwrap(),
            "safe"
        );
        fs::remove_dir_all(repositories.join("collision")).unwrap();
        publish_managed_skill_repository(
            root.path().to_string_lossy().into_owned(),
            ".agent-deck-clone-first".into(),
            "owner-repo".into(),
        )
        .unwrap();
        delete_managed_skill_repository(
            root.path().to_string_lossy().into_owned(),
            "owner-repo".into(),
        )
        .unwrap();
        assert!(!repositories.join("owner-repo").exists());
        assert!(
            delete_managed_skill_repository(
                root.path().to_string_lossy().into_owned(),
                "../outside".into(),
            )
            .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_git_copy_stays_on_captured_clone_after_leaf_swap() {
        let root = home();
        let repositories = root.path().join("SkillRepositories");
        let repository = repositories.join("owner-repo");
        fs::create_dir(&repositories).unwrap();
        fs::create_dir(&repository).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(cwd)
                    .status()
                    .unwrap()
                    .success()
            );
        };
        git(&repository, &["init", "-b", "main"]);
        git(
            &repository,
            &["config", "user.email", "test@example.invalid"],
        );
        git(&repository, &["config", "user.name", "Test"]);
        fs::write(repository.join("owned"), "trusted").unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "initial"]);
        git(
            &repository,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/trusted.git",
            ],
        );
        let root_dir = Dir::open_ambient_dir(&repositories, ambient_authority()).unwrap();
        let (_, captured_clone) = capture_managed_clone(&root_dir, "owner-repo").unwrap();
        fs::rename(&repository, repositories.join("owner-repo-held")).unwrap();
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);

        let (stage_leaf, stage) = allocate_managed_stage(&root_dir).unwrap();
        copy_tree_inner(&captured_clone, &stage, true).unwrap();
        let inspected = inspect_stage(
            &stage,
            "/raced/path/is/ignored",
            None,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(inspected.origin, "https://example.invalid/trusted.git");
        cleanup_owned_stage(&root_dir, &stage_leaf).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn managed_git_stays_on_captured_root_after_lexical_swap() {
        let root = home();
        let repositories = root.path().join("SkillRepositories");
        let repository = repositories.join("owner-repo");
        fs::create_dir(&repositories).unwrap();
        fs::create_dir(&repository).unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repository)
                .status()
                .unwrap();
            assert!(status.success());
        };
        git(&["init", "-b", "main"]);
        git(&["config", "user.email", "test@example.invalid"]);
        git(&["config", "user.name", "Test"]);
        fs::write(repository.join("owned"), "trusted").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "initial"]);
        git(&[
            "remote",
            "add",
            "origin",
            "https://example.invalid/trusted.git",
        ]);

        let captured = Dir::open_ambient_dir(&repositories, ambient_authority()).unwrap();
        fs::rename(&repositories, root.path().join("SkillRepositories-held")).unwrap();
        let replacement = root.path().join("SkillRepositories/owner-repo");
        fs::create_dir_all(&replacement).unwrap();
        std::process::Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&replacement)
            .status()
            .unwrap();

        let inspected = managed_inspect(
            &captured,
            repositories.to_string_lossy().as_ref(),
            "owner-repo",
            None,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(inspected.origin, "https://example.invalid/trusted.git");
    }

    #[cfg(unix)]
    #[test]
    fn managed_repository_delete_rejects_links_and_rolls_back_quarantine() {
        use std::os::unix::fs::symlink;
        let root = home();
        let repositories = root.path().join("SkillRepositories");
        let repository = repositories.join("owner-repo");
        let victim = root.path().join("victim");
        fs::create_dir(&repositories).unwrap();
        fs::create_dir(&repository).unwrap();
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "safe").unwrap();
        symlink(victim.join("sentinel"), repository.join("link")).unwrap();
        assert!(
            delete_managed_skill_repository(
                root.path().to_string_lossy().into_owned(),
                "owner-repo".into(),
            )
            .is_err()
        );
        assert!(repository.exists());
        assert_eq!(fs::read_to_string(victim.join("sentinel")).unwrap(), "safe");
    }

    #[cfg(windows)]
    #[test]
    fn managed_repository_delete_rejects_final_junction() {
        let root = home();
        let repositories = root.path().join("SkillRepositories");
        let victim = root.path().join("victim");
        fs::create_dir(&repositories).unwrap();
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("sentinel"), "safe").unwrap();
        let junction = repositories.join("owner-repo");
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&junction)
                .arg(&victim)
                .status()
                .unwrap()
                .success()
        );
        let root_dir = Dir::open_ambient_dir(&repositories, ambient_authority()).unwrap();
        assert!(delete_managed_from_root(&root_dir, "owner-repo").is_err());
        assert_eq!(fs::read_to_string(victim.join("sentinel")).unwrap(), "safe");
        assert!(
            std::process::Command::new("cmd")
                .args(["/c", "rmdir"])
                .arg(&junction)
                .status()
                .unwrap()
                .success()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_reconcile_is_busy_then_retry_succeeds() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let root = home();
        let parent = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        parent.create_dir("target").unwrap();
        fs::write(root.path().join("target/SKILL.md"), "old").unwrap();
        let held = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(root.path().join("target/SKILL.md"))
            .unwrap();
        parent.create_dir("stage-locked").unwrap();
        fs::write(root.path().join("stage-locked/SKILL.md"), "new").unwrap();
        let error = publish_staged_tree(&parent, "stage-locked", "target", true).unwrap_err();
        assert!(error.reason.starts_with("RESOURCE_BUSY:"), "{error:?}");
        assert!(!root.path().join("stage-locked").exists());
        drop(held);
        parent.create_dir("stage-retry").unwrap();
        fs::write(root.path().join("stage-retry/SKILL.md"), "new").unwrap();
        publish_staged_tree(&parent, "stage-retry", "target", true).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("target/SKILL.md")).unwrap(),
            "new"
        );
    }

    #[cfg(unix)]
    #[test]
    fn session_worktree_deletion_unlinks_nested_links_and_rejects_external_paths() {
        let data = home();
        let store = SessionWorktreeStore::new(data.path().to_string_lossy().into_owned()).unwrap();
        let target = std::path::Path::new(&store.root_path).join("a1b2c3d4");
        let outside = data.path().join("outside");
        fs::create_dir_all(target.join("nested")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), "safe").unwrap();
        std::os::unix::fs::symlink(&outside, target.join("nested/link")).unwrap();

        let identity = capture_session_worktree_identity(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
        )
        .unwrap();
        delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
            &identity,
        )
        .unwrap();
        assert!(!target.exists());
        assert_eq!(
            fs::read_to_string(outside.join("sentinel")).unwrap(),
            "safe"
        );
        delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
            &identity,
        )
        .unwrap();
        let error = delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &outside.to_string_lossy(),
            &identity,
        )
        .unwrap_err();
        assert!(error.reason.starts_with("SESSION_WORKTREE_INVALID_PATH:"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_session_worktree_deletion_unlinks_nested_junction() {
        let data = home();
        let store = SessionWorktreeStore::new(data.path().to_string_lossy().into_owned()).unwrap();
        let target = std::path::Path::new(&store.root_path).join("a1b2c3d4");
        let outside = data.path().join("outside");
        fs::create_dir_all(target.join("nested")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("sentinel"), "safe").unwrap();
        assert!(
            Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(target.join("nested/link"))
                .arg(&outside)
                .status()
                .unwrap()
                .success()
        );

        let identity = capture_session_worktree_identity(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
        )
        .unwrap();
        delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
            &identity,
        )
        .unwrap();

        assert!(!target.exists());
        assert_eq!(
            fs::read_to_string(outside.join("sentinel")).unwrap(),
            "safe"
        );
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn session_worktree_retry_reconciles_only_its_interrupted_quarantine() {
        let data = home();
        let store = SessionWorktreeStore::new(data.path().to_string_lossy().into_owned()).unwrap();
        let target = std::path::Path::new(&store.root_path).join("facefeed");
        fs::create_dir(&target).unwrap();
        let fifo = target.join("busy-fifo");
        assert!(
            Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let unrelated = std::path::Path::new(&store.root_path)
            .join(".agent-deck-session-delete-deadbeef-0123456789abcdef0123456789abcdef");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("sentinel"), "unrelated").unwrap();

        let identity = capture_session_worktree_identity(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
        )
        .unwrap();
        let first = delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
            &identity,
        )
        .unwrap_err();
        assert!(first.reason.starts_with("SESSION_WORKTREE_UNSAFE:"));
        assert!(!target.exists());
        let quarantine = fs::read_dir(&store.root_path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".agent-deck-session-delete-facefeed-")
            })
            .unwrap();

        let retry = delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
            &identity,
        )
        .unwrap_err();
        assert!(retry.reason.starts_with("SESSION_WORKTREE_UNSAFE:"));
        assert!(quarantine.exists());
        assert_eq!(
            fs::read_to_string(unrelated.join("sentinel")).unwrap(),
            "unrelated"
        );

        fs::remove_file(quarantine.join("busy-fifo")).unwrap();
        delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &target.to_string_lossy(),
            &identity,
        )
        .unwrap();
        assert!(!quarantine.exists());
        assert_eq!(
            fs::read_to_string(unrelated.join("sentinel")).unwrap(),
            "unrelated"
        );
    }

    #[cfg(unix)]
    #[test]
    fn session_worktree_root_identity_swap_fails_closed() {
        let data = home();
        let store = SessionWorktreeStore::new(data.path().to_string_lossy().into_owned()).unwrap();
        let original = std::path::Path::new(&store.root_path).join("cafebabe");
        fs::create_dir(&original).unwrap();
        let identity = capture_session_worktree_identity(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &original.to_string_lossy(),
        )
        .unwrap();
        fs::remove_dir(&original).unwrap();
        let captured = data.path().join("captured-root");
        fs::rename(&store.root_path, &captured).unwrap();
        fs::create_dir(&store.root_path).unwrap();
        let replacement = std::path::Path::new(&store.root_path).join("deadbeef");
        fs::create_dir(&replacement).unwrap();
        let error = delete_session_worktree(
            &store.root,
            &store.root_path,
            &store.root_identity,
            &replacement.to_string_lossy(),
            &identity,
        )
        .unwrap_err();
        assert!(error.reason.starts_with("SESSION_WORKTREE_UNSAFE:"));
        assert!(replacement.exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_sharing_failure_leaks_no_owned_temp() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let root = home();
        let home = root.path().to_string_lossy().into_owned();
        create_loop_catalog_file(home.clone(), "shared.loop.md".into(), "safe".into()).unwrap();
        let loops = root.path().join(".pi/agent/loops");
        let held = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(loops.join("shared.loop.md"))
            .unwrap();
        assert!(
            replace_loop_catalog_file(home.clone(), "shared.loop.md".into(), "blocked".into())
                .is_err()
        );
        drop(held);
        assert!(fs::read_dir(loops).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(TEMP_PREFIX)
        }));

        write_resource_catalog_file(
            home.clone(),
            "global-prompts".into(),
            vec!["shared.md".into()],
            "safe".into(),
            false,
        )
        .unwrap();
        let prompts = root.path().join(".pi/agent/prompts");
        let held = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(prompts.join("shared.md"))
            .unwrap();
        let error = write_resource_catalog_file(
            home,
            "global-prompts".into(),
            vec!["shared.md".into()],
            "blocked".into(),
            false,
        )
        .unwrap_err();
        assert!(error.reason.starts_with("RESOURCE_BUSY:"), "{error:?}");
        drop(held);
        assert!(fs::read_dir(prompts).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(RESOURCE_TEMP_PREFIX)
        }));
    }
}
