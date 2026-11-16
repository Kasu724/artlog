use artlog_core::{Error, Kind, Repository};
use std::{fs, io::Write};

#[test]
fn init_capture_reopen_deduplicate_and_reconstruct_exact_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let original = b"first layered artwork\0bytes";
    fs::write(root.join("drawing.clip"), original).unwrap();
    fs::write(root.join("poster.psd"), b"initial composite").unwrap();
    let repo = Repository::init(root, vec!["drawing.clip".into(), "poster.psd".into()]).unwrap();
    let baseline = repo.head().unwrap().unwrap();
    let baseline_commit = repo.commit(&baseline).unwrap();
    assert_eq!(baseline_commit.kind, Kind::Baseline);
    fs::write(root.join("drawing.clip"), b"second exact saved state").unwrap();
    let captured = repo.capture(Kind::Auto, "", "").unwrap().unwrap();
    assert!(captured.title.contains("drawing.clip"));
    assert!(repo.capture(Kind::Auto, "", "").unwrap().is_none());
    let reopened = Repository::open(root).unwrap();
    let entry = reopened.entry(&captured.id, "drawing.clip").unwrap();
    let mut output = Vec::new();
    reopened.reconstruct(&entry, &mut output).unwrap();
    assert_eq!(output, b"second exact saved state");
    let checkpoint = reopened
        .capture(Kind::Checkpoint, "Approved line art", "Looks good")
        .unwrap()
        .unwrap();
    assert_eq!(checkpoint.files.len(), 2);
    assert_eq!(reopened.history().unwrap().len(), 3);
    assert_eq!(reopened.health().unwrap().versions, 3);
}

#[test]
fn corrupt_chunk_is_rejected_before_reconstruction_succeeds() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::write(root.join("art.clip"), vec![0x4a; 1_300_000]).unwrap();
    let repo = Repository::init(root, vec!["art.clip".into()]).unwrap();
    let id = repo.head().unwrap().unwrap();
    let entry = repo.entry(&id, "art.clip").unwrap();
    let chunk = &entry.chunks[0];
    let path = repo
        .metadata()
        .join("objects")
        .join(&chunk[..2])
        .join(chunk);
    let mut file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.write_all(b"x").unwrap();
    let err = repo.reconstruct(&entry, &mut Vec::new()).unwrap_err();
    assert!(matches!(err, Error::Corrupt(_)));
    assert!(matches!(repo.health().unwrap_err(), Error::Corrupt(_)));
}

#[test]
fn rejects_traversal_ads_and_symlinked_files() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("art.clip"), b"art").unwrap();
    let repo = Repository::init(temp.path(), vec!["art.clip".into()]).unwrap();
    for unsafe_path in [
        "../outside.clip",
        "C:/outside.psd",
        "art.clip:stream",
        ".ARTLOG/HEAD",
        ".Git/config",
        ".artlog-restore-recovery/file.clip",
        ".artlog-staged-temp/file.psd",
        "CON.psd",
        "Lpt9.clip",
        "folder/NUL.ext",
    ] {
        assert!(matches!(
            repo.source_path(unsafe_path),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn history_ignores_orphan_commit_and_preview_prefix_verifies_chunks() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let bytes: Vec<u8> = (0..1_400_000).map(|i| (i % 251) as u8).collect();
    fs::write(root.join("art.clip"), &bytes).unwrap();
    let repo = Repository::init(root, vec!["art.clip".into()]).unwrap();
    let baseline = repo.head().unwrap().unwrap();
    let checkpoint = repo
        .capture(Kind::Checkpoint, "Orphan candidate", "")
        .unwrap()
        .unwrap();
    let entry = repo.entry(&checkpoint.id, "art.clip").unwrap();
    assert_eq!(repo.read_prefix(&entry, 512).unwrap(), bytes[..512]);
    fs::write(
        repo.metadata().join("refs/heads/main"),
        format!("{baseline}\n"),
    )
    .unwrap();
    assert_eq!(repo.history().unwrap().len(), 1);
    assert!(repo.commit(&checkpoint.id).is_ok());
}

#[test]
fn large_file_streams_across_many_content_chunks_and_restores_exactly() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let mut bytes = Vec::with_capacity(12 * 1024 * 1024 + 137);
    let mut state = 0x1234_5678u32;
    for _ in 0..12 * 1024 * 1024 + 137 {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        bytes.push(state as u8);
    }
    fs::write(root.join("large.psd"), &bytes).unwrap();
    let repo = Repository::init(root, vec!["large.psd".into()]).unwrap();
    let id = repo.head().unwrap().unwrap();
    let entry = repo.entry(&id, "large.psd").unwrap();
    assert!(entry.chunks.len() >= 3, "expected multiple bounded chunks");
    for chunk in &entry.chunks {
        let object = repo
            .metadata()
            .join("objects")
            .join(&chunk[..2])
            .join(chunk);
        assert!(fs::metadata(object).unwrap().len() <= 4 * 1024 * 1024);
    }
    let mut restored = Vec::new();
    repo.reconstruct(&entry, &mut restored).unwrap();
    assert_eq!(restored, bytes);
    assert!(repo.capture(Kind::Auto, "", "").unwrap().is_none());
}

#[test]
fn normalizes_settings_and_blocks_capture_while_restore_recovery_is_pending() {
    use artlog_core::Settings;
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("art.clip"), b"art").unwrap();
    let repo = Repository::init(temp.path(), vec!["art.clip".into()]).unwrap();
    repo.set_settings(Settings {
        tracked: vec!["z.psd".into(), "a.clip".into(), "a.clip".into()],
        auto_capture: false,
        debounce_ms: 250,
    })
    .unwrap();
    let settings = repo.settings().unwrap();
    assert_eq!(settings.tracked, vec!["a.clip", "z.psd"]);
    assert!(!settings.auto_capture);
    for debounce_ms in [249, 10_001] {
        assert!(repo
            .set_settings(Settings {
                debounce_ms,
                ..settings.clone()
            })
            .is_err());
    }
    let recovery = repo.staging_path("restore-test").unwrap();
    fs::create_dir(&recovery).unwrap();
    assert!(matches!(
        repo.capture(Kind::Auto, "", ""),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        repo.capture(Kind::Checkpoint, "Manual", ""),
        Err(Error::Invalid(_))
    ));
    assert!(repo.capture(Kind::Safety, "Safety", "").unwrap().is_some());
    fs::remove_dir(recovery).unwrap();
}
