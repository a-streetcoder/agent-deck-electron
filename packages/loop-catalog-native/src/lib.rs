use std::io::{ErrorKind, Read, Write};
#[cfg(not(windows))]
use std::sync::atomic::{AtomicU64, Ordering};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::ambient_authority;
#[cfg(windows)]
use cap_std::fs::OpenOptionsExt as _;
use cap_std::fs::{Dir, OpenOptions};
#[cfg(unix)]
use cap_std::fs::{MetadataExt as _, OpenOptionsExt};
use napi::{Error, Result, Status};
use napi_derive::napi;

#[cfg(not(windows))]
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
    #[cfg(windows)]
    if maybe_dir {
        options.share_mode(
            windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
        );
    }
    dir.open_with(name, &options)
}

fn open_child_dir(parent: &Dir, name: &str, create: bool) -> std::io::Result<Option<Dir>> {
    match parent.symlink_metadata(name) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
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
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "unsafe directory component",
        ));
    }
    Ok(Some(Dir::reopen_dir(&opened)?))
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
fn windows_open_mutation(
    dir: &Dir,
    name: &str,
    write: bool,
    maybe_dir: bool,
) -> std::io::Result<cap_std::fs::File> {
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let mut options = OpenOptions::new();
    options
        .read(true)
        .follow(FollowSymlinks::No)
        .maybe_dir(maybe_dir)
        .access_mode(DELETE | FILE_GENERIC_READ | if write { FILE_GENERIC_WRITE } else { 0 })
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    dir.open_with(name, &options)
}

#[cfg(windows)]
fn windows_rename_handle(
    source: &cap_std::fs::File,
    to_dir: &Dir,
    to: &str,
    replace: bool,
) -> std::io::Result<()> {
    use std::mem::{offset_of, size_of};
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_RENAME_INFO, FileRenameInfo, FileRenameInfoEx, SetFileInformationByHandle,
    };

    let name: Vec<u16> = std::ffi::OsStr::new(to).encode_wide().collect();
    let name_bytes = name
        .len()
        .checked_mul(2)
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "target name is too long"))?;
    let buffer_size = offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(name_bytes)
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "rename buffer overflow"))?;
    let words = buffer_size.div_ceil(size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        if replace {
            (*info).Anonymous.Flags = 0x0000_0001 | 0x0000_0002;
        } else {
            (*info).Anonymous.ReplaceIfExists = 0;
        }
        (*info).RootDirectory = to_dir.as_raw_handle();
        (*info).FileNameLength = u32::try_from(name_bytes)
            .map_err(|_| std::io::Error::new(ErrorKind::InvalidInput, "target name is too long"))?;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
        if SetFileInformationByHandle(
            source.as_raw_handle(),
            if replace {
                FileRenameInfoEx
            } else {
                FileRenameInfo
            },
            info.cast(),
            u32::try_from(buffer_size).map_err(|_| {
                std::io::Error::new(ErrorKind::InvalidInput, "rename buffer is too large")
            })?,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_delete_handle(file: &cap_std::fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_DISPOSITION_INFO, FileDispositionInfo, SetFileInformationByHandle,
    };
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let result = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            std::ptr::addr_of!(disposition).cast(),
            u32::try_from(std::mem::size_of_val(&disposition)).unwrap(),
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn rename_noreplace(from_dir: &Dir, from: &str, to_dir: &Dir, to: &str) -> std::io::Result<()> {
    let source = windows_open_mutation(from_dir, from, false, true)?;
    windows_rename_handle(&source, to_dir, to, false)
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
    Dir::reopen_dir(&opened).map_err(map_resource_io)
}

fn unique_resource_temp(
    dir: &Dir,
    prefix: &str,
    content: &str,
) -> std::io::Result<(String, cap_std::fs::File)> {
    for _ in 0..128 {
        let name = format!("{prefix}{}", private_nonce()?);
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No)
            .maybe_dir(false);
        #[cfg(unix)]
        options.mode(0o600);
        #[cfg(windows)]
        options
            .access_mode(
                windows_sys::Win32::Storage::FileSystem::DELETE
                    | windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ
                    | windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE,
            )
            .share_mode(
                windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                    | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
            );
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
    #[cfg(windows)]
    let target_guard = if replace_existing {
        Some(windows_open_mutation(&parent, &leaf, true, true).map_err(map_resource_io)?)
    } else {
        None
    };
    let (temp, file) =
        unique_resource_temp(&parent, RESOURCE_TEMP_PREFIX, &content).map_err(map_resource_io)?;
    #[cfg(windows)]
    let _ = &temp;
    #[cfg(windows)]
    let result = windows_rename_handle(&file, &parent, &leaf, replace_existing);
    #[cfg(not(windows))]
    let result = if replace_existing {
        parent.rename(&temp, &parent, &leaf)
    } else {
        parent.hard_link(&temp, &parent, &leaf)
    };
    #[cfg(windows)]
    if result.is_err() {
        let _ = windows_delete_handle(&file);
    }
    drop(file);
    #[cfg(windows)]
    drop(target_guard);
    #[cfg(not(windows))]
    let _ = parent.remove_file(&temp);
    result.map_err(map_resource_io)?;
    sync_dir(&parent).map_err(map_resource_io)
}

#[cfg(not(windows))]
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
    let entries = child.entries().map_err(map_resource_io)?;
    for entry in entries {
        let entry = entry.map_err(map_resource_io)?;
        let entry_name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| {
                resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 resource name")
            })?;
        let metadata = child
            .symlink_metadata(&entry_name)
            .map_err(map_resource_io)?;
        if metadata.file_type().is_symlink() {
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "nested links are not resource mutation targets",
            ));
        }
        remove_tree_entry(&child, &entry_name)?;
    }
    drop(child);
    parent.remove_dir(name).map_err(map_resource_io)
}

