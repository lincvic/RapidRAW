use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};

type PathLock = Mutex<()>;

static PATH_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<PathLock>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TargetState {
    Absent,
    RegularFile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TargetExpectation<'a> {
    Absent,
    Bytes(&'a [u8]),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TargetReplacement<'a> {
    Absent,
    Bytes(&'a [u8]),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TargetSnapshot {
    Absent,
    Bytes(Vec<u8>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ConditionalUpdateOutcome {
    Applied,
    Conflict(TargetSnapshot),
}

#[cfg(unix)]
fn open_target_file(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(windows)]
fn open_target_file(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_target_file(path: &Path) -> std::io::Result<fs::File> {
    fs::File::open(path)
}

#[cfg(windows)]
fn windows_file_standard_info(
    file: &fs::File,
) -> std::io::Result<windows_sys::Win32::Storage::FileSystem::FILE_STANDARD_INFO> {
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_STANDARD_INFO, FileStandardInfo, GetFileInformationByHandleEx,
    };

    let mut info = MaybeUninit::<FILE_STANDARD_INFO>::uninit();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { info.assume_init() })
    }
}

#[cfg(unix)]
fn file_link_count(_file: &fs::File, metadata: &fs::Metadata) -> std::io::Result<u64> {
    use std::os::unix::fs::MetadataExt;

    Ok(metadata.nlink())
}

#[cfg(windows)]
fn file_link_count(file: &fs::File, _metadata: &fs::Metadata) -> std::io::Result<u64> {
    Ok(u64::from(windows_file_standard_info(file)?.NumberOfLinks))
}

#[cfg(not(any(unix, windows)))]
fn file_link_count(_file: &fs::File, _metadata: &fs::Metadata) -> std::io::Result<u64> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "sidecar hard-link validation is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn path_link_count(_path: &Path, metadata: &fs::Metadata) -> std::io::Result<u64> {
    use std::os::unix::fs::MetadataExt;

    Ok(metadata.nlink())
}

#[cfg(windows)]
fn path_link_count(path: &Path, _metadata: &fs::Metadata) -> std::io::Result<u64> {
    let file = open_target_file(path)?;
    let metadata = file.metadata()?;
    file_link_count(&file, &metadata)
}

#[cfg(not(any(unix, windows)))]
fn path_link_count(_path: &Path, _metadata: &fs::Metadata) -> std::io::Result<u64> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "sidecar hard-link validation is unsupported on this platform",
    ))
}

#[cfg(unix)]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
pub(crate) fn file_identity(file: &fs::File) -> std::io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    volume: u64,
    id: [u8; 16],
}

#[cfg(windows)]
pub(crate) fn file_identity(file: &fs::File) -> std::io::Result<FileIdentity> {
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx,
    };

    let mut info = MaybeUninit::<FILE_ID_INFO>::uninit();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(FileIdentity {
        volume: info.VolumeSerialNumber,
        id: info.FileId.Identifier,
    })
}

#[cfg(not(any(unix, windows)))]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct FileIdentity;

#[cfg(not(any(unix, windows)))]
pub(crate) fn file_identity(_file: &fs::File) -> std::io::Result<FileIdentity> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "sidecar file-identity validation is unsupported on this platform",
    ))
}

fn validate_open_target(path: &Path, file: &fs::File) -> std::io::Result<fs::Metadata> {
    let metadata = file.metadata()?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar '{}' is a symbolic link", path.display()),
        ));
    }
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar '{}' is not a regular file", path.display()),
        ));
    }
    if file_link_count(file, &metadata)? > 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar '{}' has multiple hard links", path.display()),
        ));
    }
    Ok(metadata)
}

pub(crate) fn inspect_target(path: &Path) -> std::io::Result<TargetState> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar '{}' is a symbolic link", path.display()),
        )),
        Ok(metadata) if metadata.is_file() => {
            if path_link_count(path, &metadata)? > 1 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("sidecar '{}' has multiple hard links", path.display()),
                ));
            }
            Ok(TargetState::RegularFile)
        }
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar '{}' is not a regular file", path.display()),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TargetState::Absent),
        Err(error) => Err(error),
    }
}

fn normalized_path(path: &Path) -> std::io::Result<PathBuf> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar path '{}' has no file name", path.display()),
        )
    })?;
    Ok(fs::canonicalize(parent)?.join(file_name))
}

