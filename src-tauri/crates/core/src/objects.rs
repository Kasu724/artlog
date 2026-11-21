use super::*;

const MAGIC: &[u8; 8] = b"\x89ALOG\r\n\x1a";
const VERSION: u8 = 1;
const RAW: u8 = 0;
const ZSTD: u8 = 1;
const HEADER_LEN: usize = 14;
const MAX_STORED: usize = CHUNK_MAX + HEADER_LEN;
const COMPRESSION_LEVEL: i32 = 1;
const REPACK_PREFIX: &str = "repack-object-";
const REPACK_SUFFIX_LEN: usize = 12;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepackMode {
    Compress,
    Raw,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepackReport {
    pub objects_rewritten: usize,
    pub before_bytes: u64,
    pub after_bytes: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Encoding {
    Raw,
    FramedRaw,
    Zstd,
}

pub(super) struct Object {
    pub bytes: Vec<u8>,
    encoding: Encoding,
    stored_size: usize,
}

pub(super) fn compress(bytes: &[u8]) -> io::Result<Option<Vec<u8>>> {
    let minimum_saving = bytes.len().div_ceil(100).max(1024);
    if bytes.len() <= HEADER_LEN + minimum_saving {
        return Ok(None);
    }
    let frame = zstd::bulk::compress(bytes, COMPRESSION_LEVEL)?;
    let stored_size = HEADER_LEN + frame.len();
    if stored_size + minimum_saving > bytes.len() {
        return Ok(None);
    }
    let mut stored = Vec::with_capacity(stored_size);
    stored.extend_from_slice(MAGIC);
    stored.extend_from_slice(&[VERSION, ZSTD]);
    stored.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    stored.extend_from_slice(&frame);
    Ok(Some(stored))
}

pub(super) fn read(path: &Path, id: &str) -> Result<Object> {
    let meta = path
        .symlink_metadata()
        .map_err(|e| Error::io("inspect stored object", path, e))?;
    if !meta.is_file() || is_link(&meta) || meta.len() > MAX_STORED as u64 {
        return Err(Error::Corrupt(format!("unsafe or oversized object: {id}")));
    }
    let mut stored = Vec::with_capacity(meta.len() as usize);
    open_source(path)
        .and_then(|file| file.take(MAX_STORED as u64 + 1).read_to_end(&mut stored))
        .map_err(|e| Error::io("read stored object", path, e))?;
    decode(stored, id)
}

fn decode(stored: Vec<u8>, id: &str) -> Result<Object> {
    let stored_size = stored.len();
    let corrupt = |reason| Error::Corrupt(format!("{reason}: {id}"));
    if stored_size > MAX_STORED {
        return Err(corrupt("oversized stored object"));
    }
    // The plaintext ID disambiguates legacy objects that start with our magic.
    if stored_size <= CHUNK_MAX && blake3::hash(&stored).to_hex().as_str() == id {
        return Ok(Object {
            bytes: stored,
            encoding: Encoding::Raw,
            stored_size,
        });
    }
    if !stored.starts_with(MAGIC) {
        return Err(corrupt("object hash mismatch or oversized raw object"));
    }
    if stored_size < HEADER_LEN {
        return Err(corrupt("truncated object header"));
    }
    if stored[8] != VERSION {
        return Err(corrupt("unsupported object version"));
    }
    let size = u32::from_le_bytes(stored[10..14].try_into().unwrap()) as usize;
    if size > CHUNK_MAX {
        return Err(corrupt("oversized plaintext object"));
    }
    let payload = &stored[HEADER_LEN..];
    let (bytes, encoding) = match stored[9] {
        RAW if payload.len() == size => (payload.to_vec(), Encoding::FramedRaw),
        RAW => return Err(corrupt("raw object length mismatch")),
        ZSTD => (
            decompress(payload, size).map_err(|_| corrupt("invalid Zstd object"))?,
            Encoding::Zstd,
        ),
        _ => return Err(corrupt("unsupported object codec")),
    };
    if bytes.len() != size || blake3::hash(&bytes).to_hex().as_str() != id {
        return Err(corrupt("decoded object length or hash mismatch"));
    }
    Ok(Object {
        bytes,
        encoding,
        stored_size,
    })
}

fn decompress(payload: &[u8], size: usize) -> io::Result<Vec<u8>> {
    // Accept one ordinary frame ending exactly at the end of the object.
    if !payload.starts_with(&[0x28, 0xb5, 0x2f, 0xfd])
        || zstd::zstd_safe::find_frame_compressed_size(payload) != Ok(payload.len())
    {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frame"));
    }
    let mut decoder = zstd::stream::read::Decoder::with_buffer(payload)?;
    decoder.window_log_max(CHUNK_MAX.ilog2())?;
    let mut bytes = Vec::with_capacity(size + 1);
    decoder.take(size as u64 + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

impl Repository {
    pub fn history_compression(&self) -> Result<bool> {
        if self.version != projects::VERSION {
            return Ok(false);
        }
        let path = self.metadata.join("compression.json");
        if projects::exists(&path)? {
            read_json(&path)
        } else {
            Ok(true)
        }
    }

    pub fn set_history_compression(&self, enabled: bool) -> Result<()> {
        let _guard = self.with_write_lock()?;
        self.set_history_compression_locked(enabled)
    }

    pub(super) fn set_history_compression_locked(&self, enabled: bool) -> Result<()> {
        if self.version != projects::VERSION {
            return Err(Error::Invalid(
                "Open the upgraded history to change compression.".into(),
            ));
        }
        atomic_json(&self.metadata.join("compression.json"), &enabled)
    }

    pub fn repack_history(&self, mode: RepackMode) -> Result<RepackReport> {
        self.repack_history_with(mode, |_| Ok(()))
    }

    fn repack_history_with(
        &self,
        mode: RepackMode,
        mut before_publish: impl FnMut(&Path) -> Result<()>,
    ) -> Result<RepackReport> {
        let _guard = self.with_write_lock()?;
        if self.version != projects::VERSION {
            return Err(Error::Invalid(
                "Open the upgraded history to repack it.".into(),
            ));
        }
        self.health()?;
        if mode == RepackMode::Raw && !matches!(self.history_compression(), Ok(false)) {
            // Prevent new compressed objects even if expansion stops partway through.
            self.set_history_compression_locked(false)?;
        }
        let staging = self.staging()?;
        clear_repack_staging(&staging)?;
        let mut report = RepackReport::default();
        for shard in projects::children(&self.metadata.join("objects"))? {
            let Some(prefix) = shard.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if prefix.len() != 2
                || !prefix
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                continue;
            }
            for path in projects::children(&shard)? {
                let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                // Temporary and unrelated files aren't addressed objects. Keep them intact.
                if valid_id(id).is_err() {
                    continue;
                }
                if !id.starts_with(prefix) {
                    return Err(Error::Corrupt(format!(
                        "object in the wrong directory: {id}"
                    )));
                }
                let object = read(&path, id)?;
                let encoded;
                let replacement = match mode {
                    RepackMode::Compress if object.encoding != Encoding::Zstd => {
                        encoded = compress(&object.bytes)
                            .map_err(|e| Error::io("compress stored object", &path, e))?;
                        encoded.as_deref().map(|bytes| (bytes, Encoding::Zstd))
                    }
                    RepackMode::Raw if object.encoding != Encoding::Raw => {
                        Some((object.bytes.as_slice(), Encoding::Raw))
                    }
                    _ => None,
                };
                report.before_bytes += object.stored_size as u64;
                if let Some((bytes, encoding)) = replacement {
                    let staged = stage_object(&staging, id, bytes, &object.bytes, encoding)?;
                    before_publish(&path)?;
                    let staged_path = staged.path().to_owned();
                    staged.persist(&path).map_err(|e| {
                        Error::io("replace verified history object", &path, e.error)
                    })?;
                    projects::sync_parent(&path)?;
                    projects::sync_parent(&staged_path)?;
                    report.objects_rewritten += 1;
                    report.after_bytes += bytes.len() as u64;
                } else {
                    report.after_bytes += object.stored_size as u64;
                }
            }
        }
        Ok(report)
    }
}

fn clear_repack_staging(staging: &Path) -> Result<()> {
    for path in projects::children(staging)? {
        let Some(suffix) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(REPACK_PREFIX))
        else {
            continue;
        };
        if suffix.len() == REPACK_SUFFIX_LEN && suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
            let meta = path
                .symlink_metadata()
                .map_err(|e| Error::io("inspect interrupted repack staging", &path, e))?;
            if meta.is_file() && !is_link(&meta) {
                fs::remove_file(&path)
                    .map_err(|e| Error::io("clear interrupted repack staging", &path, e))?;
            }
        }
    }
    Ok(())
}

fn stage_object(
    staging: &Path,
    id: &str,
    encoded: &[u8],
    original: &[u8],
    encoding: Encoding,
) -> Result<tempfile::NamedTempFile> {
    let mut staged = tempfile::Builder::new()
        .prefix(REPACK_PREFIX)
        .rand_bytes(REPACK_SUFFIX_LEN)
        .tempfile_in(staging)
        .map_err(|e| Error::io("stage history object", staging, e))?;
    staged
        .write_all(encoded)
        .and_then(|_| staged.as_file().sync_all())
        .map_err(|e| Error::io("write and flush staged history object", staged.path(), e))?;
    let verified = read(staged.path(), id)?;
    if verified.encoding != encoding
        || verified.stored_size != encoded.len()
        || verified.bytes != original
    {
        return Err(Error::Corrupt(format!(
            "staged object verification failed: {id}"
        )));
    }
    Ok(staged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    #[test]
    fn round_trips_max_size_and_accepts_raw_bytes_with_envelope_magic() {
        let mut bytes = vec![0x73; CHUNK_MAX];
        bytes[..MAGIC.len()].copy_from_slice(MAGIC);
        let expected = id(&bytes);
        let encoded = compress(&bytes).unwrap().unwrap();
        assert!(encoded.starts_with(MAGIC));
        assert_eq!(decode(encoded, &expected).unwrap().bytes, bytes);
        assert_eq!(decode(bytes.clone(), &expected).unwrap().bytes, bytes);

        let mut framed_raw = MAGIC.to_vec();
        framed_raw.extend_from_slice(&[VERSION, RAW]);
        framed_raw.extend_from_slice(&(CHUNK_MAX as u32).to_le_bytes());
        framed_raw.extend_from_slice(&bytes);
        assert_eq!(decode(framed_raw, &expected).unwrap().bytes, bytes);
        for bytes in [b"".as_slice(), b"little", MAGIC] {
            assert!(compress(bytes).unwrap().is_none());
            assert_eq!(decode(bytes.to_vec(), &id(bytes)).unwrap().bytes, bytes);
        }
    }

    #[test]
    fn rejects_corrupt_headers_frames_and_lengths() {
        let bytes = vec![0x19; 64 * 1024];
        let expected = id(&bytes);
        let valid = compress(&bytes).unwrap().unwrap();
        let mut wrong_version = valid.clone();
        wrong_version[8] += 1;
        let mut wrong_codec = valid.clone();
        wrong_codec[9] = 0xff;
        let mut wrong_size = valid.clone();
        wrong_size[10..14].copy_from_slice(&1u32.to_le_bytes());
        let mut oversized = valid.clone();
        oversized[10..14].copy_from_slice(&(CHUNK_MAX as u32 + 1).to_le_bytes());
        let mut trailing = valid.clone();
        trailing.extend_from_slice(&valid[HEADER_LEN..]);
        for invalid in [
            wrong_version,
            wrong_codec,
            wrong_size,
            oversized,
            trailing,
            valid[..HEADER_LEN - 1].to_vec(),
            valid[..valid.len() - 1].to_vec(),
            vec![0; MAX_STORED + 1],
        ] {
            assert!(matches!(decode(invalid, &expected), Err(Error::Corrupt(_))));
        }
        assert!(matches!(
            decode(valid, &id(b"different")),
            Err(Error::Corrupt(_))
        ));
    }

    #[test]
    fn repack_resumes_after_a_publish_failure_and_returns_every_object_to_raw() {
        let folder = tempfile::tempdir().unwrap();
        let source = folder.path().join("art.clip");
        let baseline = vec![0x12; 100_000];
        fs::write(&source, &baseline).unwrap();
        let container = projects::Container::create(folder.path()).unwrap();
        let repo = container.open_or_create_single("art.clip").unwrap();
        repo.repack_history(RepackMode::Raw).unwrap();
        let mut noise = vec![0; 200_000];
        blake3::Hasher::new().finalize_xof().fill(&mut noise);
        assert!(compress(&noise).unwrap().is_none());
        fs::write(&source, &noise).unwrap();
        let saved = repo
            .capture(Kind::Checkpoint, "Early state", "Exact bytes")
            .unwrap()
            .unwrap();
        let orphan = vec![0x34; 90_000];
        let orphan_id = id(&orphan);
        repo.store_object(&orphan_id, &orphan, false).unwrap();
        let history = repo.history().unwrap();
        let settings = fs::read(repo.metadata.join("config.json")).unwrap();
        let before = repo.repository_size().unwrap();

        let compressed = repo.repack_history(RepackMode::Compress).unwrap();
        assert_eq!(compressed.objects_rewritten, 2);
        assert_eq!(
            compressed.before_bytes,
            (baseline.len() + noise.len() + orphan.len()) as u64
        );
        assert_eq!(
            compressed.before_bytes - compressed.after_bytes,
            before - repo.repository_size().unwrap()
        );
        assert_eq!(
            repo.repack_history(RepackMode::Compress)
                .unwrap()
                .objects_rewritten,
            0
        );
        repo.set_history_compression(true).unwrap();

        let orphan_stage = repo.staging().unwrap().join("repack-object-123456abcdef");
        fs::write(&orphan_stage, b"abandoned partial write").unwrap();
        let mut attempts = 0;
        let failed = repo.repack_history_with(RepackMode::Raw, |path| {
            attempts += 1;
            if attempts == 2 {
                return Err(Error::io(
                    "publish staged object",
                    path,
                    io::ErrorKind::StorageFull.into(),
                ));
            }
            Ok(())
        });
        assert!(
            matches!(failed, Err(Error::Io { source, .. }) if source.kind() == io::ErrorKind::StorageFull)
        );
        assert!(!orphan_stage.exists());
        assert!(!repo.history_compression().unwrap());
        assert_eq!(repo.health().unwrap().versions, history.len());
        assert_eq!(repo.history().unwrap(), history);

        let reopened = container.open_or_create_single("art.clip").unwrap();
        let expanded = reopened.repack_history(RepackMode::Raw).unwrap();
        assert_eq!(expanded.objects_rewritten, 1);
        assert_eq!(expanded.after_bytes, compressed.before_bytes);
        assert_eq!(
            reopened
                .repack_history(RepackMode::Raw)
                .unwrap()
                .objects_rewritten,
            0
        );
        for bytes in [&baseline, &noise, &orphan] {
            let path = safe_object_path(&reopened.metadata, &id(bytes)).unwrap();
            assert_eq!(&fs::read(path).unwrap(), bytes);
        }
        assert_eq!(fs::read(&source).unwrap(), noise);
        assert_eq!(
            fs::read(reopened.metadata.join("config.json")).unwrap(),
            settings
        );
        assert_eq!(reopened.history().unwrap(), history);
        let destination = folder.path().join("copy.clip");
        restore::as_copy(&reopened, &saved.id, "art.clip", &destination).unwrap();
        assert_eq!(fs::read(destination).unwrap(), noise);
    }
}
