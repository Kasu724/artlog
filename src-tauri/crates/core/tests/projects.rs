use artlog_core::{
    formats,
    projects::{self, trash, Container, Mode},
    restore, Kind, Repository,
};
use std::{fs, io, path::Path, sync::Arc, time::Duration};

fn sources() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("first.clip"), b"original bytes").unwrap();
    fs::write(dir.path().join("second.clip"), b"original bytes").unwrap();
    dir
}

fn both() -> Vec<String> {
    vec!["first.clip".into(), "second.clip".into()]
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for item in fs::read_dir(from).unwrap() {
        let item = item.unwrap();
        let destination = to.join(item.file_name());
        if item.file_type().unwrap().is_dir() {
            copy_dir(&item.path(), &destination);
        } else {
            fs::copy(item.path(), destination).unwrap();
        }
    }
}

#[test]
fn migrates_exact_checkpoints_previews_and_file_ids_and_copies_portably() {
    let root = sources();
    let legacy = Repository::init(root.path(), both()).unwrap();
    let baseline = legacy.history().unwrap().remove(0);
    let image = root.path().join("export.png");
    image::RgbImage::new(3, 4).save(&image).unwrap();
    formats::attach(&legacy, &baseline.id, "first.clip", &image).unwrap();
    fs::write(root.path().join("first.clip"), b"saved later").unwrap();
    let tip = legacy
        .capture(Kind::Checkpoint, "Line art", "Keep this note")
        .unwrap()
        .unwrap();
    let container = Container::discover(root.path()).unwrap().unwrap();
    let migrated = container.open(legacy.id()).unwrap();
    assert_eq!(tip.id, migrated.head().unwrap().unwrap());
    assert_eq!(migrated.health().unwrap().objects, 2);
    assert_eq!(migrated.settings().unwrap().tracked, both());
    assert!(!legacy.metadata().join("format.json").exists());
    let first = migrated.entry(&baseline.id, "first.clip").unwrap();
    let second = migrated.entry(&baseline.id, "second.clip").unwrap();
    assert_ne!(first.file_id, second.file_id);
    assert_eq!(first.chunks, second.chunks);
    assert_eq!(
        formats::get(&migrated, &baseline.id, "first.clip")
            .unwrap()
            .unwrap()
            .adapter,
        "export"
    );
    assert!(migrated
        .metadata()
        .join("files")
        .join(first.file_id.as_ref().unwrap())
        .join("file.json")
        .is_file());
    let target = root.path().join("copy.clip");
    restore::as_copy(&migrated, &baseline.id, "first.clip", &target).unwrap();
    assert_eq!(fs::read(target).unwrap(), b"original bytes");

    let copy = tempfile::tempdir().unwrap();
    copy_dir(root.path(), copy.path());
    let copied = Repository::open(copy.path()).unwrap();
    assert_eq!(copied.id(), migrated.id());
    assert_eq!(copied.history().unwrap(), migrated.history().unwrap());
    assert_eq!(copied.settings().unwrap(), migrated.settings().unwrap());
    copied.health().unwrap();
}

#[test]
fn migration_retries_without_losing_legacy_history() {
    let root = sources();
    let legacy = Repository::init(root.path(), both()).unwrap();
    let head = legacy.head().unwrap().unwrap();
    let entry = legacy.entry(&head, "first.clip").unwrap();
    let chunk = &entry.chunks[0];
    let object = legacy
        .metadata()
        .join("objects")
        .join(&chunk[..2])
        .join(chunk);
    let original = fs::read(&object).unwrap();
    fs::write(&object, b"incomplete disk write").unwrap();
    assert!(Container::discover(root.path()).is_err());
    assert!(legacy.metadata().join("migration.json").is_file());
    assert!(!legacy.metadata().join("container.json").exists());
    let legacy = Repository::open(root.path()).unwrap();
    assert_eq!(legacy.head().unwrap().as_deref(), Some(head.as_str()));
    fs::write(object, &original).unwrap();
    legacy.reconstruct(&entry, &mut io::sink()).unwrap();
    let repo = Container::discover(root.path())
        .unwrap()
        .unwrap()
        .open(legacy.id())
        .unwrap();
    assert_eq!(repo.head().unwrap().as_deref(), Some(head.as_str()));
    assert!(!legacy.metadata().join("migration.json").exists());
}

