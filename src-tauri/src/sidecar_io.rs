use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, Weak};

type PathLock = Mutex<()>;

static PATH_LOCKS: LazyLock<Mutex<BTreeMap<PhysicalPathKey, Weak<PathLock>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
std::thread_local! {
    static INSENSITIVE_COMPARE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Clone, Debug)]
enum PhysicalLeafKey {
    Exact(OsString),
    #[cfg(target_os = "macos")]
    MacInsensitive(String),
    #[cfg(target_os = "windows")]
    WindowsInsensitive(Vec<u16>),
    #[cfg(any(target_os = "linux", test))]
    LinuxAsciiInsensitive(Vec<u8>),
}

impl PartialEq for PhysicalLeafKey {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for PhysicalLeafKey {}

impl PartialOrd for PhysicalLeafKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PhysicalLeafKey {
    fn cmp(&self, other: &Self) -> Ordering {
        #[cfg(target_os = "macos")]
        {
            return match (self, other) {
                (Self::Exact(left), Self::Exact(right)) => left.cmp(right),
                (Self::MacInsensitive(left), Self::MacInsensitive(right)) => {
                    #[cfg(test)]
                    INSENSITIVE_COMPARE_COUNT.with(|count| count.set(count.get() + 1));
                    mac_insensitive_compare(left, right)
                }
                #[cfg(test)]
                (Self::LinuxAsciiInsensitive(left), Self::LinuxAsciiInsensitive(right)) => {
                    left.cmp(right)
                }
                (Self::Exact(_), Self::MacInsensitive(_)) => Ordering::Less,
                (Self::MacInsensitive(_), Self::Exact(_)) => Ordering::Greater,
                #[cfg(test)]
                (Self::Exact(_) | Self::MacInsensitive(_), Self::LinuxAsciiInsensitive(_)) => {
                    Ordering::Less
                }
                #[cfg(test)]
                (Self::LinuxAsciiInsensitive(_), Self::Exact(_) | Self::MacInsensitive(_)) => {
                    Ordering::Greater
                }
            };
        }

        #[cfg(target_os = "windows")]
        {
            return match (self, other) {
                (Self::Exact(left), Self::Exact(right)) => left.cmp(right),
                (Self::WindowsInsensitive(left), Self::WindowsInsensitive(right)) => {
                    #[cfg(test)]
                    INSENSITIVE_COMPARE_COUNT.with(|count| count.set(count.get() + 1));
                    windows_insensitive_compare(left, right)
                }
                (Self::Exact(_), Self::WindowsInsensitive(_)) => Ordering::Less,
                (Self::WindowsInsensitive(_), Self::Exact(_)) => Ordering::Greater,
                #[cfg(test)]
                (Self::LinuxAsciiInsensitive(left), Self::LinuxAsciiInsensitive(right)) => {
                    left.cmp(right)
                }
                #[cfg(test)]
                (Self::Exact(_) | Self::WindowsInsensitive(_), Self::LinuxAsciiInsensitive(_)) => {
                    Ordering::Less
                }
                #[cfg(test)]
                (Self::LinuxAsciiInsensitive(_), Self::Exact(_) | Self::WindowsInsensitive(_)) => {
                    Ordering::Greater
                }
            };
        }

        #[cfg(target_os = "linux")]
        {
            return match (self, other) {
                (Self::Exact(left), Self::Exact(right)) => left.cmp(right),
                (Self::LinuxAsciiInsensitive(left), Self::LinuxAsciiInsensitive(right)) => {
                    left.cmp(right)
                }
                (Self::Exact(_), Self::LinuxAsciiInsensitive(_)) => Ordering::Less,
                (Self::LinuxAsciiInsensitive(_), Self::Exact(_)) => Ordering::Greater,
            };
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        match (self, other) {
            (Self::Exact(left), Self::Exact(right)) => left.cmp(right),
            #[cfg(test)]
            (Self::LinuxAsciiInsensitive(left), Self::LinuxAsciiInsensitive(right)) => {
                left.cmp(right)
            }
            #[cfg(test)]
            (Self::Exact(_), Self::LinuxAsciiInsensitive(_)) => Ordering::Less,
            #[cfg(test)]
            (Self::LinuxAsciiInsensitive(_), Self::Exact(_)) => Ordering::Greater,
        }
    }
}

#[cfg(any(target_os = "linux", test))]
const LINUX_EXT_SUPER_MAGIC: u64 = 0x0000_ef53;
#[cfg(any(target_os = "linux", test))]
const LINUX_F2FS_SUPER_MAGIC: u64 = 0xf2f5_2010;
#[cfg(any(target_os = "linux", test))]
const LINUX_BTRFS_SUPER_MAGIC: u64 = 0x9123_683e;
#[cfg(any(target_os = "linux", test))]
const LINUX_TMPFS_MAGIC: u64 = 0x0102_1994;
#[cfg(any(target_os = "linux", test))]
const LINUX_XFS_SUPER_MAGIC: u64 = 0x5846_5342;
#[cfg(any(target_os = "linux", test))]
const LINUX_MSDOS_SUPER_MAGIC: u64 = 0x0000_4d44;
#[cfg(any(target_os = "linux", test))]
const LINUX_EXFAT_SUPER_MAGIC: u64 = 0x2011_bab0;
#[cfg(any(target_os = "linux", test))]
const LINUX_NFS_SUPER_MAGIC: u64 = 0x0000_6969;
#[cfg(any(target_os = "linux", test))]
const LINUX_CIFS_SUPER_MAGIC: u64 = 0xff53_4d42;
#[cfg(any(target_os = "linux", test))]
const LINUX_FUSE_SUPER_MAGIC: u64 = 0x6573_5546;
#[cfg(any(target_os = "linux", test))]
const LINUX_OVERLAYFS_SUPER_MAGIC: u64 = 0x794c_7630;
#[cfg(any(target_os = "linux", test))]
const LINUX_FS_CASEFOLD_FL: u32 = 0x4000_0000;
#[cfg(any(target_os = "linux", test))]
const LINUX_XFS_FSOP_GEOM_FLAGS_DIRV2CI: u32 = 1 << 12;

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxCaseMode {
    Sensitive,
    AsciiInsensitive,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct LinuxMountRecord {
    mount_id: u64,
    fs_type: Vec<u8>,
    mount_options: Vec<u8>,
    super_options: Vec<u8>,
}

#[cfg(any(target_os = "linux", test))]
#[repr(C)]
struct LinuxXfsFsopGeomV1 {
    blocksize: u32,
    rtextsize: u32,
    agblocks: u32,
    agcount: u32,
    logblocks: u32,
    sectsize: u32,
    inodesize: u32,
    imaxpct: u32,
    datablocks: u64,
    rtblocks: u64,
    rtextents: u64,
    logstart: u64,
    uuid: [u8; 16],
    sunit: u32,
    swidth: u32,
    version: i32,
    flags: u32,
    logsectsize: u32,
    rtsectsize: u32,
    dirblocksize: u32,
}

#[cfg(all(any(target_os = "linux", test), target_pointer_width = "64"))]
const _: () = assert!(std::mem::size_of::<LinuxXfsFsopGeomV1>() == 112);

#[cfg(any(target_os = "linux", test))]
fn linux_invalid_data(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
}

#[cfg(any(target_os = "linux", test))]
fn linux_unsupported(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Unsupported, message.into())
}

#[cfg(any(target_os = "linux", test))]
fn parse_linux_decimal(field: &[u8]) -> Option<u64> {
    if field.is_empty() || field.iter().any(|byte| !byte.is_ascii_digit()) {
        return None;
    }

    field.iter().try_fold(0_u64, |value, byte| {
        value.checked_mul(10)?.checked_add(u64::from(byte - b'0'))
    })
}

#[cfg(any(target_os = "linux", test))]
fn valid_linux_device_field(field: &[u8]) -> bool {
    let mut components = field.split(|byte| *byte == b':');
    matches!(
        (components.next(), components.next(), components.next()),
        (Some(major), Some(minor), None)
            if parse_linux_decimal(major).is_some() && parse_linux_decimal(minor).is_some()
    )
}

#[cfg(any(target_os = "linux", test))]
fn ensure_linux_mount_id_stable(
    selected_mount_id: u64,
    observed_mount_id: u64,
) -> std::io::Result<()> {
    if selected_mount_id == observed_mount_id {
        Ok(())
    } else {
        Err(linux_invalid_data(format!(
            "parent directory mount ID changed from {selected_mount_id} to {observed_mount_id} during classification"
        )))
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_linux_mountinfo(
    mountinfo: &[u8],
    target_mount_id: u64,
) -> std::io::Result<LinuxMountRecord> {
    let mut target = None;

    for line in mountinfo.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        let mut initial_fields = line.split(|byte| *byte == b' ');
        let Some(mount_id_field) = initial_fields.next() else {
            continue;
        };
        if parse_linux_decimal(mount_id_field) != Some(target_mount_id) {
            continue;
        }
        if target.is_some() {
            return Err(linux_invalid_data(format!(
                "mountinfo contains duplicate mount ID {target_mount_id}"
            )));
        }

        let fields = line.split(|byte| *byte == b' ').collect::<Vec<_>>();
        if fields.iter().any(|field| field.is_empty()) {
            return Err(linux_invalid_data(format!(
                "mountinfo record {target_mount_id} contains an empty field"
            )));
        }
        let separators = fields
            .iter()
            .enumerate()
            .filter_map(|(index, field)| (*field == b"-").then_some(index))
            .collect::<Vec<_>>();
        if separators.len() != 1 {
            return Err(linux_invalid_data(format!(
                "mountinfo record {target_mount_id} has no unique separator"
            )));
        }
        let separator = separators[0];
        if separator < 6 || fields.len() != separator + 4 {
            return Err(linux_invalid_data(format!(
                "mountinfo record {target_mount_id} has missing or extra fields"
            )));
        }
        if parse_linux_decimal(fields[1]).is_none()
            || !valid_linux_device_field(fields[2])
            || fields[3].is_empty()
            || fields[4].is_empty()
            || fields[5].is_empty()
            || fields[separator + 1].is_empty()
            || fields[separator + 2].is_empty()
            || fields[separator + 3].is_empty()
        {
            return Err(linux_invalid_data(format!(
                "mountinfo record {target_mount_id} contains an invalid required field"
            )));
        }

        target = Some(LinuxMountRecord {
            mount_id: target_mount_id,
            fs_type: fields[separator + 1].to_vec(),
            mount_options: fields[5].to_vec(),
            super_options: fields[separator + 3].to_vec(),
        });
    }

    target.ok_or_else(|| {
        linux_invalid_data(format!(
            "mountinfo does not contain mount ID {target_mount_id}"
        ))
    })
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Copy)]
enum LinuxFilesystemCaseKind {
    InodeFlags,
    XfsGeometry,
    Vfat,
    Rejected,
}

#[cfg(any(target_os = "linux", test))]
fn linux_filesystem_case_kind(fs_type: &[u8]) -> Option<(u64, LinuxFilesystemCaseKind)> {
    let mapping = match fs_type {
        b"ext2" | b"ext3" | b"ext4" => (LINUX_EXT_SUPER_MAGIC, LinuxFilesystemCaseKind::InodeFlags),
        b"f2fs" => (LINUX_F2FS_SUPER_MAGIC, LinuxFilesystemCaseKind::InodeFlags),
        b"btrfs" => (LINUX_BTRFS_SUPER_MAGIC, LinuxFilesystemCaseKind::InodeFlags),
        b"tmpfs" => (LINUX_TMPFS_MAGIC, LinuxFilesystemCaseKind::InodeFlags),
        b"xfs" => (LINUX_XFS_SUPER_MAGIC, LinuxFilesystemCaseKind::XfsGeometry),
        b"vfat" => (LINUX_MSDOS_SUPER_MAGIC, LinuxFilesystemCaseKind::Vfat),
        b"msdos" => (LINUX_MSDOS_SUPER_MAGIC, LinuxFilesystemCaseKind::Rejected),
        b"exfat" => (LINUX_EXFAT_SUPER_MAGIC, LinuxFilesystemCaseKind::Rejected),
        b"nfs" | b"nfs4" => (LINUX_NFS_SUPER_MAGIC, LinuxFilesystemCaseKind::Rejected),
        b"cifs" | b"smb3" => (LINUX_CIFS_SUPER_MAGIC, LinuxFilesystemCaseKind::Rejected),
        b"overlay" => (
            LINUX_OVERLAYFS_SUPER_MAGIC,
            LinuxFilesystemCaseKind::Rejected,
        ),
        b"fuse" | b"fuseblk" => (LINUX_FUSE_SUPER_MAGIC, LinuxFilesystemCaseKind::Rejected),
        fs_type if fs_type.starts_with(b"fuse.") => {
            (LINUX_FUSE_SUPER_MAGIC, LinuxFilesystemCaseKind::Rejected)
        }
        _ => return None,
    };
    Some(mapping)
}

#[cfg(any(target_os = "linux", test))]
fn classify_linux_vfat_case_mode(mount: &LinuxMountRecord) -> std::io::Result<LinuxCaseMode> {
    let mut check_value = None;
    for options in [&mount.mount_options, &mount.super_options] {
        for option in options.split(|byte| *byte == b',') {
            let value = if option == b"check" {
                Some(&b""[..])
            } else {
                option.strip_prefix(b"check=")
            };
            let Some(value) = value else {
                continue;
            };
            if check_value.replace(value).is_some() {
                return Err(linux_invalid_data(format!(
                    "VFAT mount ID {} has duplicate check options",
                    mount.mount_id
                )));
            }
        }
    }

    // This models the case comparison selected by VFAT's kernel dentry operations.
    match check_value {
        None | Some(b"n" | b"normal" | b"r" | b"relaxed") => Ok(LinuxCaseMode::AsciiInsensitive),
        Some(b"s" | b"strict") => Ok(LinuxCaseMode::Sensitive),
        Some(value) => Err(linux_invalid_data(format!(
            "VFAT mount ID {} has unsupported check option {:?}",
            mount.mount_id, value
        ))),
    }
}

#[cfg(any(target_os = "linux", test))]
fn classify_linux_case_mode_with<FI, FX>(
    magic: u64,
    mount: &LinuxMountRecord,
    inode_flags: FI,
    xfs_geometry_flags: FX,
) -> std::io::Result<LinuxCaseMode>
where
    FI: FnOnce() -> std::io::Result<u32>,
    FX: FnOnce() -> std::io::Result<u32>,
{
    let (expected_magic, kind) = linux_filesystem_case_kind(&mount.fs_type).ok_or_else(|| {
        linux_unsupported(format!(
            "mount ID {} has unsupported filesystem type {:?}",
            mount.mount_id, mount.fs_type
        ))
    })?;
    if magic != expected_magic {
        return Err(linux_invalid_data(format!(
            "mount ID {} filesystem type {:?} has magic {magic:#x}, expected {expected_magic:#x}",
            mount.mount_id, mount.fs_type
        )));
    }

    match kind {
        LinuxFilesystemCaseKind::InodeFlags => {
            if inode_flags()? & LINUX_FS_CASEFOLD_FL == 0 {
                Ok(LinuxCaseMode::Sensitive)
            } else {
                Ok(LinuxCaseMode::AsciiInsensitive)
            }
        }
        LinuxFilesystemCaseKind::XfsGeometry => {
            if xfs_geometry_flags()? & LINUX_XFS_FSOP_GEOM_FLAGS_DIRV2CI == 0 {
                Ok(LinuxCaseMode::Sensitive)
            } else {
                Ok(LinuxCaseMode::AsciiInsensitive)
            }
        }
        LinuxFilesystemCaseKind::Vfat => classify_linux_vfat_case_mode(mount),
        LinuxFilesystemCaseKind::Rejected => Err(linux_unsupported(format!(
            "mount ID {} filesystem type {:?} has ambiguous filename identity semantics",
            mount.mount_id, mount.fs_type
        ))),
    }
}

#[cfg(any(target_os = "linux", test))]
fn linux_insensitive_leaf_key(leaf: &[u8]) -> std::io::Result<PhysicalLeafKey> {
    if !leaf.is_ascii() {
        return Err(linux_invalid_data(
            "case-insensitive Linux sidecar name contains non-ASCII bytes",
        ));
    }
    let mut folded = leaf.to_vec();
    folded.make_ascii_lowercase();
    Ok(PhysicalLeafKey::LinuxAsciiInsensitive(folded))
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct PhysicalPathKey {
    parent: FileIdentity,
    leaf: PhysicalLeafKey,
}

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
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
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
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct FileIdentity;

#[cfg(not(any(unix, windows)))]
pub(crate) fn file_identity(_file: &fs::File) -> std::io::Result<FileIdentity> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "sidecar file-identity validation is unsupported on this platform",
    ))
}

