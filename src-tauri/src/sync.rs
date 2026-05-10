//! v0.5.35 — local cache for the per-account project-sync key.
//!
//! See `src/services/projectSync.ts` for the full architecture. The
//! short version: when a user signs in, the renderer derives or
//! fetches a 256-bit AES-GCM key (the "sync key") that decrypts
//! cloud-stored project payloads. We cache that key in the OS
//! keychain so it survives restarts without round-tripping through
//! Supabase on every cold launch.
//!
//! The renderer is the single owner of the encrypt/decrypt path
//! (WebCrypto in `projectSync.ts`); this module is just a (write,
//! read, delete) blob store, like `auth.rs`. No crypto happens here.
//!
//! ## Threat model — what the keychain protects against
//!
//! - Casual filesystem inspection: yes (encrypted at rest, scoped
//!   to the signing identity).
//! - A second process on the same machine: yes (macOS prompts on
//!   first read from a non-whitelisted binary).
//! - A malicious process running *as Typeset* (e.g. dylib injection,
//!   debugger): no — but at that point the renderer's WebCrypto key
//!   material is already exposed in process memory.
//!
//! ## Service / account
//!
//! - service: `app.typeset.sync`
//! - account: `sync-key-v1`
//!
//! Distinct from `app.typeset.auth` so the sync key can be cleared
//! independently of the auth session (e.g. user wants to re-key
//! sync without signing out, a future "rotate sync key" affordance).

use keyring::Entry;

const SERVICE: &str = "app.typeset.sync";
const ACCOUNT: &str = "sync-key-v1";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("sync keychain entry init failed: {e}"))
}

/// Cache the base64-encoded 32-byte sync key locally.
///
/// The renderer always passes a base64 string so the keychain entry
/// stays printable UTF-8 (matches how `projects.rs` stores its
/// AES key — the keychain's plain-text-only string semantics are
/// the constraint).
#[tauri::command]
pub fn sync_save_key(key_b64: String) -> Result<(), String> {
    if key_b64.trim().is_empty() {
        return Err("Refusing to save an empty sync key.".into());
    }
    entry()?
        .set_password(&key_b64)
        .map_err(|e| format!("Failed to save sync key: {e}"))
}

/// Read the cached sync key. `None` means "not signed in or first
/// device" — the renderer then either fetches it from
/// `user_metadata.sync_key_b64` or generates a fresh one.
#[tauri::command]
pub fn sync_load_key() -> Result<Option<String>, String> {
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
            eprintln!(
                "[Typeset] sync_load_key: keychain read failed ({e}); treating as no-key."
            );
            Ok(None)
        }
    }
}

/// Forget the local sync key. Called on sign-out so a different
/// account on the same machine can't accidentally decrypt the
/// previous account's local cache.
#[tauri::command]
pub fn sync_clear_key() -> Result<(), String> {
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to clear sync key: {e}")),
    }
}
