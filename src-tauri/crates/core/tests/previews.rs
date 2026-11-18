use artlog_core::{formats, restore, Kind, Repository};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use rusqlite::Connection;
use std::{fs, io::Cursor};

fn clip_file(color: [u8; 3], width: u32, height: u32) -> Vec<u8> {
    let mut image = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb(color)))
        .write_to(&mut image, ImageFormat::Png)
        .unwrap();
    clip_database(Some(image.into_inner()))
}

fn clip_database(preview: Option<Vec<u8>>) -> Vec<u8> {
    let database = tempfile::NamedTempFile::new().unwrap();
    let connection = Connection::open(database.path()).unwrap();
    connection
        .execute_batch("CREATE TABLE CanvasPreview (ImageData BLOB)")
        .unwrap();
    if let Some(preview) = preview {
        connection
            .execute("INSERT INTO CanvasPreview VALUES (?1)", [preview])
            .unwrap();
    }
    connection.close().unwrap();

    let mut bytes = b"CSFCHUNK".to_vec();
    bytes.extend_from_slice(&[0; 8]);
    bytes.extend_from_slice(&24u64.to_be_bytes());
    for (kind, payload) in [
        (b"CHNKHead", vec![0; 40]),
        (b"CHNKExta", b"layer payload containing CHNKSQLi".to_vec()),
        (b"CHNKSQLi", fs::read(database.path()).unwrap()),
        (b"CHNKFoot", Vec::new()),
    ] {
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&payload);
    }
    let length = bytes.len() as u64;
    bytes[8..16].copy_from_slice(&length.to_be_bytes());
    bytes
}

fn preview_image(preview: &formats::Preview) -> DynamicImage {
    let (_, data) = preview.data_url.split_once(',').unwrap();
    image::load_from_memory(&STANDARD.decode(data).unwrap()).unwrap()
}

#[test]
fn captures_version_specific_thumbnails_and_preserves_exact_bytes() {
    let folder = tempfile::tempdir().unwrap();
    let source = folder.path().join("study.clip");
    let first = clip_file([180, 60, 30], 1800, 1200);
    fs::write(&source, &first).unwrap();
    let repo = Repository::init(folder.path(), vec!["study.clip".into()]).unwrap();
    let baseline = repo.history().unwrap().remove(0);
    let entry = repo.entry(&baseline.id, "study.clip").unwrap();
    let cache = repo
        .metadata()
        .join("previews")
        .join(format!("{}-clip-v1.bin", entry.hash));
    assert!(
        cache.is_file(),
        "Capture creates the preview before returning."
    );

    let second = clip_file([40, 80, 160], 1800, 1200);
    fs::write(&source, &second).unwrap();
    let checkpoint = repo
        .capture(Kind::Checkpoint, "Blue pass", "")
        .unwrap()
        .unwrap();
    let reopened = Repository::open(folder.path()).unwrap();
    let old = formats::get(&reopened, &baseline.id, "study.clip")
        .unwrap()
        .unwrap();
    let new = formats::get(&reopened, &checkpoint.id, "study.clip")
        .unwrap()
        .unwrap();
    assert_eq!(old.adapter, "clip");
    assert_eq!(old.width.max(old.height), 1024);
    assert_eq!(
        preview_image(&old).to_rgb8().get_pixel(0, 0).0,
        [180, 60, 30]
    );
    assert_eq!(
        preview_image(&new).to_rgb8().get_pixel(0, 0).0,
        [40, 80, 160]
    );

    // Simulate history created before automatic previews, then delete the working file.
    fs::remove_file(cache).unwrap();
    fs::remove_file(&source).unwrap();
    let derived = formats::get(&reopened, &baseline.id, "study.clip")
        .unwrap()
        .unwrap();
    assert_eq!(derived.data_url, old.data_url);
    let copy = folder.path().join("restored.clip");
    restore::as_copy(&reopened, &baseline.id, "study.clip", &copy).unwrap();
    assert_eq!(fs::read(copy).unwrap(), first);
}

#[test]
fn commit_thumbnail_uses_an_available_file_and_keeps_exports_preferred() {
    let folder = tempfile::tempdir().unwrap();
    fs::write(
        folder.path().join("a.clip"),
        b"unsupported Clip Studio bytes",
    )
    .unwrap();
    fs::write(
        folder.path().join("b.clip"),
        clip_file([12, 34, 56], 400, 200),
    )
    .unwrap();
    let repo = Repository::init(folder.path(), vec!["a.clip".into(), "b.clip".into()]).unwrap();
    let commit = repo.history().unwrap().remove(0);
    let thumbnail = formats::commit_thumbnail(&repo, &commit.id)
        .unwrap()
        .unwrap();
    assert_eq!(thumbnail.path, "b.clip");
    assert_eq!(
        (thumbnail.preview.width, thumbnail.preview.height),
        (160, 80)
    );

    let export = folder.path().join("manual.png");
    RgbImage::from_pixel(20, 30, Rgb([90, 60, 30]))
        .save(&export)
        .unwrap();
    formats::attach(&repo, &commit.id, "b.clip", &export).unwrap();
    let manual = formats::get(&repo, &commit.id, "b.clip").unwrap().unwrap();
    assert_eq!(manual.adapter, "export");
    assert_eq!(
        preview_image(&manual).to_rgb8().get_pixel(0, 0).0,
        [90, 60, 30]
    );
    assert_eq!(
        formats::commit_thumbnail(&repo, &commit.id)
            .unwrap()
            .unwrap()
            .preview
            .adapter,
        "export"
    );
}

