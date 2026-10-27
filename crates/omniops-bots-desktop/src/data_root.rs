use super::error::Error;
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
};

/// The native owner keeps this OS lock until the Node process and native resources are gone.
/// Both normal startup and --diagnostics acquire the same file; process death releases it.
pub(super) struct DataRootLock {
    _file: File,
    pub(super) directory: PathBuf,
}

pub(super) fn local_root() -> Result<PathBuf, Error> {
    let root = match std::env::var_os("OMNIOPS_BOTS_LOCAL_ROOT") {
        Some(root) => PathBuf::from(root),
        None => std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .map(|home| home.join(".omnimind-ops"))
            .ok_or(Error::Unavailable("用户数据目录不可用。"))?,
    };
    if !root.is_absolute() {
        return Err(Error::InvalidInput("本地数据目录必须为绝对路径。"));
    }
    Ok(root)
}

impl DataRootLock {
    pub(super) fn acquire(root: &Path) -> Result<Self, Error> {
        let mut directories = fs::DirBuilder::new();
        directories.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directories.mode(0o700);
        }
        directories.create(root)?;
        if fs::symlink_metadata(root)?.file_type().is_symlink() {
            return Err(Error::InvalidInput("本地数据目录不能是符号链接。"));
        }
        let directory = root.canonicalize()?;
        let file_path = directory.join(".desktop.lock");
        match fs::symlink_metadata(&file_path) {
            Ok(info) if !info.is_file() || info.file_type().is_symlink() => {
                return Err(Error::InvalidInput("数据目录锁文件无效。"));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0020_0000);
        } // FILE_FLAG_OPEN_REPARSE_POINT
        let file = options.open(file_path)?;
        if !file.metadata()?.is_file() {
            return Err(Error::InvalidInput("数据目录锁文件无效。"));
        }
        match file.try_lock() {
            Ok(()) => Ok(Self {
                _file: file,
                directory,
            }),
            Err(TryLockError::WouldBlock) => Err(Error::Unavailable(
                "另一客户端正在使用此数据目录，请关闭后重试。",
            )),
            Err(TryLockError::Error(error)) => Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lock_is_exclusive_and_drop_releases_without_stale_pid_logic() {
        let root = std::env::temp_dir().join(format!("omniops-lock-{}", uuid::Uuid::new_v4()));
        let first = DataRootLock::acquire(&root).unwrap();
        assert_eq!(first.directory, root.canonicalize().unwrap());
        assert!(matches!(
            DataRootLock::acquire(&root),
            Err(Error::Unavailable(_))
        ));
        drop(first);
        let second = DataRootLock::acquire(&root).unwrap();
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn lock_does_not_follow_a_symlink() {
        let root = std::env::temp_dir().join(format!("omniops-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("target");
        std::fs::write(&target, b"original").unwrap();
        std::os::unix::fs::symlink(&target, root.join(".desktop.lock")).unwrap();
        assert!(DataRootLock::acquire(&root).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        std::fs::remove_dir_all(root).unwrap();
    }
}
