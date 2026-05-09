//! OS-keychain wrapper for Typeset's secret material.
//!
//! On macOS this uses the system Keychain; on Windows the Credential Manager;
//! on Linux the Secret Service (libsecret). All access goes through the
//! `keyring` crate so the renderer never sees the raw secrets.
//!
//! Accounts (all under service `typeset`):
//!   - `gemini-api-key`              the Gemini detection API key
//!
//! As of v0.5.8 the Supabase template-registry credentials are baked
//! into the binary at build time (URL + publishable key, with optional
//! `VITE_SUPABASE_*` overrides for staging) so they no longer need to
//! be persisted here. Keychain entries from earlier versions
//! (`registry-supabase-url`, `registry-supabase-anon-key`) on user
//! machines are simply ignored — the new code path never reads them.
//!
//! Earlier versions stored an Anthropic key under `anthropic-api-key`;
//! we don't migrate it because the keys are not interchangeable. Users
//! update once via the Settings panel.

use keyring::Entry;

const SERVICE: &str = "typeset";
const GEMINI_ACCOUNT: &str = "gemini-api-key";

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
