use std::{
    fs,
    path::PathBuf,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use artlog_core::{
    watcher::{WatchEvent, WatchHandle},
    Repository,
};

fn temp_dir(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("artlog-watcher-{label}-{stamp}"));
    fs::create_dir_all(&path).unwrap();
    path
}

fn receive_capture(rx: &mpsc::Receiver<WatchEvent>, timeout: Duration) -> WatchEvent {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(
            !left.is_zero(),
            "timed out waiting for an automatic capture"
        );
        if let Ok(event) = rx.recv_timeout(left) {
            if event.changed {
                return event;
            }
        }
    }
}

#[test]
fn repeated_save_notifications_create_one_history_entry() {
    let project = temp_dir("dedupe");
    fs::write(project.join("paint.clip"), b"initial").unwrap();
    let repo = Arc::new(Repository::init(&project, vec!["paint.clip".into()]).unwrap());
    let mut settings = repo.settings().unwrap();
    settings.debounce_ms = 250;
    repo.set_settings(settings).unwrap();

    let (tx, rx) = mpsc::channel();
    let handle = WatchHandle::start(repo.clone(), move |event| {
        let _ = tx.send(event);
    })
    .unwrap();
    thread::sleep(Duration::from_millis(800));
    for _ in 0..4 {
        fs::write(project.join("paint.clip"), b"final save").unwrap();
        thread::sleep(Duration::from_millis(30));
    }
    receive_capture(&rx, Duration::from_secs(8));
    thread::sleep(Duration::from_secs(3));
    assert_eq!(repo.history().unwrap().len(), 2);
    drop(handle);
}

#[test]
fn startup_reconciliation_captures_a_save_made_while_closed() {
    let project = temp_dir("reopen");
    fs::write(project.join("art.psd"), b"before").unwrap();
    let repo = Repository::init(&project, vec!["art.psd".into()]).unwrap();
    drop(repo);

    fs::write(project.join("art.psd"), b"saved while ArtLog was closed").unwrap();
    let repo = Arc::new(Repository::open(&project).unwrap());
    let (tx, rx) = mpsc::channel();
    let _handle = WatchHandle::start(repo.clone(), move |event| {
        let _ = tx.send(event);
    })
    .unwrap();

    let changed = receive_capture(&rx, Duration::from_secs(8));
    assert_eq!(changed.state, artlog_core::watcher::WatchState::Current);
    assert_eq!(repo.history().unwrap().len(), 2);
}

#[test]
fn disabled_capture_pauses_then_rescan_catches_changes() {
    let project = temp_dir("disabled");
    fs::write(project.join("art.clip"), b"before").unwrap();
    let repo = Arc::new(Repository::init(&project, vec!["art.clip".into()]).unwrap());
    let mut settings = repo.settings().unwrap();
    settings.auto_capture = false;
    repo.set_settings(settings).unwrap();

    let (tx, rx) = mpsc::channel();
    let handle = WatchHandle::start(repo.clone(), move |event| {
        let _ = tx.send(event);
    })
    .unwrap();
    thread::sleep(Duration::from_millis(400));
    fs::write(project.join("art.clip"), b"while paused").unwrap();
    thread::sleep(Duration::from_secs(3));
    assert_eq!(repo.history().unwrap().len(), 1);

    let mut settings = repo.settings().unwrap();
    settings.auto_capture = true;
    repo.set_settings(settings).unwrap();
    handle.rescan();
    receive_capture(&rx, Duration::from_secs(8));
    assert_eq!(repo.history().unwrap().len(), 2);
}

#[test]
fn rename_omits_old_working_path_without_losing_its_history() {
    let project = tempfile::tempdir().unwrap();
    let before = project.path().join("Old.clip");
    let after = project.path().join("Renamed.clip");
    fs::write(&before, b"renamed artwork").unwrap();
    let repo = Arc::new(Repository::init(project.path(), vec!["Old.clip".into()]).unwrap());
    let baseline = repo.head().unwrap().unwrap();
    let (tx, rx) = mpsc::channel();
    let _handle = WatchHandle::start(repo.clone(), move |event| {
        let _ = tx.send(event);
    })
    .unwrap();
    fs::rename(before, &after).unwrap();
    receive_capture(&rx, Duration::from_secs(8));
    assert!(repo.history().unwrap()[0].files.is_empty());
    let mut output = Vec::new();
    repo.reconstruct(&repo.entry(&baseline, "Old.clip").unwrap(), &mut output)
        .unwrap();
    assert_eq!(output, fs::read(after).unwrap());
}
