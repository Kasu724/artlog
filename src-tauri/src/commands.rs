use artlog_core::{
    formats::{self, CommitThumbnail, Preview},
    index::ProjectIndex,
    projects::{self, trash, Container, Mode, ProjectFile, Summary},
    restore,
    watcher::{WatchHandle, WatchState},
    Commit, Health, Kind, Repository, ScanEntry, Settings,
};
use serde::Serialize;
use std::{
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
    open_warning: Option<String>,
}

impl Deref for Opened {
    type Target = Repository;

    fn deref(&self) -> &Self::Target {
        &self.repo
    }
}

impl Opened {
    fn new(repo: Repository, app: &AppHandle) -> Reply<Self> {
        Self::with_warning(repo, app, None)
    }

    fn with_warning(
        repo: Repository,
        app: &AppHandle,
        open_warning: Option<String>,
    ) -> Reply<Self> {
        static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
        // A portable repository can be copied. Scope commands to the particular
        // folder activation even when two folders share one repository ID.
        let id = format!(
            "{}-{}",
            repo.id(),
            NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
        );
        let settings = repo.settings().map_err(message)?;
        let initial = if open_warning.is_some() {
            (
                WatchState::Paused,
                "Reopen this folder to retry the history upgrade.",
            )
        } else if !repo.recovery_paths().map_err(message)?.is_empty() {
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
            open_warning,
        };
        project.start_watcher(app);
        Ok(project)
    }

