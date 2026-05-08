mod anthropic;
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
            keychain::set_anthropic_key,
            keychain::get_anthropic_key,
            keychain::has_anthropic_key,
            keychain::clear_anthropic_key,
            anthropic::analyze_pdf_with_claude,
            anthropic::analyze_pdf_agentic,
            anthropic::test_anthropic_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
