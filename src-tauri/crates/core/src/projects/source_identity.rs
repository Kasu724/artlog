use super::*;
use std::time::SystemTime;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SourceIdentity {
    path: String,
    volume: u64,
    file: [u8; 16],
    created: SystemTime,
}

impl SourceIdentity {
    pub(super) fn observe(repo: &Repository, path: &str) -> Option<Self> {
        let handle = open_source(&repo.source_path(path).ok()?).ok()?;
        let created = handle.metadata().ok()?.created().ok()?;
        let (volume, file) = file_identity(&handle)?;
        Some(Self {
            path: path.to_owned(),
            volume,
            file,
            created,
        })
    }

    pub(super) fn saved(dir: &Path, path: &str) -> Option<Self> {
        let identity: Self = read_json(&dir.join("source-identity.json")).ok()?;
        (identity.path == path).then_some(identity)
    }

    pub(super) fn remember(self, dir: &Path) -> Result<()> {
        if Self::saved(dir, &self.path).as_ref() != Some(&self) {
            atomic_json(&dir.join("source-identity.json"), &self)?;
        }
        Ok(())
    }

    pub(super) fn same_file(&self, other: &Self) -> bool {
        (self.volume, self.file, self.created) == (other.volume, other.file, other.created)
    }
}

#[cfg(windows)]
fn file_identity(handle: &File) -> Option<(u64, [u8; 16])> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };

    let mut info = FILE_ID_INFO::default();
    // The handle is a verified regular file. The buffer matches FileIdInfo.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    (ok != 0 && info.FileId.Identifier != [0; 16])
        .then_some((info.VolumeSerialNumber, info.FileId.Identifier))
}

#[cfg(unix)]
fn file_identity(handle: &File) -> Option<(u64, [u8; 16])> {
    use std::os::unix::fs::MetadataExt;

    let metadata = handle.metadata().ok()?;
    let inode = metadata.ino();
    (inode != 0).then_some((metadata.dev(), u128::from(inode).to_le_bytes()))
}
