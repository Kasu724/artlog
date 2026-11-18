use chrono::Utc;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};
const FORMAT_VERSION: u32 = 1;
const CHUNK_MIN: usize = 256 * 1024;
const CHUNK_AVG: usize = 1024 * 1024;
const CHUNK_MAX: usize = 4 * 1024 * 1024;
const CHUNK_MASK: u64 = CHUNK_AVG as u64 - 1;
const CAPTURE_ATTEMPTS: usize = 5;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not {action} '{path}': {source}")]
    Io {
        action: String,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{0}")]
    Invalid(String),
    #[error("repository data is corrupted: {0}")]
    Corrupt(String),
    #[error("file changed while it was being captured: {0}")]
    Unstable(String),
    #[error("repository is being modified by another ArtLog process")]
    Busy,
}
impl Error {
    pub fn io(action: impl Into<String>, path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            action: action.into(),
            path: path.into(),
            source,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub tracked: Vec<String>,
    pub auto_capture: bool,
    pub debounce_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub path: String,
    pub size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub hash: String,
    pub chunks: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Baseline,
    Auto,
    Checkpoint,
    Safety,
    Restore,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub id: String,
    pub parent: Option<String>,
    pub timestamp: String,
    pub title: String,
    pub note: String,
    pub kind: Kind,
    pub manifest_id: String,
    #[serde(default)]
    pub files: Vec<Entry>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub versions: usize,
    pub objects: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Format {
    format_version: u32,
    repository_id: String,
    app_version: String,
}
pub struct Repository {
    root: PathBuf,
    metadata: PathBuf,
    id: String,
}
impl Repository {
    pub fn init(root: &Path, tracked: Vec<String>) -> Result<Self> {
        let root = canonical_root(root)?;
        let metadata = root.join(".artlog");
        if fs::symlink_metadata(&metadata).is_ok() {
            return Err(Error::Invalid(
                ".artlog already exists or is not accessible".into(),
            ));
        }
        let mut settings = Settings {
            tracked,
            auto_capture: true,
            debounce_ms: 1200,
        };
        normalize_tracking_settings(&mut settings)?;
        fs::create_dir(&metadata)
            .map_err(|e| Error::io("create repository directory", &metadata, e))?;
        for name in ["commits", "manifests", "objects", "staging", "refs/heads"] {
            fs::create_dir_all(metadata.join(name))
                .map_err(|e| Error::io("create repository directory", metadata.join(name), e))?;
        }
        let id = uuid::Uuid::new_v4().to_string();
        atomic_json(
            &metadata.join("format.json"),
            &Format {
                format_version: FORMAT_VERSION,
                repository_id: id.clone(),
                app_version: env!("CARGO_PKG_VERSION").into(),
            },
        )?;
        atomic_json(&metadata.join("config.json"), &settings)?;
        atomic_write(&metadata.join("HEAD"), b"main\n")?;
        atomic_write(&metadata.join("refs/heads/main"), b"\n")?;
        let repo = Self { root, metadata, id };
        let _ = repo.capture(
            Kind::Baseline,
            "Project created",
            "Initial project snapshot",
        )?;
        Ok(repo)
    }
    pub fn open(root: &Path) -> Result<Self> {
        let root = canonical_root(root)?;
        let metadata = root.join(".artlog");
        check_directory(&metadata)?;
        let format: Format = read_json(&metadata.join("format.json"))?;
        if format.format_version != FORMAT_VERSION {
            return Err(Error::Invalid(format!(
                "repository format {} is unsupported (expected {})",
                format.format_version, FORMAT_VERSION
            )));
        }
        if uuid::Uuid::parse_str(&format.repository_id).is_err() {
            return Err(Error::Corrupt("invalid repository id".into()));
        }
        check_directory(&metadata.join("commits"))?;
        check_directory(&metadata.join("manifests"))?;
        check_directory(&metadata.join("objects"))?;
        check_directory(&metadata.join("staging"))?;
        check_directory(&metadata.join("refs"))?;
        check_directory(&metadata.join("refs/heads"))?;
        let repo = Self {
            root,
            metadata,
            id: format.repository_id,
        };
        repo.settings()?;
        repo.verify_head()?;
        Ok(repo)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn metadata(&self) -> &Path {
        &self.metadata
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn settings(&self) -> Result<Settings> {
        let mut s: Settings = read_json(&self.metadata.join("config.json"))?;
        let mut normalized = s.clone();
        normalize_settings(&mut normalized)?;
        if normalized.tracked != s.tracked {
            return Err(Error::Corrupt(
                "tracked paths are duplicated or unsorted".into(),
            ));
        }
        // Older projects may track other formats. Preserve the saved config
        // until the user changes settings and keep those files in history.
        s.tracked.retain(|path| is_clip_document(Path::new(path)));
        Ok(s)
    }
    pub fn set_settings(&self, mut settings: Settings) -> Result<()> {
        normalize_tracking_settings(&mut settings)?;
        let _guard = self.with_write_lock()?;
        atomic_json(&self.metadata.join("config.json"), &settings)
    }
    pub fn scan(root: &Path) -> Result<Vec<ScanEntry>> {
        let root = canonical_root(root)?;
        let mut out = Vec::new();
        scan_dir(&root, &root, &mut out)?;
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }
    pub fn history(&self) -> Result<Vec<Commit>> {
        let mut commits = Vec::new();
        let mut cursor = self.head()?;
        let mut seen = std::collections::HashSet::new();
        while let Some(id) = cursor {
            if !seen.insert(id.clone()) {
                return Err(Error::Corrupt("cycle in main history".into()));
            }
            let commit = self.commit(&id)?;
            cursor = commit.parent.clone();
            commits.push(commit);
        }
        Ok(commits)
    }
    pub fn commit(&self, id: &str) -> Result<Commit> {
        valid_id(id)?;
        check_directory(&self.metadata)?;
        check_directory(&self.metadata.join("commits"))?;
        check_directory(&self.metadata.join("manifests"))?;
        let mut c: Commit = read_json(&self.metadata.join("commits").join(format!("{id}.json")))?;
        valid_id(&c.manifest_id)?;
        if c.id != id || c.parent.as_deref().is_some_and(|p| valid_id(p).is_err()) {
            return Err(Error::Corrupt(format!(
                "invalid commit identity or parent: {id}"
            )));
        }
        chrono::DateTime::parse_from_rfc3339(&c.timestamp)
            .map_err(|_| Error::Corrupt(format!("invalid timestamp in commit {id}")))?;
        let manifest: Vec<Entry> = read_json(
            &self
                .metadata
                .join("manifests")
                .join(format!("{}.json", c.manifest_id)),
        )?;
        if !c.files.is_empty() && manifest != c.files {
            return Err(Error::Corrupt(format!("commit manifest differs for {id}")));
        }
        let bytes = serde_json::to_vec(&manifest).map_err(|e| Error::Corrupt(e.to_string()))?;
        if blake3::hash(&bytes).to_hex().as_str() != c.manifest_id {
            return Err(Error::Corrupt(format!(
                "manifest hash mismatch in commit {id}"
            )));
        }
        c.files = manifest;
        if commit_digest(&c)? != id {
            return Err(Error::Corrupt(format!("commit hash mismatch: {id}")));
        }
        let mut paths = std::collections::HashSet::new();
        for entry in &c.files {
            validate_relative(&entry.path)?;
            valid_id(&entry.hash)?;
            if entry.chunks.is_empty() && entry.size != 0 {
                return Err(Error::Corrupt(format!("missing chunks for {}", entry.path)));
            }
            for cid in &entry.chunks {
                valid_id(cid)?;
            }
            if !paths.insert(path_identity(&entry.path)) {
                return Err(Error::Corrupt(format!(
                    "duplicate manifest path {}",
                    entry.path
                )));
            }
        }
        Ok(c)
    }
    pub fn capture(&self, kind: Kind, title: &str, note: &str) -> Result<Option<Commit>> {
        let _guard = self.with_write_lock()?;
        if matches!(kind, Kind::Auto | Kind::Checkpoint) && !self.recovery_paths()?.is_empty() {
            return Err(Error::Invalid("A previous restore needs attention. Review the recovery folder in .artlog/staging before capturing another version.".into()));
        }
        self.capture_locked(kind, title, note)
    }
    pub fn with_write_lock(&self) -> Result<WriteGuard> {
        check_directory(&self.metadata)?;
        let path = self.metadata.join("write.lock");
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.is_file() || is_link(&meta) {
                return Err(Error::Corrupt("unsafe repository lock file".into()));
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| Error::io("open repository lock", &path, e))?;
        file.try_lock_exclusive().map_err(|e| {
            if e.kind() == io::ErrorKind::WouldBlock
                || e.raw_os_error()
                    .is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error())
            {
                Error::Busy
            } else {
                Error::io("lock repository", &path, e)
            }
        })?;
        Ok(WriteGuard(file))
    }
    pub(crate) fn capture_locked(
        &self,
        kind: Kind,
        title: &str,
        note: &str,
    ) -> Result<Option<Commit>> {
        let settings = self.settings()?;
        let parent = self.head()?;
        let mut files = Vec::new();
        for rel in &settings.tracked {
            let source = self.source_path(rel)?;
            match fs::symlink_metadata(&source) {
                Ok(m) if m.is_file() && !is_link(&m) => {}
                Ok(_) => {
                    return Err(Error::Invalid(format!(
                        "tracked path is not a regular file: {rel}"
                    )))
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(Error::io("inspect tracked file", &source, e)),
            }
            let entry = self.capture_entry(rel, &source)?;
            files.push(entry);
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let latest = match parent.as_deref() {
            Some(id) => Some(self.commit(id)?),
            None => None,
        };
        if kind == Kind::Auto
            && latest.as_ref().is_some_and(|commit| {
                commit
                    .files
                    .iter()
                    .filter(|entry| is_clip_document(Path::new(&entry.path)))
                    .eq(&files)
            })
        {
            return Ok(None);
        }
        if kind == Kind::Auto && title.trim().is_empty() {
            let old = latest
                .as_ref()
                .map(|c| {
                    c.files
                        .iter()
                        .map(|f| (&f.path, &f.hash))
                        .collect::<std::collections::HashMap<_, _>>()
                })
                .unwrap_or_default();
            let changed: Vec<_> = files
                .iter()
                .filter(|f| old.get(&f.path).copied() != Some(&f.hash))
                .map(|f| f.path.as_str())
                .take(3)
                .collect();
            let t = if changed.is_empty() {
                "Project files changed".to_owned()
            } else {
                format!("Saved {}", changed.join(", "))
            };
            return self.write_commit(parent, files, kind, &t, note);
        }
        self.write_commit(parent, files, kind, title, note)
    }
    pub fn entry(&self, id: &str, path: &str) -> Result<Entry> {
        let c = self.commit(id)?;
        c.files
            .into_iter()
            .find(|e| e.path == path)
            .ok_or_else(|| Error::Invalid(format!("{path} is not present in version {id}")))
    }
    pub fn reconstruct(&self, entry: &Entry, output: &mut impl Write) -> Result<()> {
        validate_relative(&entry.path)?;
        let mut full = blake3::Hasher::new();
        let mut length = 0u64;
        for cid in &entry.chunks {
            valid_id(cid)?;
            let path = safe_object_path(&self.metadata, cid)?;
            let meta = fs::symlink_metadata(&path)
                .map_err(|e| Error::io("read stored object", &path, e))?;
            if !meta.is_file() || is_link(&meta) || meta.len() as usize > CHUNK_MAX {
                return Err(Error::Corrupt(format!("unsafe or oversized object: {cid}")));
            }
            let mut f = File::open(&path).map_err(|e| Error::io("read stored object", &path, e))?;
            let mut bytes = Vec::with_capacity(meta.len() as usize);
            f.read_to_end(&mut bytes)
                .map_err(|e| Error::io("read stored object", &path, e))?;
            if blake3::hash(&bytes).to_hex().as_str() != cid {
                return Err(Error::Corrupt(format!("object hash mismatch: {cid}")));
            }
            full.update(&bytes);
            length += bytes.len() as u64;
            output
                .write_all(&bytes)
                .map_err(|e| Error::io("write reconstructed file", &entry.path, e))?;
        }
        if length != entry.size || full.finalize().to_hex().as_str() != entry.hash {
            return Err(Error::Corrupt(format!(
                "file verification failed: {}",
                entry.path
            )));
        }
        Ok(())
    }
    pub fn source_path(&self, path: &str) -> Result<PathBuf> {
        validate_relative(path)?;
        let mut cur = self.root.clone();
        check_directory(&cur)?;
        let mut found = true;
        let mut components = path.split('/').peekable();
        while let Some(component) = components.next() {
            cur.push(component);
            if !found {
                continue;
            }
            match fs::symlink_metadata(&cur) {
                Ok(m) if is_link(&m) => {
                    return Err(Error::Invalid(format!(
                        "symlinks and reparse points are not tracked: {path}"
                    )))
                }
                Ok(m) if components.peek().is_some() && !m.is_dir() => {
                    return Err(Error::Invalid(format!(
                        "parent component is not a directory: {path}"
                    )))
                }
                Ok(m) if components.peek().is_none() && !m.is_file() => {
                    return Err(Error::Invalid(format!(
                        "Tracked path is not a regular file: {path}"
                    )))
                }
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => found = false,
                Err(e) => return Err(Error::io("inspect project path", &cur, e)),
            }
        }
        Ok(cur)
    }
    pub fn hash_file(path: &Path) -> Result<String> {
        hash_file(path)
    }
    pub fn repository_size(&self) -> Result<u64> {
        let mut sum = 0;
        walk_size(&self.metadata, &mut sum)?;
        Ok(sum)
    }
    pub fn health(&self) -> Result<Health> {
        let history = self.history()?;
        let mut objects = std::collections::HashSet::new();
        let mut files = std::collections::HashSet::new();
        for c in &history {
            for e in &c.files {
                if files.insert((&e.hash, e.size, &e.chunks)) {
                    self.reconstruct(e, &mut io::sink())?;
                }
                objects.extend(&e.chunks);
            }
        }
        Ok(Health {
            versions: history.len(),
            objects: objects.len(),
        })
    }
    pub fn recovery_paths(&self) -> Result<Vec<String>> {
        let d = self.staging()?;
        let mut out = Vec::new();
        for e in fs::read_dir(&d).map_err(|e| Error::io("inspect recovery staging", &d, e))? {
            let e = e.map_err(|e| Error::io("inspect recovery staging", &d, e))?;
            if e.file_type()
                .map_err(|e| Error::io("inspect recovery item", &d, e))?
                .is_dir()
                && e.file_name().to_string_lossy().starts_with("restore-")
            {
                out.push(e.file_name().to_string_lossy().into_owned());
            }
        }
        out.sort();
        Ok(out)
    }
    pub(crate) fn staging(&self) -> Result<PathBuf> {
        let path = self.metadata.join("staging");
        check_directory(&path)?;
        Ok(path)
    }
    pub fn staging_path(&self, name: &str) -> Result<PathBuf> {
        if name.is_empty()
            || name.contains("..")
            || name.contains('/')
            || name.contains('\\')
            || !name.starts_with("restore-")
        {
            return Err(Error::Invalid("unsafe recovery staging name".into()));
        }
        let staging = self.metadata.join("staging");
        check_directory(&staging)?;
        let path = staging.join(name);
        if let Ok(m) = fs::symlink_metadata(&path) {
            if !m.is_dir() || is_link(&m) {
                return Err(Error::Invalid("unsafe recovery staging path".into()));
            }
        }
        Ok(path)
    }
    pub fn verify_head(&self) -> Result<()> {
        let _ = self.history()?;
        Ok(())
    }
    pub fn head(&self) -> Result<Option<String>> {
        check_directory(&self.metadata)?;
        check_directory(&self.metadata.join("refs"))?;
        check_directory(&self.metadata.join("refs/heads"))?;
        let refname = read_ref(&self.metadata.join("HEAD"))?;
        let line = refname.trim();
        if line != "main" {
            return Err(Error::Corrupt("HEAD must name main".into()));
        }
        let path = self.metadata.join("refs/heads/main");
        let id = read_ref(&path)?;
        let id = id.trim();
        if id.is_empty() {
            Ok(None)
        } else {
            valid_id(id)?;
            Ok(Some(id.to_owned()))
        }
    }
    fn capture_entry(&self, rel: &str, source: &Path) -> Result<Entry> {
        let mut last = None;
        for _ in 0..CAPTURE_ATTEMPTS {
            match self.capture_entry_once(rel, source) {
                Ok(x) => return Ok(x),
                Err(e @ Error::Unstable(_)) => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| Error::Unstable(rel.to_owned())))
    }
    fn capture_entry_once(&self, rel: &str, source: &Path) -> Result<Entry> {
        let before =
            fs::symlink_metadata(source).map_err(|e| Error::io("inspect source", source, e))?;
        if !before.is_file() || is_link(&before) {
            return Err(Error::Invalid(format!(
                "tracked path is not a regular file: {rel}"
            )));
        }
        let input = open_source(source)
            .map_err(|e| Error::io("read source without following links", source, e))?;
        let opened = input
            .metadata()
            .map_err(|e| Error::io("inspect opened source", source, e))?;
        let modified = opened.modified().ok();
        let original_size = opened.len();
        // Keep the candidate snapshot in repository-local staging until a second source pass
        // proves the bytes stable. tempfile::tempfile_in is anonymous where the platform allows.
        let staging = self.staging()?;
        let mut staged = tempfile::tempfile_in(&staging)
            .map_err(|e| Error::io("create capture staging file", &staging, e))?;
        let mut full_hash = blake3::Hasher::new();
        let copied = {
            let mut tee = HashingWriter {
                output: &mut staged,
                hasher: &mut full_hash,
            };
            io::copy(&mut input.take(original_size.saturating_add(1)), &mut tee)
                .map_err(|e| Error::io("copy source to capture staging", source, e))?
        };
        staged
            .sync_all()
            .map_err(|e| Error::io("flush capture staging", &staging, e))?;
        if copied != original_size {
            return Err(Error::Unstable(rel.into()));
        }
        let after_first =
            fs::symlink_metadata(source).map_err(|e| Error::io("recheck source", source, e))?;
        if !after_first.is_file()
            || is_link(&after_first)
            || after_first.len() != original_size
            || modified != after_first.modified().ok()
        {
            return Err(Error::Unstable(rel.into()));
        }
        let second = open_source(source)
            .map_err(|e| Error::io("verify stable source without following links", source, e))?;
        let second_meta = second
            .metadata()
            .map_err(|e| Error::io("inspect source during verification", source, e))?;
        if second_meta.len() != original_size || second_meta.modified().ok() != modified {
            return Err(Error::Unstable(rel.into()));
        }
        let mut verify_hash = blake3::Hasher::new();
        let verified_size = io::copy(
            &mut second.take(original_size.saturating_add(1)),
            &mut HashWriter(&mut verify_hash),
        )
        .map_err(|e| Error::io("verify stable source", source, e))?;
        let after_second =
            fs::symlink_metadata(source).map_err(|e| Error::io("recheck source", source, e))?;
        let hash = full_hash.finalize().to_hex().to_string();
        if verified_size != original_size
            || verify_hash.finalize().to_hex().as_str() != hash
            || !after_second.is_file()
            || is_link(&after_second)
            || after_second.len() != original_size
            || after_second.modified().ok() != modified
        {
            return Err(Error::Unstable(rel.into()));
        }
        staged
            .seek(SeekFrom::Start(0))
            .map_err(|e| Error::io("read capture staging", &staging, e))?;
        let mut chunks = Vec::new();
        let mut chunk = Vec::with_capacity(CHUNK_MAX);
        let mut rolling = 0u64;
        let mut io_buffer = [0u8; 64 * 1024];
        loop {
            let n = staged
                .read(&mut io_buffer)
                .map_err(|e| Error::io("read capture staging", &staging, e))?;
            if n == 0 {
                break;
            }
            for byte in &io_buffer[..n] {
                chunk.push(*byte);
                rolling = rolling.rotate_left(1).wrapping_add(gear(*byte));
                let size = chunk.len();
                if size >= CHUNK_MIN && ((rolling & CHUNK_MASK) == 0 || size >= CHUNK_MAX) {
                    let id = blake3::hash(&chunk).to_hex().to_string();
                    self.store_object(&id, &chunk)?;
                    chunks.push(id);
                    chunk.clear();
                    rolling = 0;
                }
            }
        }
        if !chunk.is_empty() {
            let id = blake3::hash(&chunk).to_hex().to_string();
            self.store_object(&id, &chunk)?;
            chunks.push(id);
        }
        let entry = Entry {
            path: rel.into(),
            size: original_size,
            hash,
            chunks,
        };
        // Derive from the verified staging file, before it is discarded.
        // Preview errors are independent from the exact-byte snapshot.
        let _ = formats::cache_embedded(self, &entry, &mut staged);
        Ok(entry)
    }
    fn store_object(&self, id: &str, data: &[u8]) -> Result<()> {
        valid_id(id)?;
        if blake3::hash(data).to_hex().as_str() != id {
            return Err(Error::Corrupt(
                "refusing to store object under the wrong hash".into(),
            ));
        }
        let d = self.metadata.join("objects").join(&id[..2]);
        if !d.exists() {
            fs::create_dir(&d)
                .or_else(|e| {
                    if e.kind() == io::ErrorKind::AlreadyExists {
                        Ok(())
                    } else {
                        Err(e)
                    }
                })
                .map_err(|e| Error::io("create object directory", &d, e))?;
        }
        check_directory(&d)?;
        let p = d.join(id);
        match fs::symlink_metadata(&p) {
            Ok(m) if !m.is_file() || is_link(&m) => {
                return Err(Error::Corrupt(format!("unsafe stored object: {id}")))
            }
            Ok(_) => {
                if hash_file(&p)? != id {
                    return Err(Error::Corrupt(format!("existing object is corrupt: {id}")));
                }
                return Ok(());
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::io("inspect stored object", &p, e)),
        }
        atomic_write(&p, data)
    }
    fn write_commit(
        &self,
        parent: Option<String>,
        files: Vec<Entry>,
        kind: Kind,
        title: &str,
        note: &str,
    ) -> Result<Option<Commit>> {
        let manifest_bytes =
            serde_json::to_vec(&files).map_err(|e| Error::Corrupt(e.to_string()))?;
        let manifest_id = blake3::hash(&manifest_bytes).to_hex().to_string();
        let manifest_path = self
            .metadata
            .join("manifests")
            .join(format!("{manifest_id}.json"));
        match manifest_path.symlink_metadata() {
            Ok(_) => {
                if read_json::<Vec<Entry>>(&manifest_path)? != files {
                    return Err(Error::Corrupt(format!(
                        "Stored manifest is invalid: {manifest_id}"
                    )));
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                atomic_write(&manifest_path, &manifest_bytes)?;
            }
            Err(err) => return Err(Error::io("inspect stored manifest", &manifest_path, err)),
        }
        let timestamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let title = if title.trim().is_empty() {
            match kind {
                Kind::Auto => "Saved project files",
                Kind::Baseline => "Project created",
                Kind::Checkpoint => "Checkpoint",
                Kind::Safety => "Safety snapshot",
                Kind::Restore => "Restored version",
            }
            .to_owned()
        } else {
            title.trim().into()
        };
        let mut c = Commit {
            id: String::new(),
            parent,
            timestamp,
            title,
            note: note.trim().into(),
            kind,
            manifest_id,
            files,
        };
        let id = commit_digest(&c)?;
        c.id = id.clone();
        let mut record = serde_json::to_value(&c).map_err(|e| Error::Corrupt(e.to_string()))?;
        // Store file lists once, under their manifest hash. The commit digest
        // still covers the resolved list and accepts earlier format-1 records.
        record
            .as_object_mut()
            .expect("commit record is an object")
            .remove("files");
        atomic_json(
            &self.metadata.join("commits").join(format!("{id}.json")),
            &record,
        )?;
        atomic_write(
            &self.metadata.join("refs/heads/main"),
            format!("{id}\n").as_bytes(),
        )?;
        Ok(Some(c))
    }
}
pub struct WriteGuard(File);
impl Drop for WriteGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
pub fn hash_file(path: &Path) -> Result<String> {
    let mut f = open_source(path).map_err(|e| Error::io("hash file", path, e))?;
    let mut h = blake3::Hasher::new();
    io::copy(&mut f, &mut HashWriter(&mut h)).map_err(|e| Error::io("hash file", path, e))?;
    Ok(h.finalize().to_hex().to_string())
}
struct HashingWriter<'a, W> {
    output: &'a mut W,
    hasher: &'a mut blake3::Hasher,
}
impl<W: Write> Write for HashingWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.output.write(bytes)?;
        self.hasher.update(&bytes[..written]);
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}
struct HashWriter<'a>(&'a mut blake3::Hasher);
impl Write for HashWriter<'_> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.update(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn open_source(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "source is not a regular file",
        ));
    }
    Ok(file)
}
fn canonical_root(path: &Path) -> Result<PathBuf> {
    let md =
        fs::symlink_metadata(path).map_err(|e| Error::io("inspect project folder", path, e))?;
    if !md.is_dir() || is_link(&md) {
        return Err(Error::Invalid(
            "project folder must be a real directory".into(),
        ));
    }
    fs::canonicalize(path).map_err(|e| Error::io("open project folder", path, e))
}
fn check_directory(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path).map_err(|e| Error::io("inspect repository", path, e))?;
    if !m.is_dir() || is_link(&m) {
        return Err(Error::Corrupt(format!(
            "repository directory is missing or unsafe: {}",
            path.display()
        )));
    }
    Ok(())
}
#[cfg(windows)]
fn is_link(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & 0x400 != 0
}
#[cfg(not(windows))]
fn is_link(m: &fs::Metadata) -> bool {
    m.file_type().is_symlink()
}
pub fn is_clip_document(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("clip"))
}

