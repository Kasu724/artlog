use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use artlog_core::{index::ProjectIndex, Kind, Repository};

fn temp_dir(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("artlog-index-{label}-{stamp}"));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn cache_can_be_deleted_and_rebuilt_from_portable_history() {
    let project = temp_dir("project");
    let cache = temp_dir("cache");
    fs::write(project.join("drawing.psd"), b"first version").unwrap();
    let repo = Repository::init(&project, vec!["drawing.psd".into()]).unwrap();
    fs::write(project.join("drawing.psd"), b"second version").unwrap();
    repo.capture(Kind::Checkpoint, "Line art approved", "Ready for color")
        .unwrap();

    let history = repo.history().unwrap();
    assert_eq!(history.len(), 2);
    let index = ProjectIndex::open_or_rebuild(&cache, repo.id(), &history).unwrap();
    assert_eq!(index.list_commits(10, 0).unwrap().len(), history.len());
    drop(index);

    fs::remove_file(cache.join(format!("{}.sqlite3", repo.id()))).unwrap();
    let rebuilt = ProjectIndex::open_or_rebuild(&cache, repo.id(), &history).unwrap();
    assert_eq!(rebuilt.list_commits(10, 0).unwrap().len(), history.len());
    assert_eq!(
        rebuilt.list_checkpoints(10).unwrap()[0].title,
        "Line art approved"
    );
    assert_eq!(
        rebuilt.list_files(&history[0].id).unwrap()[0].path,
        "drawing.psd"
    );
}