#[cfg(target_os = "macos")]
fn mac_insensitive_compare(left: &str, right: &str) -> Ordering {
    use objc2_core_foundation::{CFString, CFStringCompareFlags};

    let left = CFString::from_str(left);
    let right = CFString::from_str(right);
    left.compare(
        Some(&right),
        CFStringCompareFlags::CompareCaseInsensitive | CFStringCompareFlags::CompareNonliteral,
    )
    .into()
}

#[cfg(target_os = "windows")]
fn windows_insensitive_compare(left: &[u16], right: &[u16]) -> Ordering {
    use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

    let Ok(left_len) = i32::try_from(left.len()) else {
        return left.cmp(right);
    };
    let Ok(right_len) = i32::try_from(right.len()) else {
        return left.cmp(right);
    };
    let result =
        unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) };
    match result {
        0 => left.cmp(right),
        CSTR_EQUAL => Ordering::Equal,
        1 => Ordering::Less,
        _ => Ordering::Greater,
    }
}

#[cfg(not(target_os = "windows"))]
fn open_parent_directory(path: &Path) -> std::io::Result<fs::File> {
    fs::File::open(path)
}

#[cfg(target_os = "windows")]
fn open_parent_directory(path: &Path) -> std::io::Result<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

#[cfg(target_os = "linux")]
fn linux_parent_mount_id(parent: &fs::File) -> std::io::Result<u64> {
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;

    const EMPTY_PATH: [u8; 1] = [0];
    let mut statx = MaybeUninit::<libc::statx>::zeroed();
    let result = unsafe {
        libc::statx(
            parent.as_raw_fd(),
            EMPTY_PATH.as_ptr().cast(),
            libc::AT_EMPTY_PATH,
            libc::STATX_MNT_ID,
            statx.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let statx = unsafe { statx.assume_init() };
    if statx.stx_mask & libc::STATX_MNT_ID == 0 {
        return Err(linux_unsupported(
            "statx did not return the parent directory mount ID",
        ));
    }
    Ok(statx.stx_mnt_id)
}

#[cfg(target_os = "linux")]
fn linux_parent_statfs_magic(parent: &fs::File) -> std::io::Result<u64> {
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;

    let mut statfs = MaybeUninit::<libc::statfs>::zeroed();
    if unsafe { libc::fstatfs(parent.as_raw_fd(), statfs.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let statfs = unsafe { statfs.assume_init() };
    Ok(u64::from(statfs.f_type as u32))
}

#[cfg(target_os = "linux")]
fn linux_parent_inode_flags(parent: &fs::File) -> std::io::Result<u32> {
    use std::os::fd::AsRawFd;

    let mut flags: libc::c_int = 0;
    if unsafe { libc::ioctl(parent.as_raw_fd(), libc::FS_IOC_GETFLAGS, &mut flags) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(flags as u32)
}

#[cfg(target_os = "linux")]
fn linux_parent_xfs_geometry_flags(parent: &fs::File) -> std::io::Result<u32> {
    use std::mem::MaybeUninit;
    use std::os::fd::AsRawFd;

    let request = libc::_IOR::<LinuxXfsFsopGeomV1>(u32::from(b'X'), 100);
    let mut geometry = MaybeUninit::<LinuxXfsFsopGeomV1>::zeroed();
    if unsafe { libc::ioctl(parent.as_raw_fd(), request, geometry.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { geometry.assume_init() }.flags)
}

#[cfg(target_os = "macos")]
fn parent_is_case_sensitive(parent: &fs::File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;

    match unsafe { libc::fpathconf(parent.as_raw_fd(), libc::_PC_CASE_SENSITIVE) } {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(std::io::Error::last_os_error()),
    }
}

#[cfg(target_os = "windows")]
fn parent_is_case_sensitive(parent: &fs::File) -> std::io::Result<bool> {
    use std::mem::{MaybeUninit, size_of};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_CASE_SENSITIVE_INFO, FileCaseSensitiveInfo, GetFileInformationByHandleEx,
    };
    use windows_sys::Win32::System::SystemServices::FILE_CS_FLAG_CASE_SENSITIVE_DIR;

    let mut info = MaybeUninit::<FILE_CASE_SENSITIVE_INFO>::uninit();
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            parent.as_raw_handle(),
            FileCaseSensitiveInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_CASE_SENSITIVE_INFO>() as u32,
        )
    };
    if succeeded != 0 {
        return Ok(unsafe { info.assume_init() }.Flags & FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0);
    }

    let error = std::io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED) => Ok(false),
        _ => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn parent_is_case_sensitive(parent: &fs::File) -> std::io::Result<bool> {
    let mount_id = linux_parent_mount_id(parent)?;
    let magic = linux_parent_statfs_magic(parent)?;
    let mountinfo = fs::read("/proc/self/mountinfo")?;
    let mount = parse_linux_mountinfo(&mountinfo, mount_id)?;
    ensure_linux_mount_id_stable(mount_id, linux_parent_mount_id(parent)?)?;
    let mode = classify_linux_case_mode_with(
        magic,
        &mount,
        || linux_parent_inode_flags(parent),
        || linux_parent_xfs_geometry_flags(parent),
    )?;
    Ok(mode == LinuxCaseMode::Sensitive)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn parent_is_case_sensitive(_parent: &fs::File) -> std::io::Result<bool> {
    Ok(true)
}

fn physical_leaf_key(file_name: &OsStr, case_sensitive: bool) -> std::io::Result<PhysicalLeafKey> {
    if case_sensitive {
        return Ok(PhysicalLeafKey::Exact(file_name.to_os_string()));
    }

    #[cfg(target_os = "macos")]
    {
        let leaf = file_name.to_str().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "case-insensitive macOS sidecar name is not valid UTF-8",
            )
        })?;
        return Ok(PhysicalLeafKey::MacInsensitive(leaf.to_owned()));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;

        return Ok(PhysicalLeafKey::WindowsInsensitive(
            file_name.encode_wide().collect(),
        ));
    }

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;

        return linux_insensitive_leaf_key(file_name.as_bytes());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Ok(PhysicalLeafKey::Exact(file_name.to_os_string()))
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

fn physical_path_key_from_normalized(path: &Path) -> std::io::Result<PhysicalPathKey> {
    physical_path_key_from_normalized_with_case_query(path, parent_is_case_sensitive)
}

fn physical_path_key_from_normalized_with_case_query<F>(
    path: &Path,
    case_sensitivity: F,
) -> std::io::Result<PhysicalPathKey>
where
    F: FnOnce(&fs::File) -> std::io::Result<bool>,
{
    let parent_path = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar path '{}' has no parent directory", path.display()),
        )
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("sidecar path '{}' has no file name", path.display()),
        )
    })?;
    let parent = open_parent_directory(parent_path)?;
    let parent_identity = file_identity(&parent)?;
    let case_sensitive = case_sensitivity(&parent)?;
    Ok(PhysicalPathKey {
        parent: parent_identity,
        leaf: physical_leaf_key(file_name, case_sensitive)?,
    })
}