fn normalize_tracking_settings(settings: &mut Settings) -> Result<()> {
    normalize_settings(settings)?;
    if let Some(path) = settings
        .tracked
        .iter()
        .find(|path| !is_clip_document(Path::new(path)))
    {
        return Err(Error::Invalid(format!(
            "ArtLog only tracks Clip Studio Paint (.clip) files: {path}"
        )));
    }
    Ok(())
}

fn normalize_settings(settings: &mut Settings) -> Result<()> {
    if !(250..=10_000).contains(&settings.debounce_ms) {
        return Err(Error::Invalid(
            "debounce interval must be between 250 and 10000 milliseconds".into(),
        ));
    }
    for path in &settings.tracked {
        validate_relative(path)?;
    }
    settings.tracked.sort_by_key(|path| path_identity(path));
    settings
        .tracked
        .dedup_by(|a, b| path_identity(a) == path_identity(b));
    Ok(())
}
fn validate_relative(p: &str) -> Result<()> {
    if p.trim().is_empty()
        || p.starts_with('/')
        || p.starts_with('\\')
        || p.contains(':')
        || p.contains('\0')
        || p.contains('\\')
    {
        return Err(Error::Invalid(format!("unsafe project path: {p}")));
    }
    for c in Path::new(p).components() {
        if !matches!(c, Component::Normal(_)) {
            return Err(Error::Invalid(format!("unsafe project path: {p}")));
        }
    }
    for component in p.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with('.')
            || component.ends_with(' ')
        {
            return Err(Error::Invalid(format!("unsafe project path: {p}")));
        }
        if component
            .chars()
            .any(|c| c.is_control() || "<>\"|?*".contains(c))
        {
            return Err(Error::Invalid(format!("unsafe Windows path: {p}")));
        }
        let lower = component.to_ascii_lowercase();
        if matches!(lower.as_str(), ".artlog" | ".git")
            || lower.starts_with(".artlog-restore-")
            || lower.starts_with(".artlog-staged-")
        {
            return Err(Error::Invalid(format!("reserved ArtLog path: {p}")));
        }
        let stem = lower.split('.').next().unwrap_or("");
        let device = matches!(stem, "con" | "prn" | "aux" | "nul" | "conin$" | "conout$")
            || ["com", "lpt"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2"
                            | "3"
                            | "4"
                            | "5"
                            | "6"
                            | "7"
                            | "8"
                            | "9"
                            | "\u{00b9}"
                            | "\u{00b2}"
                            | "\u{00b3}"
                    )
                })
            });
        if device {
            return Err(Error::Invalid(format!("reserved Windows filename: {p}")));
        }
    }
    Ok(())
}
fn valid_id(id: &str) -> Result<()> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(Error::Corrupt(format!(
            "invalid object or manifest id: {id}"
        )));
    }
    Ok(())
}
fn safe_object_path(metadata: &Path, id: &str) -> Result<PathBuf> {
    valid_id(id)?;
    check_directory(&metadata.join("objects"))?;
    let parent = metadata.join("objects").join(&id[..2]);
    check_directory(&parent)?;
    Ok(parent.join(id))
}
fn path_identity(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}
fn commit_digest(commit: &Commit) -> Result<String> {
    let mut canonical = commit.clone();
    canonical.id.clear();
    let bytes = serde_json::to_vec(&canonical).map_err(|e| Error::Corrupt(e.to_string()))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid("metadata path has no parent".into()))?;
    check_directory(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| Error::io("create staged metadata", path, e))?;
    temp.write_all(bytes)
        .map_err(|e| Error::io("write staged metadata", path, e))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| Error::io("flush staged metadata", path, e))?;
    temp.persist(path)
        .map_err(|e| Error::io("replace metadata", path, e.error))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| Error::io("flush metadata directory", parent, e))?;
    Ok(())
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| Error::Corrupt(e.to_string()))?;
    atomic_write(path, &bytes)
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let m =
        fs::symlink_metadata(path).map_err(|e| Error::io("read repository metadata", path, e))?;
    if !m.is_file() || is_link(&m) {
        return Err(Error::Corrupt(format!(
            "unsafe metadata file: {}",
            path.display()
        )));
    }
    let mut b = Vec::new();
    open_source(path)
        .and_then(|file| file.take(64 * 1024 * 1024 + 1).read_to_end(&mut b))
        .map_err(|e| Error::io("read repository metadata", path, e))?;
    if b.len() > 64 * 1024 * 1024 {
        return Err(Error::Corrupt(format!(
            "Metadata is too large: {}",
            path.display()
        )));
    }
    serde_json::from_slice(&b).map_err(|e| Error::Corrupt(format!("{}: {e}", path.display())))
}