#[test]
fn leaves_a_legacy_restore_journal_available_until_resolved() {
    let root = sources();
    let legacy = Repository::init(root.path(), both()).unwrap();
    let recovery = legacy.metadata().join("staging/restore-safety");
    fs::create_dir(&recovery).unwrap();
    assert!(Container::discover(root.path()).is_err());
    let reopened = Repository::open(root.path()).unwrap();
    assert_eq!(reopened.recovery_paths().unwrap(), ["restore-safety"]);
    assert!(reopened.capture(Kind::Auto, "", "").is_err());
    fs::remove_dir(recovery).unwrap();
    assert!(Container::discover(root.path()).unwrap().is_some());
}

#[test]
fn single_file_watcher_and_rename_preserve_scope_and_identity() {
    let root = sources();
    let container = Container::create(root.path()).unwrap();
    let sibling = container.open_or_create_single("second.clip").unwrap();
    let single = container.open_or_create_single("first.clip").unwrap();
    assert_ne!(single.id(), sibling.id());
    assert!(single.metadata().ends_with(".artlog/projects/first.clip"));
    assert!(sibling.metadata().ends_with(".artlog/projects/second.clip"));
    assert_eq!(
        single.id(),
        container.open_or_create_single("first.clip").unwrap().id()
    );
    assert_eq!(projects::describes(&single).unwrap().mode, Mode::SingleFile);
    assert_eq!(projects::scan_project_files(&single).unwrap().len(), 1);
    let baseline = single.history().unwrap().remove(0);
    let id = baseline.files[0].file_id.as_ref().unwrap();
    let mut settings = single.settings().unwrap();
    settings.tracked = both();
    assert!(single.set_settings(settings).is_err());
    let mut settings = single.settings().unwrap();
    settings.debounce_ms = 250;
    single.set_settings(settings).unwrap();
    let single = Arc::new(single);
    let (sender, receiver) = std::sync::mpsc::channel();
    let watcher = artlog_core::watcher::WatchHandle::start(single.clone(), move |event| {
        if event.changed {
            let _ = sender.send(());
        }
    })
    .unwrap();
    fs::write(root.path().join("second.clip"), b"sibling only").unwrap();
    assert!(receiver.recv_timeout(Duration::from_millis(750)).is_err());
    fs::write(root.path().join("first.clip"), b"selected save").unwrap();
    receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    watcher.stop();
    let head = single.history().unwrap().remove(0);
    assert_eq!(head.files.len(), 1);
    assert_eq!(head.files[0].file_id.as_ref(), Some(id));
    assert_eq!(sibling.history().unwrap().len(), 1);

    fs::rename(
        root.path().join("first.clip"),
        root.path().join("renamed.clip"),
    )
    .unwrap();
    assert!(projects::relink_file(&single, id, "second.clip").is_err());
    let relinked = projects::relink_file(&single, id, "renamed.clip").unwrap();
    assert!(!single.metadata().exists());
    assert!(relinked
        .metadata()
        .ends_with(".artlog/projects/renamed.clip"));
    assert_eq!(relinked.head().unwrap().as_deref(), Some(head.id.as_str()));
    let reopened = container.open_or_create_single("renamed.clip").unwrap();
    assert_eq!(reopened.id(), single.id());
    assert_eq!(
        projects::describes(&reopened).unwrap().path.as_deref(),
        Some("renamed.clip")
    );
    let next = reopened
        .capture(Kind::Checkpoint, "Renamed", "")
        .unwrap()
        .unwrap();
    assert_eq!(next.files[0].file_id.as_ref(), Some(id));
    assert_eq!(
        projects::file_path(&reopened, &baseline.files[0]).unwrap(),
        "renamed.clip"
    );
}