#[test]
fn malformed_or_missing_embedded_previews_never_block_history_or_restore() {
    let valid = clip_file([1, 2, 3], 10, 10);
    let mut overflow = valid.clone();
    overflow[32..40].copy_from_slice(&u64::MAX.to_be_bytes());
    let mut truncated = valid.clone();
    truncated.truncate(100);
    let mut huge_database = b"CSFCHUNK".to_vec();
    huge_database.resize(24, 0);
    huge_database.extend_from_slice(b"CHNKSQLi");
    huge_database.extend_from_slice(&(129u64 * 1024 * 1024).to_be_bytes());
    for bytes in [
        overflow,
        truncated,
        huge_database,
        clip_database(None),
        clip_database(Some(b"broken PNG".to_vec())),
    ] {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("study.clip"), &bytes).unwrap();
        let repo = Repository::init(folder.path(), vec!["study.clip".into()]).unwrap();
        let commit = repo
            .capture(Kind::Checkpoint, "Still saved", "")
            .unwrap()
            .unwrap();
        assert!(formats::get(&repo, &commit.id, "study.clip")
            .unwrap()
            .is_none());
        assert!(formats::commit_thumbnail(&repo, &commit.id)
            .unwrap()
            .is_none());
        let copy = folder.path().join("copy.clip");
        restore::as_copy(&repo, &commit.id, "study.clip", &copy).unwrap();
        assert_eq!(fs::read(copy).unwrap(), bytes);
    }
}

#[test]
fn preview_cache_failures_leave_capture_and_restore_available() {
    let folder = tempfile::tempdir().unwrap();
    let first = clip_file([1, 2, 3], 20, 20);
    fs::write(folder.path().join("study.clip"), &first).unwrap();
    let repo = Repository::init(folder.path(), vec!["study.clip".into()]).unwrap();
    // A non-directory cache path must not interfere with the immutable object store.
    fs::remove_dir_all(repo.metadata().join("previews")).unwrap();
    fs::write(repo.metadata().join("previews"), b"cache unavailable").unwrap();
    let second = clip_file([4, 5, 6], 20, 20);
    fs::write(folder.path().join("study.clip"), &second).unwrap();
    let commit = repo
        .capture(Kind::Checkpoint, "Saved despite cache failure", "")
        .unwrap()
        .unwrap();
    let preview = formats::get(&repo, &commit.id, "study.clip")
        .unwrap()
        .unwrap();
    assert_eq!(
        preview_image(&preview).to_rgb8().get_pixel(0, 0).0,
        [4, 5, 6]
    );
    let copy = folder.path().join("copy.clip");
    restore::as_copy(&repo, &commit.id, "study.clip", &copy).unwrap();
    assert_eq!(fs::read(copy).unwrap(), second);
}

#[test]
fn corrupt_preview_cache_is_regenerated_from_the_archived_version() {
    let folder = tempfile::tempdir().unwrap();
    fs::write(
        folder.path().join("study.clip"),
        clip_file([15, 25, 35], 40, 50),
    )
    .unwrap();
    let repo = Repository::init(folder.path(), vec!["study.clip".into()]).unwrap();
    let commit = repo.history().unwrap().remove(0);
    let entry = repo.entry(&commit.id, "study.clip").unwrap();
    let cache = repo
        .metadata()
        .join("previews")
        .join(format!("{}-clip-v1.bin", entry.hash));
    fs::write(cache, b"invalid derived data").unwrap();
    let regenerated = formats::get(&repo, &commit.id, "study.clip")
        .unwrap()
        .unwrap();
    assert_eq!(
        preview_image(&regenerated).to_rgb8().get_pixel(0, 0).0,
        [15, 25, 35]
    );
}

#[test]
fn attaches_export_to_clip_history_without_touching_original() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path();
    let document = "Sample.CLIP";
    let source = b"opaque exact Clip Studio Paint bytes";
    fs::write(root.join(document), source).unwrap();
    let repo = Repository::init(root, vec![document.into()]).unwrap();
    let baseline = repo.history().unwrap().remove(0);
    assert!(formats::get(&repo, &baseline.id, document)
        .unwrap()
        .is_none());

    let png = root.join("Export.png");
    RgbImage::from_pixel(8, 4, Rgb([19, 28, 37]))
        .save(&png)
        .unwrap();
    let preview = formats::attach(&repo, &baseline.id, document, &png).unwrap();
    assert_eq!(
        (preview.width, preview.height, preview.adapter),
        (8, 4, "export")
    );

    let reopened = Repository::open(root).unwrap();
    let persisted = formats::get(&reopened, &baseline.id, document)
        .unwrap()
        .unwrap();
    assert_eq!(persisted.data_url, preview.data_url);
    assert_eq!(fs::read(root.join(document)).unwrap(), source);
}

#[test]
fn restores_clip_bytes_without_an_attached_preview() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path();
    let raw = b"opaque Clip Studio Paint bytes";
    fs::write(root.join("sample.clip"), raw).unwrap();
    let repo = Repository::init(root, vec!["sample.clip".into()]).unwrap();
    let baseline = repo.history().unwrap().remove(0);
    assert!(formats::get(&repo, &baseline.id, "sample.clip")
        .unwrap()
        .is_none());
    let copy = root.join("copy.clip");
    restore::as_copy(&repo, &baseline.id, "sample.clip", &copy).unwrap();
    assert_eq!(fs::read(copy).unwrap(), raw);
}