#[cfg(windows)]
fn remove_opened_tree(opened: &cap_std::fs::File) -> Result<()> {
    let opened_metadata = opened.metadata().map_err(map_resource_io)?;
    if opened_metadata.file_type().is_symlink()
        || (!opened_metadata.is_file() && !opened_metadata.is_dir())
    {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "opened resource entry is unsafe",
        ));
    }
    if opened_metadata.is_dir() {
        let child = Dir::reopen_dir(opened).map_err(map_resource_io)?;
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
        for entry_name in names {
            let nested = child
                .symlink_metadata(&entry_name)
                .map_err(map_resource_io)?;
            if nested.file_type().is_symlink() {
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "nested links are not resource mutation targets",
                ));
            }
            remove_tree_entry(&child, &entry_name)?;
        }
        drop(child);
    }
    windows_delete_handle(opened).map_err(map_resource_io)
}

#[cfg(windows)]
fn remove_tree_entry(parent: &Dir, name: &str) -> Result<()> {
    let metadata = parent.symlink_metadata(name).map_err(map_resource_io)?;
    if metadata.file_type().is_symlink() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "links are not resource mutation targets",
        ));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "unsupported file type",
        ));
    }
    let opened =
        windows_open_mutation(parent, name, metadata.is_file(), true).map_err(map_resource_io)?;
    let opened_metadata = opened.metadata().map_err(map_resource_io)?;
    if opened_metadata.file_type().is_symlink()
        || opened_metadata.is_file() != metadata.is_file()
        || opened_metadata.is_dir() != metadata.is_dir()
    {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "resource entry changed type",
        ));
    }
    remove_opened_tree(&opened)
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