#[test]
fn detects_rename_in_an_open_session_and_continues_its_history() {
    let root = sources();
    let container = Container::create(root.path()).unwrap();
    let repo = container.open_or_create_single("first.clip").unwrap();
    let baseline = repo.history().unwrap().remove(0);
    fs::rename(
        root.path().join("first.clip"),
        root.path().join("cover.clip"),
    )
    .unwrap();
    let renamed = projects::reconcile_open_file(&repo).unwrap().unwrap();
    assert_eq!(renamed.id(), repo.id());
    assert!(!repo.metadata().exists());
    assert!(renamed.metadata().ends_with(".artlog/projects/cover.clip"));
    assert_eq!(renamed.history().unwrap(), std::slice::from_ref(&baseline));
    fs::write(root.path().join("cover.clip"), b"finished cover").unwrap();
    let capture = renamed.capture(Kind::Auto, "", "").unwrap().unwrap();
    assert_eq!(capture.files[0].file_id, baseline.files[0].file_id);
    assert_eq!(capture.files[0].path, "cover.clip");
    assert_eq!(capture.parent.as_deref(), Some(baseline.id.as_str()));
}

#[test]
fn reopens_renamed_artwork_after_a_close_without_creating_another_history() {
    let root = sources();
    let container = Container::create(root.path()).unwrap();
    let repo = container.open_or_create_single("first.clip").unwrap();
    let id = repo.id().to_owned();
    let head = repo.head().unwrap();
    drop(repo);
    drop(container);
    fs::rename(
        root.path().join("first.clip"),
        root.path().join("cover.clip"),
    )
    .unwrap();
    let container = Container::create(root.path()).unwrap();
    let repo = container.open_or_create_single("cover.clip").unwrap();
    assert_eq!(repo.id(), id);
    assert_eq!(repo.head().unwrap(), head);
    assert_eq!(container.list().unwrap().len(), 1);
}

#[test]
fn leaves_history_unlinked_when_identity_is_missing_or_ambiguous() {
    let root = sources();
    let container = Container::create(root.path()).unwrap();
    let repo = container.open_or_create_single("first.clip").unwrap();
    let source = root.path().join("first.clip");
    let moved = root.path().join("moved.clip");
    let alias = root.path().join("alias.clip");
    fs::hard_link(&source, &alias).unwrap();
    fs::rename(&source, &moved).unwrap();
    assert!(projects::reconcile_open_file(&repo).unwrap().is_none());
    fs::remove_file(alias).unwrap();
    fs::remove_file(moved).unwrap();
    // second.clip contains identical bytes but was created as a distinct file.
    assert!(projects::reconcile_open_file(&repo).unwrap().is_none());
    assert_eq!(
        projects::describes(&repo).unwrap().path.as_deref(),
        Some("first.clip")
    );
}

#[test]
fn stop_delete_restore_and_remove_are_scoped_to_the_selected_history() {
    let root = sources();
    let legacy = Repository::init(root.path(), both()).unwrap();
    let container = Container::discover(root.path()).unwrap().unwrap();
    let folder = container.open(legacy.id()).unwrap();
    let sibling = container.open_or_create_single("first.clip").unwrap();
    fs::write(root.path().join("first.clip"), b"new working bytes").unwrap();
    folder
        .capture(Kind::Checkpoint, "Milestone", "note")
        .unwrap();
    let original = folder.history().unwrap();
    let file = original[0].files[0].file_id.as_ref().unwrap();
    projects::stop_tracking(&folder, file).unwrap();
    assert_eq!(folder.history().unwrap(), original);
    assert_eq!(folder.settings().unwrap().tracked, ["second.clip"]);
    assert!(folder.capture(Kind::Auto, "", "").unwrap().is_none());
    assert!(trash::archive_file(&folder, file, "second.clip").is_err());
    let cleaned = trash::archive_file(&folder, file, "first.clip").unwrap();
    let active = cleaned.history().unwrap();
    assert_ne!(active[0].id, original[0].id);
    assert_eq!(active.len(), original.len());
    for (active, original) in active.iter().zip(&original) {
        assert_eq!(active.timestamp, original.timestamp);
        assert_eq!(active.title, original.title);
        assert_eq!(active.note, original.note);
        assert_eq!(active.files, [original.files[1].clone()]);
    }
    assert!(folder.capture(Kind::Checkpoint, "stale", "").is_err());
    assert_eq!(cleaned.health().unwrap().objects, 1);
    let item = container.list_trash().unwrap().remove(0);
    assert_eq!(item.file_path.as_deref(), Some("first.clip"));
    assert!(item.size > 0);
    assert_eq!(container.restore_trash(&item.id).unwrap().id, cleaned.id());
    let restored = container.open(cleaned.id()).unwrap();
    assert_eq!(restored.history().unwrap(), original);
    assert_eq!(restored.settings().unwrap().tracked, ["second.clip"]);
    assert_eq!(
        fs::read(root.path().join("first.clip")).unwrap(),
        b"new working bytes"
    );
    assert_eq!(sibling.history().unwrap().len(), 1);
    trash::archive_project(&restored, &projects::describes(&restored).unwrap().name).unwrap();
    assert_eq!(container.list().unwrap()[0].id, sibling.id());
    let removed = container.list_trash().unwrap().remove(0);
    assert_eq!(
        container.restore_trash(&removed.id).unwrap().id,
        restored.id()
    );
    assert_eq!(
        container.open(restored.id()).unwrap().history().unwrap(),
        original
    );
}

