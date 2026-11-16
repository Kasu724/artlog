//! Filesystem notifications are hints. Capture is driven by coalesced, stable
//! file state and periodic reconciliation of the selected project paths.

use crate::{Kind, Repository};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, UNIX_EPOCH},
};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const PROBE_INTERVAL: Duration = Duration::from_millis(300);
const FULL_RECONCILE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchState {
    Pending,
    Capturing,
    Current,
    Paused,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub state: WatchState,
    pub message: String,
    pub changed: bool,
}

enum Control {
    Rescan,
    Stop,
}

enum NativeMessage {
    Event(Event),
    Error(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fingerprint {
    size: u64,
    modified_nanos: u128,
}

struct PendingPath {
    last_event: Instant,
    last_probe: Instant,
    fingerprint: Option<Fingerprint>,
    has_probe: bool,
    stable_probes: u8,
}

/// Owns the worker lifetime. Dropping it signals shutdown without blocking the
/// UI thread on filesystem operations or an in-progress large-file capture.
pub struct WatchHandle {
    control: mpsc::Sender<Control>,
    worker: Option<JoinHandle<()>>,
}

impl WatchHandle {
    pub fn start(
        repo: Arc<Repository>,
        callback: impl Fn(WatchEvent) + Send + 'static,
    ) -> io::Result<Self> {
        let root = repo.root().to_path_buf();
        let (native_tx, native_rx) = mpsc::sync_channel::<NativeMessage>(256);
        let overflow = Arc::new(AtomicBool::new(false));
        let mut watcher = RecommendedWatcher::new(
            native_callback(native_tx, overflow.clone()),
            Config::default().with_poll_interval(POLL_INTERVAL),
        )
        .ok();
        let watcher_error = match watcher.as_mut() {
            Some(watcher) => watcher
                .watch(&root, RecursiveMode::Recursive)
                .err()
                .map(|err| err.to_string()),
            None => Some("Filesystem notifications could not be started.".to_owned()),
        };
        if watcher_error.is_some() {
            watcher = None;
        }

        let (control, control_rx) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("artlog-watcher".into())
            .spawn(move || {
                run_worker(
                    repo,
                    callback,
                    native_rx,
                    overflow,
                    control_rx,
                    watcher,
                    watcher_error,
                )
            })?;
        Ok(Self {
            control,
            worker: Some(worker),
        })
    }

    /// Re-checks changed tracking/automatic-capture settings and reconciles the
    /// selected files. Call this after settings are saved in the UI.
    pub fn rescan(&self) {
        let _ = self.control.send(Control::Rescan);
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        let _ = self.control.send(Control::Stop);
        // Detach rather than join: an atomic snapshot may be reading a large
        // document, and shutdown must never hang a UI callback.
        let _ = self.worker.take();
    }
}

fn native_callback(
    sender: SyncSender<NativeMessage>,
    overflow: Arc<AtomicBool>,
) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |event| match event {
        Ok(event) if event.kind.is_access() => (),
        Ok(event) => {
            if sender.try_send(NativeMessage::Event(event)).is_err() {
                overflow.store(true, Ordering::Release);
            }
        }
        Err(error) => {
            let _ = sender.try_send(NativeMessage::Error(error.to_string()));
        }
    }
}

fn run_worker(
    repo: Arc<Repository>,
    callback: impl Fn(WatchEvent) + Send + 'static,
    native_rx: Receiver<NativeMessage>,
    overflow: Arc<AtomicBool>,
    control_rx: Receiver<Control>,
    _watcher: Option<RecommendedWatcher>,
    watcher_error: Option<String>,
) {
    let mut pending = BTreeMap::<String, PendingPath>::new();
    let mut known = BTreeMap::<String, Option<Fingerprint>>::new();
    let mut settings = match repo.settings() {
        Ok(settings) => settings,
        Err(err) => {
            emit(
                &callback,
                WatchState::Error,
                format!("Could not read capture settings: {err}"),
                false,
            );
            return;
        }
    };
    let mut tracked = settings.tracked.clone();
    let mut next_poll = Instant::now();
    let mut next_full_reconcile = Instant::now() + FULL_RECONCILE_INTERVAL;
    let mut force_reconcile = true;
    let mut stop = false;
    let mut recovering = false;
    let mut last_pending_notice = Instant::now() - Duration::from_secs(2);
    if let Some(message) = &watcher_error {
        emit(
            &callback,
            WatchState::Error,
            format!(
                "Filesystem notifications are unavailable; periodic checks are active. {message}"
            ),
            false,
        );
    }

    while !stop {
        match control_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Control::Stop) => stop = true,
            Ok(Control::Rescan) => force_reconcile = true,
            Err(RecvTimeoutError::Disconnected) => stop = true,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if stop {
            break;
        }

        for _ in 0..256 {
            match native_rx.try_recv() {
                Ok(NativeMessage::Event(event)) => {
                    if !settings.auto_capture {
                        continue;
                    }
                    for path in event.paths {
                        if let Some(relative) = relative_path(repo.root(), &path) {
                            if tracked.iter().any(|tracked| tracked == &relative) {
                                add_pending(&mut pending, relative);
                            }
                        }
                    }
                }
                Ok(NativeMessage::Error(message)) => {
                    force_reconcile = true;
                    emit(&callback, WatchState::Error,
                        format!("Filesystem notifications are degraded; periodic checks remain active. {message}"), false);
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        force_reconcile |= overflow.swap(false, Ordering::AcqRel);

        if next_full_reconcile <= Instant::now() {
            force_reconcile = true;
            next_full_reconcile = Instant::now() + FULL_RECONCILE_INTERVAL;
        }
        if next_poll <= Instant::now() || force_reconcile {
            match repo.settings() {
                Ok(updated) => {
                    if updated.tracked != tracked || updated.auto_capture != settings.auto_capture {
                        tracked = updated.tracked.clone();
                        pending.clear();
                        force_reconcile = true;
                    }
                    settings = updated;
                }
                Err(err) => {
                    emit(
                        &callback,
                        WatchState::Error,
                        format!("Could not read capture settings: {err}"),
                        false,
                    );
                    next_poll = Instant::now() + POLL_INTERVAL;
                    continue;
                }
            }
            next_poll = Instant::now() + POLL_INTERVAL;

            match repo.recovery_paths() {
                Ok(paths) if !paths.is_empty() => {
                    recovering = true;
                    pending.clear();
                    emit(
                        &callback,
                        WatchState::Paused,
                        format!(
                        "Automatic capture is paused while restore recovery needs attention: {}",
                        paths.join(", ")
                    ),
                        false,
                    );
                    force_reconcile = false;
                    continue;
                }
                Ok(_) => {
                    if recovering {
                        recovering = false;
                        force_reconcile = true;
                    }
                }
                Err(err) => {
                    emit(
                        &callback,
                        WatchState::Error,
                        format!("Could not check restore recovery: {err}"),
                        false,
                    );
                    force_reconcile = false;
                    continue;
                }
            }

            if !settings.auto_capture {
                pending.clear();
                emit(
                    &callback,
                    WatchState::Paused,
                    "Automatic capture is turned off.".into(),
                    false,
                );
                if force_reconcile {
                    known.clear();
                    for path in &tracked {
                        known.insert(path.clone(), file_fingerprint(&repo, path));
                    }
                }
                force_reconcile = false;
                continue;
            }

            if force_reconcile {
                for path in &tracked {
                    known.insert(path.clone(), file_fingerprint(&repo, path));
                    add_pending(&mut pending, path.clone());
                }
                force_reconcile = false;
            } else {
                for path in &tracked {
                    let current = file_fingerprint(&repo, path);
                    let previous = known.insert(path.clone(), current);
                    if previous != Some(current) && !pending.contains_key(path) {
                        add_pending(&mut pending, path.clone());
                    }
                }
            }
        }

        if pending.len() > MAX_PENDING {
            pending.clear();
            for path in &tracked {
                add_pending(&mut pending, path.clone());
            }
        }
        let now = Instant::now();
        let debounce = Duration::from_millis(settings.debounce_ms.clamp(100, 10_000));
        let mut all_stable = !pending.is_empty();
        for (path, candidate) in pending.iter_mut() {
            let current = file_fingerprint(&repo, path);
            if !candidate.has_probe || candidate.fingerprint != current {
                candidate.fingerprint = current;
                candidate.has_probe = true;
                candidate.stable_probes = 0;
                candidate.last_probe = now;
                candidate.last_event = now;
            } else if now.duration_since(candidate.last_probe) >= PROBE_INTERVAL {
                candidate.stable_probes = candidate.stable_probes.saturating_add(1);
                candidate.last_probe = now;
            }
            let quiet = now.duration_since(candidate.last_event) >= debounce;
            let stable = candidate.stable_probes >= 2;
            all_stable &= quiet && stable;
        }
        if !pending.is_empty()
            && !all_stable
            && now.duration_since(last_pending_notice) >= Duration::from_secs(1)
        {
            emit(
                &callback,
                WatchState::Pending,
                "Waiting for tracked files to finish saving.".into(),
                false,
            );
            last_pending_notice = now;
        }
        if all_stable {
            match repo.recovery_paths() {
                Ok(paths) if !paths.is_empty() => {
                    recovering = true;
                    pending.clear();
                    emit(
                        &callback,
                        WatchState::Paused,
                        format!(
                        "Automatic capture is paused while restore recovery needs attention: {}",
                        paths.join(", ")
                    ),
                        false,
                    );
                    continue;
                }
                Err(err) => {
                    emit(
                        &callback,
                        WatchState::Error,
                        format!("Could not check restore recovery: {err}"),
                        false,
                    );
                    continue;
                }
                Ok(_) => {}
            }
            match repo.settings() {
                Ok(updated) => {
                    if !updated.auto_capture || updated.tracked != tracked {
                        settings = updated;
                        tracked = settings.tracked.clone();
                        pending.clear();
                        force_reconcile = true;
                        continue;
                    }
                    settings = updated;
                }
                Err(err) => {
                    emit(
                        &callback,
                        WatchState::Error,
                        format!("Could not read capture settings: {err}"),
                        false,
                    );
                    continue;
                }
            }
            emit(
                &callback,
                WatchState::Capturing,
                "Recording the stable project state.".into(),
                false,
            );
            match repo.capture(Kind::Auto, "", "") {
                Ok(Some(commit)) => {
                    let message = if commit.title.is_empty() {
                        "Saved project changes.".into()
                    } else {
                        commit.title
                    };
                    emit(&callback, WatchState::Current, message, true);
                }
                Ok(None) => emit(
                    &callback,
                    WatchState::Current,
                    "Project is up to date.".into(),
                    false,
                ),
                Err(crate::Error::Unstable(_) | crate::Error::Busy) => {
                    for item in pending.values_mut() {
                        item.last_event = Instant::now();
                        item.stable_probes = 0;
                    }
                    emit(
                        &callback,
                        WatchState::Pending,
                        "A file changed during capture. Retrying when it settles.".into(),
                        false,
                    );
                    continue;
                }
                Err(err) if is_transient_io(&err) => {
                    for item in pending.values_mut() {
                        item.last_event = Instant::now();
                        item.stable_probes = 0;
                    }
                    emit(&callback, WatchState::Pending,
                        "A file is still locked by its editor. ArtLog will retry after the save settles.".into(), false);
                    continue;
                }
                Err(err) => {
                    for item in pending.values_mut() {
                        item.last_event = Instant::now();
                        item.stable_probes = 0;
                    }
                    emit(
                        &callback,
                        WatchState::Error,
                        format!("Could not capture the project: {err}"),
                        false,
                    );
                    continue;
                }
            }
            pending.clear();
            known.clear();
            for path in &tracked {
                known.insert(path.clone(), file_fingerprint(&repo, path));
            }
        }
    }
}

fn is_transient_io(error: &crate::Error) -> bool {
    match error {
        crate::Error::Io { source, .. } => {
            source.kind() == io::ErrorKind::PermissionDenied
                || matches!(source.raw_os_error(), Some(32 | 33))
        }
        _ => false,
    }
}

fn add_pending(pending: &mut BTreeMap<String, PendingPath>, path: String) {
    let now = Instant::now();
    pending
        .entry(path)
        .and_modify(|item| {
            item.last_event = now;
            item.stable_probes = 0;
        })
        .or_insert(PendingPath {
            last_event: now,
            last_probe: now,
            fingerprint: None,
            has_probe: false,
            stable_probes: 0,
        });
}

fn file_fingerprint(repo: &Repository, relative: &str) -> Option<Fingerprint> {
    let path = repo.source_path(relative).ok()?;
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    Some(Fingerprint {
        size: metadata.len(),
        modified_nanos,
    })
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let part = component.as_os_str().to_str()?;
        if part == ".artlog"
            || part == ".git"
            || part.starts_with(".artlog-restore-")
            || part.starts_with(".artlog-staged-")
            || part.ends_with(".tmp")
            || part.ends_with(".temp")
        {
            return None;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn emit(callback: &impl Fn(WatchEvent), state: WatchState, message: String, changed: bool) {
    callback(WatchEvent {
        state,
        message,
        changed,
    });
}
