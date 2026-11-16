//! Keep one owner for working-file replacement. A journal is committed before
//! displacing the original; recovery never assumes the editor stopped writing.
use crate::{hash_file, Error, Kind, Repository, Result};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tempfile::Builder;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub path: String,
    pub safety_id: String,
    pub commit_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Journal<'a> {
    target: &'a str,
    requested_version: &'a str,
    safety_version: &'a str,
    working_recovery_folder: &'a Path,
}

fn disk<T>(action: &'static str, path: &Path, result: io::Result<T>) -> Result<T> {
    result.map_err(|err| Error::io(action, path, err))
}

fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    disk(
        "flush restore folder",
        path,
        File::open(path).and_then(|dir| dir.sync_all()),
    )?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn reserved(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        name == ".artlog" || name == ".git" || name.starts_with(".artlog-restore-")
    })
}

fn copy_target(destination: &Path) -> Result<PathBuf> {
    if !destination.is_absolute() || reserved(destination) {
        return Err(Error::Invalid(
            "Choose an absolute destination outside repository and recovery folders.".into(),
        ));
    }
    let name = destination
        .file_name()
        .and_then(|part| part.to_str())
        .filter(|part| {
            !part.ends_with([' ', '.'])
                && !part.contains([':', '\\', '/', '<', '>', '\"', '|', '?', '*'])
                && !part.chars().any(char::is_control)
        })
        .ok_or_else(|| Error::Invalid("Choose a normal filename for the restored copy.".into()))?;
    let parent = destination
        .parent()
        .ok_or_else(|| Error::Invalid("Choose a destination folder.".into()))?;
    let parent = disk("open destination folder", parent, parent.canonicalize())?;
    if reserved(&parent) || !parent.is_dir() {
        return Err(Error::Invalid(
            "Choose a regular destination folder.".into(),
        ));
    }
    #[cfg(windows)]
    {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem[3..].chars().count() == 1
            && stem[3..].contains(['1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³'])
        {
            return Err(Error::Invalid(
                "Choose a filename that Windows can store.".into(),
            ));
        }
    }
    Ok(parent.join(name))
}

pub fn as_copy(repo: &Repository, version: &str, path: &str, destination: &Path) -> Result<String> {
    let entry = repo.entry(version, path)?;
    let destination = copy_target(destination)?;
    let folder = destination.parent().expect("validated destination");
    let mut temp = disk(
        "stage restored copy",
        folder,
        Builder::new().prefix(".artlog-staged-").tempfile_in(folder),
    )?;
    repo.reconstruct(&entry, &mut temp)?;
    disk(
        "flush restored copy",
        &destination,
        temp.as_file().sync_all(),
    )?;
    if hash_file(temp.path())? != entry.hash {
        return Err(Error::Corrupt(
            "The staged copy did not pass its hash check.".into(),
        ));
    }
    let _file = disk(
        "save copy (choose a new filename if it already exists)",
        &destination,
        temp.persist_noclobber(&destination)
            .map_err(|err| err.error),
    )?;
    sync_dir(folder)?;
    if hash_file(&destination)? != entry.hash {
        return Err(Error::Corrupt(format!(
            "The copy at {} changed after it was written. Choose a new filename and try again.",
            destination.display()
        )));
    }
    Ok(destination.to_string_lossy().into_owned())
}

pub fn in_place(
    repo: &Repository,
    version: &str,
    path: &str,
    confirmed_target: &str,
) -> Result<RestoreOutcome> {
    if path != confirmed_target {
        return Err(Error::Invalid(
            "Confirm the exact working file before replacing it.".into(),
        ));
    }
    let _guard = repo.with_write_lock()?;
    replace_locked(repo, version, path, |_| {})
}