    fn start_watcher(&mut self, app: &AppHandle) {
        if self.open_warning.is_some() {
            return;
        }
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

    fn writable(&self) -> Reply<()> {
        if let Some(warning) = &self.open_warning {
            return Err(warning.clone());
        }
        Ok(())
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
    projects: Vec<Summary>,
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
    project: Summary,
    files: Vec<ProjectFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    open_warning: Option<String>,
    metadata: String,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileLocation {
    root: String,
    path: String,
    existing: Option<Summary>,
    folders: Vec<Summary>,
    shared: bool,
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
        size: repo.repository_size().map_err(message)?,
        recovery_paths: repo.recovery_paths().map_err(message)?,
        commits: history.into_iter().map(Version::from).collect(),
        capture: repo.capture.lock().map_err(message)?.clone(),
        project: summary,
        files,
        open_warning: repo.open_warning.clone(),
        metadata: display(repo.metadata()),
    })
}

#[tauri::command]
pub(crate) async fn scan_project(root: String) -> Reply<Scan> {
    background(move || {
        let root = PathBuf::from(root);
        if !root.is_absolute() || !root.is_dir() {
            return Err("Choose a folder on this computer.".into());
        }
        let projects = match Container::discover(&root) {
            Ok(Some(container)) => container.list().map_err(message)?,
            Ok(None) => Vec::new(),
            Err(error) => match projects::readable_during_migration(&root) {
                Ok(repo) => vec![projects::describes(&repo).map_err(message)?],
                Err(_) => return Err(message(error)),
            },
        };
        let exists = projects
            .iter()
            .any(|project| project.mode == Mode::Folder && !project.recovered);
        let files = if exists {
            Vec::new()
        } else {
            Repository::scan(&root).map_err(message)?
        };
        Ok(Scan {
            exists,
            files,
            projects,
        })
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
            Some(paths) => Opened::new(
                Container::create(&root)
                    .and_then(|c| c.create_folder(paths))
                    .map_err(message)?,
                &app,
            )?,
            None => match projects::open_folder(&root) {
                Ok(repo) => Opened::new(repo, &app)?,
                Err(error) => legacy_fallback(&root, error, &app)?,
            },
        };
        replace_active(&mut active, project, &app)
    })
    .await
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

fn legacy_fallback(root: &Path, error: artlog_core::Error, app: &AppHandle) -> Reply<Opened> {
    let legacy = projects::readable_during_migration(root).map_err(|_| message(&error))?;
    Opened::with_warning(legacy, app, Some(format!("ArtLog could not upgrade this folder. Its saved history is available as copies. Reopen the folder to retry. {error}")))
}

fn project_container(root: &Path) -> Reply<Container> {
    Container::discover(root)
        .map_err(message)?
        .ok_or_else(|| "No ArtLog history was found in this folder.".to_owned())
}

#[tauri::command]
pub(crate) async fn inspect_clip(path: String) -> Reply<FileLocation> {
    background(move || {
        let (root, path) = projects::selected_file(Path::new(&path)).map_err(message)?;
        let mut existing = None;
        let mut folders = Vec::new();
        let mut shared = false;
        if let Some(container) = Container::discover(&root).map_err(message)? {
            for item in container.list().map_err(message)? {
                match item.mode {
                    Mode::Folder => {
                        let repo = container.open(&item.id).map_err(message)?;
                        shared |= repo.settings().map_err(message)?.tracked.contains(&path);
                        folders.push(item);
                    }
                    Mode::SingleFile
                        if item
                            .path
                            .as_ref()
                            .is_some_and(|item| projects::same_path(item, &path)) =>
                    {
                        existing = Some(item)
                    }
                    Mode::SingleFile => (),
                }
            }
        }
        Ok(FileLocation {
            root: display(&root),
            path,
            existing,
            folders,
            shared,
        })
    })
    .await
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
        let project = match project_container(root).and_then(|c| c.open(&id).map_err(message)) {
            Ok(repo) => Opened::new(repo, &app)?,
            Err(error) => {
                let legacy = projects::readable_during_migration(root).map_err(|_| error.clone())?;
                if legacy.id() != id { return Err(error); }
                Opened::with_warning(legacy, &app, Some(format!("ArtLog could not upgrade this folder. Its saved history is available as copies. Reopen the folder to retry. {error}")))?
            }
        };
        replace_active(&mut active, project, &app)
    }).await
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
    state: State<'_, Desktop>,
    project_id: String,
) -> Reply<ProjectState> {
    on_project(state, project_id, |repo| {
        Ok(ProjectState {
            head: repo.head().map_err(message)?,
            capture: repo.capture.lock().map_err(message)?.clone(),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn project_files(
    state: State<'_, Desktop>,
    project_id: String,
) -> Reply<Vec<ScanEntry>> {
    on_project(state, project_id, |repo| {
        projects::scan_project_files(repo).map_err(message)
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
                file_id: entry.file_id,
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
        repo.writable()?;
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
        repo.writable()?;
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
        repo.writable()?;
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
pub(crate) async fn attach_preview(
    state: State<'_, Desktop>,
    project_id: String,
    id: String,
    path: String,
    image_path: String,
) -> Reply<Preview> {
    on_project(state, project_id, move |repo| {
        repo.writable()?;
        let _read = repo.with_read_lock().map_err(message)?;
        formats::attach(repo, &id, &path, Path::new(&image_path)).map_err(message)
    })
    .await
}

#[tauri::command]
pub(crate) async fn stop_tracking(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    file_id: String,
) -> Reply<ProjectView> {
    on_project(state, project_id, move |repo| {
        repo.writable()?;
        projects::stop_tracking(repo, &file_id).map_err(message)?;
        repo.rescan();
        view(repo, &app)
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
    on_project(state, project_id, move |repo| {
        repo.writable()?;
        let destination = Path::new(&destination);
        if !destination.is_absolute() {
            return Err("Choose a .clip file in the project folder.".into());
        }
        let canonical = destination.canonicalize().map_err(message)?;
        let relative = canonical
            .strip_prefix(repo.root())
            .map_err(|_| "Choose a .clip file in the project folder.")?;
        let path = relative
            .to_str()
            .ok_or("The selected path is not valid Unicode.")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if destination
            .symlink_metadata()
            .map_err(message)?
            .file_type()
            .is_symlink()
        {
            return Err("Choose the original file and its direct path.".into());
        }
        projects::relink_file(repo, &file_id, &path).map_err(message)?;
        repo.rescan();
        view(repo, &app)
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
        repo.writable()?;
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
pub(crate) async fn delete_file_history(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    file_id: String,
    confirmation: String,
) -> Reply<ProjectView> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let project = active_mut(&mut active, &project_id)?;
        project.writable()?;
        project.stop_watcher();
        match trash::archive_file(project, &file_id, &confirmation) {
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
pub(crate) async fn remove_project(
    app: AppHandle,
    state: State<'_, Desktop>,
    project_id: String,
    confirmation: String,
) -> Reply<()> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        let project = active_mut(&mut active, &project_id)?;
        project.writable()?;
        project.stop_watcher();
        match trash::archive_project(project, &confirmation) {
            Ok(()) => {
                *active = None;
                Ok(())
            }
            Err(error) => {
                project.start_watcher(&app);
                Err(message(error))
            }
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_trash(root: String) -> Reply<Vec<trash::TrashItem>> {
    background(
        move || match Container::discover(Path::new(&root)).map_err(message)? {
            Some(container) => container.list_trash().map_err(message),
            None => Ok(Vec::new()),
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn restore_trash(
    app: AppHandle,
    state: State<'_, Desktop>,
    root: String,
    id: String,
) -> Reply<ProjectView> {
    let desktop = state.inner().clone();
    background(move || {
        let mut active = desktop.0.lock().map_err(message)?;
        if let Some(project) = active.as_mut() {
            project.stop_watcher();
        }
        let result = (|| {
            let container = project_container(Path::new(&root))?;
            let restored = container.restore_trash(&id).map_err(message)?;
            let repo = container.open(&restored.id).map_err(message)?;
            replace_active(&mut active, Opened::new(repo, &app)?, &app)
        })();
        if result.is_err() {
            if let Some(project) = active.as_mut() {
                project.start_watcher(&app);
            }
        }
        result
    })
    .await
}

#[tauri::command]
pub(crate) async fn purge_trash(root: String, id: String, confirmation: String) -> Reply<()> {
    background(move || {
        Container::for_purge(Path::new(&root))
            .and_then(|c| c.purge_trash(&id, &confirmation))
            .map_err(message)
    })
    .await
}
