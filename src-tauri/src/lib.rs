mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::Desktop::default())
        .invoke_handler(tauri::generate_handler![
            commands::scan_project,
            commands::activate_project,
            commands::close_project,
            commands::project_view,
            commands::project_files,
            commands::list_commit_files,
            commands::create_checkpoint,
            commands::save_settings,
            commands::restore_copy,
            commands::restore_in_place,
            commands::repository_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ArtLog");
}
