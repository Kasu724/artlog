//! Read-only preview adapters. Original documents never enter an image decoder
//! directly from the working tree; previews use addressed historical bytes.
use crate::{Entry, Error, Repository, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat, ImageReader, Limits, RgbImage};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
};

const PREFIX_LIMIT: usize = 32 * 1024 * 1024;
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

#[derive(Clone, Copy)]
enum Adapter {
    Psd,
    Export,
}

impl Adapter {
    fn name(self) -> &'static str {
        match self {
            Self::Psd => "psd",
            Self::Export => "export",
        }
    }
}

pub fn get(repo: &Repository, id: &str, path: &str) -> Result<Option<Preview>> {
    let entry = repo.entry(id, path)?;
    if let Some(preview) = cached(repo, &entry, Adapter::Export) {
        return Ok(Some(preview));
    }
    if !Path::new(&entry.path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("psd"))
    {
        return Ok(None);
    }
    if let Some(preview) = cached(repo, &entry, Adapter::Psd) {
        return Ok(Some(preview));
    }
    let prefix = repo.read_prefix(&entry, PREFIX_LIMIT)?;
    let image = psd_preview(&prefix);
    let Some(image) = image else { return Ok(None) };
    let (preview, bytes) = encode(image, Adapter::Psd)?;
    // A read-only or full disk must not prevent viewing an already decoded
    // image. Saving this derived copy is best effort.
    let _ = store(repo, &entry, Adapter::Psd, &bytes);
    Ok(Some(preview))
}

pub fn attach(repo: &Repository, id: &str, path: &str, export: &Path) -> Result<Preview> {
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
    let (preview, bytes) = encode(image, Adapter::Export)?;
    store(repo, &entry, Adapter::Export, &bytes)?;
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

fn encode(image: DynamicImage, adapter: Adapter) -> Result<(Preview, Vec<u8>)> {
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
    Ok((make_preview(&bytes, width, height, adapter), bytes))
}

fn make_preview(bytes: &[u8], width: u32, height: u32, adapter: Adapter) -> Preview {
    Preview {
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
        width,
        height,
        adapter: adapter.name(),
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

fn cache_filename(entry: &Entry, adapter: Adapter) -> String {
    // Both are strictly derived: the repository validates the full historical
    // BLAKE3 ID and the adapter has a fixed name/version.
    format!("{}-{}-v1.bin", entry.hash, adapter.name())
}

fn cached(repo: &Repository, entry: &Entry, adapter: Adapter) -> Option<Preview> {
    let path = preview_dir(repo, false)
        .ok()?
        .join(cache_filename(entry, adapter));
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
    Some(make_preview(bytes, width, height, adapter))
}

fn store(repo: &Repository, entry: &Entry, adapter: Adapter, bytes: &[u8]) -> Result<()> {
    let dir = preview_dir(repo, true)?;
    let path = dir.join(cache_filename(entry, adapter));
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

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(at..at.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn psd_preview(bytes: &[u8]) -> Option<DynamicImage> {
    // Adobe Photoshop File Formats Specification: PSD v1, image resource
    // blocks, resource 1036 (28-byte thumbnail header followed by RGB JPEG).
    if bytes.get(..4)? != b"8BPS" || u16_at(bytes, 4)? != 1 {
        return None;
    }
    let resource_section = 30usize.checked_add(u32_at(bytes, 26)? as usize)?;
    let resource_start = resource_section.checked_add(4)?;
    let resource_end = resource_start.checked_add(u32_at(bytes, resource_section)? as usize)?;
    let mut cursor = resource_start;
    while cursor < resource_end {
        if bytes.get(cursor..cursor.checked_add(4)?)? != b"8BIM" {
            break;
        }
        let id = u16_at(bytes, cursor.checked_add(4)?)?;
        let name_start = cursor.checked_add(6)?;
        let name_length = usize::from(*bytes.get(name_start)?) + 1;
        let size_at = name_start.checked_add(name_length.next_multiple_of(2))?;
        let size = u32_at(bytes, size_at)? as usize;
        let start = size_at.checked_add(4)?;
        let end = start.checked_add(size)?;
        if end > resource_end {
            return None;
        }
        if id == 1036 {
            let data = bytes.get(start..end)?;
            if u32_at(data, 0) == Some(1) {
                let size = u32_at(data, 20)? as usize;
                if let Some(preview) = data
                    .get(28..28usize.checked_add(size)?)
                    .and_then(|jpeg| decode(jpeg, ImageFormat::Jpeg))
                {
                    return Some(preview);
                }
            }
        }
        cursor = end.checked_add(size % 2)?;
    }
    // A bounded fallback for raw 8-bit RGB/grayscale merged pixels. We never
    // interpret layers, extra channels, other modes or unknown compression.
    let mode = u16_at(bytes, 24)?;
    if u16_at(bytes, 22)? != 8 || !matches!(mode, 1 | 3) {
        return None;
    }
    let channels = if mode == 3 { 3 } else { 1 };
    if u16_at(bytes, 12)? != channels {
        return None;
    }
    let (width, height) = (u32_at(bytes, 18)?, u32_at(bytes, 14)?);
    if !valid_dimensions(width, height) || width.max(height) > 4096 {
        return None;
    }
    let compression = resource_end
        .checked_add(4)?
        .checked_add(u32_at(bytes, resource_end)? as usize)?;
    if u16_at(bytes, compression)? != 0 {
        return None;
    }
    let start = compression.checked_add(2)?;
    let plane = width as usize * height as usize;
    let data = bytes.get(start..start.checked_add(plane * usize::from(channels))?)?;
    let rgb = RgbImage::from_fn(width, height, |x, y| {
        let i = x as usize + y as usize * width as usize;
        if channels == 3 {
            image::Rgb([data[i], data[i + plane], data[i + plane * 2]])
        } else {
            image::Rgb([data[i]; 3])
        }
    });
    Some(DynamicImage::ImageRgb8(rgb))
}