fn path_locks(paths: &[PathBuf]) -> Vec<Arc<PathLock>> {
    let mut registry = PATH_LOCKS.lock().unwrap_or_else(|error| error.into_inner());
    paths
        .iter()
        .map(|path| {
            if let Some(path_lock) = registry.get(path).and_then(Weak::upgrade) {
                path_lock
            } else {
                let path_lock = Arc::new(Mutex::new(()));
                registry.insert(path.clone(), Arc::downgrade(&path_lock));
                path_lock
            }
        })
        .collect()
}

pub(crate) fn with_locked_paths<T, F>(paths: &[PathBuf], operation: F) -> std::io::Result<T>
where
    F: FnOnce(&[PathBuf]) -> std::io::Result<T>,
{
    let mut paths = paths
        .iter()
        .map(|path| normalized_path(path))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.sort();
    paths.dedup();

    let locks = path_locks(&paths);
    let _guards = locks
        .iter()
        .map(|path_lock| path_lock.lock().unwrap_or_else(|error| error.into_inner()))
        .collect::<Vec<_>>();

    for path in &paths {
        inspect_target(path)?;
    }
    operation(&paths)
}

fn parent_directory(path: &Path) -> std::io::Result<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("sidecar path '{}' has no parent directory", path.display()),
            )
        })
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

#[derive(Clone, Copy)]
enum StageMode {
    Private,
    NewFile,
}

fn stage_bytes(
    path: &Path,
    bytes: &[u8],
    mode: StageMode,
) -> std::io::Result<tempfile::NamedTempFile> {
    let parent = parent_directory(path)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".rapidraw-sidecar-");
    #[cfg(unix)]
    if matches!(mode, StageMode::NewFile) {
        use std::os::unix::fs::PermissionsExt;

        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut staged = builder.tempfile_in(parent)?;
    staged.write_all(bytes)?;
    staged.flush()?;
    staged.as_file().sync_all()?;
    Ok(staged)
}

fn target_snapshot(path: &Path) -> std::io::Result<(TargetSnapshot, Option<fs::Permissions>)> {
    target_snapshot_with(path, |_| Ok(()))
}

fn target_snapshot_with<F>(
    path: &Path,
    after_read: F,
) -> std::io::Result<(TargetSnapshot, Option<fs::Permissions>)>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    const MAX_SNAPSHOT_ATTEMPTS: usize = 8;

    let mut after_read = Some(after_read);
    for _ in 0..MAX_SNAPSHOT_ATTEMPTS {
        match inspect_target(path)? {
            TargetState::Absent => return Ok((TargetSnapshot::Absent, None)),
            TargetState::RegularFile => {}
        }

        let mut file = match open_target_file(path) {
            Ok(file) => file,
            Err(error) => match inspect_target(path) {
                Ok(TargetState::Absent) => continue,
                Ok(TargetState::RegularFile) => return Err(error),
                Err(validation_error) => return Err(validation_error),
            },
        };
        validate_open_target(path, &file)?;

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        if let Some(after_read) = after_read.take() {
            after_read(path)?;
        }

        match inspect_target(path)? {
            TargetState::Absent => return Ok((TargetSnapshot::Absent, None)),
            TargetState::RegularFile => {}
        }
        let mut current_file = match open_target_file(path) {
            Ok(file) => file,
            Err(error) => match inspect_target(path) {
                Ok(TargetState::Absent) => continue,
                Ok(TargetState::RegularFile) => return Err(error),
                Err(validation_error) => return Err(validation_error),
            },
        };
        validate_open_target(path, &current_file)?;
        if file_identity(&file)? != file_identity(&current_file)? {
            continue;
        }

        let mut current_bytes = Vec::new();
        current_file.read_to_end(&mut current_bytes)?;
        let current_metadata = validate_open_target(path, &current_file)?;
        if bytes != current_bytes {
            continue;
        }

        return Ok((
            TargetSnapshot::Bytes(current_bytes),
            Some(current_metadata.permissions()),
        ));
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::WouldBlock,
        format!(
            "sidecar '{}' kept changing while it was being read",
            path.display()
        ),
    ))
}

