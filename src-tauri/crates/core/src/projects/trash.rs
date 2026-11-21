//! Journaled moves of verified, project-local history bundles.

use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Removal {
    Project,
    FileHistory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub file_path: Option<String>,
    pub removed_at: String,
    pub size: u64,
    pub active_size: Option<u64>,
    pub kind: Removal,
    pub purge_pending: bool,
}

#[derive(Serialize, Deserialize)]
struct Record {
    item: TrashItem,
    inventory: BTreeMap<String, Owned>,
    replacement: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Owned {
    Directory,
    File { hash: String, size: u64 },
}

#[derive(Serialize, Deserialize)]
struct Signed {
    record: Record,
    checksum: String,
}

#[derive(Serialize, Deserialize)]
enum Move {
    Archive {
        trash: String,
        project: String,
        #[serde(default)]
        directory: Option<String>,
        before: String,
        after: Option<String>,
    },
    Restore {
        trash: String,
        project: String,
        #[serde(default)]
        directory: Option<String>,
        before: Option<String>,
        after: String,
    },
}

pub fn archive_file(repo: &Repository, file: &str, confirmation: &str) -> Result<Repository> {
    archive_file_with(repo, file, confirmation, finish_move)
}

fn archive_file_with(
    repo: &Repository,
    file: &str,
    confirmation: &str,
    publish: impl FnOnce(&Container) -> Result<()>,
) -> Result<Repository> {
    let container = active_container(repo)?;
    let _location = container.lock()?;
    let _project = repo.with_write_lock()?;
    ensure_no_restore(repo)?;
    let info = project(repo.metadata())?;
    let file = record(repo.metadata(), file)?;
    if component(Path::new(&file.path))? != confirmation {
        return Err(Error::Invalid(
            "Enter the exact file name to delete its history.".into(),
        ));
    }
    let history = repo.history()?;
    if !history
        .iter()
        .flat_map(|c| &c.files)
        .any(|entry| entry.file_id.as_ref() == Some(&file.id))
    {
        return Err(Error::Invalid(
            "This file has no active history to delete.".into(),
        ));
    }
    repo.health()?;
    let id = new_id();
    let stage = working_path(&container, &id, "install")?;
    let temp = container.stage()?;
    let replacement = Repository::init_at(
        repo.root.clone(),
        temp.path().to_owned(),
        repo.id.clone(),
        VERSION,
    )?;
    let next = Project {
        generation: new_id(),
        ..info.clone()
    };
    atomic_json(&replacement.metadata.join("project.json"), &next)?;
    for known in records(repo)? {
        write_record(replacement.metadata(), &known)?;
        if known.id != file.id {
            let dir = Path::new("files").join(&known.id).join("previews");
            // Derived preview problems cannot make the history rewrite fail.
            let _ = copy_tree(&repo.metadata.join(&dir), &replacement.metadata.join(dir));
        }
    }
    let mut settings = repo.settings()?;
    settings.tracked.retain(|path| *path != file.path);
    replacement.set_settings_locked(settings)?;
    if !repo.history_compression()? {
        replacement.set_history_compression_locked(false)?;
    }
    let mut parent = None;
    let mut copied = BTreeSet::new();
    let mut has_history = false;
    for mut commit in history.into_iter().rev() {
        commit
            .files
            .retain(|entry| entry.file_id.as_ref() != Some(&file.id));
        has_history |= !commit.files.is_empty();
        for chunk in commit.files.iter().flat_map(|entry| &entry.chunks) {
            if copied.insert(chunk.clone()) {
                let from = safe_object_path(repo.metadata(), chunk)?;
                let target = replacement.metadata.join("objects").join(&chunk[..2]);
                ensure_dir(&target)?;
                copy_file(&from, &target.join(chunk))?;
            }
        }
        commit.parent = parent;
        parent = Some(replacement.write_record(commit)?.id);
    }
    if !has_history {
        replacement.write_commit(
            parent,
            Vec::new(),
            Kind::Baseline,
            "History reset",
            "File history moved to ArtLog trash",
        )?;
    }
    replacement.health()?;
    let remaining = replacement.history()?;
    if remaining
        .iter()
        .flat_map(|commit| &commit.files)
        .any(|entry| entry.file_id.as_ref() == Some(&file.id))
    {
        return Err(Error::Corrupt(
            "The replacement still contains the selected file's history.".into(),
        ));
    }
    let fingerprint = fingerprint(&replacement)?;
    let archived = prepare_record(
        &container,
        repo,
        &id,
        Some(file.path),
        Some(fingerprint),
        Some(replacement.repository_size()?),
    )?;
    move_path(temp.path(), &stage)?;
    write_move(
        &container,
        &Move::Archive {
            trash: archived.item.id,
            project: repo.id.clone(),
            directory: Some(component(repo.metadata())?.to_owned()),
            before: info.generation,
            after: Some(next.generation),
        },
    )?;
    publish(&container)?;
    container.open_active(repo.id())
}

pub fn archive_project(repo: &Repository, confirmation: &str) -> Result<()> {
    let container = active_container(repo)?;
    let _location = container.lock()?;
    let _project = repo.with_write_lock()?;
    ensure_no_restore(repo)?;
    if describes(repo)?.name != confirmation {
        return Err(Error::Invalid(
            "Enter the exact project name to remove it.".into(),
        ));
    }
    repo.health()?;
    let id = new_id();
    let archived = prepare_record(&container, repo, &id, None, None, None)?;
    write_move(
        &container,
        &Move::Archive {
            trash: archived.item.id,
            project: repo.id.clone(),
            directory: Some(component(repo.metadata())?.to_owned()),
            before: project(repo.metadata())?.generation,
            after: None,
        },
    )?;
    finish_move(&container)
}

impl Container {
    pub fn list_trash(&self) -> Result<Vec<TrashItem>> {
        let _location = self.lock()?;
        recover(self)?;
        let mut items = Vec::new();
        for dir in children(&self.dir.join("trash"))? {
            let id = component(&dir)?;
            check_uuid(id)?;
            check_directory(&dir)?;
            if !exists(&dir.join("trash.json"))? {
                continue;
            }
            let record = read_record(self, id)?;
            if exists(&dir.join("payload"))? || record.item.purge_pending {
                items.push(record.item);
            }
        }
        items.sort_by(|a, b| b.removed_at.cmp(&a.removed_at));
        Ok(items)
    }