#[cfg(windows)]
fn rename_resource_entry_windows(
    from_parent: &Dir,
    from_leaf: &str,
    to_parent: &Dir,
    to_leaf: &str,
    source_is_file: bool,
    _case_only: bool,
    replacement_content: Option<&str>,
) -> Result<()> {
    let source = windows_open_mutation(from_parent, from_leaf, source_is_file, true)
        .map_err(map_resource_io)?;
    if let Some(content) = replacement_content {
        let (temporary, replacement) =
            unique_resource_temp(to_parent, RESOURCE_TEMP_PREFIX, content)
                .map_err(map_resource_io)?;
        let publication = windows_rename_handle(&replacement, to_parent, to_leaf, false);
        drop(replacement);
        if let Err(error) = publication {
            let _ = to_parent.remove_file(&temporary);
            return Err(map_resource_io(error));
        }
        if let Err(error) = windows_delete_handle(&source) {
            return Err(map_resource_io(error));
        }
    } else {
        windows_rename_handle(&source, to_parent, to_leaf, false).map_err(map_resource_io)?;
    }
    Ok(())
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
    #[cfg(windows)]
    {
        rename_resource_entry_windows(
            &from_parent,
            &from_leaf,
            &to_parent,
            &to_leaf,
            source.is_file(),
            case_only,
            replacement_content.as_deref(),
        )?;
        sync_dir(&from_parent).map_err(map_resource_io)?;
        sync_dir(&to_parent).map_err(map_resource_io)
    }
    #[cfg(not(windows))]
    let replacement = if let Some(content) = replacement_content.as_deref() {
        let (name, file) = unique_resource_temp(&to_parent, RESOURCE_TEMP_PREFIX, content)
            .map_err(map_resource_io)?;
        drop(file);
        Some(name)
    } else {
        None
    };
    #[cfg(not(windows))]
    if case_only && to_parent.symlink_metadata(&to_leaf).is_ok() {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = format!(
            "{RESOURCE_BACKUP_PREFIX}rename-{}-{sequence:016x}",
            std::process::id()
        );
        if let Err(error) = from_parent.rename(&from_leaf, &from_parent, &temporary) {
            if let Some(replacement) = &replacement {
                let _ = to_parent.remove_file(replacement);
            }
            return Err(map_resource_io(error));
        }
        if to_parent.symlink_metadata(&to_leaf).is_ok() {
            let _ = rename_noreplace(&from_parent, &temporary, &from_parent, &from_leaf);
            if let Some(replacement) = &replacement {
                let _ = to_parent.remove_file(replacement);
            }
            return Err(resource_error("RESOURCE_ALREADY_EXISTS", "target exists"));
        }
        let result = if let Some(replacement) = &replacement {
            rename_noreplace(&to_parent, replacement, &to_parent, &to_leaf)
        } else {
            rename_noreplace(&from_parent, &temporary, &to_parent, &to_leaf)
        };
        if let Err(error) = result {
            let _ = rename_noreplace(&from_parent, &temporary, &from_parent, &from_leaf);
            if let Some(replacement) = &replacement {
                let _ = to_parent.remove_file(replacement);
            }
            return Err(map_resource_io(error));
        }
        if replacement.is_some() {
            let _ = from_parent.remove_file(&temporary);
        }
    } else if source.is_file() {
        let source_name = replacement.as_deref().unwrap_or(&from_leaf);
        let source_parent = if replacement.is_some() {
            &to_parent
        } else {
            &from_parent
        };
        if let Err(error) = source_parent.hard_link(source_name, &to_parent, &to_leaf) {
            if let Some(replacement) = &replacement {
                let _ = to_parent.remove_file(replacement);
            }
            return Err(map_resource_io(error));
        }
        if let Err(error) = from_parent.remove_file(&from_leaf) {
            let _ = to_parent.remove_file(&to_leaf);
            if let Some(replacement) = &replacement {
                let _ = to_parent.remove_file(replacement);
            }
            return Err(map_resource_io(error));
        }
        if let Some(replacement) = &replacement {
            let _ = to_parent.remove_file(replacement);
        }
    } else {
        if to_parent.symlink_metadata(&to_leaf).is_ok() {
            return Err(resource_error("RESOURCE_ALREADY_EXISTS", "target exists"));
        }
        rename_noreplace(&from_parent, &from_leaf, &to_parent, &to_leaf)
            .map_err(map_resource_io)?;
    }
    #[cfg(not(windows))]
    {
        sync_dir(&from_parent).map_err(map_resource_io)?;
        sync_dir(&to_parent).map_err(map_resource_io)
    }
}

