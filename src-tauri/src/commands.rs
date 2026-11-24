use artlog_core::{
    formats::{self, CommitThumbnail, Preview},
    index::ProjectIndex,
    projects::{self, trash, Container, Mode, ProjectFile, Summary},
    restore,
    watcher::{WatchHandle, WatchState},
    Commit, Health, Kind, RepackMode, RepackReport, Repository, Settings,
};
use serde::Serialize;
use std::{
    ops::Deref,
    path::Path,
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
        let summary = projects::describes(&repo).map_err(message)?;
        if summary.mode != Mode::SingleFile {
            return Err("Open a .clip file to use ArtLog.".into());
        }
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
        let mut project = Self {
            id,
            repo: Arc::new(repo),
            capture,
            watcher: None,
        };
        project.start_watcher(app);
        Ok(project)
    }

    fn start_watcher(&mut self, app: &AppHandle) {
        let watcher = {
            let app = app.clone();
            let saved = self.capture.clone();
            let id = self.id.clone();
            WatchHandle::start(self.repo.clone(), move |event| {
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
        self.watcher = match watcher {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                if let Ok(mut status) = self.capture.lock() {
                    status.state = WatchState::Error;
                    status.message = format!("Automatic capture could not start: {error}");
                }
                None
            }
        };
    }

    fn stop_watcher(&mut self) {
        if let Some(watcher) = self.watcher.take() {
            watcher.stop();
        }
    }

    fn rescan(&self) {
        if let Some(watcher) = &self.watcher {
            watcher.rescan();
        }
    }
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
    history_compression: Option<bool>,
    size: u64,
    recovery_paths: Vec<String>,
    commits: Vec<Version>,
    capture: CaptureStatus,
    project: Summary,
    files: Vec<ProjectFile>,
    metadata: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryRepack {
    report: RepackReport,
    size: u64,
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
pub(crate) struct ProjectState {
    head: Option<String>,
    path: Option<String>,
    capture: CaptureStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionFile {
    path: String,
    size: u64,
    hash: String,
    file_id: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ComparisonVersion {
    id: String,
    path: String,
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
    let _read = repo.with_read_lock().map_err(message)?;
    let history = repo.history().map_err(message)?;
    let summary = projects::describes(repo).map_err(message)?;
    let files = projects::files(repo, &history).map_err(message)?;
    if let Ok(data) = app.path().app_local_data_dir() {
        // Index errors are never repository errors. The portable commits are
        // authoritative, including when the local application data is lost.
        let _ = ProjectIndex::open_or_rebuild(&data.join("index"), repo.id(), &history);
    }
    Ok(ProjectView {
        id: repo.id.clone(),
        root: display(repo.root()),
        name: summary.name.clone(),
        settings: repo.settings().map_err(message)?,
        history_compression: repo.history_compression().ok(),
        size: repo.repository_size().map_err(message)?,
        recovery_paths: repo.recovery_paths().map_err(message)?,
        commits: history
            .into_iter()
            .map(|commit| {
                let mut version = Version::from(commit);
                // Optional presentation metadata cannot block access to saved artwork.
                if let Ok(Some(details)) = repo.version_details(&version.id) {
                    version.title = details.title;
                    version.note = details.note;
                }
                version
            })
            .collect(),
        capture: repo.capture.lock().map_err(message)?.clone(),
        project: summary,
        files,
        metadata: display(repo.metadata()),
    })
}

fn replace_active(
    active: &mut Option<Opened>,
    project: Opened,
    app: &AppHandle,
) -> Reply<ProjectView> {
    let view = view(&project, app)?;
    if let Some(previous) = active.as_mut() {
        previous.stop_watcher();
    }
    *active = Some(project);
    Ok(view)
}

#[tauri::command]
pub(crate) async fn open_clip(
    app: AppHandle,
    state: State<'_, Desktop>,
    path: String,
) -> Reply<ProjectView> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let (root, path) = projects::selected_file(Path::new(&path)).map_err(message)?;
        let project = Container::create(&root)
            .and_then(|c| c.open_or_create_single(&path))
            .map_err(message)?;
        replace_active(&mut active, Opened::new(project, &app)?, &app)
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_container_project(
    app: AppHandle,
    state: State<'_, Desktop>,
    root: String,
    id: String,
) -> Reply<ProjectView> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let root = Path::new(&root);
        let container = Container::discover(root)
            .map_err(message)?
            .ok_or_else(|| "No ArtLog history was found in this folder.".to_owned())?;
        let repo = container.open(&id).map_err(message)?;
        replace_active(&mut active, Opened::new(repo, &app)?, &app)
    })
    .await
}

#[tauri::command]
pub(crate) async fn close_project(state: State<'_, Desktop>) -> Reply<()> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        if let Some(mut previous) = active.take() {
            previous.stop_watcher();
        }
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
pub(crate) async fn project_state(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
) -> Reply<ProjectState> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let project = active_mut(&mut active, &project_id)?;
        if let Some(repo) = projects::reconcile_open_file(project).map_err(message)? {
            project.stop_watcher();
            project.repo = Arc::new(repo);
            project.start_watcher(&app);
        }
        let _read = project.with_read_lock().map_err(message)?;
        let capture = project.capture.lock().map_err(message)?.clone();
        Ok(ProjectState {
            head: project.head().map_err(message)?,
            path: projects::describes(project).map_err(message)?.path,
            capture,
        })
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
        let _read = repo.with_read_lock().map_err(message)?;
        Ok(repo
            .commit(&id)
            .map_err(message)?
            .files
            .into_iter()
            .map(|entry| VersionFile {
                path: entry.path,
                size: entry.size,
                hash: entry.hash,
                file_id: entry.file_id,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn update_version_details(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    id: String,
    title: String,
    note: String,
) -> Reply<ProjectView> {
    on_project(state, project_id, move |repo| {
        repo.update_version_details(&id, &title, &note)
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
pub(crate) async fn set_history_compression(
    state: State<'_, Desktop>,
    project_id: String,
    enabled: bool,
) -> Reply<u64> {
    on_project(state, project_id, move |repo| {
        repo.set_history_compression(enabled).map_err(message)?;
        repo.repository_size().map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn repack_history(
    state: State<'_, Desktop>,
    project_id: String,
    mode: RepackMode,
) -> Reply<HistoryRepack> {
    on_project(state, project_id, move |repo| {
        let report = repo.repack_history(mode).map_err(message)?;
        let size = repo.repository_size().map_err(message)?;
        Ok(HistoryRepack { report, size })
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
        let _read = repo.with_read_lock().map_err(message)?;
        restore::as_copy(repo, &id, &path, Path::new(&destination))
            .map(|path| display(Path::new(&path)))
            .map_err(message)
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
    on_project(state, project_id, |repo| {
        let _read = repo.with_read_lock().map_err(message)?;
        repo.health().map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_preview(
    state: State<'_, Desktop>,
    project_id: String,
    id: String,
    path: String,
) -> Reply<Option<Preview>> {
    let repo = on_project(state, project_id, |project| Ok(project.repo.clone())).await?;
    background(move || {
        let _read = repo.with_read_lock().map_err(message)?;
        formats::get(&repo, &id, &path).map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_commit_thumbnail(
    state: State<'_, Desktop>,
    project_id: String,
    id: String,
    path: Option<String>,
) -> Reply<Option<CommitThumbnail>> {
    let repo = on_project(state, project_id, |project| Ok(project.repo.clone())).await?;
    background(move || {
        let _read = repo.with_read_lock().map_err(message)?;
        formats::thumbnail(&repo, &id, path.as_deref()).map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn comparison_versions(
    state: State<'_, Desktop>,
    project_id: String,
    path: String,
    file_id: Option<String>,
) -> Reply<Vec<ComparisonVersion>> {
    on_project(state, project_id, move |repo| {
        let _read = repo.with_read_lock().map_err(message)?;
        Ok(repo
            .history()
            .map_err(message)?
            .into_iter()
            .filter_map(|commit| {
                let entry = commit.files.into_iter().find(|file| {
                    file_id
                        .as_ref()
                        .map_or(file.path == path, |id| file.file_id.as_ref() == Some(id))
                })?;
                Some(ComparisonVersion {
                    id: commit.id,
                    path: entry.path,
                })
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn relink_file(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    file_id: String,
    destination: String,
) -> Reply<ProjectView> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let project = active_mut(&mut active, &project_id)?;
        let (root, path) = projects::selected_file(Path::new(&destination)).map_err(message)?;
        if root != project.root() {
            return Err("Choose a .clip file in the original folder.".into());
        }
        project.stop_watcher();
        match projects::relink_file(project, &file_id, &path) {
            Ok(repo) => replace_active(&mut active, Opened::new(repo, &app)?, &app),
            Err(error) => {
                project.start_watcher(&app);
                Err(message(error))
            }
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn rename_project(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    name: String,
) -> Reply<ProjectView> {
    on_project(state, project_id, move |repo| {
        projects::rename(repo, &name).map_err(message)?;
        view(repo, &app)
    })
    .await
}

fn active_mut<'a>(active: &'a mut Option<Opened>, id: &str) -> Reply<&'a mut Opened> {
    active
        .as_mut()
        .filter(|project| project.id == id)
        .ok_or_else(|| "That project is no longer open.".to_owned())
}

#[tauri::command]
pub(crate) async fn delete_history(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    confirmation: String,
) -> Reply<()> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let project = active_mut(&mut active, &project_id)?;
        project.stop_watcher();
        match trash::delete_single_history(project, &confirmation) {
            Ok(()) => {
                if let Ok(data) = app.path().app_local_data_dir() {
                    let _ = ProjectIndex::discard(&data.join("index"), project.id());
                }
                *active = None;
                Ok(())
            }
            Err(error) => {
                if !project.pending_history_operation().unwrap_or(true) {
                    project.start_watcher(&app);
                }
                Err(message(error))
            }
        }
    })
    .await
}
