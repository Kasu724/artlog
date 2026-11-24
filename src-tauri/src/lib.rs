mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Desktop::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_clip,
            commands::open_container_project,
            commands::close_project,
            commands::project_view,
            commands::project_state,
            commands::list_commit_files,
            commands::update_version_details,
            commands::save_settings,
            commands::set_history_compression,
            commands::repack_history,
            commands::restore_copy,
            commands::restore_in_place,
            commands::repository_health,
            commands::get_preview,
            commands::get_commit_thumbnail,
            commands::comparison_versions,
            commands::relink_file,
            commands::rename_project,
            commands::delete_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ArtLog");
}
