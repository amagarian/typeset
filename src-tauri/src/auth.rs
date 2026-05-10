//! v0.5.35 — Supabase auth session storage.
//!
//! The renderer drives the magic-link flow (it owns the
//! `@supabase/supabase-js` auth client). All this module does is
//! round-trip the resulting `Session` JSON through the OS keychain so
//! the session survives quits without ever touching localStorage —
//! same posture as `keychain.rs` (Gemini API key) and `projects.rs`
//! (project-encryption AES key).
//!
//! ## Why the keychain, not localStorage
//!
//! `localStorage` on macOS lives in the WebKit data store under
//! `~/Library/WebKit/...`, unencrypted. Storing a Supabase session
//! token there would mean every browser-cookie-grabber malware
//! family on macOS suddenly knows how to drain Typeset accounts.
//! The keychain is encrypted at rest, scoped to the app's signing
//! identity, and prompts the user the first time another app
//! (including a malicious one) tries to read the entry.
//!
//! ## Wire shape
//!
//! `auth_save_session` takes the JSON-stringified Supabase
//! [`Session`](https://supabase.com/docs/reference/javascript/auth-getsession)
//! object verbatim. We never parse it server-side — supabase-js
//! handles refreshing the access token from the refresh token, and
//! the Rust side is just a (write, read, delete) blob store.
//!
//! ## Service / account
//!
//! - service: `app.typeset.auth`
//! - account: `session-v1`
//!
//! Distinct from the existing keychain entries (`typeset` and
//! `com.typeset.app`) so the auth session can be cleared
//! independently of the API key + project encryption key. v0.5.36
//! may bump to `session-v2` if Supabase changes its session shape.

use keyring::Entry;

const SERVICE: &str = "app.typeset.auth";
const ACCOUNT: &str = "session-v1";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("auth keychain entry init failed: {e}"))
}

/// Persist the Supabase session JSON. Overwrites any existing
/// session — the renderer is the single writer and decides when
/// the on-disk session is stale.
#[tauri::command]
pub fn auth_save_session(json: String) -> Result<(), String> {
    if json.trim().is_empty() {
        return Err("Refusing to save an empty session.".into());
    }
    entry()?
        .set_password(&json)
        .map_err(|e| format!("Failed to save auth session: {e}"))
}

/// Read the persisted session JSON. Returns `None` on first launch
/// (no entry yet) and on any non-`NoEntry` error — the latter
/// matches the gemini key path: better to fall through to a
/// signed-out state than throw and break the UI.
#[tauri::command]
pub fn auth_load_session() -> Result<Option<String>, String> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            // Don't surface this as an error to the renderer — a
            // keychain access denial on cold launch should leave the
            // user signed out, not show a scary modal. Log for support
            // and treat as no-session.
            eprintln!("[Typeset] auth_load_session: keychain read failed ({e}); treating as no-session.");
            Ok(None)
        }
    }
}

/// Delete the persisted session. Idempotent — a missing entry is
/// not an error so the renderer can call this on every sign-out
/// without first checking for existence.
#[tauri::command]
pub fn auth_clear_session() -> Result<(), String> {
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear auth session: {e}")),
    }
}
