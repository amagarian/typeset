//! OS-keychain wrapper for Typeset's secret material.
//!
//! On macOS this uses the system Keychain; on Windows the Credential Manager;
//! on Linux the Secret Service (libsecret). All access goes through the
//! `keyring` crate so the renderer never sees the raw secrets.
//!
//! Accounts (all under service `typeset`):
//!   - `gemini-api-key`              the Gemini detection API key
//!   - `registry-supabase-url`       the user's Supabase project URL
//!   - `registry-supabase-anon-key`  the publishable / anon key
//!
//! The Supabase pair is stored alongside the Gemini key (rather than in
//! a config file) so that:
//!   1. The user can change projects without rebuilding the app — no
//!      .env, no `import.meta.env.VITE_SUPABASE_*`.
//!   2. The publishable key, while not strictly secret, is treated as
//!      sensitive runtime config and never lands in plain-text on disk.
//!   3. The renderer always pulls credentials through the same Tauri
//!      command path it uses for the Gemini key, keeping the surface
//!      area uniform.
//!
//! Earlier versions stored an Anthropic key under `anthropic-api-key`;
//! we don't migrate it because the keys are not interchangeable. Users
//! update once via the Settings panel.

use keyring::Entry;

const SERVICE: &str = "typeset";
const GEMINI_ACCOUNT: &str = "gemini-api-key";
const REGISTRY_URL_ACCOUNT: &str = "registry-supabase-url";
const REGISTRY_ANON_ACCOUNT: &str = "registry-supabase-anon-key";

fn entry_for(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("keychain entry init failed: {e}"))
}

fn read_secret(account: &str) -> Option<String> {
    let entry = match entry_for(account) {
        Ok(e) => e,
        Err(_) => return None,
    };
    match entry.get_password() {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

fn write_secret(account: &str, value: &str) -> Result<(), String> {
    entry_for(account)?
        .set_password(value)
        .map_err(|e| format!("Failed to save key: {e}"))
}

fn delete_secret(account: &str) -> Result<(), String> {
    let entry = entry_for(account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear key: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Gemini API key
// ---------------------------------------------------------------------------

/// Internal helper used by the Gemini command to fetch the key inside Rust.
pub fn read_api_key() -> Option<String> {
    read_secret(GEMINI_ACCOUNT)
}

#[tauri::command]
pub fn set_gemini_key(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty.".into());
    }
    write_secret(GEMINI_ACCOUNT, trimmed)
}

#[tauri::command]
pub fn get_gemini_key() -> Result<Option<String>, String> {
    Ok(read_api_key())
}

#[tauri::command]
pub fn has_gemini_key() -> Result<bool, String> {
    Ok(read_api_key().is_some())
}

#[tauri::command]
pub fn clear_gemini_key() -> Result<(), String> {
    delete_secret(GEMINI_ACCOUNT)
}

// ---------------------------------------------------------------------------
// Supabase template-registry credentials
//
// `url` is the project URL (e.g. https://xyz.supabase.co).
// `anon_key` is the project's publishable / anon key (the newer
// `sb_publishable_*` format and the legacy JWT-shaped anon key both
// work — Supabase accepts either via `createClient(url, key)`). We
// don't validate the format on either side.
// ---------------------------------------------------------------------------

/// Whatever the renderer pasted into Settings. Both fields are
/// `Option<String>` so the UI can render "configured / not configured"
/// correctly even when only one half exists (e.g. the user wiped the
/// anon key but not the URL).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RegistryCredentials {
    pub url: Option<String>,
    pub anon_key: Option<String>,
}

#[tauri::command]
pub fn registry_set_credentials(url: String, anon_key: String) -> Result<(), String> {
    let url_trimmed = url.trim();
    let key_trimmed = anon_key.trim();
    if url_trimmed.is_empty() {
        return Err("Supabase URL cannot be empty.".into());
    }
    if key_trimmed.is_empty() {
        return Err("Supabase anon key cannot be empty.".into());
    }
    write_secret(REGISTRY_URL_ACCOUNT, url_trimmed)?;
    write_secret(REGISTRY_ANON_ACCOUNT, key_trimmed)?;
    Ok(())
}

#[tauri::command]
pub fn registry_get_credentials() -> Result<RegistryCredentials, String> {
    Ok(RegistryCredentials {
        url: read_secret(REGISTRY_URL_ACCOUNT),
        anon_key: read_secret(REGISTRY_ANON_ACCOUNT),
    })
}

#[tauri::command]
pub fn registry_has_credentials() -> Result<bool, String> {
    Ok(read_secret(REGISTRY_URL_ACCOUNT).is_some() && read_secret(REGISTRY_ANON_ACCOUNT).is_some())
}

#[tauri::command]
pub fn registry_clear_credentials() -> Result<(), String> {
    delete_secret(REGISTRY_URL_ACCOUNT)?;
    delete_secret(REGISTRY_ANON_ACCOUNT)?;
    Ok(())
}
