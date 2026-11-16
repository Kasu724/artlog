use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    path: String,
    name: String,
}

#[tauri::command]
fn open_project(path: String) -> Result<ProjectInfo, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("Choose a folder that exists on this device.".into());
    }
    let name = root
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("Art project")
        .to_owned();
    Ok(ProjectInfo { path, name })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_project])
        .run(tauri::generate_context!())
        .expect("error while running ArtLog");
}
