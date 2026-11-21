use super::*;

const MAGIC: &[u8; 8] = b"\x89ALOG\r\n\x1a";
const VERSION: u8 = 1;
const RAW: u8 = 0;
const ZSTD: u8 = 1;
const HEADER_LEN: usize = 14;
const MAX_STORED: usize = CHUNK_MAX + HEADER_LEN;
const COMPRESSION_LEVEL: i32 = 1;

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

pub(super) fn read(path: &Path, id: &str) -> Result<Vec<u8>> {
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

fn decode(stored: Vec<u8>, id: &str) -> Result<Vec<u8>> {
    let stored_size = stored.len();
    let corrupt = |reason| Error::Corrupt(format!("{reason}: {id}"));
    if stored_size > MAX_STORED {
        return Err(corrupt("oversized stored object"));
    }
    // The plaintext ID disambiguates legacy objects that start with our magic.
    if stored_size <= CHUNK_MAX && blake3::hash(&stored).to_hex().as_str() == id {
        return Ok(stored);
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
    let bytes = match stored[9] {
        RAW if payload.len() == size => payload.to_vec(),
        RAW => return Err(corrupt("raw object length mismatch")),
        ZSTD => decompress(payload, size).map_err(|_| corrupt("invalid Zstd object"))?,
        _ => return Err(corrupt("unsupported object codec")),
    };
    if bytes.len() != size || blake3::hash(&bytes).to_hex().as_str() != id {
        return Err(corrupt("decoded object length or hash mismatch"));
    }
    Ok(bytes)
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
        assert_eq!(decode(encoded, &expected).unwrap(), bytes);
        assert_eq!(decode(bytes.clone(), &expected).unwrap(), bytes);

        let mut framed_raw = MAGIC.to_vec();
        framed_raw.extend_from_slice(&[VERSION, RAW]);
        framed_raw.extend_from_slice(&(CHUNK_MAX as u32).to_le_bytes());
        framed_raw.extend_from_slice(&bytes);
        assert_eq!(decode(framed_raw, &expected).unwrap(), bytes);
        for bytes in [b"".as_slice(), b"little", MAGIC] {
            assert!(compress(bytes).unwrap().is_none());
            assert_eq!(decode(bytes.to_vec(), &id(bytes)).unwrap(), bytes);
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
}
