//! OS-keychain wrapper for Typeset's secret material.
//!
//! On macOS this uses the system Keychain; on Windows the Credential Manager;
//! on Linux the Secret Service (libsecret). All access goes through the
//! `keyring` crate so the renderer never sees the raw secrets.
//!
//! Accounts (all under service `typeset`):
//!   - `gemini-api-key`              the Gemini detection API key (legacy; see below)
//!
//! As of v0.5.8 the Supabase template-registry credentials are baked
//! into the binary at build time (URL + publishable key, with optional
//! `VITE_SUPABASE_*` overrides for staging) so they no longer need to
//! be persisted here. Keychain entries from earlier versions
//! (`registry-supabase-url`, `registry-supabase-anon-key`) on user
//! machines are simply ignored — the new code path never reads them.
//!
//! Earlier versions stored an Anthropic key under `anthropic-api-key`;
//! we don't migrate it because the keys are not interchangeable.
//!
//! Gemini API keys:
//!   - **Keychain** (`gemini-api-key`) — set in Settings; takes precedence
//!     over any build-time key (local override / rotation).
//!   - **Compile-time** — optional `TYPESET_GEMINI_API_KEY` env var at
//!     `cargo build` time (e.g. CI secret). Middle ground: not in git, but
//!     still recoverable from the shipped binary (not a substitute for a
//!     server-side proxy).

use keyring::Entry;
use serde::Serialize;

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

/// Non-empty value baked in at **compile time** when `TYPESET_GEMINI_API_KEY`
/// is set in the environment for `cargo build`. Never read from runtime env.
fn embedded_gemini_key() -> Option<&'static str> {
    match option_env!("TYPESET_GEMINI_API_KEY") {
        Some(raw) => {
            let t = raw.trim();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        None => None,
    }
}

/// Read the Gemini API key for `gemini.rs` detection commands.
pub fn read_api_key() -> Option<String> {
    read_secret(GEMINI_ACCOUNT)
}

/// Keychain first (user override), then compile-time embedded key.
pub fn resolve_gemini_api_key() -> Result<String, String> {
    if let Some(k) = read_api_key() {
        return Ok(k);
    }
    if let Some(k) = embedded_gemini_key() {
        return Ok(k.to_string());
    }
    Err(
        "Gemini API key is not configured. Open Settings (⌘,) and paste a key from Google AI Studio."
            .to_string(),
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct GeminiKeyStatus {
    /// Whether this binary was built with `TYPESET_GEMINI_API_KEY` set.
    pub build_time_key_present: bool,
    pub keychain_key_present: bool,
}

#[tauri::command]
pub fn get_gemini_key_status() -> Result<GeminiKeyStatus, String> {
    Ok(GeminiKeyStatus {
        build_time_key_present: embedded_gemini_key().is_some(),
        keychain_key_present: read_api_key().is_some(),
    })
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
    Ok(read_api_key().is_some() || embedded_gemini_key().is_some())
}

#[tauri::command]
pub fn clear_gemini_key() -> Result<(), String> {
    delete_secret(GEMINI_ACCOUNT)
}
