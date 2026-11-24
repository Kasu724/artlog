mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Desktop::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::open_clip,
            commands::open_container_project,
            commands::close_project,
            commands::project_view,
            commands::project_state,
            commands::project_files,
            commands::list_commit_files,
            commands::create_checkpoint,
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
            commands::attach_preview,
            commands::stop_tracking,
            commands::relink_file,
            commands::rename_project,
            commands::delete_file_history,
            commands::delete_history,
            commands::remove_project,
            commands::list_trash,
            commands::restore_trash,
            commands::purge_trash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ArtLog");
}