pub(crate) fn physical_path_key(path: &Path) -> std::io::Result<(PhysicalPathKey, PathBuf)> {
    let normalized = normalized_path(path)?;
    let key = physical_path_key_from_normalized(&normalized)?;
    Ok((key, normalized))
}

fn path_locks(paths: &[PhysicalPathKey]) -> Vec<Arc<PathLock>> {
    let mut registry = PATH_LOCKS.lock().unwrap_or_else(|error| error.into_inner());
    registry.retain(|_, path_lock| path_lock.strong_count() > 0);
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

fn deduplicated_keyed_paths(
    mut keyed_paths: Vec<(PhysicalPathKey, PathBuf)>,
) -> Vec<(PhysicalPathKey, PathBuf)> {
    keyed_paths.sort_by(|left, right| left.1.cmp(&right.1));
    let mut seen = BTreeSet::new();
    keyed_paths.retain(|(key, _)| seen.insert(key.clone()));
    keyed_paths
}

pub(crate) fn with_locked_paths<T, F>(paths: &[PathBuf], operation: F) -> std::io::Result<T>
where
    F: FnOnce(&[PathBuf]) -> std::io::Result<T>,
{
    with_locked_paths_with_case_query(paths, parent_is_case_sensitive, operation)
}

fn with_locked_paths_with_case_query<T, F, Q>(
    paths: &[PathBuf],
    mut case_sensitivity: Q,
    operation: F,
) -> std::io::Result<T>
where
    F: FnOnce(&[PathBuf]) -> std::io::Result<T>,
    Q: FnMut(&fs::File) -> std::io::Result<bool>,
{
    let keyed_paths = paths
        .iter()
        .map(|path| {
            let normalized = normalized_path(path)?;
            let key = physical_path_key_from_normalized_with_case_query(&normalized, |parent| {
                case_sensitivity(parent)
            })?;
            Ok((key, normalized))
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    let keyed_paths = deduplicated_keyed_paths(keyed_paths);

    let keys = keyed_paths
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    let paths = keyed_paths
        .into_iter()
        .map(|(_, path)| path)
        .collect::<Vec<_>>();

    let mut locks = path_locks(&keys);
    locks.sort_by_key(|path_lock| Arc::as_ptr(path_lock) as usize);
    locks.dedup_by(|left, right| Arc::ptr_eq(left, right));
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AtomicUpdateErrorPhase {
    TempWrite,
    Rename,
    Write,
}

#[derive(Debug)]
pub(crate) struct AtomicUpdateError {
    pub(crate) phase: AtomicUpdateErrorPhase,
    pub(crate) source: std::io::Error,
}

fn atomic_update_error(
    phase: AtomicUpdateErrorPhase,
) -> impl FnOnce(std::io::Error) -> AtomicUpdateError {
    move |source| AtomicUpdateError { phase, source }
}

pub(crate) fn atomic_update_if_matches(
    path: &Path,
    expected: TargetExpectation<'_>,
    replacement: TargetReplacement<'_>,
) -> std::io::Result<ConditionalUpdateOutcome> {
    atomic_update_if_matches_detailed(path, expected, replacement).map_err(|error| error.source)
}

pub(crate) fn atomic_update_if_matches_detailed(
    path: &Path,
    expected: TargetExpectation<'_>,
    replacement: TargetReplacement<'_>,
) -> Result<ConditionalUpdateOutcome, AtomicUpdateError> {
    atomic_update_if_matches_detailed_with(path, expected, replacement, |_| Ok(()))
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
    atomic_update_if_matches_detailed_with(path, expected, replacement, before_final_validation)
        .map_err(|error| error.source)
}

fn atomic_update_if_matches_detailed_with<F>(
    path: &Path,
    expected: TargetExpectation<'_>,
    replacement: TargetReplacement<'_>,
    before_final_validation: F,
) -> Result<ConditionalUpdateOutcome, AtomicUpdateError>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    let parent =
        parent_directory(path).map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
    let mut staged = match replacement {
        TargetReplacement::Absent => None,
        TargetReplacement::Bytes(bytes) => {
            let mode = match expected {
                TargetExpectation::Absent => StageMode::NewFile,
                TargetExpectation::Bytes(_) => StageMode::Private,
            };
            Some(
                stage_bytes(path, bytes, mode)
                    .map_err(atomic_update_error(AtomicUpdateErrorPhase::TempWrite))?,
            )
        }
    };

    let (observed, target_permissions) =
        target_snapshot(path).map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
    if !snapshot_matches(&observed, expected) {
        return Ok(ConditionalUpdateOutcome::Conflict(observed));
    }

    if let Some(staged) = staged.as_mut() {
        if let Some(permissions) = target_permissions.as_ref() {
            staged
                .as_file()
                .set_permissions(permissions.clone())
                .map_err(atomic_update_error(AtomicUpdateErrorPhase::TempWrite))?;
            staged
                .as_file()
                .sync_all()
                .map_err(atomic_update_error(AtomicUpdateErrorPhase::TempWrite))?;
        }
    }

    if !matches!(
        (expected, replacement),
        (TargetExpectation::Absent, TargetReplacement::Absent)
    ) {
        before_final_validation(path)
            .map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
        let (observed, final_permissions) =
            target_snapshot(path).map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
        if !snapshot_matches(&observed, expected) || final_permissions != target_permissions {
            return Ok(ConditionalUpdateOutcome::Conflict(observed));
        }
    }

    match (expected, replacement, staged) {
        (TargetExpectation::Absent, TargetReplacement::Absent, _) => {
            Ok(ConditionalUpdateOutcome::Applied)
        }
        (TargetExpectation::Bytes(_), TargetReplacement::Absent, _) => {
            fs::remove_file(path).map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
            sync_parent_directory(parent)
                .map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
            Ok(ConditionalUpdateOutcome::Applied)
        }
        (TargetExpectation::Absent, TargetReplacement::Bytes(_), Some(staged)) => {
            match staged.persist_noclobber(path) {
                Ok(persisted) => {
                    sync_persisted_file(&persisted, parent, None)
                        .map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
                    Ok(ConditionalUpdateOutcome::Applied)
                }
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    drop(error.file);
                    let (observed, _) = target_snapshot(path)
                        .map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
                    Ok(ConditionalUpdateOutcome::Conflict(observed))
                }
                Err(error) => Err(AtomicUpdateError {
                    phase: AtomicUpdateErrorPhase::Rename,
                    source: error.error,
                }),
            }
        }
        (TargetExpectation::Bytes(_), TargetReplacement::Bytes(_), Some(staged)) => {
            let persisted = staged.persist(path).map_err(|error| AtomicUpdateError {
                phase: AtomicUpdateErrorPhase::Rename,
                source: error.error,
            })?;
            sync_persisted_file(&persisted, parent, target_permissions)
                .map_err(atomic_update_error(AtomicUpdateErrorPhase::Write))?;
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

    fn linux_mount_record(
        fs_type: &[u8],
        mount_options: &[u8],
        super_options: &[u8],
    ) -> LinuxMountRecord {
        LinuxMountRecord {
            mount_id: 42,
            fs_type: fs_type.to_vec(),
            mount_options: mount_options.to_vec(),
            super_options: super_options.to_vec(),
        }
    }

    fn classify_linux_test_mount(
        fs_type: &[u8],
        magic: u64,
        mount_options: &[u8],
        super_options: &[u8],
        inode_flags: Option<u32>,
        xfs_geometry_flags: Option<u32>,
    ) -> std::io::Result<LinuxCaseMode> {
        let mount = linux_mount_record(fs_type, mount_options, super_options);
        classify_linux_case_mode_with(
            magic,
            &mount,
            || {
                inode_flags.ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "synthetic missing FS_IOC_GETFLAGS result",
                    )
                })
            },
            || {
                xfs_geometry_flags.ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "synthetic missing XFS geometry result",
                    )
                })
            },
        )
    }

    #[test]
    fn linux_mountinfo_parser_accepts_optional_fields_and_byte_paths() {
        let mountinfo = b"41 1 8:1 / /unrelated rw - ext4 /dev/root rw\n\
42 41 8:2 /root\\040with\\011bytes /mnt/\xff\\012name rw,nosuid shared:7 master:2 - f2fs /dev/camera rw,compress_algorithm=zstd\n";

        let record = parse_linux_mountinfo(mountinfo, 42).unwrap();

        assert_eq!(record.mount_id, 42);
        assert_eq!(record.fs_type, b"f2fs");
        assert_eq!(record.mount_options, b"rw,nosuid");
        assert_eq!(record.super_options, b"rw,compress_algorithm=zstd");
    }

    #[test]
    fn linux_mountinfo_parser_matches_exact_decimal_mount_id() {
        let mountinfo = b"123 1 8:1 / /wrong rw - ext4 /dev/a rw\n\
12 1 8:2 / /right rw - xfs /dev/b rw\n";

        let record = parse_linux_mountinfo(mountinfo, 12).unwrap();

        assert_eq!(record.mount_id, 12);
        assert_eq!(record.fs_type, b"xfs");
    }

    #[test]
    fn linux_mount_id_change_is_rejected() {
        let error = ensure_linux_mount_id_stable(12, 13).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn linux_mountinfo_parser_ignores_unrelated_malformed_records() {
        let mountinfo = b"not-decimal malformed\n\
18446744073709551616 overflowed id\n\
11 matching-id-is-different-but-record-is-incomplete\n\
12 1 8:2 / /right rw - ext4 /dev/root rw\n";

        let record = parse_linux_mountinfo(mountinfo, 12).unwrap();

        assert_eq!(record.mount_id, 12);
        assert_eq!(record.fs_type, b"ext4");
    }

    #[test]
    fn linux_mountinfo_parser_rejects_missing_or_duplicate_target() {
        let missing =
            parse_linux_mountinfo(b"11 1 8:1 / / rw - ext4 /dev/root rw\n", 12).unwrap_err();
        let duplicate = parse_linux_mountinfo(
            b"12 1 8:1 / /a rw - ext4 /dev/a rw\n\
12 1 8:2 / /b rw - ext4 /dev/b rw\n",
            12,
        )
        .unwrap_err();

        assert_eq!(missing.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(duplicate.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn linux_mountinfo_parser_rejects_malformed_target_records() {
        for mountinfo in [
            &b"12 1 8:1 / / rw ext4 /dev/root rw\n"[..],
            &b"12 1 8:1 / / rw - ext4 /dev/root\n"[..],
            &b"12 1 8:1 / / rw - ext4 /dev/root rw trailing\n"[..],
            &b"12 1 8:1 / / - ext4 /dev/root rw\n"[..],
        ] {
            let error = parse_linux_mountinfo(mountinfo, 12).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn linux_inode_flag_filesystems_respect_casefold_bit() {
        for (fs_type, magic) in [
            (&b"ext2"[..], LINUX_EXT_SUPER_MAGIC),
            (&b"ext3"[..], LINUX_EXT_SUPER_MAGIC),
            (&b"ext4"[..], LINUX_EXT_SUPER_MAGIC),
            (&b"f2fs"[..], LINUX_F2FS_SUPER_MAGIC),
            (&b"btrfs"[..], LINUX_BTRFS_SUPER_MAGIC),
            (&b"tmpfs"[..], LINUX_TMPFS_MAGIC),
        ] {
            assert_eq!(
                classify_linux_test_mount(fs_type, magic, b"rw", b"rw", Some(0), None).unwrap(),
                LinuxCaseMode::Sensitive,
                "{fs_type:?} without FS_CASEFOLD_FL"
            );
            assert_eq!(
                classify_linux_test_mount(
                    fs_type,
                    magic,
                    b"rw",
                    b"rw",
                    Some(LINUX_FS_CASEFOLD_FL),
                    None,
                )
                .unwrap(),
                LinuxCaseMode::AsciiInsensitive,
                "{fs_type:?} with FS_CASEFOLD_FL"
            );
        }
    }

    #[test]
    fn linux_inode_flag_filesystems_reject_missing_probe() {
        for (fs_type, magic) in [
            (&b"ext4"[..], LINUX_EXT_SUPER_MAGIC),
            (&b"f2fs"[..], LINUX_F2FS_SUPER_MAGIC),
            (&b"btrfs"[..], LINUX_BTRFS_SUPER_MAGIC),
            (&b"tmpfs"[..], LINUX_TMPFS_MAGIC),
        ] {
            let error =
                classify_linux_test_mount(fs_type, magic, b"rw", b"rw", None, None).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        }
    }

    #[test]
    fn linux_xfs_uses_geometry_case_insensitive_flag() {
        assert_eq!(
            classify_linux_test_mount(b"xfs", LINUX_XFS_SUPER_MAGIC, b"rw", b"rw", None, Some(0),)
                .unwrap(),
            LinuxCaseMode::Sensitive
        );
        assert_eq!(
            classify_linux_test_mount(
                b"xfs",
                LINUX_XFS_SUPER_MAGIC,
                b"rw",
                b"rw",
                None,
                Some(LINUX_XFS_FSOP_GEOM_FLAGS_DIRV2CI),
            )
            .unwrap(),
            LinuxCaseMode::AsciiInsensitive
        );
    }

    #[test]
    fn linux_xfs_geometry_v1_has_stable_abi() {
        assert_eq!(std::mem::offset_of!(LinuxXfsFsopGeomV1, flags), 92);
        if cfg!(target_pointer_width = "64") {
            assert_eq!(std::mem::size_of::<LinuxXfsFsopGeomV1>(), 112);
            assert_eq!(std::mem::align_of::<LinuxXfsFsopGeomV1>(), 8);
        }
    }

    #[test]
    fn linux_xfs_rejects_geometry_probe_failure() {
        let error =
            classify_linux_test_mount(b"xfs", LINUX_XFS_SUPER_MAGIC, b"rw", b"rw", None, None)
                .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
    }

    #[test]
    fn linux_vfat_check_modes_follow_kernel_dentry_comparison() {
        for value in [b"n".as_slice(), b"normal", b"r", b"relaxed"] {
            let options = [b"rw,".as_slice(), b"check=", value].concat();
            assert_eq!(
                classify_linux_test_mount(
                    b"vfat",
                    LINUX_MSDOS_SUPER_MAGIC,
                    b"rw",
                    &options,
                    None,
                    None,
                )
                .unwrap(),
                LinuxCaseMode::AsciiInsensitive,
                "check={value:?}"
            );
        }
        for value in [b"s".as_slice(), b"strict"] {
            let options = [b"rw,".as_slice(), b"check=", value].concat();
            assert_eq!(
                classify_linux_test_mount(
                    b"vfat",
                    LINUX_MSDOS_SUPER_MAGIC,
                    b"rw",
                    &options,
                    None,
                    None,
                )
                .unwrap(),
                LinuxCaseMode::Sensitive,
                "check={value:?}"
            );
        }
        assert_eq!(
            classify_linux_test_mount(b"vfat", LINUX_MSDOS_SUPER_MAGIC, b"rw", b"rw", None, None,)
                .unwrap(),
            LinuxCaseMode::AsciiInsensitive
        );
        assert_eq!(
            classify_linux_test_mount(
                b"vfat",
                LINUX_MSDOS_SUPER_MAGIC,
                b"rw,check=strict",
                b"rw",
                None,
                None,
            )
            .unwrap(),
            LinuxCaseMode::Sensitive
        );
    }

    #[test]
    fn linux_vfat_rejects_unknown_duplicate_or_conflicting_check_modes() {
        for (mount_options, super_options) in [
            (&b"rw"[..], &b"rw,check=unknown"[..]),
            (&b"rw"[..], &b"rw,check=n,check=n"[..]),
            (&b"rw,check=s"[..], &b"rw,check=r"[..]),
            (&b"rw"[..], &b"rw,check"[..]),
            (&b"rw"[..], &b"rw,check=strictly"[..]),
        ] {
            let error = classify_linux_test_mount(
                b"vfat",
                LINUX_MSDOS_SUPER_MAGIC,
                mount_options,
                super_options,
                None,
                None,
            )
            .unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn linux_vfat_option_matching_has_no_substring_false_positives() {
        assert_eq!(
            classify_linux_test_mount(
                b"vfat",
                LINUX_MSDOS_SUPER_MAGIC,
                b"rw,nocheck=s",
                b"rw,prefixcheck=strict,other=check=s",
                None,
                None,
            )
            .unwrap(),
            LinuxCaseMode::AsciiInsensitive
        );
    }

    #[test]
    fn linux_ambiguous_and_remote_filesystems_are_rejected() {
        for (fs_type, magic) in [
            (&b"msdos"[..], LINUX_MSDOS_SUPER_MAGIC),
            (&b"exfat"[..], LINUX_EXFAT_SUPER_MAGIC),
            (&b"nfs"[..], LINUX_NFS_SUPER_MAGIC),
            (&b"nfs4"[..], LINUX_NFS_SUPER_MAGIC),
            (&b"cifs"[..], LINUX_CIFS_SUPER_MAGIC),
            (&b"smb3"[..], LINUX_CIFS_SUPER_MAGIC),
            (&b"fuse"[..], LINUX_FUSE_SUPER_MAGIC),
            (&b"fuseblk"[..], LINUX_FUSE_SUPER_MAGIC),
            (&b"fuse.sshfs"[..], LINUX_FUSE_SUPER_MAGIC),
            (&b"overlay"[..], LINUX_OVERLAYFS_SUPER_MAGIC),
            (&b"unknown"[..], 0xdead_beef),
        ] {
            let error =
                classify_linux_test_mount(fs_type, magic, b"rw", b"rw", None, None).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
        }
    }

    #[test]
    fn linux_filesystem_magic_and_mountinfo_type_must_match() {
        for (fs_type, magic) in [
            (&b"ext4"[..], LINUX_XFS_SUPER_MAGIC),
            (&b"xfs"[..], LINUX_EXT_SUPER_MAGIC),
            (&b"vfat"[..], LINUX_EXFAT_SUPER_MAGIC),
            (&b"nfs4"[..], LINUX_CIFS_SUPER_MAGIC),
        ] {
            let error = classify_linux_test_mount(fs_type, magic, b"rw", b"rw", Some(0), Some(0))
                .unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn linux_ascii_insensitive_leaf_keys_merge_only_ascii_case_aliases() {
        let lower = linux_insensitive_leaf_key(b"case.raf.rrdata").unwrap();
        let upper = linux_insensitive_leaf_key(b"CASE.RAF.RRDATA").unwrap();
        let sensitive_lower = PhysicalLeafKey::Exact(OsString::from("case.raf.rrdata"));
        let sensitive_upper = PhysicalLeafKey::Exact(OsString::from("CASE.RAF.RRDATA"));

        assert_eq!(lower, upper);
        assert_ne!(sensitive_lower, sensitive_upper);
    }

    #[test]
    fn linux_ascii_insensitive_leaf_key_rejects_non_ascii_bytes() {
        for leaf in [b"caf\xc3\xa9.rrdata".as_slice(), b"invalid-\xff.rrdata"] {
            let error = linux_insensitive_leaf_key(leaf).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        }
    }

    #[test]
    fn linux_classification_failure_prevents_locked_operation() {
        use std::cell::Cell;

        let temp = tempfile::tempdir().unwrap();
        let sidecar = temp.path().join("blocked.RAF.rrdata");
        let operation_called = Cell::new(false);

        let error = with_locked_paths_with_case_query(
            &[sidecar],
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "synthetic ambiguous Linux filesystem",
                ))
            },
            |_| {
                operation_called.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(!operation_called.get());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_parent_detector_matches_empirical_ascii_case_lookup() {
        let temp = tempfile::tempdir().unwrap();
        let mixed = temp.path().join("RaPiDrAw-CaSe-PrObE");
        let alias = temp.path().join("rApIdRaW-cAsE-pRoBe");
        fs::write(&mixed, b"probe").unwrap();
        let empirical_case_sensitive = match fs::metadata(&alias) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => panic!("mixed-case lookup failed: {error}"),
        };
        let parent = open_parent_directory(temp.path()).unwrap();
        let mount_id = linux_parent_mount_id(&parent).unwrap();
        let magic = linux_parent_statfs_magic(&parent).unwrap();
        let mount =
            parse_linux_mountinfo(&fs::read("/proc/self/mountinfo").unwrap(), mount_id).unwrap();
        ensure_linux_mount_id_stable(mount_id, linux_parent_mount_id(&parent).unwrap()).unwrap();
        let supported_local = matches!(
            linux_filesystem_case_kind(&mount.fs_type),
            Some((expected_magic, LinuxFilesystemCaseKind::InodeFlags
                | LinuxFilesystemCaseKind::XfsGeometry
                | LinuxFilesystemCaseKind::Vfat)) if expected_magic == magic
        );

        if supported_local {
            let detected = parent_is_case_sensitive(&parent)
                .expect("supported local filesystem classification failed");
            assert_eq!(detected, empirical_case_sensitive);
            let (mixed_key, _) = physical_path_key(&mixed).unwrap();
            let (alias_key, _) = physical_path_key(&alias).unwrap();
            assert_eq!(mixed_key == alias_key, !detected);
        } else {
            use std::sync::atomic::{AtomicBool, Ordering};

            assert!(parent_is_case_sensitive(&parent).is_err());
            let operation_called = AtomicBool::new(false);
            let result = with_locked_paths(&[temp.path().join("blocked.rrdata")], |_| {
                operation_called.store(true, Ordering::SeqCst);
                Ok(())
            });
            assert!(result.is_err());
            assert!(!operation_called.load(Ordering::SeqCst));
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn physical_leaf_keys_respect_injected_case_sensitivity() {
        use std::collections::BTreeSet;
        use std::ffi::OsStr;

        let insensitive = BTreeSet::from([
            physical_leaf_key(OsStr::new("Case.RAF.rrdata"), false).unwrap(),
            physical_leaf_key(OsStr::new("case.raf.rrdata"), false).unwrap(),
        ]);
        let sensitive = BTreeSet::from([
            physical_leaf_key(OsStr::new("Case.RAF.rrdata"), true).unwrap(),
            physical_leaf_key(OsStr::new("case.raf.rrdata"), true).unwrap(),
        ]);

        assert_eq!(insensitive.len(), 1);
        assert_eq!(sensitive.len(), 2);
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn path_lock_registry_reuses_case_insensitive_alias_lock() {
        use std::ffi::OsStr;

        let parent = FileIdentity::default();
        let lower = PhysicalPathKey {
            parent: parent.clone(),
            leaf: physical_leaf_key(OsStr::new("case.raf.rrdata"), false).unwrap(),
        };
        let upper = PhysicalPathKey {
            parent,
            leaf: physical_leaf_key(OsStr::new("CASE.RAF.rrdata"), false).unwrap(),
        };
        let first = path_locks(&[lower]);
        let second = path_locks(&[upper]);

        assert!(Arc::ptr_eq(&first[0], &second[0]));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn insensitive_path_lock_dedup_uses_subquadratic_native_comparisons() {
        use std::ffi::OsStr;

        const KEY_COUNT: usize = 256;
        const MAX_NATIVE_COMPARISONS: usize = 24_000;

        let temp = tempfile::tempdir().unwrap();
        let parent = file_identity(&open_parent_directory(temp.path()).unwrap()).unwrap();
        let keyed_paths = (0..KEY_COUNT)
            .map(|index| {
                let name = format!("image-{index:04}.RAF.rrdata");
                let key = PhysicalPathKey {
                    parent: parent.clone(),
                    leaf: physical_leaf_key(OsStr::new(&name), false).unwrap(),
                };
                (key, temp.path().join(name))
            })
            .collect::<Vec<_>>();

        INSENSITIVE_COMPARE_COUNT.with(|count| count.set(0));
        let keyed_paths = deduplicated_keyed_paths(keyed_paths);
        let keys = keyed_paths
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let locks = path_locks(&keys);
        let comparisons = INSENSITIVE_COMPARE_COUNT.with(std::cell::Cell::get);

        assert_eq!(keyed_paths.len(), KEY_COUNT);
        assert_eq!(locks.len(), KEY_COUNT);
        assert!(
            comparisons <= MAX_NATIVE_COMPARISONS,
            "{KEY_COUNT} distinct insensitive leaves required {comparisons} native comparisons"
        );
    }

    #[test]
    fn path_lock_registry_prunes_stale_entries_on_access() {
        use std::ffi::OsStr;

        let temp = tempfile::tempdir().unwrap();
        let parent = file_identity(&open_parent_directory(temp.path()).unwrap()).unwrap();
        let key = |name: &str| PhysicalPathKey {
            parent: parent.clone(),
            leaf: physical_leaf_key(OsStr::new(name), true).unwrap(),
        };
        let stale_keys = [key("stale-a.rrdata"), key("stale-b.rrdata")];
        let live_key = key("live.rrdata");

        {
            let mut registry = PATH_LOCKS.lock().unwrap_or_else(|error| error.into_inner());
            registry.retain(|key, _| !key.parent.eq(&parent));
        }

        let stale_locks = path_locks(&stale_keys);
        drop(stale_locks);
        let live_locks = path_locks(std::slice::from_ref(&live_key));

        let registry = PATH_LOCKS.lock().unwrap_or_else(|error| error.into_inner());
        let parent_entries = registry
            .iter()
            .filter(|(key, _)| key.parent.eq(&parent))
            .collect::<Vec<_>>();
        assert_eq!(parent_entries.len(), 1);
        assert_eq!(parent_entries[0].0, &live_key);
        let registered_lock = parent_entries[0].1.upgrade().unwrap();
        assert!(Arc::ptr_eq(&registered_lock, &live_locks[0]));
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn with_locked_paths_serializes_case_insensitive_aliases() {
        use std::sync::mpsc::{self, RecvTimeoutError};
        use std::thread;
        use std::time::Duration;

        let temp = tempfile::tempdir().unwrap();
        let parent = open_parent_directory(temp.path()).unwrap();
        if parent_is_case_sensitive(&parent).unwrap_or(true) {
            return;
        }

        let lower = temp.path().join("case.raf.rrdata");
        let upper = temp.path().join("CASE.RAF.rrdata");
        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first = thread::spawn(move || {
            with_locked_paths(&[lower], |_| {
                first_entered_tx.send(()).unwrap();
                release_first_rx
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                Ok(())
            })
            .unwrap();
        });
        first_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap();

        let (second_started_tx, second_started_rx) = mpsc::channel();
        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let second = thread::spawn(move || {
            second_started_tx.send(()).unwrap();
            with_locked_paths(&[upper], |_| {
                second_entered_tx.send(()).unwrap();
                Ok(())
            })
            .unwrap();
        });
        second_started_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        let entered_before_release =
            match second_entered_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(()) => true,
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => {
                    release_first_tx.send(()).unwrap();
                    panic!("second alias operation disconnected before entering");
                }
            };

        release_first_tx.send(()).unwrap();
        first.join().unwrap();
        if !entered_before_release {
            second_entered_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        second.join().unwrap();

        assert!(
            !entered_before_release,
            "case aliases acquired distinct locks"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_physical_leaf_key_matches_canonical_unicode_aliases() {
        use std::ffi::OsStr;

        let composed = physical_leaf_key(OsStr::new("\u{e9}.rrdata"), false).unwrap();
        let decomposed = physical_leaf_key(OsStr::new("e\u{301}.rrdata"), false).unwrap();

        assert_eq!(composed, decomposed);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_insensitive_leaf_rejects_invalid_utf8_without_lossy_merging() {
        use std::os::unix::ffi::OsStringExt;

        let invalid = std::ffi::OsString::from_vec(vec![0xff]);
        let error = physical_leaf_key(&invalid, false).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    #[test]
    fn physical_key_reflects_actual_parent_case_sensitivity() {
        let temp = tempfile::tempdir().unwrap();
        let lower = temp.path().join("case.raf.rrdata");
        let upper = temp.path().join("CASE.RAF.rrdata");
        let parent = open_parent_directory(temp.path()).unwrap();
        let case_sensitive = match parent_is_case_sensitive(&parent) {
            Ok(case_sensitive) => case_sensitive,
            Err(_) => {
                assert!(physical_path_key(&lower).is_err());
                assert!(physical_path_key(&upper).is_err());
                return;
            }
        };
        let (lower_key, _) = physical_path_key(&lower).unwrap();
        let (upper_key, _) = physical_path_key(&upper).unwrap();

        assert_eq!(lower_key == upper_key, !case_sensitive);
    }

    #[test]
    fn physical_key_propagates_case_sensitivity_query_failure() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("query-error.raf.rrdata");

        let error = physical_path_key_from_normalized_with_case_query(&path, |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "synthetic case-sensitivity query failure",
            ))
        })
        .unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            error.to_string(),
            "synthetic case-sensitivity query failure"
        );
    }

    #[test]
    fn detailed_update_reports_missing_parent_stage_failure_as_temp_write() {
        let temp = tempfile::tempdir().unwrap();
        let sidecar = temp.path().join("missing").join("stage.RAF.rrdata");

        let error = atomic_update_if_matches_detailed(
            &sidecar,
            TargetExpectation::Absent,
            TargetReplacement::Bytes(b"replacement"),
        )
        .unwrap_err();

        assert_eq!(error.phase, AtomicUpdateErrorPhase::TempWrite);
        assert_eq!(error.source.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn detailed_update_reports_persist_failure_as_rename() {
        let temp = tempfile::tempdir().unwrap();
        let active_parent = temp.path().join("active");
        let displaced_parent = temp.path().join("displaced");
        fs::create_dir(&active_parent).unwrap();
        let sidecar = active_parent.join("publish.RAF.rrdata");

        let error = atomic_update_if_matches_detailed_with(
            &sidecar,
            TargetExpectation::Absent,
            TargetReplacement::Bytes(b"replacement"),
            |_| fs::rename(&active_parent, &displaced_parent),
        )
        .unwrap_err();

        assert_eq!(error.phase, AtomicUpdateErrorPhase::Rename);
        assert_eq!(error.source.kind(), std::io::ErrorKind::NotFound);
        fs::rename(displaced_parent, active_parent).unwrap();
    }

    #[test]
    fn legacy_update_preserves_the_original_io_error() {
        let temp = tempfile::tempdir().unwrap();
        let sidecar = temp.path().join("missing").join("legacy.RAF.rrdata");

        let detailed = atomic_update_if_matches_detailed(
            &sidecar,
            TargetExpectation::Absent,
            TargetReplacement::Bytes(b"replacement"),
        )
        .unwrap_err();
        let legacy = atomic_update_if_matches(
            &sidecar,
            TargetExpectation::Absent,
            TargetReplacement::Bytes(b"replacement"),
        )
        .unwrap_err();

        assert_eq!(legacy.kind(), detailed.source.kind());
        assert_eq!(legacy.raw_os_error(), detailed.source.raw_os_error());

        let stable_message = |error: &std::io::Error| {
            error
                .to_string()
                .split(" at path ")
                .next()
                .unwrap()
                .to_owned()
        };
        assert_eq!(stable_message(&legacy), stable_message(&detailed.source));
        assert!(legacy.to_string().contains(".rapidraw-sidecar-"));
        assert!(detailed.source.to_string().contains(".rapidraw-sidecar-"));
    }
}
