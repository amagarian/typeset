mod gemini;
mod keychain;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            keychain::set_gemini_key,
            keychain::get_gemini_key,
            keychain::has_gemini_key,
            keychain::clear_gemini_key,
            keychain::registry_set_credentials,
            keychain::registry_get_credentials,
            keychain::registry_has_credentials,
            keychain::registry_clear_credentials,
            gemini::gemini_detect_fields,
            gemini::gemini_detect_fields_images,
            gemini::gemini_test_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