fn replace_locked(
    repo: &Repository,
    version: &str,
    path: &str,
    after_displace: impl FnOnce(&Path),
) -> Result<RestoreOutcome> {
    let entry = repo.entry(version, path)?;
    let target = repo.source_path(path)?;
    if !target.is_file()
        || !repo
            .settings()?
            .tracked
            .iter()
            .any(|tracked| tracked == path)
    {
        return Err(Error::Invalid(
            "In-place restore needs an existing tracked working file. Restore as a copy instead."
                .into(),
        ));
    }
    let parent = target.parent().expect("validated working path");
    let side = disk(
        "create restore workspace",
        parent,
        Builder::new().prefix(".artlog-restore-").tempdir_in(parent),
    )?;
    let staged = side.path().join("replacement.bin");
    let mut output = disk("stage historical file", &staged, File::create(&staged))?;
    repo.reconstruct(&entry, &mut output)?;
    disk("flush historical file", &staged, output.sync_all())?;
    drop(output);
    if hash_file(&staged)? != entry.hash {
        return Err(Error::Corrupt(
            "The staged replacement did not pass its hash check.".into(),
        ));
    }

    let safety = repo
        .capture_locked(Kind::Safety, &format!("Before restoring {path}"), "")?
        .ok_or_else(|| Error::Invalid("A safety snapshot could not be recorded.".into()))?;
    let saved = safety
        .files
        .iter()
        .find(|file| file.path == path)
        .ok_or_else(|| {
            Error::Invalid("The working file disappeared during the safety snapshot.".into())
        })?;
    let fresh_target = repo.source_path(path)?;
    if fresh_target != target || hash_file(&fresh_target)? != saved.hash {
        return Err(Error::Invalid(
            "The working file changed while preparing the restore. Close it in your editor and retry."
                .into(),
        ));
    }

    let staging = repo.staging()?;
    let journal = disk(
        "create restore journal",
        &staging,
        Builder::new().prefix("restore-").tempdir_in(&staging),
    )?;
    let record = journal.path().join("recovery.json");
    let json = serde_json::to_vec_pretty(&Journal {
        target: path,
        requested_version: version,
        safety_version: &safety.id,
        working_recovery_folder: side.path(),
    })
    .map_err(|err| Error::Invalid(format!("Could not encode the restore journal: {err}")))?;
    let mut file = disk("write restore journal", &record, File::create(&record))?;
    disk("write restore journal", &record, file.write_all(&json))?;
    disk("flush restore journal", &record, file.sync_all())?;
    drop(file);
    sync_dir(journal.path())?;
    sync_dir(&staging)?;
    sync_dir(side.path())?;
    sync_dir(parent)?;

    let previous = side.path().join("previous.bin");
    let side = side.keep();
    let journal = journal.keep();
    if let Err(err) = fs::rename(&target, &previous) {
        // No replacement was attempted. Retain the journal if the filesystem
        // reports a failure but the displaced file nevertheless exists.
        if previous
            .symlink_metadata()
            .is_err_and(|err| err.kind() == io::ErrorKind::NotFound)
        {
            cleanup(&side, &journal);
            return Err(Error::io(
                "move the working file; close it in your editor first",
                &target,
                err,
            ));
        }
        return Err(recovery(
            path,
            &safety.id,
            &previous,
            &journal,
            &err.to_string(),
        ));
    }
    after_displace(&target);
    let operation = (|| {
        if !regular_file(&previous) || hash_file(&previous)? != saved.hash {
            return Err(Error::Invalid(
                "The displaced working file changed during restore.".into(),
            ));
        }
        sync_dir(&side)?;
        sync_dir(parent)?;
        // Hard links publish existing, synced file bytes without overwriting a
        // file that an editor may have created in the meantime.
        disk(
            "publish restored file",
            &target,
            fs::hard_link(&staged, &target),
        )?;
        sync_dir(parent)?;
        if hash_file(&repo.source_path(path)?)? != entry.hash {
            return Err(Error::Corrupt(
                "The replacement failed post-restore verification.".into(),
            ));
        }
        let restored = repo
            .capture_locked(Kind::Restore, &format!("Restored {path}"), "")?
            .ok_or_else(|| Error::Invalid("The restored version was not recorded.".into()))?;
        // The editor could still write while the history entry is being saved.
        // Retain the displaced original if either path drifted.
        if !restored
            .files
            .iter()
            .any(|file| file.path == path && file.hash == entry.hash)
            || hash_file(&repo.source_path(path)?)? != entry.hash
            || hash_file(&previous)? != saved.hash
        {
            return Err(Error::Invalid(
                "The working file changed during restore.".into(),
            ));
        }
        Ok(restored.id)
    })();

    match operation {
        Ok(commit_id) => {
            if !cleanup(&side, &journal) {
                return Err(recovery(
                    path, &safety.id, &previous, &journal,
                    "The restore was verified, but temporary recovery files could not be cleaned up.",
                ));
            }
            Ok(RestoreOutcome {
                path: path.to_string(),
                safety_id: safety.id,
                commit_id,
            })
        }
        Err(err) => {
            // Only roll back into an empty path. A newly saved document or a
            // published restored file must never be overwritten automatically.
            if regular_file(&previous) {
                let _ = repo.source_path(path).and_then(|checked| {
                    disk(
                        "return the displaced original if the target is empty",
                        &checked,
                        fs::hard_link(&previous, &checked),
                    )?;
                    sync_dir(parent)
                });
            }
            Err(recovery(
                path,
                &safety.id,
                &previous,
                &journal,
                &err.to_string(),
            ))
        }
    }
}

