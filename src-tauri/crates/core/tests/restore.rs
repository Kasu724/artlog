use artlog_core::{restore, Kind, Repository};
use std::fs;

#[test]
fn restores_exact_bytes_without_clobbering_and_keeps_a_safety_version() {
    let folder = tempfile::tempdir().unwrap();
    let art = folder.path().join("色.clip");
    fs::write(&art, b"\0old\xff").unwrap();
    let repo = Repository::init(folder.path(), vec!["色.clip".into()]).unwrap();
    let old = repo.history().unwrap().remove(0);
    fs::write(&art, b"new working bytes").unwrap();

    let copy = folder.path().join("old copy.clip");
    restore::as_copy(&repo, &old.id, "色.clip", &copy).unwrap();
    assert_eq!(fs::read(&copy).unwrap(), b"\0old\xff");
    assert!(restore::as_copy(&repo, &old.id, "色.clip", &art).is_err());
    assert!(restore::in_place(&repo, &old.id, "色.clip", "wrong.clip").is_err());
    assert_eq!(fs::read(&art).unwrap(), b"new working bytes");

    let receipt = restore::in_place(&repo, &old.id, "色.clip", "色.clip").unwrap();
    assert_eq!(fs::read(&art).unwrap(), b"\0old\xff");
    let versions = repo.history().unwrap();
    assert_eq!(versions[0].kind, Kind::Restore);
    assert_eq!(versions[0].id, receipt.commit_id);
    assert_eq!(versions[1].kind, Kind::Safety);
    assert_eq!(versions[1].id, receipt.safety_id);
    let recover = folder.path().join("safety copy.clip");
    restore::as_copy(&repo, &receipt.safety_id, "色.clip", &recover).unwrap();
    assert_eq!(fs::read(&recover).unwrap(), b"new working bytes");
    assert!(repo.recovery_paths().unwrap().is_empty());
}

#[test]
fn missing_historical_chunk_does_not_touch_working_file() {
    let folder = tempfile::tempdir().unwrap();
    let art = folder.path().join("Painting.clip");
    fs::write(&art, b"original").unwrap();
    let repo = Repository::init(folder.path(), vec!["Painting.clip".into()]).unwrap();
    let old = repo.history().unwrap().remove(0);
    let hash = &old.files[0].chunks[0];
    fs::remove_file(repo.metadata().join("objects").join(&hash[..2]).join(hash)).unwrap();
    fs::write(&art, b"keep my latest painting").unwrap();
    assert!(restore::in_place(&repo, &old.id, "Painting.clip", "Painting.clip").is_err());
    assert_eq!(fs::read(&art).unwrap(), b"keep my latest painting");
    assert_eq!(repo.history().unwrap().len(), 1);
}

#[cfg(windows)]
#[test]
fn locked_editor_file_is_never_replaced() {
    use std::os::windows::fs::OpenOptionsExt;

    let folder = tempfile::tempdir().unwrap();
    let art = folder.path().join("Locked.clip");
    fs::write(&art, b"original").unwrap();
    let repo = Repository::init(folder.path(), vec!["Locked.clip".into()]).unwrap();
    let old = repo.history().unwrap().remove(0);
    fs::write(&art, b"unsaved-to-history").unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&art)
        .unwrap();
    assert!(restore::in_place(&repo, &old.id, "Locked.clip", "Locked.clip").is_err());
    drop(lock);
    assert_eq!(fs::read(&art).unwrap(), b"unsaved-to-history");
    assert!(!repo
        .history()
        .unwrap()
        .iter()
        .any(|commit| commit.kind == Kind::Restore));
}
