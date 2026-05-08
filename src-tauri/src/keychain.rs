//! OS-keychain wrapper for the Gemini API key.
//!
//! On macOS this uses the system Keychain; on Windows the Credential Manager;
//! on Linux the Secret Service (libsecret). All access goes through the
//! `keyring` crate so the renderer never sees the raw key.
//!
//! The keychain account is `gemini-api-key`. Earlier versions of Typeset
//! stored an Anthropic key under `anthropic-api-key`; we don't migrate
//! it because the keys are not interchangeable. Users update once via
//! the Settings panel.

use keyring::Entry;

const SERVICE: &str = "typeset";
const ACCOUNT: &str = "gemini-api-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain entry init failed: {e}"))
}

/// Internal helper used by the Gemini command to fetch the key inside Rust.
pub fn read_api_key() -> Option<String> {
    let entry = match entry() {
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

#[tauri::command]
pub fn set_gemini_key(key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key cannot be empty.".into());
    }
    entry()?
        .set_password(trimmed)
        .map_err(|e| format!("Failed to save key: {e}"))?;
    Ok(())
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
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear key: {e}")),
    }
}
