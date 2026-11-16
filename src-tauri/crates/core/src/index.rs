//! Rebuildable SQLite cache for browsing portable repository history.
//! The JSON repository stays authoritative; this cache never writes to it.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use super::Commit;
use rusqlite::{params, Connection, OptionalExtension};

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("invalid repository identifier for local index")]
    InvalidRepositoryId,
    #[error("local history index I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("local history index database failed: {0}")]
    Database(#[from] rusqlite::Error),
}

/// Local cache stored under the caller-supplied OS application-data directory.
pub struct ProjectIndex {
    connection: Connection,
    repository_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedCommit {
    pub id: String,
    pub parent: Option<String>,
    pub timestamp: String,
    pub title: String,
    pub note: String,
    pub kind: String,
    pub manifest_id: String,
    pub file_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedFile {
    pub path: String,
    pub size: u64,
    pub hash: String,
}

impl ProjectIndex {
    /// Opens the index and reconciles it with authoritative portable history.
    /// Missing, stale-schema, or corrupt databases are preserved and rebuilt.
    pub fn open_or_rebuild(
        cache_root: &Path,
        repository_id: &str,
        history: &[Commit],
    ) -> Result<Self, IndexError> {
        validate_repository_id(repository_id)?;
        fs::create_dir_all(cache_root)?;
        let path = cache_root.join(format!("{repository_id}.sqlite3"));
        let existed = path.exists();
        let mut connection = Connection::open(&path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        if !database_is_usable(&connection, repository_id) {
            drop(connection);
            if existed {
                preserve_corrupt_database(&path)?;
            } else if path.exists() {
                fs::remove_file(&path)?;
            }
            connection = Connection::open(&path)?;
            connection.busy_timeout(std::time::Duration::from_secs(5))?;
        }
        let index = Self {
            connection,
            repository_id: repository_id.to_owned(),
        };
        index.initialize_schema()?;
        index.refresh(history)?;
        Ok(index)
    }

    pub fn repository_id(&self) -> &str {
        &self.repository_id
    }

    /// Incrementally upserts commits and files in one transaction, then removes
    /// cache rows absent from portable history. It never touches repo objects.
    pub fn refresh(&self, history: &[Commit]) -> Result<(), IndexError> {
        let transaction = self.connection.unchecked_transaction()?;
        let authoritative: std::collections::HashSet<&str> =
            history.iter().map(|item| item.id.as_str()).collect();
        {
            let mut upsert_commit = transaction.prepare(
                "INSERT INTO commits (id,parent,timestamp,title,note,kind,manifest_id)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,
                 timestamp=excluded.timestamp,title=excluded.title,note=excluded.note,
                 kind=excluded.kind,manifest_id=excluded.manifest_id",
            )?;
            let mut upsert_file = transaction.prepare(
                "INSERT INTO files (commit_id,path,size,hash) VALUES (?1,?2,?3,?4)
                 ON CONFLICT(commit_id,path) DO UPDATE SET size=excluded.size,hash=excluded.hash",
            )?;
            for commit in history {
                upsert_commit.execute(params![
                    commit.id,
                    commit.parent,
                    commit.timestamp,
                    commit.title,
                    commit.note,
                    format!("{:?}", commit.kind).to_lowercase(),
                    commit.manifest_id
                ])?;
                let paths: std::collections::HashSet<&str> =
                    commit.files.iter().map(|file| file.path.as_str()).collect();
                for file in &commit.files {
                    upsert_file.execute(params![
                        commit.id,
                        file.path,
                        file.size as i64,
                        file.hash
                    ])?;
                }
                let mut existing =
                    transaction.prepare("SELECT path FROM files WHERE commit_id=?1")?;
                let old_paths: Vec<String> = existing
                    .query_map(params![commit.id], |row| row.get(0))?
                    .collect::<Result<_, _>>()?;
                drop(existing);
                for path in old_paths {
                    if !paths.contains(path.as_str()) {
                        transaction.execute(
                            "DELETE FROM files WHERE commit_id=?1 AND path=?2",
                            params![commit.id, path],
                        )?;
                    }
                }
            }
        }
        let mut statement = transaction.prepare("SELECT id FROM commits")?;
        let cached: Vec<String> = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        drop(statement);
        for id in cached {
            if !authoritative.contains(id.as_str()) {
                transaction.execute("DELETE FROM commits WHERE id=?1", params![id])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_commits(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<IndexedCommit>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT c.id,c.parent,c.timestamp,c.title,c.note,c.kind,c.manifest_id,COUNT(f.path)
             FROM commits c LEFT JOIN files f ON f.commit_id=c.id GROUP BY c.id
             ORDER BY c.timestamp DESC,c.id DESC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit as i64, offset as i64], |row| {
            Ok(IndexedCommit {
                id: row.get(0)?,
                parent: row.get(1)?,
                timestamp: row.get(2)?,
                title: row.get(3)?,
                note: row.get(4)?,
                kind: row.get(5)?,
                manifest_id: row.get(6)?,
                file_count: row.get::<_, i64>(7)? as usize,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn list_checkpoints(&self, limit: usize) -> Result<Vec<IndexedCommit>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT c.id,c.parent,c.timestamp,c.title,c.note,c.kind,c.manifest_id,COUNT(f.path)
             FROM commits c LEFT JOIN files f ON f.commit_id=c.id WHERE c.kind='checkpoint'
             GROUP BY c.id ORDER BY c.timestamp DESC,c.id DESC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], |row| {
            Ok(IndexedCommit {
                id: row.get(0)?,
                parent: row.get(1)?,
                timestamp: row.get(2)?,
                title: row.get(3)?,
                note: row.get(4)?,
                kind: row.get(5)?,
                manifest_id: row.get(6)?,
                file_count: row.get::<_, i64>(7)? as usize,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn list_files(&self, commit_id: &str) -> Result<Vec<IndexedFile>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT path,size,hash FROM files WHERE commit_id=?1 ORDER BY path COLLATE NOCASE",
        )?;
        let rows = statement.query_map(params![commit_id], |row| {
            Ok(IndexedFile {
                path: row.get(0)?,
                size: row.get::<_, i64>(1)? as u64,
                hash: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn search_paths(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<(String, String)>, IndexError> {
        let mut statement = self.connection.prepare(
            "SELECT commit_id,path FROM files WHERE path LIKE ?1 ESCAPE '\'
             ORDER BY path COLLATE NOCASE LIMIT ?2",
        )?;
        let pattern = format!("%{}%", escape_like(query));
        let rows = statement.query_map(params![pattern, limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn initialize_schema(&self) -> Result<(), IndexError> {
        self.connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS index_meta (
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               version INTEGER NOT NULL, repository_id TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS commits (
               id TEXT PRIMARY KEY, parent TEXT, timestamp TEXT NOT NULL,
               title TEXT NOT NULL, note TEXT NOT NULL, kind TEXT NOT NULL,
               manifest_id TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS files (
               commit_id TEXT NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
               path TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL,
               PRIMARY KEY(commit_id,path)
             );
             CREATE INDEX IF NOT EXISTS commits_timestamp_idx ON commits(timestamp DESC);
             CREATE INDEX IF NOT EXISTS files_path_idx ON files(path COLLATE NOCASE);",
        )?;
        self.connection.execute(
            "INSERT INTO index_meta VALUES(1,?1,?2)
             ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,
             repository_id=excluded.repository_id",
            params![SCHEMA_VERSION, self.repository_id],
        )?;
        Ok(())
    }
}

fn validate_repository_id(id: &str) -> Result<(), IndexError> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(IndexError::InvalidRepositoryId);
    }
    Ok(())
}

fn database_is_usable(connection: &Connection, repository_id: &str) -> bool {
    let check: rusqlite::Result<String> =
        connection.query_row("PRAGMA quick_check(1)", [], |row| row.get(0));
    if !matches!(check, Ok(ref result) if result == "ok") {
        return false;
    }
    let meta: rusqlite::Result<Option<(i64, String)>> = connection
        .query_row(
            "SELECT version,repository_id FROM index_meta WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional();
    matches!(meta, Ok(Some((SCHEMA_VERSION, ref id))) if id == repository_id)
}

fn preserve_corrupt_database(path: &Path) -> Result<(), std::io::Error> {
    if !path.exists() {
        return Ok(());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut preserved = path.with_extension(format!("corrupt-{stamp}.sqlite3"));
    let mut suffix = 0_u32;
    while preserved.exists() {
        suffix += 1;
        preserved = path.with_extension(format!("corrupt-{stamp}-{suffix}.sqlite3"));
    }
    fs::rename(path, preserved)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_ids_cannot_escape_cache_directory() {
        assert!(validate_repository_id("../outside").is_err());
        assert!(validate_repository_id("valid-repository-0123").is_ok());
    }

    #[test]
    fn like_search_escapes_wildcards() {
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
    }
}