fn snapshot_matches(snapshot: &TargetSnapshot, expected: TargetExpectation<'_>) -> bool {
    match (snapshot, expected) {
        (TargetSnapshot::Absent, TargetExpectation::Absent) => true,
        (TargetSnapshot::Bytes(current), TargetExpectation::Bytes(expected)) => current == expected,
        _ => false,
    }
}

fn sync_persisted_file(
    persisted: &fs::File,
    parent: &Path,
    permissions: Option<fs::Permissions>,
) -> std::io::Result<()> {
    if let Some(permissions) = permissions {
        persisted.set_permissions(permissions)?;
    }
    persisted.sync_all()?;
    sync_parent_directory(parent)
}

/// Applies one exact expected-content transition and reports mismatches without mutation.
///
/// Portable filesystems do not provide a content-based compare-and-swap primitive. RapidRAW
/// writers are serialized by `with_locked_paths`; replacement bytes are staged before a final
/// validation to minimize the remaining read-to-action window for non-cooperating writers. A
/// well-timed external process can still change an existing target after validation. Where native
/// no-replace rename is unavailable, `tempfile` may use its documented hard-link fallback for
/// absent-target publication.
pub(crate) fn atomic_update_if_matches(
    path: &Path,
    expected: TargetExpectation<'_>,
    replacement: TargetReplacement<'_>,
) -> std::io::Result<ConditionalUpdateOutcome> {
    atomic_update_if_matches_with(path, expected, replacement, |_| Ok(()))
}

fn atomic_update_if_matches_with<F>(
    path: &Path,
    expected: TargetExpectation<'_>,
    replacement: TargetReplacement<'_>,
    before_final_validation: F,
) -> std::io::Result<ConditionalUpdateOutcome>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    let parent = parent_directory(path)?;
    let mut staged = match replacement {
        TargetReplacement::Absent => None,
        TargetReplacement::Bytes(bytes) => {
            let mode = match expected {
                TargetExpectation::Absent => StageMode::NewFile,
                TargetExpectation::Bytes(_) => StageMode::Private,
            };
            Some(stage_bytes(path, bytes, mode)?)
        }
    };

    let (observed, target_permissions) = target_snapshot(path)?;
    if !snapshot_matches(&observed, expected) {
        return Ok(ConditionalUpdateOutcome::Conflict(observed));
    }

    if let Some(staged) = staged.as_mut() {
        if let Some(permissions) = target_permissions.as_ref() {
            staged.as_file().set_permissions(permissions.clone())?;
            staged.as_file().sync_all()?;
        }
    }

    if !matches!(
        (expected, replacement),
        (TargetExpectation::Absent, TargetReplacement::Absent)
    ) {
        before_final_validation(path)?;
        let (observed, final_permissions) = target_snapshot(path)?;
        if !snapshot_matches(&observed, expected) || final_permissions != target_permissions {
            return Ok(ConditionalUpdateOutcome::Conflict(observed));
        }
    }

    match (expected, replacement, staged) {
        (TargetExpectation::Absent, TargetReplacement::Absent, _) => {
            Ok(ConditionalUpdateOutcome::Applied)
        }
        (TargetExpectation::Bytes(_), TargetReplacement::Absent, _) => {
            fs::remove_file(path)?;
            sync_parent_directory(parent)?;
            Ok(ConditionalUpdateOutcome::Applied)
        }
        (TargetExpectation::Absent, TargetReplacement::Bytes(_), Some(staged)) => {
            match staged.persist_noclobber(path) {
                Ok(persisted) => {
                    sync_persisted_file(&persisted, parent, None)?;
                    Ok(ConditionalUpdateOutcome::Applied)
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    drop(error.file);
                    let (observed, _) = target_snapshot(path)?;
                    Ok(ConditionalUpdateOutcome::Conflict(observed))
                }
                Err(error) => Err(error.error),
            }
        }
        (TargetExpectation::Bytes(_), TargetReplacement::Bytes(_), Some(staged)) => {
            let persisted = staged.persist(path).map_err(|error| error.error)?;
            sync_persisted_file(&persisted, parent, target_permissions)?;
            Ok(ConditionalUpdateOutcome::Applied)
        }
        (_, TargetReplacement::Bytes(_), None) => unreachable!("replacement bytes were staged"),
    }
}