    pub fn restore_trash(&self, id: &str) -> Result<Summary> {
        self.restore_trash_with(id, finish_move)
    }

    fn restore_trash_with(
        &self,
        id: &str,
        publish: impl FnOnce(&Container) -> Result<()>,
    ) -> Result<Summary> {
        let _location = self.lock()?;
        recover(self)?;
        let archived = read_record(self, id)?;
        if archived.item.purge_pending {
            return Err(Error::Invalid(
                "Permanent deletion was started. Finish deleting this trash item.".into(),
            ));
        }
        let payload = trash_path(self, id)?.join("payload");
        validate_inventory(&payload, &archived, false)?;
        let original = open_payload(self, &payload)?;
        ensure_no_restore(&original)?;
        let original_info = project(&payload)?;
        if original.id != archived.item.project_id || original_info.id != original.id {
            return Err(Error::Corrupt(
                "The archive belongs to a different project.".into(),
            ));
        }

        let _original_lock = self.project_lock(original.id(), true)?;
        let active = self.active_path(original.id())?;
        let mut info = original_info.clone();
        let mut previous = None;
        let mut separate = false;
        if exists(&active)? {
            let current = self.open_active(original.id())?;
            if archived.replacement.as_ref().is_some_and(|expected| {
                fingerprint(&current).is_ok_and(|actual| &actual == expected)
            }) && current.recovery_paths()?.is_empty()
            {
                previous = Some(project(&active)?.generation);
            } else {
                separate = true;
            }
        }
        if info.mode == Mode::SingleFile {
            let original_path = summary(&self.root, &payload, &info)?.path;
            separate |= self.list_locked()?.iter().any(|item| {
                item.id != info.id
                    && item
                        .path
                        .as_ref()
                        .zip(original_path.as_ref())
                        .is_some_and(|(a, b)| path_identity(a) == path_identity(b))
            });
        }
        if separate {
            previous = None;
            info.id = new_id();
            info.mode = Mode::Folder;
            info.single_file = None;
            info.name = Some(format!("Recovered {}", archived.item.project_name));
            info.recovered = true;
        }
        info.generation = new_id();
        let _new_lock = separate
            .then(|| self.project_lock(&info.id, true))
            .transpose()?;
        let temp = self.stage()?;
        copy_tree(&payload, temp.path())?;
        let format_path = temp.path().join("format.json");
        let mut format: Format = read_json(&format_path)?;
        format.repository_id.clone_from(&info.id);
        atomic_json(&format_path, &format)?;
        atomic_json(&temp.path().join("project.json"), &info)?;
        let candidate = open_payload(self, temp.path())?;
        candidate.health()?;
        let install = if previous.is_some() {
            active
        } else {
            self.available_directory(candidate.metadata(), &info)?
        };
        move_path(temp.path(), &working_path(self, id, "install")?)?;
        write_move(
            self,
            &Move::Restore {
                trash: id.to_owned(),
                project: info.id.clone(),
                directory: Some(component(&install)?.to_owned()),
                before: previous,
                after: info.generation.clone(),
            },
        )?;
        publish(self)?;
        describes(&self.open_active(&info.id)?)
    }

