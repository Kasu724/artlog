use artlog_core::{projects::Container, restore, Error, Kind, Repository};
use std::{
    fs,
    io::{self, Write},
};

#[test]
fn init_capture_reopen_deduplicate_and_reconstruct_exact_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let original = b"first layered artwork\0bytes";
    fs::write(root.join("drawing.clip"), original).unwrap();
    fs::write(root.join("poster.clip"), b"initial composite").unwrap();
    let repo = Repository::init(root, vec!["drawing.clip".into(), "poster.clip".into()]).unwrap();
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
    assert_eq!(checkpoint.manifest_id, captured.manifest_id);
    let record = fs::read_to_string(
        reopened
            .metadata()
            .join("commits")
            .join(format!("{}.json", checkpoint.id)),
    )
    .unwrap();
    assert!(!record.contains("\"files\""));
    assert_eq!(reopened.history().unwrap().len(), 3);
    assert_eq!(reopened.health().unwrap().versions, 3);
}

#[test]
fn desktop_history_deduplicates_plaintext_across_codecs_and_restores_a_copy() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path();
    let source = root.join("art.clip");
    let first = vec![0x42; 100_000];
    fs::write(&source, &first).unwrap();
    let container = Container::create(root).unwrap();
    let repo = container.open_or_create_single("art.clip").unwrap();
    let baseline = repo.history().unwrap().remove(0);
    let id = &baseline.files[0].chunks[0];
    let object = repo.metadata().join("objects").join(&id[..2]).join(id);
    assert!(fs::metadata(&object).unwrap().len() < 1000);

    repo.set_history_compression(false).unwrap();
    let checkpoint = repo
        .capture(Kind::Checkpoint, "Same bytes", "Deduplicated")
        .unwrap()
        .unwrap();
    assert_eq!(baseline.manifest_id, checkpoint.manifest_id);
    assert_eq!(repo.health().unwrap().objects, 1);
    assert!(fs::metadata(&object).unwrap().len() < 1000);

    let second = vec![0x24; 100_000];
    fs::write(&source, &second).unwrap();
    let uncompressed = repo.capture(Kind::Auto, "", "").unwrap().unwrap();
    let id = &uncompressed.files[0].chunks[0];
    let object = repo.metadata().join("objects").join(&id[..2]).join(id);
    assert_eq!(fs::read(&object).unwrap(), second);
    drop(repo);

    let reopened = container.open_or_create_single("art.clip").unwrap();
    assert!(!reopened.history_compression().unwrap());
    assert_eq!(reopened.health().unwrap().objects, 2);
    let restored = root.join("restored.clip");
    restore::as_copy(&reopened, &baseline.id, "art.clip", &restored).unwrap();
    assert_eq!(fs::read(restored).unwrap(), first);
    assert_eq!(fs::read(source).unwrap(), second);

    let mut entry = baseline.files[0].clone();
    entry.size -= 1;
    assert!(matches!(
        reopened.reconstruct(&entry, &mut io::sink()),
        Err(Error::Corrupt(_))
    ));
    entry.size += 1;
    entry.hash.clone_from(&uncompressed.files[0].hash);
    assert!(matches!(
        reopened.reconstruct(&entry, &mut io::sink()),
        Err(Error::Corrupt(_))
    ));
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
fn scans_only_clip_documents_and_captures_a_long_unicode_path() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path().canonicalize().unwrap();
    // Exercise paths over 260 characters on Windows while leaving room for
    // the temporary directory within the macOS pathname byte limit.
    let prefix = format!("{}{}", "a".repeat(64), "画".repeat(4));
    let deep = ["one", "two", "three", "four"]
        .map(|component| format!("{component}-{prefix}"))
        .join("/");
    let art = format!("{deep}/夜.CLIP");
    fs::create_dir_all(root.join(&deep)).unwrap();
    fs::write(root.join(&art), b"layered art").unwrap();
    fs::write(root.join("palette.txt"), b"palette companion").unwrap();
    fs::write(root.join("outside.psd"), b"other artwork").unwrap();
    fs::write(root.join("temp.TMP"), b"editor scratch").unwrap();
    let found = Repository::scan(&root).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].path, art);
    assert!(matches!(
        Repository::init(&root, vec!["outside.psd".into()]),
        Err(Error::Invalid(_))
    ));
    assert!(!root.join(".artlog").exists());
    let repo = Repository::init(&root, vec![art.clone()]).unwrap();
    let mut unsupported = repo.settings().unwrap();
    unsupported.tracked.push("palette.txt".into());
    assert!(matches!(
        repo.set_settings(unsupported),
        Err(Error::Invalid(_))
    ));
    assert_eq!(
        repo.settings().unwrap().tracked.as_slice(),
        std::slice::from_ref(&art)
    );
    let id = repo.head().unwrap().unwrap();
    assert!(repo.entry(&id, "palette.txt").is_err());
    let mut output = Vec::new();
    repo.reconstruct(&repo.entry(&id, &art).unwrap(), &mut output)
        .unwrap();
    assert_eq!(output, b"layered art");
}

#[test]
fn interrupted_restore_write_reports_disk_full_and_leaves_history_intact() {
    struct FullDisk;
    impl Write for FullDisk {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "fixture disk is full",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path();
    fs::write(root.join("art.clip"), b"historical").unwrap();
    let repo = Repository::init(root, vec!["art.clip".into()]).unwrap();
    let id = repo.head().unwrap().unwrap();
    let entry = repo.entry(&id, "art.clip").unwrap();
    assert!(matches!(
        repo.reconstruct(&entry, &mut FullDisk),
        Err(Error::Io { source, .. }) if source.kind() == io::ErrorKind::StorageFull
    ));
    assert_eq!(repo.head().unwrap().as_deref(), Some(id.as_str()));
    assert_eq!(fs::read(root.join("art.clip")).unwrap(), b"historical");
    assert_eq!(repo.health().unwrap().versions, 1);
}

#[test]
fn rejects_traversal_ads_and_symlinked_files() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("art.clip"), b"art").unwrap();
    let repo = Repository::init(temp.path(), vec!["art.clip".into()]).unwrap();
    for unsafe_path in [
        "../outside.clip",
        "C:/outside.clip",
        "art.clip:stream",
        ".ARTLOG/HEAD",
        ".Git/config",
        ".artlog-restore-recovery/file.clip",
        ".artlog-staged-temp/file.clip",
        "CON.clip",
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
fn history_ignores_orphan_commit() {
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
    fs::write(root.join("large.clip"), &bytes).unwrap();
    let repo = Repository::init(root, vec!["large.clip".into()]).unwrap();
    let id = repo.head().unwrap().unwrap();
    let entry = repo.entry(&id, "large.clip").unwrap();
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
        tracked: vec!["z.clip".into(), "a.clip".into(), "a.clip".into()],
        auto_capture: false,
        debounce_ms: 250,
    })
    .unwrap();
    let settings = repo.settings().unwrap();
    assert_eq!(settings.tracked, vec!["a.clip", "z.clip"]);
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