fn regular_file(path: &Path) -> bool {
    path.symlink_metadata().is_ok_and(|metadata| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
        metadata.is_file()
    })
}

fn cleanup(side: &Path, journal: &Path) -> bool {
    // These are newly created private directories. Remove only the files we
    // created and leave any unexpected contents for manual recovery.
    let remove_file = |path| match fs::remove_file(path) {
        Ok(()) => true,
        Err(err) => err.kind() == io::ErrorKind::NotFound,
    };
    remove_file(side.join("replacement.bin"))
        && remove_file(side.join("previous.bin"))
        && fs::remove_dir(side).is_ok()
        && remove_file(journal.join("recovery.json"))
        && fs::remove_dir(journal).is_ok()
}

fn recovery(path: &str, safety: &str, previous: &Path, journal: &Path, detail: &str) -> Error {
    Error::Invalid(format!(
        concat!(
            "Restore of {} needs attention: {} Do not delete the recovery folder. ",
            "Check the working file, then restore as a copy from safety checkpoint {} ",
            "or save a separate copy of the displaced file at {} if present. Journal: {}."
        ),
        path,
        detail,
        safety,
        previous.display(),
        journal.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn competing_editor_save_is_never_replaced_and_both_versions_survive() {
        let project = tempfile::tempdir().unwrap();
        let path = "layered.clip";
        let target = project.path().join(path);
        fs::write(&target, b"historical bytes").unwrap();
        let repo = Repository::init(project.path(), vec![path.into()]).unwrap();
        let historical = repo.history().unwrap().remove(0);
        fs::write(&target, b"working bytes before restore").unwrap();
        {
            let _guard = repo.with_write_lock().unwrap();
            let error = replace_locked(&repo, &historical.id, path, |target| {
                fs::write(target, b"editor saved during replace").unwrap();
            })
            .unwrap_err();
            assert!(error.to_string().contains("needs attention"));
        }
        let reopened = Repository::open(project.path()).unwrap();
        assert_eq!(fs::read(target).unwrap(), b"editor saved during replace");
        assert_eq!(reopened.recovery_paths().unwrap().len(), 1);
        let safety = reopened.history().unwrap().remove(0);
        assert_eq!(safety.kind, Kind::Safety);
        let copy = project.path().join("before.clip");
        as_copy(&reopened, &safety.id, path, &copy).unwrap();
        assert_eq!(fs::read(copy).unwrap(), b"working bytes before restore");
    }
}
