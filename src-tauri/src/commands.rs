use artlog_core::{
    index::ProjectIndex,
    restore,
    watcher::{WatchHandle, WatchState},
    Commit, Health, Kind, Repository, ScanEntry, Settings,
};
use serde::Serialize;
use std::{
    io,
    ops::Deref,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

type Reply<T> = std::result::Result<T, String>;

#[derive(Default, Clone)]
pub(crate) struct Desktop(Arc<Mutex<Option<Opened>>>);

struct Opened {
    id: String,
    repo: Arc<Repository>,
    capture: Arc<Mutex<CaptureStatus>>,
    watcher: Option<WatchHandle>,
}

impl Deref for Opened {
    type Target = Repository;

    fn deref(&self) -> &Self::Target {
        &self.repo
    }
}

impl Opened {
    fn new(repo: Repository, app: &AppHandle) -> Reply<Self> {
        static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
        // A portable repository can be copied. Scope commands to the particular
        // folder activation even when two folders share one repository ID.
        let id = format!(
            "{}-{}",
            repo.id(),
            NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
        );
        let settings = repo.settings().map_err(message)?;
        let initial = if !repo.recovery_paths().map_err(message)?.is_empty() {
            (
                WatchState::Paused,
                "Review the restore recovery folders before capturing.",
            )
        } else if settings.auto_capture {
            (WatchState::Pending, "Checking for saved changes…")
        } else {
            (WatchState::Paused, "Automatic capture is paused.")
        };
        let capture = Arc::new(Mutex::new(CaptureStatus {
            project_id: id.clone(),
            state: initial.0,
            message: initial.1.into(),
        }));
        let repo = Arc::new(repo);
        let watcher = {
            let app = app.clone();
            let saved = capture.clone();
            let id = id.clone();
            WatchHandle::start(repo.clone(), move |event| {
                let status = CaptureStatus {
                    project_id: id.clone(),
                    state: event.state,
                    message: event.message,
                };
                if let Ok(mut current) = saved.lock() {
                    *current = status.clone();
                }
                let _ = app.emit("capture-status", &status);
                if event.changed {
                    let _ = app.emit("project-updated", &id);
                }
            })
        };
        let watcher = match watcher {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                let mut status = capture.lock().map_err(message)?;
                status.state = WatchState::Error;
                status.message = format!("Automatic capture could not start: {error}");
                None
            }
        };
        Ok(Self {
            id,
            repo,
            capture,
            watcher,
        })
    }

    fn rescan(&self) {
        if let Some(watcher) = &self.watcher {
            watcher.rescan();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Scan {
    exists: bool,
    files: Vec<ScanEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Version {
    id: String,
    parent: Option<String>,
    timestamp: String,
    title: String,
    note: String,
    kind: Kind,
    file_count: usize,
}

impl From<Commit> for Version {
    fn from(commit: Commit) -> Self {
        Self {
            id: commit.id,
            parent: commit.parent,
            timestamp: commit.timestamp,
            title: commit.title,
            note: commit.note,
            kind: commit.kind,
            file_count: commit.files.len(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectView {
    id: String,
    root: String,
    name: String,
    settings: Settings,
    size: u64,
    recovery_paths: Vec<String>,
    commits: Vec<Version>,
    capture: CaptureStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureStatus {
    project_id: String,
    state: WatchState,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionFile {
    path: String,
    size: u64,
    hash: String,
}

fn message(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(regular) = text.strip_prefix(r"\\?\") {
            return regular.to_owned();
        }
    }
    text.into_owned()
}

async fn background<T: Send + 'static>(
    operation: impl FnOnce() -> Reply<T> + Send + 'static,
) -> Reply<T> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "ArtLog could not finish the background operation.".to_owned())?
}

async fn on_project<T: Send + 'static>(
    state: State<'_, Desktop>,
    project_id: String,
    operation: impl FnOnce(&Opened) -> Reply<T> + Send + 'static,
) -> Reply<T> {
    let desktop = state.inner().clone();
    background(move || {
        let active = desktop.0.lock().map_err(message)?;
        let project = active
            .as_ref()
            .filter(|project| project.id == project_id)
            .ok_or_else(|| "That project is no longer open.".to_owned())?;
        operation(project)
    })
    .await
}

fn view(repo: &Opened, app: &AppHandle) -> Reply<ProjectView> {
    let history = repo.history().map_err(message)?;
    if let Ok(data) = app.path().app_local_data_dir() {
        // Index errors are never repository errors. The portable commits are
        // authoritative, including when the local application data is lost.
        let _ = ProjectIndex::open_or_rebuild(&data.join("index"), repo.id(), &history);
    }
    Ok(ProjectView {
        id: repo.id.clone(),
        root: display(repo.root()),
        name: repo
            .root()
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Art project")
            .to_owned(),
        settings: repo.settings().map_err(message)?,
        size: repo.repository_size().map_err(message)?,
        recovery_paths: repo.recovery_paths().map_err(message)?,
        commits: history.into_iter().map(Version::from).collect(),
        capture: repo.capture.lock().map_err(message)?.clone(),
    })
}

#[tauri::command]
pub(crate) async fn scan_project(root: String) -> Reply<Scan> {
    background(move || {
        let root = PathBuf::from(root);
        if !root.is_absolute() || !root.is_dir() {
            return Err("Choose a folder on this computer.".into());
        }
        let exists = match root.join(".artlog").symlink_metadata() {
            Ok(_) => true,
            Err(err) if err.kind() == io::ErrorKind::NotFound => false,
            Err(err) => return Err(format!("Could not inspect this folder: {err}")),
        };
        let files = if exists {
            Vec::new()
        } else {
            Repository::scan(&root).map_err(message)?
        };
        Ok(Scan { exists, files })
    })
    .await
}

#[tauri::command]
pub(crate) async fn activate_project(
    app: AppHandle,
    state: State<'_, Desktop>,
    root: String,
    tracked: Option<Vec<String>>,
) -> Reply<ProjectView> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return Err("Choose a folder on this computer.".into());
        }
        let project = match tracked {
            Some(paths) => Repository::init(&root, paths),
            None => Repository::open(&root),
        }
        .map_err(message)?;
        let project = Opened::new(project, &app)?;
        let result = view(&project, &app)?;
        *active = Some(project);
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(crate) async fn close_project(state: State<'_, Desktop>) -> Reply<()> {
    let desktop = state.inner().clone();
    background(move || {
        *desktop.0.lock().map_err(message)? = None;
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_view(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
) -> Reply<ProjectView> {
    on_project(state, project_id, move |repo| view(repo, &app)).await
}

#[tauri::command]
pub(crate) async fn project_files(
    state: State<'_, Desktop>,
    project_id: String,
) -> Reply<Vec<ScanEntry>> {
    on_project(state, project_id, |repo| {
        Repository::scan(repo.root()).map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_commit_files(
    state: State<'_, Desktop>,
    project_id: String,
    id: String,
) -> Reply<Vec<VersionFile>> {
    on_project(state, project_id, move |repo| {
        Ok(repo
            .commit(&id)
            .map_err(message)?
            .files
            .into_iter()
            .map(|entry| VersionFile {
                path: entry.path,
                size: entry.size,
                hash: entry.hash,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_checkpoint(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    title: String,
    note: String,
) -> Reply<ProjectView> {
    let title = title.trim().to_owned();
    if title.is_empty() || title.chars().count() > 100 || note.chars().count() > 1000 {
        return Err(
            "Enter a checkpoint name of up to 100 characters and a note of up to 1,000.".into(),
        );
    }
    on_project(state, project_id, move |repo| {
        repo.capture(Kind::Checkpoint, &title, note.trim())
            .map_err(message)?;
        view(repo, &app)
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_settings(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    settings: Settings,
) -> Reply<ProjectView> {
    on_project(state, project_id, move |repo| {
        repo.set_settings(settings).map_err(message)?;
        repo.rescan();
        view(repo, &app)
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_copy(
    state: State<'_, Desktop>,
    project_id: String,
    id: String,
    path: String,
    destination: String,
) -> Reply<String> {
    on_project(state, project_id, move |repo| {
        restore::as_copy(repo, &id, &path, Path::new(&destination)).map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_in_place(
    state: State<'_, Desktop>,
    project_id: String,
    id: String,
    path: String,
    confirmed_target: String,
) -> Reply<restore::RestoreOutcome> {
    on_project(state, project_id, move |repo| {
        let result = restore::in_place(repo, &id, &path, &confirmed_target).map_err(message);
        repo.rescan();
        result
    })
    .await
}

#[tauri::command]
pub(crate) async fn repository_health(
    state: State<'_, Desktop>,
    project_id: String,
) -> Reply<Health> {
    on_project(state, project_id, |repo| repo.health().map_err(message)).await
}
