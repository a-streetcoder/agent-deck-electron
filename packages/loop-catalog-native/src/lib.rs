use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::ambient_authority;
#[cfg(unix)]
use cap_std::fs::OpenOptionsExt;
use cap_std::fs::{Dir, OpenOptions};
use napi::{Error, Result, Status};
use napi_derive::napi;

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

fn unique_temp(dir: &Dir, content: &str) -> std::io::Result<(String, cap_std::fs::File)> {
    for _ in 0..128 {
        let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!("{TEMP_PREFIX}{}-{sequence:016x}", std::process::id());
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
        assert!(create_loop_catalog_file(home, "a.loop.md".into(), "bad".into()).is_err());
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