fn copy_tree(source: &Dir, destination: &Dir) -> Result<()> {
    for entry in source.entries().map_err(map_resource_io)? {
        let entry = entry.map_err(map_resource_io)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "non-UTF-8 source name"))?;
        if name == ".git" {
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
            copy_tree(&source_child, &destination_child)?;
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
        #[cfg(windows)]
        options
            .access_mode(
                windows_sys::Win32::Storage::FileSystem::DELETE
                    | windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ
                    | windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE,
            )
            .share_mode(
                windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                    | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE,
            );
        match destination.open_with(&temporary, &options) {
            Ok(mut output) => {
                if let Err(error) =
                    std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all())
                {
                    drop(output);
                    let _ = destination.remove_file(&temporary);
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
        #[cfg(windows)]
        let target_guard =
            windows_open_mutation(destination, name, true, true).map_err(map_resource_io)?;
        let (temporary, file) = staged_file_temp(staged, name, destination)?;
        #[cfg(windows)]
        let _ = &temporary;
        #[cfg(windows)]
        let result = windows_rename_handle(&file, destination, name, true);
        #[cfg(not(windows))]
        let result = destination.rename(&temporary, destination, name);
        #[cfg(windows)]
        if result.is_err() {
            let _ = windows_delete_handle(&file);
        }
        drop(file);
        #[cfg(windows)]
        drop(target_guard);
        if let Err(error) = result {
            #[cfg(not(windows))]
            let _ = destination.remove_file(&temporary);
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
        #[cfg(windows)]
        let _ = &temporary;
        #[cfg(windows)]
        let result = windows_rename_handle(&file, destination, name, false);
        #[cfg(not(windows))]
        let result = rename_noreplace(destination, &temporary, destination, name);
        #[cfg(windows)]
        if result.is_err() {
            let _ = windows_delete_handle(&file);
        }
        drop(file);
        if let Err(error) = result {
            #[cfg(not(windows))]
            let _ = destination.remove_file(&temporary);
            return Err(reconcile_io(error, *mutated));
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

fn cleanup_owned_stage(
    parent: &Dir,
    stage: &str,
    stage_handle: Option<&cap_std::fs::File>,
) -> Result<()> {
    #[cfg(windows)]
    if let Some(stage_handle) = stage_handle {
        return remove_opened_tree(stage_handle);
    }
    #[cfg(not(windows))]
    let _ = stage_handle;
    remove_tree_entry(parent, stage)
}

fn publish_staged_tree_with_handle(
    parent: &Dir,
    stage: &str,
    leaf: &str,
    replace: bool,
    stage_handle: Option<&cap_std::fs::File>,
) -> Result<()> {
    if !replace {
        #[cfg(windows)]
        let publication = if let Some(stage_handle) = stage_handle {
            windows_rename_handle(stage_handle, parent, leaf, false)
        } else {
            rename_noreplace(parent, stage, parent, leaf)
        };
        #[cfg(not(windows))]
        let publication = rename_noreplace(parent, stage, parent, leaf);
        if let Err(error) = publication {
            let _ = cleanup_owned_stage(parent, stage, stage_handle);
            return Err(map_resource_io(error));
        }
        return sync_dir(parent).map_err(map_resource_io);
    }

    #[cfg(not(windows))]
    let _ = stage_handle;
    let target = match parent.symlink_metadata(leaf) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                let _ = cleanup_owned_stage(parent, stage, stage_handle);
                return Err(resource_error(
                    "RESOURCE_UNSAFE_COMPONENT",
                    "target changed to an unsafe entry",
                ));
            }
            Some(metadata)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            let _ = cleanup_owned_stage(parent, stage, stage_handle);
            return Err(map_resource_io(error));
        }
    };
    let Some(target) = target else {
        #[cfg(windows)]
        let publication = if let Some(stage_handle) = stage_handle {
            windows_rename_handle(stage_handle, parent, leaf, false)
        } else {
            rename_noreplace(parent, stage, parent, leaf)
        };
        #[cfg(not(windows))]
        let publication = rename_noreplace(parent, stage, parent, leaf);
        if let Err(error) = publication {
            let _ = cleanup_owned_stage(parent, stage, stage_handle);
            return Err(map_resource_io(error));
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
            let _ = remove_tree_entry(parent, stage);
            return Err(map_resource_io(error));
        }
        let exchanged = match parent.symlink_metadata(stage) {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = exchange_entries(parent, stage, parent, leaf);
                return Err(map_resource_io(error));
            }
        };
        if !exchanged.is_dir()
            || exchanged.file_type().is_symlink()
            || exchanged.dev() != target.dev()
            || exchanged.ino() != target.ino()
        {
            let _ = exchange_entries(parent, stage, parent, leaf);
            let _ = remove_tree_entry(parent, stage);
            return Err(resource_error(
                "RESOURCE_UNSAFE_COMPONENT",
                "target changed during replacement",
            ));
        }
        if let Err(error) = remove_tree_entry(parent, stage) {
            // Publication succeeded and the original remains recoverable under
            // the owned stage name. Attempt an atomic rollback before failing.
            if exchange_entries(parent, stage, parent, leaf).is_ok() {
                let _ = remove_tree_entry(parent, stage);
            }
            return Err(error);
        }
        sync_dir(parent).map_err(map_resource_io)
    }

    #[cfg(windows)]
    {
        let _ = target;
        let mut mutated = false;
        let result = (|| {
            let _stage_pin = if stage_handle.is_none() {
                Some(
                    windows_open_mutation(parent, stage, false, true)
                        .map_err(|error| reconcile_io(error, false))?,
                )
            } else {
                None
            };
            let _destination_pin = windows_open_mutation(parent, leaf, false, true)
                .map_err(|error| reconcile_io(error, false))?;
            let staged = open_child_dir(parent, stage, false)
                .map_err(|error| reconcile_io(error, false))?
                .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "staging changed"))?;
            let destination = open_child_dir(parent, leaf, false)
                .map_err(|error| reconcile_io(error, false))?
                .ok_or_else(|| resource_error("RESOURCE_UNSAFE_COMPONENT", "target changed"))?;
            validate_reconcile_tree(&staged)?;
            validate_reconcile_tree(&destination)?;
            reconcile_staged_dir(&staged, &destination, &mut mutated)?;
            validate_exact_tree(&staged, &destination)
        })();
        let cleanup = cleanup_owned_stage(parent, stage, stage_handle);
        if let Err(error) = result {
            return Err(
                if mutated && !error.reason.starts_with("RESOURCE_UNSAFE_COMPONENT:") {
                    resource_error(
                        "RESOURCE_RECONCILE_INCOMPLETE",
                        if cleanup.is_err() {
                            "reconciliation and private-stage cleanup were interrupted; retry"
                        } else {
                            "resource reconciliation was interrupted; retry the operation"
                        },
                    )
                } else {
                    error
                },
            );
        }
        if cleanup.is_err() {
            return Err(resource_error(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "resource was reconciled but private-stage cleanup was interrupted; retry",
            ));
        }
        sync_dir(parent).map_err(map_resource_io)
    }
}

