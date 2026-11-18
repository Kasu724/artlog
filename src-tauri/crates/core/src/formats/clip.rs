use super::{decode, EXPORT_LIMIT};
use image::{DynamicImage, ImageFormat};
use rusqlite::{limits::Limit, Connection, OpenFlags, OptionalExtension};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    time::{Duration, Instant},
};

const DATABASE_LIMIT: u64 = 128 * 1024 * 1024;
const CHUNK_LIMIT: usize = 100_000;

// CLIP stores a canvas preview in the SQLite chunk of its CSFCHUNK container.
// Read only that chunk, skipping layer payloads without allocating them.
pub(super) fn extract(source: &mut File) -> io::Result<Option<DynamicImage>> {
    let file_size = source.metadata()?.len();
    if file_size < 24 {
        return Ok(None);
    }
    source.seek(SeekFrom::Start(0))?;
    let mut header = [0; 24];
    source.read_exact(&mut header)?;
    if &header[..8] != b"CSFCHUNK" {
        return Ok(None);
    }

    let mut position = 24u64;
    for _ in 0..CHUNK_LIMIT {
        if file_size.saturating_sub(position) < 16 {
            return Ok(None);
        }
        source.seek(SeekFrom::Start(position))?;
        let mut chunk = [0; 16];
        source.read_exact(&mut chunk)?;
        if &chunk[..4] != b"CHNK" {
            return Ok(None);
        }
        let length = u64::from_be_bytes(chunk[8..].try_into().unwrap());
        let Some(end) = position
            .checked_add(16)
            .and_then(|start| start.checked_add(length))
        else {
            return Ok(None);
        };
        if end > file_size {
            return Ok(None);
        }
        if &chunk[..8] == b"CHNKSQLi" {
            if !(100..=DATABASE_LIMIT).contains(&length) {
                return Ok(None);
            }
            let mut database = tempfile::Builder::new()
                .prefix("artlog-preview-")
                .tempfile()?;
            if io::copy(&mut source.take(length), &mut database)? != length {
                return Ok(None);
            }
            return Ok(read_canvas(database.path()));
        }
        position = end;
    }
    Ok(None)
}

fn read_canvas(path: &std::path::Path) -> Option<DynamicImage> {
    let database = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    database.set_limit(Limit::SQLITE_LIMIT_LENGTH, EXPORT_LIMIT as i32);
    let started = Instant::now();
    database.progress_handler(
        1_000,
        Some(move || started.elapsed() > Duration::from_secs(1)),
    );
    database
        .execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;")
        .ok()?;
    let is_table: bool = database
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'CanvasPreview' AND type = 'table')",
            [],
            |row| row.get(0),
        )
        .ok()?;
    if !is_table {
        return None;
    }
    let bytes: Vec<u8> = database
        .query_row(
            "SELECT ImageData FROM CanvasPreview
             WHERE typeof(ImageData) = 'blob' AND length(ImageData) BETWEEN 1 AND ?1
             LIMIT 1",
            [EXPORT_LIMIT as i64],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    let format = image::guess_format(&bytes).ok()?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg) {
        return None;
    }
    decode(&bytes, format)
}