    pub fn purge_trash(&self, id: &str, confirmation: &str) -> Result<()> {
        if confirmation != "DELETE" {
            return Err(Error::Invalid(
                "Type DELETE to permanently delete this trash item.".into(),
            ));
        }
        let _location = self.lock()?;
        // Purge must refuse an unresolved move rather than complete it implicitly.
        if exists(&self.dir.join("move.json"))? || exists(&self.dir.join("migration.json"))? {
            return Err(Error::Invalid(
                "Resolve the interrupted history operation before permanently deleting trash."
                    .into(),
            ));
        }
        let mut record = read_record(self, id)?;
        let _project = self.project_lock(&record.item.project_id, true)?;
        let active = self.active_path(&record.item.project_id)?;
        if exists(&active)? {
            ensure_no_restore(&self.open_active(&record.item.project_id)?)?;
        }
        if !record.item.purge_pending {
            let payload = trash_path(self, id)?.join("payload");
            validate_inventory(&payload, &record, false)?;
            ensure_no_restore(&open_payload(self, &payload)?)?;
            record.item.purge_pending = true;
            write_record_file(self, &record)?;
        }
        finish_purge(self, id, &record)
    }
}

fn active_container(repo: &Repository) -> Result<Container> {
    if repo.binding.is_none() {
        return Err(Error::Invalid(
            "Reopen this project after migration to manage its history.".into(),
        ));
    }
    Container::at(repo.root())
}

fn digest(value: &impl Serialize) -> Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|e| Error::Corrupt(e.to_string()))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

fn fingerprint(repo: &Repository) -> Result<String> {
    let files = records(repo)?;
    let mut exports = BTreeMap::new();
    for file in &files {
        let previews = repo.metadata.join("files").join(&file.id).join("previews");
        if exists(&previews)? {
            for path in children(&previews)? {
                let name = component(&path)?;
                if name.ends_with("-export-v1.bin") {
                    regular(&path)?;
                    exports.insert((file.id.as_str(), name.to_owned()), hash_file(&path)?);
                }
            }
        }
    }
    digest(&(
        repo.head()?,
        repo.settings()?,
        project(repo.metadata())?,
        &files,
        exports.into_iter().collect::<Vec<_>>(),
    ))
}

fn open_payload(container: &Container, path: &Path) -> Result<Repository> {
    Repository::open_at(container.root.clone(), path.to_owned(), VERSION)
}

fn trash_path(container: &Container, id: &str) -> Result<PathBuf> {
    check_uuid(id)?;
    let dir = container.dir.join("trash");
    check_directory(&dir)?;
    Ok(dir.join(id))
}

