mod auth;
mod gemini;
mod keychain;
mod projects;
mod sync;

use tauri::Emitter;

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

/// v0.5.35 — Tauri event emitted whenever the OS hands us a deep
/// link (e.g. `typeset://auth/callback?token_hash=…&type=magiclink`).
/// The frontend `authClient` listens for this and feeds the URL
/// into `supabase.auth.verifyOtp(...)` to complete the magic-link
/// sign-in handshake. Centralised so the Rust emit and the TS
/// listener can't drift.
const DEEP_LINK_EVENT: &str = "deep-link:url";

/// v0.5.27 — menu item id for the Settings entry under the app
/// submenu. Bound to the standard macOS shortcut (`Cmd+,`) and
/// emitted as `menu:open-settings` so the React layer can flip
/// the SettingsModal open without owning any of the macOS plumbing.
#[cfg(target_os = "macos")]
const SETTINGS_MENU_ID: &str = "menu-settings";

/// v0.5.27 — name of the Tauri event the frontend listens for.
/// Centralised so the Rust emit and the TS listener can't drift.
#[cfg(target_os = "macos")]
const SETTINGS_EVENT: &str = "menu:open-settings";

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            keychain::set_gemini_key,
            keychain::get_gemini_key,
            keychain::has_gemini_key,
            keychain::get_gemini_key_status,
            keychain::clear_gemini_key,
            gemini::gemini_detect_fields,
            gemini::gemini_detect_fields_images,
            gemini::gemini_test_connection,
            projects::read_projects,
            projects::write_projects,
            auth::auth_save_session,
            auth::auth_load_session,
            auth::auth_clear_session,
            sync::sync_save_key,
            sync::sync_load_key,
            sync::sync_clear_key,
        ])
        .setup(|app| {
            // v0.5.35 — magic-link callbacks.
            //
            // Supabase emails the user a link of the form
            // `typeset://auth/callback?token_hash=…&type=magiclink`.
            // macOS hands the URL to `tauri-plugin-deep-link` which
            // fires this callback. We forward each URL to the
            // renderer as a `deep-link:url` event, then surface the
            // main window so the user lands on the open SettingsModal
            // and can see the "Signed in" state instead of an
            // already-completed flow they never saw. The renderer
            // listener (services/authClient.ts) does the actual
            // verifyOtp + session persistence.
            //
            // The OnOpenUrl callback also fires for cold-start deep
            // links — `getCurrent()` from the JS side is what handles
            // that on the renderer's side, since the listener won't
            // be attached yet at the moment the URL arrives. So this
            // emit is the warm-start path; the cold-start path is
            // handled in TS via `getCurrent()`.
            let app_handle_for_deep_link = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event
                    .urls()
                    .iter()
                    .map(|url| url.to_string())
                    .collect();
                if urls.is_empty() {
                    return;
                }
                if let Some(window) = app_handle_for_deep_link.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
                if let Err(err) = app_handle_for_deep_link.emit(DEEP_LINK_EVENT, urls) {
                    eprintln!("[Typeset] failed to emit deep link event: {err}");
                }
            });
            // v0.5.27 — first pass at native macOS menu wiring.
            //
            // Up to v0.5.26 the app shipped without a custom menu, so
            // the OS provided only the default app submenu and the
            // Settings UI was reachable solely via a sidebar button.
            // The sidebar Settings button has now been dropped per
            // user feedback, so we install a real menu here whose
            // primary purpose is binding `Cmd+,` to the existing
            // SettingsModal. Other items are predefined system items
            // (Hide / Quit / Edit / Window) that come "for free" from
            // Tauri's menu builder; we include them so the OS-level
            // shortcuts (Cmd+Q, Cmd+M, Cmd+C, …) keep working
            // intuitively now that we own the menu surface.
            //
            // Scoped to macOS — `setup` runs on every desktop platform
            // and the predefined items have surprising behaviour /
            // gaps on Windows + Linux (per Tauri docs). We can broaden
            // later if/when a non-macOS target appears.
            #[cfg(target_os = "macos")]
            {
                let settings_item = MenuItemBuilder::new("Settings…")
                    .id(SETTINGS_MENU_ID)
                    .accelerator("CmdOrCtrl+,")
                    .build(app)?;

                let about_metadata = AboutMetadataBuilder::new()
                    .name(Some("Typeset"))
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .build();

                // First (app) submenu — its title is replaced by macOS
                // with the bundle display name, so the literal here is
                // only used as a fallback identifier.
                let app_submenu = SubmenuBuilder::new(app, "Typeset")
                    .about(Some(about_metadata))
                    .separator()
                    .item(&settings_item)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let view_submenu = SubmenuBuilder::new(app, "View")
                    .fullscreen()
                    .build()?;

                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .maximize()
                    .separator()
                    .close_window()
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .items(&[
                        &app_submenu,
                        &edit_submenu,
                        &view_submenu,
                        &window_submenu,
                    ])
                    .build()?;

                app.set_menu(menu)?;

                // Listen for menu activations and bridge them to the
                // frontend. Frontend listener (App.tsx) is keyed on
                // SETTINGS_EVENT and idempotently flips the modal
                // open — so it's safe if the listener attaches after
                // an early menu fire (no double-open).
                app.on_menu_event(move |app_handle, event| {
                    if event.id() == settings_item.id() {
                        let _ = app_handle.emit(SETTINGS_EVENT, ());
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