#[test]
fn restores_conflicting_legacy_history_into_a_separate_project() {
    let root = sources();
    let legacy = Repository::init(root.path(), both()).unwrap();
    let container = Container::discover(root.path()).unwrap().unwrap();
    let folder = container.open(legacy.id()).unwrap();
    let baseline = folder.history().unwrap().remove(0);
    let file = baseline.files[0].file_id.as_ref().unwrap();
    let cleaned = trash::archive_file(&folder, file, "first.clip").unwrap();
    cleaned.capture(Kind::Checkpoint, "Later work", "").unwrap();
    let item = container.list_trash().unwrap().remove(0);
    let recovered = container.restore_trash(&item.id).unwrap();
    assert_ne!(recovered.id, cleaned.id());
    let recovered = container.open(&recovered.id).unwrap();
    assert_eq!(recovered.history().unwrap(), [baseline]);
    assert_eq!(
        projects::files(&recovered, &recovered.history().unwrap())
            .unwrap()
            .len(),
        2
    );
    assert_eq!(cleaned.history().unwrap()[0].title, "Later work");
}

#[test]
fn v2_in_place_restore_verifies_the_target_and_preserves_safety_bytes() {
    let root = sources();
    let project = Container::create(root.path())
        .unwrap()
        .open_or_create_single("first.clip")
        .unwrap();
    let baseline = project.history().unwrap().remove(0);
    let source = root.path().join("first.clip");
    fs::write(&source, b"working version before restore").unwrap();
    assert!(restore::in_place(&project, &baseline.id, "first.clip", "second.clip").is_err());
    assert_eq!(
        fs::read(&source).unwrap(),
        b"working version before restore"
    );
    let outcome = restore::in_place(&project, &baseline.id, "first.clip", "first.clip").unwrap();
    let safety = project.entry(&outcome.safety_id, "first.clip").unwrap();
    let mut bytes = Vec::new();
    project.reconstruct(&safety, &mut bytes).unwrap();
    assert_eq!(bytes, b"working version before restore");
    assert_eq!(safety.file_id, baseline.files[0].file_id);
    assert_eq!(fs::read(&source).unwrap(), b"original bytes");
    assert_eq!(project.head().unwrap(), Some(outcome.commit_id));
}

#[test]
fn recovered_history_does_not_take_the_active_file_slot() {
    let root = sources();
    let container = Container::create(root.path()).unwrap();
    let single = container.open_or_create_single("first.clip").unwrap();
    trash::archive_project(&single, "first.clip").unwrap();
    let replacement = container.open_or_create_single("first.clip").unwrap();
    let archive = container.list_trash().unwrap().remove(0);
    let recovered = container.restore_trash(&archive.id).unwrap();
    assert!(recovered.recovered);
    assert_ne!(recovered.id, replacement.id());
    let sibling = container.open_or_create_single("second.clip").unwrap();
    assert!(sibling.metadata().ends_with(".artlog/projects/second.clip"));
    assert_eq!(recovered.mode, Mode::Folder);
    assert_eq!(
        container.open_or_create_single("first.clip").unwrap().id(),
        replacement.id()
    );
    assert_eq!(container.list().unwrap().len(), 3);
}