fn working_path(container: &Container, id: &str, action: &str) -> Result<PathBuf> {
    check_uuid(id)?;
    let dir = container.dir.join("work");
    check_directory(&dir)?;
    Ok(dir.join(format!("{action}-{id}")))
}

fn prepare_record(
    container: &Container,
    repo: &Repository,
    id: &str,
    file_path: Option<String>,
    replacement: Option<String>,
    active_size: Option<u64>,
) -> Result<Record> {
    let inventory = inventory(repo.metadata())?;
    let size = inventory
        .values()
        .map(|entry| match entry {
            Owned::File { size, .. } => *size,
            Owned::Directory => 0,
        })
        .fold(0u64, u64::saturating_add);
    let record = Record {
        item: TrashItem {
            id: id.to_owned(),
            project_id: repo.id.clone(),
            project_name: describes(repo)?.name,
            kind: if file_path.is_some() {
                Removal::FileHistory
            } else {
                Removal::Project
            },
            file_path,
            size,
            active_size,
            removed_at: Utc::now().to_rfc3339(),
            purge_pending: false,
        },
        inventory,
        replacement,
    };
    ensure_dir(&trash_path(container, id)?)?;
    write_record_file(container, &record)?;
    // Reject oversized or unreadable records before starting a directory move.
    read_record(container, id)
}

fn write_record_file(container: &Container, record: &Record) -> Result<()> {
    #[derive(Serialize)]
    struct Borrowed<'a> {
        record: &'a Record,
        checksum: String,
    }
    let dir = trash_path(container, &record.item.id)?;
    check_directory(&dir)?;
    atomic_json(
        &dir.join("trash.json"),
        &Borrowed {
            record,
            checksum: digest(record)?,
        },
    )
}

fn read_record(container: &Container, id: &str) -> Result<Record> {
    let dir = trash_path(container, id)?;
    check_directory(&dir)?;
    let Signed { record, checksum } = read_json(&dir.join("trash.json"))?;
    if checksum != digest(&record)? || record.item.id != id {
        return Err(Error::Corrupt("Trash record verification failed.".into()));
    }
    check_uuid(&record.item.project_id)?;
    Ok(record)
}

fn inventory(dir: &Path) -> Result<BTreeMap<String, Owned>> {
    fn visit(dir: &Path, prefix: &str, result: &mut BTreeMap<String, Owned>) -> Result<()> {
        for path in children(dir)? {
            let name = component(&path)?;
            let key = format!("{prefix}{name}");
            validate_relative(&key)?;
            let meta = path
                .symlink_metadata()
                .map_err(|e| Error::io("inspect archived data", &path, e))?;
            if meta.is_dir() && !is_link(&meta) {
                result.insert(key.clone(), Owned::Directory);
                visit(&path, &format!("{key}/"), result)?;
            } else {
                regular(&path)?;
                let mut file =
                    open_source(&path).map_err(|e| Error::io("verify archived data", &path, e))?;
                let mut hash = blake3::Hasher::new();
                let size = io::copy(&mut file, &mut HashWriter(&mut hash))
                    .map_err(|e| Error::io("verify archived data", &path, e))?;
                result.insert(
                    key,
                    Owned::File {
                        hash: hash.finalize().to_hex().to_string(),
                        size,
                    },
                );
            }
        }
        Ok(())
    }
    let mut entries = BTreeMap::new();
    visit(dir, "", &mut entries)?;
    Ok(entries)
}

fn validate_inventory(
    payload: &Path,
    record: &Record,
    partial: bool,
) -> Result<BTreeMap<String, Owned>> {
    let actual = inventory(payload)?;
    if (!partial && actual.len() != record.inventory.len())
        || actual
            .iter()
            .any(|(name, entry)| record.inventory.get(name) != Some(entry))
    {
        return Err(Error::Corrupt(
            "Archived data differs from its recorded inventory. No unverified paths were removed."
                .into(),
        ));
    }
    if actual
        .keys()
        .any(|name| name.starts_with("staging/restore-"))
    {
        return Err(Error::Invalid(
            "This archive contains an unresolved restore recovery journal.".into(),
        ));
    }
    Ok(actual)
}