fn read_ref(path: &Path) -> Result<String> {
    let mut text = String::new();
    open_source(path)
        .and_then(|file| file.take(257).read_to_string(&mut text))
        .map_err(|e| Error::io("read history pointer", path, e))?;
    if text.len() > 256 {
        return Err(Error::Corrupt("A history pointer is too large.".into()));
    }
    Ok(text)
}
fn scan_dir(root: &Path, dir: &Path, out: &mut Vec<ScanEntry>) -> Result<()> {
    for e in fs::read_dir(dir).map_err(|e| Error::io("scan project", dir, e))? {
        let e = e.map_err(|e| Error::io("scan project entry", dir, e))?;
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        let lower = name.to_ascii_lowercase();
        if validate_relative(name).is_err()
            || lower.starts_with("~$")
            || lower.ends_with(".tmp")
            || lower.ends_with(".temp")
        {
            continue;
        }
        let m = fs::symlink_metadata(e.path())
            .map_err(|e| Error::io("inspect project entry", dir, e))?;
        if is_link(&m) {
            continue;
        }
        if m.is_dir() {
            scan_dir(root, &e.path(), out)?
        } else if m.is_file() && is_clip_document(Path::new(name)) {
            let p = e
                .path()
                .strip_prefix(root)
                .map_err(|_| Error::Invalid("scan escaped project root".into()))?
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            out.push(ScanEntry {
                path: p,
                size: m.len(),
            });
        }
    }
    Ok(())
}
fn walk_size(p: &Path, sum: &mut u64) -> Result<()> {
    for e in fs::read_dir(p).map_err(|e| Error::io("measure repository", p, e))? {
        let e = e.map_err(|e| Error::io("measure repository entry", p, e))?;
        // Optional derived files cannot make the version timeline inaccessible.
        if e.file_name() == "previews" {
            continue;
        }
        let m = fs::symlink_metadata(e.path())
            .map_err(|e| Error::io("measure repository item", p, e))?;
        if is_link(&m) {
            continue;
        }
        if m.is_dir() {
            walk_size(&e.path(), sum)?
        } else {
            *sum = sum.saturating_add(m.len())
        }
    }
    Ok(())
}
fn gear(b: u8) -> u64 {
    let mut x = (b as u64).wrapping_add(0x9e3779b97f4a7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    x ^ (x >> 31)
}
pub mod formats;
pub mod index;
pub mod restore;
pub mod watcher;

#[cfg(test)]
mod tracking_tests {
    use super::*;

    #[test]
    fn reopens_legacy_project_with_clip_only_capture_and_preserves_archived_bytes() {
        let folder = tempfile::tempdir().unwrap();
        let clip = "drawing.clip";
        let legacy = "legacy.psd";
        fs::write(folder.path().join(clip), b"first drawing").unwrap();
        fs::write(folder.path().join(legacy), b"archived art").unwrap();
        let repo = Repository::init(folder.path(), vec![clip.into()]).unwrap();
        let initial = repo.history().unwrap().remove(0);
        let mut files = initial.files.clone();
        files.push(
            repo.capture_entry(legacy, &repo.source_path(legacy).unwrap())
                .unwrap(),
        );
        let archived = repo
            .write_commit(Some(initial.id), files, Kind::Checkpoint, "Legacy", "")
            .unwrap()
            .unwrap();
        let config = repo.metadata().join("config.json");
        atomic_json(
            &config,
            &Settings {
                tracked: vec![clip.into(), legacy.into()],
                auto_capture: true,
                debounce_ms: 1200,
            },
        )
        .unwrap();
        let saved_config = fs::read(&config).unwrap();
        drop(repo);

        let reopened = Repository::open(folder.path()).unwrap();
        assert_eq!(reopened.settings().unwrap().tracked, [clip]);
        assert_eq!(fs::read(config).unwrap(), saved_config);
        fs::write(folder.path().join(legacy), b"current art").unwrap();
        assert!(reopened.capture(Kind::Auto, "", "").unwrap().is_none());
        fs::write(folder.path().join(clip), b"next drawing").unwrap();
        let next = reopened.capture(Kind::Auto, "", "").unwrap().unwrap();
        assert_eq!(next.files.len(), 1);
        assert_eq!(next.files[0].path, clip);
        assert_eq!(next.parent.as_deref(), Some(archived.id.as_str()));
        assert!(formats::get(&reopened, &archived.id, legacy)
            .unwrap()
            .is_none());
        assert!(restore::in_place(&reopened, &archived.id, legacy, legacy).is_err());
        let copy = folder.path().join("copy.psd");
        restore::as_copy(&reopened, &archived.id, legacy, &copy).unwrap();
        assert_eq!(fs::read(copy).unwrap(), b"archived art");
        assert_eq!(
            fs::read(folder.path().join(legacy)).unwrap(),
            b"current art"
        );
    }
}