#[cfg(test)]
fn publish_staged_tree(parent: &Dir, stage: &str, leaf: &str, replace: bool) -> Result<()> {
    publish_staged_tree_with_handle(parent, stage, leaf, replace, None)
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
    #[cfg(windows)]
    let stage_file =
        windows_open_mutation(&parent, &stage, false, true).map_err(map_resource_io)?;
    #[cfg(not(windows))]
    let stage_file = nofollow_open(&parent, &stage, false, true).map_err(map_resource_io)?;
    if !stage_file.metadata().map_err(map_resource_io)?.is_dir() {
        return Err(resource_error(
            "RESOURCE_UNSAFE_COMPONENT",
            "staging changed type",
        ));
    }
    let stage_dir = Dir::reopen_dir(&stage_file).map_err(map_resource_io)?;
    if let Err(error) = copy_tree(&source, &stage_dir) {
        drop(stage_dir);
        drop(stage_file);
        let _ = remove_tree_entry(&parent, &stage);
        return Err(error);
    }
    drop(stage_dir);
    let result =
        publish_staged_tree_with_handle(&parent, &stage, &leaf, replace, Some(&stage_file));
    drop(stage_file);
    result
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
    fn windows_captured_parent_and_owned_stage_cannot_be_swapped_before_publication() {
        let root = home();
        let parent_path = root.path().join("captured-parent");
        fs::create_dir(&parent_path).unwrap();
        let parent = Dir::open_ambient_dir(&parent_path, ambient_authority()).unwrap();
        parent.create_dir("stage").unwrap();
        parent.create_dir("destination").unwrap();
        fs::write(parent_path.join("target-file"), "target").unwrap();
        let stage = windows_open_mutation(&parent, "stage", false, true).unwrap();
        let destination = windows_open_mutation(&parent, "destination", false, true).unwrap();
        let target_file = windows_open_mutation(&parent, "target-file", true, true).unwrap();
        let held_parent = root.path().join("captured-parent-held");
        assert!(fs::rename(&parent_path, &held_parent).is_err());
        assert!(fs::rename(parent_path.join("stage"), parent_path.join("stage-held")).is_err());
        assert!(fs::remove_dir(parent_path.join("stage")).is_err());
        assert!(
            fs::rename(
                parent_path.join("destination"),
                parent_path.join("destination-held")
            )
            .is_err()
        );
        assert!(fs::remove_dir(parent_path.join("destination")).is_err());
        assert!(
            fs::rename(
                parent_path.join("target-file"),
                parent_path.join("target-held")
            )
            .is_err()
        );
        assert!(fs::remove_file(parent_path.join("target-file")).is_err());
        drop(stage);
        drop(destination);
        drop(target_file);
        fs::rename(parent_path.join("stage"), parent_path.join("stage-held")).unwrap();
        fs::remove_dir(parent_path.join("stage-held")).unwrap();
        fs::remove_dir(parent_path.join("destination")).unwrap();
        fs::rename(
            parent_path.join("target-file"),
            parent_path.join("target-held"),
        )
        .unwrap();
        fs::remove_file(parent_path.join("target-held")).unwrap();
        drop(parent);
        fs::rename(&parent_path, &held_parent).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_resource_junction_target_is_rejected() {
        use std::process::Command;
        let root = home();
        let victim = root.path().join("resource-victim");
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("SKILL.md"), "outside-safe").unwrap();
        let skills = root.path().join(".pi/agent/skills");
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
            replace_loop_catalog_file(home, "shared.loop.md".into(), "blocked".into()).is_err()
        );
        drop(held);
        assert!(fs::read_dir(loops).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(TEMP_PREFIX)
        }));
    }
}