fn finish_purge(container: &Container, id: &str, record: &Record) -> Result<()> {
    let dir = trash_path(container, id)?;
    let payload = dir.join("payload");
    if exists(&payload)? {
        let actual = validate_inventory(&payload, record, true)?;
        // Parent entries sort before their children. Remove in reverse order.
        for (name, entry) in actual.into_iter().rev() {
            let path = owned_path(&payload, &name)?;
            match entry {
                Owned::Directory => {
                    check_directory(&path)?;
                    fs::remove_dir(&path)
                        .map_err(|e| Error::io("remove empty archived directory", &path, e))?;
                    sync_parent(&path)?;
                }
                Owned::File { .. } => {
                    regular(&path)?;
                    remove_file(&path)?;
                }
            }
        }
        fs::remove_dir(&payload).map_err(|e| Error::io("remove empty archive", &payload, e))?;
        sync_parent(&payload)?;
    }
    if children(&dir)? != [dir.join("trash.json")] {
        return Err(Error::Invalid(
            "Unexpected files remain in the trash item.".into(),
        ));
    }
    remove_file(&dir.join("trash.json"))?;
    fs::remove_dir(&dir).map_err(|e| Error::io("remove empty trash item", &dir, e))?;
    sync_parent(&dir)
}

fn owned_path(payload: &Path, name: &str) -> Result<PathBuf> {
    validate_relative(name)?;
    let mut path = payload.to_owned();
    check_directory(&path)?;
    let mut parts = name.split('/').peekable();
    while let Some(part) = parts.next() {
        path.push(part);
        if parts.peek().is_some() {
            check_directory(&path)?;
        }
    }
    Ok(path)
}

fn write_move(container: &Container, operation: &Move) -> Result<()> {
    let path = container.dir.join("move.json");
    if exists(&path)? {
        return Err(Error::Invalid(
            "An interrupted ArtLog move needs recovery.".into(),
        ));
    }
    atomic_json(&path, operation)
}

fn move_project(operation: &Move) -> &str {
    match operation {
        Move::Archive { project, .. } | Move::Restore { project, .. } => project,
    }
}

pub(super) fn recover(container: &Container) -> Result<()> {
    let path = container.dir.join("move.json");
    if !exists(&path)? {
        return Ok(());
    }
    let operation: Move = read_json(&path)?;
    let _project = container.project_lock(move_project(&operation), true)?;
    finish_move(container)
}

fn generation(path: &Path) -> Result<Option<String>> {
    if exists(path)? {
        return Ok(Some(project(path)?.generation));
    }
    Ok(None)
}

fn verify_generation(path: &Path, expected: &str) -> Result<()> {
    if generation(path)?.as_deref() != Some(expected) {
        return Err(Error::Corrupt(format!(
            "Interrupted history move found unexpected data at {}.",
            path.display()
        )));
    }
    Ok(())
}

