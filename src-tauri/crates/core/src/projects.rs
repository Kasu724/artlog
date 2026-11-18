//! Portable project identities, container discovery, and legacy migration.

use super::*;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub mod trash;
pub const VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Folder,
    SingleFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    generation: String,
    mode: Mode,
    single_file: Option<String>,
    name: Option<String>,
    legacy_namespace: String,
    #[serde(default)]
    recovered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub mode: Mode,
    pub path: Option<String>,
    pub recovered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileRecord {
    pub(super) id: String,
    pub(super) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub id: String,
    pub path: String,
    pub tracked: bool,
    pub has_history: bool,
    pub present: bool,
}

pub(super) struct Binding {
    container: PathBuf,
    generation: String,
}

impl Binding {
    pub(super) fn pending(&self) -> Result<bool> {
        Ok(exists(&self.container.join("move.json"))?
            || exists(&self.container.join("migration.json"))?)
    }
    pub(super) fn lock(&self, repo: &Repository, exclusive: bool) -> Result<WriteGuard> {
        check_directory(&self.container)?;
        check_directory(&self.container.join("locks"))?;
        let guard = lock_file(&self.container.join("locks").join(&repo.id), exclusive)?;
        check_directory(&self.container.join("projects"))?;
        check_directory(&repo.metadata)?;
        if project(&repo.metadata)?.generation != self.generation {
            return Err(Error::Invalid(
                "This project's history has changed. Reopen the project.".into(),
            ));
        }
        if exclusive && self.pending()? {
            return Err(Error::Invalid("An ArtLog history operation was interrupted. Reopen this location to finish recovery.".into()));
        }
        Ok(guard)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContainerFormat {
    format_version: u32,
}

#[derive(Serialize, Deserialize)]
struct Migration {
    project: String,
    head: Option<String>,
    settings: Settings,
}

pub struct Container {
    root: PathBuf,
    dir: PathBuf,
}

impl Container {
    /// Discovery never creates metadata for a folder that has no ArtLog data.
    pub fn discover(root: &Path) -> Result<Option<Self>> {
        let container = Self::at(root)?;
        if !exists(&container.dir)? {
            return Ok(None);
        }
        container.prepare()?;
        Ok(Some(container))
    }

    pub fn create(root: &Path) -> Result<Self> {
        let container = Self::at(root)?;
        ensure_dir(&container.dir)?;
        container.prepare()?;
        Ok(container)
    }

    pub fn for_purge(root: &Path) -> Result<Self> {
        let container = Self::at(root)?;
        check_directory(&container.dir)?;
        container.verify_marker()?;
        Ok(container)
    }

    fn at(root: &Path) -> Result<Self> {
        if !root.is_absolute() {
            return Err(Error::Invalid("Choose a folder on this computer.".into()));
        }
        let root = canonical_root(root)?;
        let dir = root.join(".artlog");
        Ok(Self { root, dir })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn prepare(&self) -> Result<()> {
        check_directory(&self.dir)?;
        let marker = self.dir.join("container.json");
        let migration = self.dir.join("migration.json");
        if exists(&marker)? {
            self.verify_marker()?;
        }
        let _guard = self.lock()?;
        if !exists(&marker)? && !exists(&migration)? && !exists(&self.dir.join("format.json"))? {
            for path in children(&self.dir)? {
                if !matches!(
                    component(&path)?,
                    "container.lock" | "projects" | "trash" | "work" | "locks"
                ) {
                    return Err(Error::Invalid(
                        "The .artlog directory has no readable project format.".into(),
                    ));
                }
            }
        }
        for child in ["projects", "trash", "work", "locks"] {
            ensure_dir(&self.dir.join(child))?;
        }
        if exists(&migration)? || (!exists(&marker)? && exists(&self.dir.join("format.json"))?) {
            self.migrate()?;
        }
        if !exists(&marker)? {
            self.publish_marker()?;
        }
        self.verify_marker()?;
        trash::recover(self)
    }

    fn lock(&self) -> Result<WriteGuard> {
        check_directory(&self.dir)?;
        lock_file(&self.dir.join("container.lock"), true)
    }

    fn project_lock(&self, id: &str, exclusive: bool) -> Result<WriteGuard> {
        check_uuid(id)?;
        let locks = self.dir.join("locks");
        check_directory(&locks)?;
        lock_file(&locks.join(id), exclusive)
    }

    fn publish_marker(&self) -> Result<()> {
        atomic_json(
            &self.dir.join("container.json"),
            &ContainerFormat {
                format_version: VERSION,
            },
        )
    }

    fn verify_marker(&self) -> Result<()> {
        let format: ContainerFormat = read_json(&self.dir.join("container.json"))?;
        if format.format_version != VERSION {
            return Err(Error::Invalid(format!(
                "ArtLog container format {} is unsupported.",
                format.format_version
            )));
        }
        Ok(())
    }

    fn active_path(&self, id: &str) -> Result<PathBuf> {
        check_uuid(id)?;
        let parent = self.dir.join("projects");
        check_directory(&parent)?;
        Ok(parent.join(id))
    }

    pub fn list(&self) -> Result<Vec<Summary>> {
        let _guard = self.lock()?;
        self.list_locked()
    }

    fn list_locked(&self) -> Result<Vec<Summary>> {
        let dir = self.dir.join("projects");
        let mut summaries = Vec::new();
        for path in children(&dir)? {
            let id = component(&path)?;
            check_uuid(id)?;
            check_directory(&path)?;
            let info = project(&path)?;
            if id != info.id {
                return Err(Error::Corrupt(
                    "Project identity differs from its directory.".into(),
                ));
            }
            summaries.push(summary(&self.root, &path, &info)?);
        }
        summaries.sort_by(|a, b| (&a.name, &a.id).cmp(&(&b.name, &b.id)));
        Ok(summaries)
    }

    pub fn open(&self, id: &str) -> Result<Repository> {
        let _guard = self.lock()?;
        self.open_locked(id)
    }

    fn open_locked(&self, id: &str) -> Result<Repository> {
        let _guard = self.project_lock(id, false)?;
        self.open_active(id)
    }

    fn open_active(&self, id: &str) -> Result<Repository> {
        let dir = self.active_path(id)?;
        let mut repo = Repository::open_at(self.root.clone(), dir, VERSION)?;
        let info = project(repo.metadata())?;
        if info.id != id || repo.id != id {
            return Err(Error::Corrupt(
                "Project identity differs from its directory.".into(),
            ));
        }
        repo.binding = Some(Binding {
            container: self.dir.clone(),
            generation: info.generation,
        });
        Ok(repo)
    }

    pub fn open_or_create_single(&self, path: &str) -> Result<Repository> {
        validate_relative(path)?;
        if path.contains('/') || !is_clip_document(Path::new(path)) {
            return Err(Error::Invalid(
                "Choose one .clip file in this folder.".into(),
            ));
        }
        let _guard = self.lock()?;
        trash::recover(self)?;
        for item in self.list_locked()? {
            if item
                .path
                .is_some_and(|present| path_identity(&present) == path_identity(path))
            {
                return self.open_locked(&item.id);
            }
        }
        self.create_project(Mode::SingleFile, vec![path.to_owned()])
    }

    pub fn create_folder(&self, tracked: Vec<String>) -> Result<Repository> {
        let _guard = self.lock()?;
        trash::recover(self)?;
        if self
            .list_locked()?
            .iter()
            .any(|item| item.mode == Mode::Folder && !item.recovered)
        {
            return Err(Error::Invalid(
                "A folder project already exists here. Open it from the project list.".into(),
            ));
        }
        self.create_project(Mode::Folder, tracked)
    }

    fn create_project(&self, mode: Mode, tracked: Vec<String>) -> Result<Repository> {
        let mut settings = Settings {
            tracked,
            auto_capture: true,
            debounce_ms: 1200,
        };
        normalize_tracking_settings(&mut settings)?;
        let id = new_id();
        let stage = self.stage()?;
        let repo = Repository::init_at(
            self.root.clone(),
            stage.path().to_owned(),
            id.clone(),
            VERSION,
        )?;
        let single_file = if mode == Mode::SingleFile {
            let path = &settings.tracked[0];
            let source = repo.source_path(path)?;
            if !source.is_file() {
                return Err(Error::Invalid(
                    "The selected .clip file is unavailable.".into(),
                ));
            }
            let record = FileRecord {
                id: new_id(),
                path: path.clone(),
            };
            write_record(repo.metadata(), &record)?;
            Some(record.id)
        } else {
            None
        };
        atomic_json(
            &repo.metadata.join("project.json"),
            &Project {
                id: id.clone(),
                generation: new_id(),
                mode,
                single_file,
                name: None,
                legacy_namespace: id.clone(),
                recovered: false,
            },
        )?;
        repo.set_settings_locked(settings)?;
        let baseline = repo.capture_locked(
            Kind::Baseline,
            "Project created",
            "Initial project snapshot",
        )?;
        if mode == Mode::SingleFile && baseline.is_none_or(|commit| commit.files.len() != 1) {
            return Err(Error::Invalid(
                "The selected .clip file disappeared during setup.".into(),
            ));
        }
        repo.health()?;
        move_path(stage.path(), &self.active_path(&id)?)?;
        self.open_locked(&id)
    }

    fn stage(&self) -> Result<tempfile::TempDir> {
        let work = self.dir.join("work");
        check_directory(&work)?;
        tempfile::Builder::new()
            .prefix("stage-")
            .tempdir_in(&work)
            .map_err(|e| Error::io("stage project data", work, e))
    }

    fn migrate(&self) -> Result<()> {
        let journal = self.dir.join("migration.json");
        let marker = self.dir.join("container.json");
        let _legacy_guard = lock_file(&self.dir.join("write.lock"), true)?;
        let existing: Option<Migration> = if exists(&journal)? {
            Some(read_json(&journal)?)
        } else {
            None
        };
        let source = if exists(&marker)? {
            None
        } else {
            Some(open_legacy(&self.root)?)
        };
        let migration = if let Some(source) = &source {
            ensure_no_restore(source)?;
            if existing
                .as_ref()
                .is_some_and(|entry| entry.project != source.id)
            {
                return Err(Error::Corrupt(
                    "Legacy project identity changed during migration.".into(),
                ));
            }
            let migration = Migration {
                project: source.id.clone(),
                head: source.head()?,
                settings: source.settings()?,
            };
            atomic_json(&journal, &migration)?;
            migration
        } else {
            existing.ok_or_else(|| Error::Corrupt("The migration journal is missing.".into()))?
        };
        let id = migration.project;
        let _project_guard = self.project_lock(&id, true)?;
        let active = self.active_path(&id)?;
        if let Some(source) = source {
            // The old app can still open v1 after a crash before publication.
            // Rebuild any previously published candidate from the current source.
            if exists(&active)? {
                let candidate = project(&active)?;
                if candidate.id != id {
                    return Err(Error::Corrupt(
                        "Migration found an unexpected active project.".into(),
                    ));
                }
                remove_tree(&active)?;
            }
            let stage = self.dir.join("work").join(format!("migration-{id}"));
            if exists(&stage)? {
                check_directory(&stage)?;
                remove_tree(&stage)?;
            }
            ensure_dir(&stage)?;
            let repo = Repository::init_at(self.root.clone(), stage.clone(), id.clone(), VERSION)?;
            let history = source.history()?;
            for name in ["commits", "manifests", "objects", "refs"] {
                copy_tree(&source.metadata.join(name), &repo.metadata.join(name))?;
            }
            let mut paths = BTreeMap::new();
            let mut previews_copied = BTreeSet::new();
            for entry in history.iter().flat_map(|commit| &commit.files) {
                let file_id = legacy_file_id(&id, &entry.path);
                paths.insert(entry.path.clone(), file_id.clone());
                if is_clip_document(Path::new(&entry.path))
                    && previews_copied.insert((file_id.clone(), &entry.hash))
                {
                    let previews = repo.metadata.join("files").join(&file_id).join("previews");
                    if ensure_dir(&repo.metadata.join("files"))
                        .and_then(|()| ensure_dir(&repo.metadata.join("files").join(&file_id)))
                        .and_then(|()| ensure_dir(&previews))
                        .is_ok()
                    {
                        for adapter in ["clip", "export"] {
                            let name = format!("{}-{adapter}-v1.bin", entry.hash);
                            let legacy = source.metadata.join("previews");
                            if check_directory(&legacy).is_ok() {
                                let _ = copy_file(&legacy.join(&name), &previews.join(name));
                            }
                        }
                    }
                }
            }
            for (path, file_id) in paths {
                write_record(repo.metadata(), &FileRecord { id: file_id, path })?;
            }
            atomic_json(
                &repo.metadata.join("project.json"),
                &Project {
                    id: id.clone(),
                    generation: new_id(),
                    mode: Mode::Folder,
                    single_file: None,
                    name: None,
                    legacy_namespace: id.clone(),
                    recovered: false,
                },
            )?;
            repo.set_settings_locked(migration.settings.clone())?;
            let verified = Repository::open_at(self.root.clone(), repo.metadata.clone(), VERSION)?;
            if migration.head != verified.head()? || migration.settings != verified.settings()? {
                return Err(Error::Corrupt(
                    "Migrated history or settings differ from the original.".into(),
                ));
            }
            verified.health()?;
            move_path(&stage, &active)?;
            self.publish_marker()?;
        }
        // The source stays authoritative until the verified v2 marker is durable.
        let installed = self.open_active(&id)?;
        if installed.head()? != migration.head || installed.settings()? != migration.settings {
            return Err(Error::Corrupt(
                "The published migration differs from its journal.".into(),
            ));
        }
        installed.health()?;
        self.verify_legacy_cleanup(&migration.head, &migration.settings)?;
        for name in [
            "format.json",
            "staging",
            "commits",
            "manifests",
            "objects",
            "refs",
            "HEAD",
            "config.json",
        ] {
            let path = self.dir.join(name);
            if exists(&path)? {
                remove_tree(&path)?;
            }
        }
        // The old preview cache is derived. Unsafe entries can be left unused
        // without preventing the verified project from opening.
        let previews = self.dir.join("previews");
        if exists(&previews)? {
            let _ = remove_tree(&previews);
        }
        remove_file(&journal)
    }

    fn verify_legacy_cleanup(&self, head: &Option<String>, settings: &Settings) -> Result<()> {
        let staging = self.dir.join("staging");
        if exists(&staging)?
            && children(&staging)?.iter().any(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("restore-"))
            })
        {
            return Err(Error::Invalid(
                "Resolve the legacy restore journal before completing migration.".into(),
            ));
        }
        let config = self.dir.join("config.json");
        if exists(&config)? {
            let mut legacy: Settings = read_json(&config)?;
            normalize_settings(&mut legacy)?;
            legacy
                .tracked
                .retain(|path| is_clip_document(Path::new(path)));
            if &legacy != settings {
                return Err(Error::Invalid(
                    "The legacy settings changed after migration. Both copies were kept.".into(),
                ));
            }
        }
        let refs = self.dir.join("refs");
        if exists(&refs)? {
            check_directory(&refs)?;
            let heads = refs.join("heads");
            if exists(&heads)? {
                check_directory(&heads)?;
                let main = heads.join("main");
                if exists(&main)? && read_ref(&main)?.trim() != head.as_deref().unwrap_or("") {
                    return Err(Error::Invalid(
                        "The legacy history changed after migration. Both copies were kept.".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

pub fn open_legacy(root: &Path) -> Result<Repository> {
    let root = canonical_root(root)?;
    Repository::open_at(root.clone(), root.join(".artlog"), FORMAT_VERSION)
}

pub fn readable_during_migration(root: &Path) -> Result<Repository> {
    if let Ok(legacy) = open_legacy(root) {
        return Ok(legacy);
    }
    let container = Container::for_purge(root)?;
    let _guard = container.lock()?;
    let migration: Migration = read_json(&container.dir.join("migration.json"))?;
    let repo = container.open_locked(&migration.project)?;
    repo.health()?;
    Ok(repo)
}

pub fn open_folder(root: &Path) -> Result<Repository> {
    let container = Container::discover(root)?
        .ok_or_else(|| Error::Invalid("No ArtLog project was found.".into()))?;
    let folder = container
        .list()?
        .into_iter()
        .find(|item| item.mode == Mode::Folder && !item.recovered)
        .ok_or_else(|| Error::Invalid("No folder project was found.".into()))?;
    container.open(&folder.id)
}

pub fn selected_file(path: &Path) -> Result<(PathBuf, String)> {
    if !path.is_absolute() || !is_clip_document(path) {
        return Err(Error::Invalid(
            "Choose one .clip file on this computer.".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid("The selected file has no folder.".into()))?;
    let name = component(path)?.to_owned();
    validate_relative(&name)?;
    let root = canonical_root(parent)?;
    regular(&root.join(&name))?;
    Ok((root, name))
}

pub fn same_path(a: &str, b: &str) -> bool {
    path_identity(a) == path_identity(b)
}

pub fn describes(repo: &Repository) -> Result<Summary> {
    if repo.version == FORMAT_VERSION {
        return Ok(Summary {
            id: repo.id.clone(),
            name: default_name(repo.root()),
            mode: Mode::Folder,
            path: None,
            recovered: false,
        });
    }
    let info = project(repo.metadata())?;
    summary(repo.root(), repo.metadata(), &info)
}

pub fn files(repo: &Repository, history: &[Commit]) -> Result<Vec<ProjectFile>> {
    if repo.version == FORMAT_VERSION {
        return Ok(Vec::new());
    }
    let settings = repo.settings()?;
    let retained: BTreeSet<&str> = history
        .iter()
        .flat_map(|c| &c.files)
        .filter_map(|entry| entry.file_id.as_deref())
        .collect();
    records(repo)?
        .into_iter()
        .map(|file| {
            let present = repo
                .source_path(&file.path)
                .is_ok_and(|path| path.is_file());
            Ok(ProjectFile {
                tracked: settings.tracked.contains(&file.path),
                has_history: retained.contains(file.id.as_str()),
                id: file.id,
                path: file.path,
                present,
            })
        })
        .collect()
}

pub fn scan_project_files(repo: &Repository) -> Result<Vec<ScanEntry>> {
    if let Some(path) = describes(repo)?.path {
        let source = repo.source_path(&path)?;
        if !exists(&source)? {
            return Ok(Vec::new());
        }
        let size = regular(&source)?.len();
        return Ok(vec![ScanEntry { path, size }]);
    }
    Repository::scan(repo.root())
}

pub fn stop_tracking(repo: &Repository, file_id: &str) -> Result<()> {
    let _guard = repo.with_write_lock()?;
    let file = record(repo.metadata(), file_id)?;
    let mut settings = repo.settings()?;
    settings.tracked.retain(|path| *path != file.path);
    repo.set_settings_locked(settings)
}

pub fn relink_file(repo: &Repository, file_id: &str, path: &str) -> Result<()> {
    let container = Container::at(repo.root())?;
    let _location = container.lock()?;
    let _guard = repo.with_write_lock()?;
    ensure_no_restore(repo)?;
    let mut file = record(repo.metadata(), file_id)?;
    if repo.source_path(&file.path)?.is_file() {
        return Err(Error::Invalid(
            "Move or rename the original file before linking its new location.".into(),
        ));
    }
    if !is_clip_document(Path::new(path)) {
        return Err(Error::Invalid("Choose a .clip file.".into()));
    }
    regular(&repo.source_path(path)?)?;
    if describes(repo)?.mode == Mode::SingleFile {
        if path.contains('/') {
            return Err(Error::Invalid(
                "Choose a replacement in the same folder.".into(),
            ));
        }
        if container.list_locked()?.iter().any(|item| {
            item.id != repo.id
                && item
                    .path
                    .as_ref()
                    .is_some_and(|other| same_path(other, path))
        }) {
            return Err(Error::Invalid(
                "That file already has a single-file project in this folder.".into(),
            ));
        }
    }
    if records(repo)?
        .iter()
        .any(|other| other.id != file_id && path_identity(&other.path) == path_identity(path))
    {
        return Err(Error::Invalid(
            "That path already has a file identity in this project.".into(),
        ));
    }
    file.path = path.to_owned();
    write_record(repo.metadata(), &file)
}

pub fn rename(repo: &Repository, name: &str) -> Result<()> {
    let _guard = repo.with_write_lock()?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(Error::Invalid(
            "Enter a project name of up to 100 characters.".into(),
        ));
    }
    let mut info = project(repo.metadata())?;
    info.name = Some(name.to_owned());
    atomic_json(&repo.metadata.join("project.json"), &info)
}

pub fn ensure_no_restore(repo: &Repository) -> Result<()> {
    if !repo.recovery_paths()?.is_empty() {
        return Err(Error::Invalid(
            "Resolve the interrupted in-place restore before changing project history.".into(),
        ));
    }
    Ok(())
}

fn default_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Art project")
        .to_owned()
}

fn summary(root: &Path, dir: &Path, info: &Project) -> Result<Summary> {
    let path = info
        .single_file
        .as_deref()
        .map(|id| record(dir, id).map(|file| file.path))
        .transpose()?;
    Ok(Summary {
        id: info.id.clone(),
        mode: info.mode,
        name: info
            .name
            .clone()
            .or_else(|| path.clone())
            .unwrap_or_else(|| default_name(root)),
        path,
        recovered: info.recovered,
    })
}

fn project(dir: &Path) -> Result<Project> {
    check_directory(dir)?;
    let info: Project = read_json(&dir.join("project.json"))?;
    check_uuid(&info.id)?;
    check_uuid(&info.generation)?;
    check_uuid(&info.legacy_namespace)?;
    match (info.mode, &info.single_file) {
        (Mode::SingleFile, Some(id)) => check_uuid(id)?,
        (Mode::Folder, None) => (),
        _ => return Err(Error::Corrupt("Invalid project scope.".into())),
    }
    Ok(info)
}

fn record(dir: &Path, id: &str) -> Result<FileRecord> {
    check_uuid(id)?;
    check_directory(dir)?;
    check_directory(&dir.join("files"))?;
    let dir = dir.join("files").join(id);
    check_directory(&dir)?;
    let record: FileRecord = read_json(&dir.join("file.json"))?;
    validate_relative(&record.path)?;
    if record.id != id {
        return Err(Error::Corrupt(
            "File identity differs from its directory.".into(),
        ));
    }
    Ok(record)
}

fn write_record(dir: &Path, record: &FileRecord) -> Result<()> {
    check_uuid(&record.id)?;
    validate_relative(&record.path)?;
    let files = dir.join("files");
    ensure_dir(&files)?;
    let dir = files.join(&record.id);
    ensure_dir(&dir)?;
    atomic_json(&dir.join("file.json"), record)
}

pub(super) fn legacy_namespace(dir: &Path) -> Result<String> {
    Ok(project(dir)?.legacy_namespace)
}

pub(super) fn records(repo: &Repository) -> Result<Vec<FileRecord>> {
    let dir = repo.metadata.join("files");
    if !exists(&dir)? {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for path in children(&dir)? {
        records.push(record(repo.metadata(), component(&path)?)?);
    }
    records.sort_by(|a, b| (&a.path, &a.id).cmp(&(&b.path, &b.id)));
    Ok(records)
}

pub(super) fn settings(repo: &Repository) -> Result<Settings> {
    let mut settings: Settings = read_json(&repo.metadata.join("config.json"))?;
    let info = project(repo.metadata())?;
    if info
        .single_file
        .as_ref()
        .is_some_and(|id| settings.tracked.iter().any(|tracked| tracked != id))
    {
        return Err(Error::Corrupt(
            "Tracking exceeds this project's single-file scope.".into(),
        ));
    }
    for id in &mut settings.tracked {
        *id = record(repo.metadata(), id)?.path;
    }
    normalize_tracking_settings(&mut settings)?;
    Ok(settings)
}

pub(super) fn set_settings(repo: &Repository, mut settings: Settings) -> Result<()> {
    let info = project(repo.metadata())?;
    let records = records(repo)?;
    for path in &mut settings.tracked {
        repo.source_path(path)?;
        let file = records.iter().find(|file| file.path == *path).or_else(|| {
            records
                .iter()
                .find(|file| path_identity(&file.path) == path_identity(path))
        });
        *path = if let Some(file) = file {
            file.id.clone()
        } else if info.mode == Mode::Folder {
            let file = FileRecord {
                id: new_id(),
                path: path.clone(),
            };
            write_record(repo.metadata(), &file)?;
            file.id
        } else {
            return Err(Error::Invalid(
                "This project tracks only its linked .clip file.".into(),
            ));
        };
    }
    if info
        .single_file
        .as_ref()
        .is_some_and(|id| settings.tracked.iter().any(|tracked| tracked != id))
    {
        return Err(Error::Invalid(
            "This project tracks only its linked .clip file.".into(),
        ));
    }
    atomic_json(&repo.metadata.join("config.json"), &settings)
}

pub(super) fn preview_base(repo: &Repository, entry: &Entry) -> Result<PathBuf> {
    if let Some(id) = &entry.file_id {
        record(repo.metadata(), id)?;
        return Ok(repo.metadata.join("files").join(id));
    }
    Ok(repo.metadata.clone())
}

pub fn file_path(repo: &Repository, entry: &Entry) -> Result<String> {
    if let Some(id) = &entry.file_id {
        return Ok(record(repo.metadata(), id)?.path);
    }
    Ok(entry.path.clone())
}

pub(super) fn legacy_file_id(repository_id: &str, path: &str) -> String {
    let mut hash = blake3::Hasher::new();
    hash.update(b"ArtLog legacy file\0");
    hash.update(repository_id.as_bytes());
    hash.update(b"\0");
    hash.update(path.as_bytes());
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&hash.finalize().as_bytes()[..16]);
    uuid::Builder::from_custom_bytes(bytes)
        .into_uuid()
        .to_string()
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub(super) fn check_uuid(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        return Ok(());
    }
    Err(Error::Invalid(
        "Invalid project, file, or trash identity.".into(),
    ))
}

pub(super) fn exists(path: &Path) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Error::io("inspect project data", path, e)),
    }
}

fn component(path: &Path) -> Result<&str> {
    path.file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| Error::Invalid("An ArtLog path is not valid Unicode.".into()))
}

fn ensure_dir(dir: &Path) -> Result<()> {
    match fs::create_dir(dir) {
        Ok(()) => sync_parent(dir),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => check_directory(dir),
        Err(e) => Err(Error::io("create ArtLog directory", dir, e)),
    }
}

fn children(path: &Path) -> Result<Vec<PathBuf>> {
    check_directory(path)?;
    let mut paths = fs::read_dir(path)
        .map_err(|e| Error::io("list ArtLog directory", path, e))?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|e| Error::io("list ArtLog directory", path, e))
        })
        .collect::<Result<Vec<_>>>()?;
    paths.sort();
    Ok(paths)
}

fn regular(path: &Path) -> Result<fs::Metadata> {
    let meta = path
        .symlink_metadata()
        .map_err(|e| Error::io("inspect ArtLog file", path, e))?;
    if !meta.is_file() || is_link(&meta) {
        return Err(Error::Invalid(format!(
            "Unsafe ArtLog file: {}",
            path.display()
        )));
    }
    Ok(meta)
}

fn copy_file(from: &Path, to: &Path) -> Result<()> {
    regular(from)?;
    let mut source = open_source(from).map_err(|e| Error::io("read project data", from, e))?;
    let mut destination =
        tempfile::NamedTempFile::new_in(to.parent().expect("metadata file has a parent"))
            .map_err(|e| Error::io("stage project data", to, e))?;
    io::copy(&mut source, &mut destination)
        .and_then(|_| destination.as_file().sync_all())
        .map_err(|e| Error::io("copy project data", to, e))?;
    destination
        .persist(to)
        .map_err(|e| Error::io("publish project data", to, e.error))?;
    sync_parent(to)
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let meta = from
        .symlink_metadata()
        .map_err(|e| Error::io("inspect project data", from, e))?;
    if meta.is_dir() && !is_link(&meta) {
        ensure_dir(to)?;
        for child in children(from)? {
            copy_tree(&child, &to.join(component(&child)?))?;
        }
        return Ok(());
    }
    copy_file(from, to)
}

fn move_path(from: &Path, to: &Path) -> Result<()> {
    check_directory(from)?;
    check_directory(to.parent().expect("project directory has a parent"))?;
    if exists(to)? {
        return Err(Error::Invalid(format!(
            "ArtLog destination already exists: {}",
            to.display()
        )));
    }
    fs::rename(from, to).map_err(|e| Error::io("move ArtLog project data", to, e))?;
    sync_parent(to)?;
    sync_parent(from)
}

fn remove_tree(path: &Path) -> Result<()> {
    let meta = path
        .symlink_metadata()
        .map_err(|e| Error::io("inspect ArtLog data", path, e))?;
    if meta.is_dir() && !is_link(&meta) {
        for child in children(path)? {
            remove_tree(&child)?;
        }
        fs::remove_dir(path).map_err(|e| Error::io("remove empty ArtLog directory", path, e))?;
        return sync_parent(path);
    }
    regular(path)?;
    remove_file(path)
}

fn remove_file(path: &Path) -> Result<()> {
    fs::remove_file(path).map_err(|e| Error::io("remove ArtLog metadata", path, e))?;
    sync_parent(path)
}

fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .expect("ArtLog metadata has a parent directory");
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|e| Error::io("flush ArtLog directory", parent, e))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_resumes_cleanup_only_after_verifying_both_copies() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("art.clip"), b"verified artwork").unwrap();
        let legacy = Repository::init(root.path(), vec!["art.clip".into()]).unwrap();
        let journal = Migration {
            project: legacy.id.clone(),
            head: legacy.head().unwrap(),
            settings: legacy.settings().unwrap(),
        };
        let backup = tempfile::tempdir().unwrap();
        copy_tree(legacy.metadata(), backup.path()).unwrap();
        let container = Container::discover(root.path()).unwrap().unwrap();
        for file in [
            "format.json",
            "config.json",
            "HEAD",
            "commits",
            "manifests",
            "objects",
            "refs",
            "staging",
        ] {
            copy_tree(&backup.path().join(file), &container.dir.join(file)).unwrap();
        }
        atomic_json(&container.dir.join("migration.json"), &journal).unwrap();
        let restore = container.dir.join("staging/restore-pending");
        ensure_dir(&restore).unwrap();
        assert!(Container::discover(root.path()).is_err());
        assert!(restore.is_dir());
        assert_eq!(
            readable_during_migration(root.path())
                .unwrap()
                .head()
                .unwrap(),
            journal.head
        );
        fs::remove_dir(restore).unwrap();
        remove_file(&container.dir.join("format.json")).unwrap();
        remove_tree(&container.dir.join("commits")).unwrap();
        let fallback = readable_during_migration(root.path()).unwrap();
        assert_eq!(fallback.head().unwrap(), journal.head);
        assert!(fallback.capture(Kind::Auto, "", "").is_err());
        let reopened = Container::discover(root.path()).unwrap().unwrap();
        let installed = reopened.open(legacy.id()).unwrap();
        assert_eq!(installed.head().unwrap(), journal.head);
        assert!(!exists(&container.dir.join("migration.json")).unwrap());
        assert_eq!(
            fs::read(root.path().join("art.clip")).unwrap(),
            b"verified artwork"
        );
    }
}