pub(crate) fn atomic_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = parent_directory(path)?;
    // Inode replacement can preserve portable permission bits, but not platform ACLs or xattrs.
    let target_permissions = match inspect_target(path)? {
        TargetState::Absent => None,
        TargetState::RegularFile => Some(fs::symlink_metadata(path)?.permissions()),
    };
    let stage_mode = if target_permissions.is_some() {
        StageMode::Private
    } else {
        StageMode::NewFile
    };
    let staged = stage_bytes(path, bytes, stage_mode)?;
    if let Some(permissions) = target_permissions {
        staged.as_file().set_permissions(permissions)?;
    }
    let persisted = staged.persist(path).map_err(|error| error.error)?;
    persisted.sync_all()?;
    sync_parent_directory(parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn existing_target_stage_starts_private() {
        const CHILD_MARKER: &str = "RAPIDRAW_PRIVATE_STAGE_TEST_CHILD";

        if std::env::var_os(CHILD_MARKER).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("existing_target_stage_starts_private")
                .arg("--nocapture")
                .env(CHILD_MARKER, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "child test failed:\n{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        use std::os::unix::fs::PermissionsExt;

        // Keep umask changes isolated to the child test process.
        unsafe {
            libc::umask(0o022);
        }
        let temp = tempfile::tempdir().unwrap();
        let sidecar = temp.path().join("private-stage.RAF.rrdata");
        fs::write(&sidecar, b"before").unwrap();

        let staged = stage_bytes(&sidecar, b"replacement", StageMode::Private).unwrap();

        assert_eq!(
            staged.as_file().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read(&sidecar).unwrap(), b"before");
    }

    #[cfg(unix)]
    #[test]
    fn conditional_update_conflicts_if_permissions_change_before_final_validation() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let sidecar = temp.path().join("chmod-race.RAF.rrdata");
        fs::write(&sidecar, b"expected").unwrap();
        fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o640)).unwrap();

        let outcome = atomic_update_if_matches_with(
            &sidecar,
            TargetExpectation::Bytes(b"expected"),
            TargetReplacement::Bytes(b"replacement"),
            |path| fs::set_permissions(path, fs::Permissions::from_mode(0o600)),
        )
        .unwrap();

        assert_eq!(
            outcome,
            ConditionalUpdateOutcome::Conflict(TargetSnapshot::Bytes(b"expected".to_vec()))
        );
        assert_eq!(fs::read(&sidecar).unwrap(), b"expected");
        assert_eq!(
            fs::metadata(&sidecar).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn target_snapshot_retries_if_path_is_replaced_after_read() {
        let temp = tempfile::tempdir().unwrap();
        let sidecar = temp.path().join("snapshot-race.RAF.rrdata");
        let displaced = temp.path().join("displaced.rrdata");
        let incoming = temp.path().join("incoming.rrdata");
        fs::write(&sidecar, b"old-expected").unwrap();
        fs::write(&incoming, b"settled-external").unwrap();

        let (snapshot, _) = target_snapshot_with(&sidecar, |path| {
            fs::rename(path, &displaced)?;
            fs::rename(&incoming, path)
        })
        .unwrap();

        assert_eq!(
            snapshot,
            TargetSnapshot::Bytes(b"settled-external".to_vec())
        );
        assert_eq!(fs::read(&sidecar).unwrap(), b"settled-external");
        assert_eq!(fs::read(&displaced).unwrap(), b"old-expected");
    }

    #[test]
    fn target_snapshot_retries_if_bytes_change_in_place_after_read() {
        let temp = tempfile::tempdir().unwrap();
        let sidecar = temp.path().join("snapshot-in-place-race.RAF.rrdata");
        fs::write(&sidecar, b"old-expected").unwrap();
        let identity_before = file_identity(&open_target_file(&sidecar).unwrap()).unwrap();

        let (snapshot, _) =
            target_snapshot_with(&sidecar, |path| fs::write(path, b"new-external")).unwrap();

        let identity_after = file_identity(&open_target_file(&sidecar).unwrap()).unwrap();
        assert!(identity_before == identity_after);
        assert_eq!(snapshot, TargetSnapshot::Bytes(b"new-external".to_vec()));
        assert_eq!(fs::read(&sidecar).unwrap(), b"new-external");
    }
}
