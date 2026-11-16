use artlog_core::{formats, restore, Repository};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use std::{fs, io::Cursor};

fn psd_with_thumbnail() -> Vec<u8> {
    let mut jpeg = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_pixel(3, 2, Rgb([45, 90, 135])))
        .write_to(&mut jpeg, ImageFormat::Jpeg)
        .unwrap();
    let jpeg = jpeg.into_inner();
    let mut thumbnail = Vec::new();
    for number in [1u32, 3, 2, 12, 24, jpeg.len() as u32] {
        thumbnail.extend(number.to_be_bytes());
    }
    thumbnail.extend(24u16.to_be_bytes());
    thumbnail.extend(1u16.to_be_bytes());
    thumbnail.extend(jpeg);

    let mut resource = b"8BIM".to_vec();
    resource.extend(1036u16.to_be_bytes());
    resource.extend([0, 0]); // empty Pascal name and padding
    resource.extend((thumbnail.len() as u32).to_be_bytes());
    resource.extend(thumbnail);
    if !resource.len().is_multiple_of(2) {
        resource.push(0);
    }
    let mut psd = b"8BPS".to_vec();
    psd.extend(1u16.to_be_bytes());
    psd.extend([0; 6]); // reserved
    psd.extend(3u16.to_be_bytes());
    psd.extend(2u32.to_be_bytes());
    psd.extend(3u32.to_be_bytes());
    psd.extend(8u16.to_be_bytes());
    psd.extend(3u16.to_be_bytes());
    psd.extend(0u32.to_be_bytes()); // color data section
    psd.extend((resource.len() as u32).to_be_bytes());
    psd.extend(resource);
    psd.extend(0u32.to_be_bytes()); // layer/mask section
    psd.extend(0u16.to_be_bytes()); // raw merged pixels
    psd.extend([0; 18]);
    psd
}

#[test]
fn creates_psd_thumbnail_and_clip_export_without_touching_originals() {
    let folder = tempfile::tempdir().unwrap();
    let psd = psd_with_thumbnail();
    let clip = b"opaque exact Clip Studio Paint bytes";
    let root = folder.path();
    fs::write(root.join("Sample.psd"), &psd).unwrap();
    fs::write(root.join("Sample.clip"), clip).unwrap();
    let repo = Repository::init(root, vec!["Sample.psd".into(), "Sample.clip".into()]).unwrap();
    let baseline = repo.history().unwrap().remove(0);
    let preview = formats::get(&repo, &baseline.id, "Sample.psd")
        .unwrap()
        .unwrap();
    assert_eq!(
        (preview.width, preview.height, preview.adapter),
        (3, 2, "psd")
    );
    assert!(formats::get(&repo, &baseline.id, "Sample.clip")
        .unwrap()
        .is_none());

    let png = root.join("Export.png");
    RgbImage::from_pixel(8, 4, Rgb([19, 28, 37]))
        .save(&png)
        .unwrap();
    let preview = formats::attach(&repo, &baseline.id, "Sample.clip", &png).unwrap();
    assert_eq!(
        (preview.width, preview.height, preview.adapter),
        (8, 4, "export")
    );
    let reopened = Repository::open(root).unwrap();
    let persisted = formats::get(&reopened, &baseline.id, "Sample.clip")
        .unwrap()
        .unwrap();
    assert_eq!(persisted.data_url, preview.data_url);
    assert_eq!(fs::read(root.join("Sample.psd")).unwrap(), psd);
    assert_eq!(fs::read(root.join("Sample.clip")).unwrap(), clip);
}

#[test]
fn unsupported_preview_still_restores_exactly() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path();
    let bad = b"8BPS\0\x01 broken and unsupported";
    fs::write(root.join("unsupported.psd"), bad).unwrap();
    let repo = Repository::init(root, vec!["unsupported.psd".into()]).unwrap();
    let baseline = repo.history().unwrap().remove(0);
    assert!(formats::get(&repo, &baseline.id, "unsupported.psd")
        .unwrap()
        .is_none());
    let copy = root.join("copy.psd");
    restore::as_copy(&repo, &baseline.id, "unsupported.psd", &copy).unwrap();
    assert_eq!(fs::read(copy).unwrap(), bad);
}
