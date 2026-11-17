use artlog_core::{formats, restore, Repository};
use image::{Rgb, RgbImage};
use std::fs;

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