fn finish_move(container: &Container) -> Result<()> {
    let journal = container.dir.join("move.json");
    let operation: Move = read_json(&journal)?;
    match operation {
        Move::Archive {
            trash,
            project: id,
            directory,
            before,
            after,
        } => {
            let record = read_record(container, &trash)?;
            if record.item.project_id != id
                || record.item.purge_pending
                || after.is_some() != record.replacement.is_some()
            {
                return Err(Error::Corrupt(
                    "History move does not match its trash record.".into(),
                ));
            }
            let active = container.project_directory(directory.as_deref().unwrap_or(&id))?;
            let payload = trash_path(container, &trash)?.join("payload");
            let stage = working_path(container, &trash, "install")?;
            if let Some(expected) = &after {
                let candidate = if exists(&stage)? { &stage } else { &active };
                verify_generation(candidate, expected)?;
                let verified = open_payload(container, candidate)?;
                if verified.id != id
                    || fingerprint(&verified)?
                        != *record.replacement.as_ref().expect("verified archive kind")
                {
                    return Err(Error::Corrupt(
                        "The staged project differs from the verified replacement.".into(),
                    ));
                }
                verified.health()?;
            }
            if !exists(&payload)? {
                verify_generation(&active, &before)?;
                validate_inventory(&active, &record, false)?;
                move_path(&active, &payload)?;
            }
            verify_generation(&payload, &before)?;
            validate_inventory(&payload, &record, false)?;
            if let Some(expected) = &after {
                if !exists(&active)? {
                    verify_generation(&stage, expected)?;
                    move_path(&stage, &active)?;
                }
                verify_generation(&active, expected)?;
            } else if exists(&active)? {
                return Err(Error::Corrupt(
                    "An unexpected project occupies the removed project's location.".into(),
                ));
            }
        }
        Move::Restore {
            trash,
            project: id,
            directory,
            before,
            after,
        } => {
            let active = container.project_directory(directory.as_deref().unwrap_or(&id))?;
            let stage = working_path(container, &trash, "install")?;
            let displaced = working_path(container, &trash, "displaced")?;
            if generation(&active)?.as_deref() != Some(&after) {
                verify_generation(&stage, &after)?;
                let candidate = open_payload(container, &stage)?;
                if candidate.id != id {
                    return Err(Error::Corrupt(
                        "The staged project identity differs from the restore journal.".into(),
                    ));
                }
                candidate.health()?;
                if let Some(expected) = &before {
                    if !exists(&displaced)? {
                        verify_generation(&active, expected)?;
                        move_path(&active, &displaced)?;
                    }
                }
                move_path(&stage, &active)?;
            }
            verify_generation(&active, &after)?;
            open_payload(container, &active)?.health()?;
            if exists(&displaced)? {
                remove_tree(&displaced)?;
            }
            let dir = trash_path(container, &trash)?;
            if exists(&dir.join("trash.json"))? {
                let mut record = read_record(container, &trash)?;
                if !record.item.purge_pending {
                    record.item.purge_pending = true;
                    write_record_file(container, &record)?;
                }
                finish_purge(container, &trash, &record)?;
            }
        }
    }
    remove_file(&journal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Container, Repository) {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.clip"), b"keep working a").unwrap();
        fs::write(root.path().join("b.clip"), b"keep working b").unwrap();
        let container = Container::create(root.path()).unwrap();
        let repo = container.open_or_create_single("a.clip").unwrap();
        (root, container, repo)
    }

    fn interrupted<T>() -> Result<T> {
        Err(Error::Invalid("simulated interruption".into()))
    }

    #[test]
    fn resumes_file_history_removal_at_each_move_boundary() {
        for boundary in 0..=2 {
            let (root, container, repo) = fixture();
            let head = repo.history().unwrap().remove(0);
            let file_id = head.files[0].file_id.as_ref().unwrap();
            let result = archive_file_with(&repo, file_id, "a.clip", |container| {
                let Move::Archive { trash, project, .. } =
                    read_json(&container.dir.join("move.json"))?
                else {
                    panic!("unexpected journal kind");
                };
                let active = container.active_path(&project)?;
                let payload = trash_path(container, &trash)?.join("payload");
                if boundary >= 1 {
                    move_path(&active, &payload)?;
                }
                if boundary >= 2 {
                    move_path(&working_path(container, &trash, "install")?, &active)?;
                }
                interrupted()
            });
            assert!(result.is_err());
            assert!(repo.capture(Kind::Checkpoint, "blocked", "").is_err());
            let operation: Move = read_json(&container.dir.join("move.json")).unwrap();
            let Move::Archive { trash, .. } = operation else {
                panic!("unexpected journal kind")
            };
            assert!(Container::for_purge(root.path())
                .unwrap()
                .purge_trash(&trash, "DELETE")
                .is_err());

            let reopened = Container::discover(root.path()).unwrap().unwrap();
            let active = reopened.open(repo.id()).unwrap();
            assert!(active.metadata().ends_with(".artlog/projects/a.clip"));
            assert!(active
                .history()
                .unwrap()
                .iter()
                .all(|commit| commit.files.is_empty()));
            assert_eq!(reopened.list_trash().unwrap()[0].id, trash);
            assert_eq!(
                fs::read(root.path().join("a.clip")).unwrap(),
                b"keep working a"
            );
            assert_eq!(
                fs::read(root.path().join("b.clip")).unwrap(),
                b"keep working b"
            );
        }
    }

    #[test]
    fn resumes_restore_after_displacement_and_after_install() {
        for boundary in 0..=2 {
            let (root, container, repo) = fixture();
            let before = repo.history().unwrap();
            let file_id = before[0].files[0].file_id.as_ref().unwrap();
            let active = archive_file(&repo, file_id, "a.clip").unwrap();
            let trash = &container.list_trash().unwrap()[0].id;
            let result = container.restore_trash_with(trash, |container| {
                if boundary >= 1 {
                    move_path(
                        active.metadata(),
                        &working_path(container, trash, "displaced")?,
                    )?;
                }
                if boundary >= 2 {
                    move_path(
                        &working_path(container, trash, "install")?,
                        active.metadata(),
                    )?;
                }
                interrupted()
            });
            assert!(result.is_err());
            let reopened = Container::discover(root.path()).unwrap().unwrap();
            assert_eq!(reopened.open(repo.id()).unwrap().history().unwrap(), before);
            assert!(reopened.list_trash().unwrap().is_empty());
            assert_eq!(
                fs::read(root.path().join("a.clip")).unwrap(),
                b"keep working a"
            );
        }
    }

    #[test]
    fn purge_checks_confirmation_inventory_recovery_and_partial_progress() {
        let (root, container, repo) = fixture();
        let head = repo.history().unwrap().remove(0);
        let active =
            archive_file(&repo, head.files[0].file_id.as_ref().unwrap(), "a.clip").unwrap();
        let trash = &container.list_trash().unwrap()[0].id;
        let payload = trash_path(&container, trash).unwrap().join("payload");
        let extra = payload.join("unknown.txt");
        let recovery = active.metadata.join("staging/restore-pending");
        fs::create_dir(&recovery).unwrap();
        assert!(container.purge_trash(trash, "DELETE").is_err());
        fs::remove_dir(recovery).unwrap();
        assert!(container.purge_trash(trash, "delete").is_err());
        assert!(container.purge_trash("../projects", "DELETE").is_err());
        fs::write(&extra, b"not inventoried").unwrap();
        assert!(container.purge_trash(trash, "DELETE").is_err());
        assert!(extra.is_file());
        fs::remove_file(extra).unwrap();
        let mut record = read_record(&container, trash).unwrap();
        record.item.purge_pending = true;
        write_record_file(&container, &record).unwrap();
        fs::remove_file(payload.join("HEAD")).unwrap();
        assert!(container.restore_trash(trash).is_err());
        assert!(container.list_trash().unwrap()[0].purge_pending);
        container.purge_trash(trash, "DELETE").unwrap();
        assert!(container.list_trash().unwrap().is_empty());
        assert_eq!(active.health().unwrap().objects, 0);
        assert_eq!(
            fs::read(root.path().join("a.clip")).unwrap(),
            b"keep working a"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_purge_refuses_directory_junctions() {
        let (root, container, repo) = fixture();
        trash::archive_project(&repo, &describes(&repo).unwrap().name).unwrap();
        let trash = &container.list_trash().unwrap()[0].id;
        let payload = trash_path(&container, trash).unwrap().join("payload");
        let junction = payload.join("staging");
        fs::remove_dir(&junction).unwrap();
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:ARTLOG_TEST_JUNCTION -Target $env:ARTLOG_TEST_OUTSIDE | Out-Null"])
            .env("ARTLOG_TEST_JUNCTION", &junction)
            .env("ARTLOG_TEST_OUTSIDE", root.path())
            .status().unwrap();
        assert!(status.success());
        assert!(container.purge_trash(trash, "DELETE").is_err());
        assert_eq!(
            fs::read(root.path().join("a.clip")).unwrap(),
            b"keep working a"
        );
        fs::remove_dir(junction).unwrap();
    }
}
