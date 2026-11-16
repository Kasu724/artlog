//! Attach a flattened export to an archived Clip Studio Paint version.
use crate::{is_clip_document, Entry, Error, Repository, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
};

const EXPORT_LIMIT: usize = 48 * 1024 * 1024;
const PNG_LIMIT: usize = 5 * 1024 * 1024;
const MAX_PREVIEW_EDGE: u32 = 1024;
const MAX_SOURCE_EDGE: u32 = 8192;
const MAX_SOURCE_PIXELS: u64 = 24_000_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub adapter: &'static str,
    pub adapter_version: u8,
}

pub fn get(repo: &Repository, id: &str, path: &str) -> Result<Option<Preview>> {
    if !is_clip_document(Path::new(path)) {
        return Ok(None);
    }
    let entry = repo.entry(id, path)?;
    Ok(cached(repo, &entry))
}

pub fn attach(repo: &Repository, id: &str, path: &str, export: &Path) -> Result<Preview> {
    if !is_clip_document(Path::new(path)) {
        return Err(Error::Invalid(
            "Previews can only be attached to Clip Studio Paint (.clip) files.".into(),
        ));
    }
    let entry = repo.entry(id, path)?;
    if !export.is_absolute() || !plain_file(export) {
        return Err(Error::Invalid("Choose a local PNG or JPEG export.".into()));
    }
    let bytes = read_limited(export, EXPORT_LIMIT)
        .map_err(|err| Error::io("read exported preview", export, err))?;
    let format = image::guess_format(&bytes)
        .ok()
        .filter(|format| matches!(format, ImageFormat::Png | ImageFormat::Jpeg));
    let image = format
        .and_then(|format| decode(&bytes, format))
        .ok_or_else(|| {
            Error::Invalid(
                "The preview could not be opened. Export a PNG or JPEG under 48 MB, at most 8,192 pixels per edge and 24 megapixels."
                    .into(),
            )
        })?;
    let (preview, bytes) = encode(image)?;
    store(repo, &entry, &bytes)?;
    Ok(preview)
}

fn read_limited(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "preview file is too large",
        ));
    }
    Ok(bytes)
}

fn reader(bytes: &[u8], format: ImageFormat) -> ImageReader<Cursor<&[u8]>> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_EDGE);
    limits.max_image_height = Some(MAX_SOURCE_EDGE);
    limits.max_alloc = Some(240_000_000);
    reader.limits(limits);
    reader
}

fn decode(bytes: &[u8], format: ImageFormat) -> Option<DynamicImage> {
    let (width, height) = reader(bytes, format).into_dimensions().ok()?;
    if !valid_dimensions(width, height) {
        return None;
    }
    reader(bytes, format).decode().ok()
}

fn valid_dimensions(width: u32, height: u32) -> bool {
    width != 0
        && height != 0
        && width.max(height) <= MAX_SOURCE_EDGE
        && u64::from(width) * u64::from(height) <= MAX_SOURCE_PIXELS
}

fn encode(image: DynamicImage) -> Result<(Preview, Vec<u8>)> {
    let image = if image.width().max(image.height()) > MAX_PREVIEW_EDGE {
        image.thumbnail(MAX_PREVIEW_EDGE, MAX_PREVIEW_EDGE)
    } else {
        image
    };
    let (width, height) = (image.width(), image.height());
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.into_rgba8())
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|err| Error::Invalid(format!("Could not create preview: {err}")))?;
    let bytes = output.into_inner();
    Ok((make_preview(&bytes, width, height), bytes))
}

fn make_preview(bytes: &[u8], width: u32, height: u32) -> Preview {
    Preview {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        width,
        height,
        adapter: "export",
        adapter_version: 1,
    }
}

fn ordinary(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
}

fn plain_file(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| ordinary(&meta) && meta.is_file())
}

fn preview_dir(repo: &Repository, create: bool) -> Result<PathBuf> {
    let base = repo.metadata();
    let dir = base.join("previews");
    let check = |path: &Path| {
        path.symlink_metadata()
            .is_ok_and(|meta| ordinary(&meta) && meta.is_dir())
    };
    if !check(base) {
        return Err(Error::Corrupt(
            "The repository directory is unavailable.".into(),
        ));
    }
    if create {
        match fs::create_dir(&dir) {
            Ok(()) => (),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => (),
            Err(err) => return Err(Error::io("create preview folder", &dir, err)),
        }
    }
    if !check(&dir) {
        return Err(Error::Invalid("The preview folder is unavailable.".into()));
    }
    Ok(dir)
}

fn cache_filename(entry: &Entry) -> String {
    format!("{}-export-v1.bin", entry.hash)
}

fn cached(repo: &Repository, entry: &Entry) -> Option<Preview> {
    let path = preview_dir(repo, false).ok()?.join(cache_filename(entry));
    if !plain_file(&path) {
        return None;
    }
    let file = read_limited(&path, PNG_LIMIT + 32).ok()?;
    let (checksum, bytes) = file.split_at_checked(32)?;
    if blake3::hash(bytes).as_bytes() != checksum {
        return None;
    }
    let (width, height) = reader(bytes, ImageFormat::Png).into_dimensions().ok()?;
    if width.min(height) == 0 || width.max(height) > MAX_PREVIEW_EDGE {
        return None;
    }
    Some(make_preview(bytes, width, height))
}

fn store(repo: &Repository, entry: &Entry, bytes: &[u8]) -> Result<()> {
    let dir = preview_dir(repo, true)?;
    let path = dir.join(cache_filename(entry));
    let mut staged = tempfile::Builder::new()
        .prefix(".preview-")
        .tempfile_in(&dir)
        .map_err(|err| Error::io("stage preview", &dir, err))?;
    staged
        .write_all(blake3::hash(bytes).as_bytes())
        .and_then(|()| staged.write_all(bytes))
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|err| Error::io("write preview", &path, err))?;
    // Derived preview records may be replaced by a new export or regenerated
    // after cache corruption. No source or historical object uses this path.
    staged
        .persist(&path)
        .map_err(|err| Error::io("save preview", &path, err.error))?;
    Ok(())
}
