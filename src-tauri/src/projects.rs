//! v0.5.28 — encrypted local project persistence.
//!
//! Up through v0.5.27 the project list was a `useState` seeded from
//! `mockProjects`, so anything the user typed died on quit. This
//! module is the on-disk half of the fix: the renderer now hands us
//! the canonical project blob (a single JSON string holding the
//! whole `ProjectStore`) and we round-trip it through an AES-256-GCM
//! encrypted file in the macOS Application Support directory.
//!
//! ## On-disk format
//!
//! ```text
//! [0..12]   12-byte AES-GCM nonce, fresh per write (`OsRng`)
//! [12..]    AES-256-GCM ciphertext + 16-byte auth tag (concatenated)
//! ```
//!
//! Single blob. No header, no length prefix, no schema bytes — the
//! encrypted payload itself is JSON whose top-level shape carries a
//! `schemaVersion` field, which is the layer that v0.5.29 will use
//! to migrate the format. The on-disk crypto envelope is intentionally
//! minimal so we can swap nonce/key conventions without breaking it.
//!
//! ## Key management
//!
//! The 256-bit AES key lives in the OS keychain under
//! `service = "com.typeset.app"`, `account = "projects-encryption-key-v1"`,
//! base64-encoded so the keychain entry stays a UTF-8 string. On first
//! `write_projects` we generate a fresh key from `OsRng`; subsequent
//! reads/writes reuse it. v0.5.29 will introduce a per-user (auth-derived)
//! key — at that point this device key gets used once to decrypt the
//! existing local file before re-encrypting under the new scheme.
//!
//! ## Atomic writes
//!
//! Every `write_projects` writes to `projects.enc.tmp` then renames it
//! over `projects.enc`. The rename is atomic on macOS (and APFS in
//! general), so a crash mid-write leaves the previous file intact.
//!
//! ## Concurrency
//!
//! Front-end autosave is debounced to 500ms but rapid edits can still
//! produce overlapping writes. A process-wide `Mutex<()>` serialises
//! the write half; reads are independent.
//!
//! ## Failure modes
//!
//! - Missing file → `read_projects` returns `"[]"` so the UI renders
//!   an empty list with no error.
//! - Decrypt failure (corruption, key mismatch) → the broken blob is
//!   renamed to `projects.enc.broken-{epoch}` for forensics, the
//!   call returns `"[]"` so the user can keep working, and the
//!   failure is logged to stderr.
//! - Keychain access denied → the call returns a meaningful string
//!   that the renderer surfaces to the user verbatim.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Service used for the OS keychain entry. Distinct from the
/// `"typeset"` service used by `keychain.rs` for the Gemini API key
/// so the two secrets are addressable independently — and so that
/// "clear all of Typeset's data" tooling can scope by service.
const KEYCHAIN_SERVICE: &str = "com.typeset.app";

/// v1 account name. Bumped if v0.5.29's per-user key migration needs
/// to coexist with the device key during a one-shot decrypt-then-
/// re-encrypt step.
const KEYCHAIN_ACCOUNT: &str = "projects-encryption-key-v1";

const FILE_NAME: &str = "projects.enc";
const TMP_FILE_NAME: &str = "projects.enc.tmp";
const APP_DIR: &str = "Typeset";

/// Length (bytes) of the AES-256-GCM nonce. AEAD spec: 96 bits.
const NONCE_LEN: usize = 12;

/// Serialise concurrent writes from rapid autosaves. The mutex is
/// taken for the full encrypt + write path; reads don't contend.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// `~/Library/Application Support/Typeset/` on macOS, equivalent on
/// other platforms. Created on first call so callers don't need to
/// gate on existence.
fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .ok_or_else(|| "Could not resolve Application Support directory.".to_string())?;
    let dir = base.join(APP_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    }
    Ok(dir)
}

fn projects_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(FILE_NAME))
}

fn tmp_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(TMP_FILE_NAME))
}

// ---------------------------------------------------------------------------
// Keychain-backed AES key
// ---------------------------------------------------------------------------

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("Failed to open keychain entry: {e}"))
}

/// Human-readable error string for the renderer to display verbatim
/// when keychain access is denied. The text doubles as the user-
/// visible UI copy — keep it actionable.
const KEYCHAIN_DENIED_MSG: &str =
    "Cannot access macOS Keychain. Projects can't be saved until you allow Typeset access in System Settings.";

/// Read the existing 256-bit project key from the OS keychain, or
/// generate + persist a fresh one on first use. Returns the raw key
/// bytes so callers can wrap them in `aes_gcm::Key` directly.
///
/// `keyring::Error::NoEntry` is the only "expected" error — every
/// other failure (PlatformFailure, etc.) is treated as a real access
/// problem and surfaced through the user-facing copy.
fn load_or_create_key() -> Result<[u8; 32], String> {
    let entry = keychain_entry()?;
    match entry.get_password() {
        Ok(value) => decode_key(&value),
        Err(keyring::Error::NoEntry) => generate_and_store_key(&entry),
        Err(e) => Err(format!("{KEYCHAIN_DENIED_MSG} ({e})")),
    }
}

fn decode_key(encoded: &str) -> Result<[u8; 32], String> {
    let bytes = B64
        .decode(encoded.trim())
        .map_err(|e| format!("Stored project key is malformed: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "Stored project key has unexpected length {}",
            bytes.len()
        ));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn generate_and_store_key(entry: &keyring::Entry) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let encoded = B64.encode(key);
    entry
        .set_password(&encoded)
        .map_err(|e| format!("{KEYCHAIN_DENIED_MSG} ({e})"))?;
    Ok(key)
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

fn encrypt(plaintext: &[u8], key_bytes: &[u8; 32]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    // 12-byte nonce per write, OsRng-sourced. AES-GCM requires a
    // unique nonce per (key, message); randomly drawing 96 bits is
    // safe up to ~2^32 messages under the same key, well above any
    // plausible autosave volume.
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt(blob: &[u8], key_bytes: &[u8; 32]) -> Result<Vec<u8>, String> {
    if blob.len() < NONCE_LEN {
        return Err(format!(
            "ciphertext too short ({} < {NONCE_LEN} bytes)",
            blob.len()
        ));
    }
    let (nonce_bytes, body) = blob.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    cipher
        .decrypt(nonce, body)
        .map_err(|e| format!("decrypt failed: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Decrypt and return the on-disk project store as a JSON string.
///
/// Behaviour:
/// - File missing → `Ok("[]")`. First-launch path — the UI shows an
///   empty list and no warning.
/// - File present but undecryptable → rename to
///   `projects.enc.broken-{epoch}`, log to stderr, return `Ok("[]")`.
///   The user keeps working with a clean slate; the broken blob is
///   preserved for support.
/// - Keychain denied → `Err(KEYCHAIN_DENIED_MSG)`. The renderer
///   surfaces this via its toast machinery.
#[tauri::command]
pub async fn read_projects() -> Result<String, String> {
    let path = projects_path()?;
    if !path.exists() {
        return Ok("[]".to_string());
    }
    let key = load_or_create_key()?;
    let blob = fs::read(&path).map_err(|e| format!("Failed to read projects file: {e}"))?;
    match decrypt(&blob, &key) {
        Ok(plaintext) => String::from_utf8(plaintext)
            .map_err(|e| format!("Decrypted projects blob is not valid UTF-8: {e}")),
        Err(err) => {
            eprintln!(
                "[Typeset] projects.enc decrypt failed ({err}); backing up and starting fresh."
            );
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let broken = path.with_file_name(format!("projects.enc.broken-{timestamp}"));
            // Best-effort rename: if it fails, we still return Ok so
            // the user isn't left in a frozen state. The next write
            // will overwrite the broken file via the atomic-rename
            // path below.
            if let Err(rename_err) = fs::rename(&path, &broken) {
                eprintln!("[Typeset] Could not rename corrupted projects file: {rename_err}");
            }
            Ok("[]".to_string())
        }
    }
}

/// Encrypt the supplied JSON blob and atomically write it to
/// `projects.enc`. Serialised against itself by `WRITE_LOCK`.
///
/// Atomicity: write to `projects.enc.tmp`, then rename over
/// `projects.enc`. APFS guarantees the rename is atomic, so a crash
/// mid-write leaves the previous file intact.
#[tauri::command]
pub async fn write_projects(json: String) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|e| format!("write lock poisoned: {e}"))?;
    let key = load_or_create_key()?;
    let blob = encrypt(json.as_bytes(), &key)?;
    let tmp = tmp_path()?;
    let final_path = projects_path()?;
    fs::write(&tmp, &blob).map_err(|e| format!("Failed to write tmp file: {e}"))?;
    fs::rename(&tmp, &final_path)
        .map_err(|e| format!("Failed to commit projects file: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_encrypt_decrypt() {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        let payload = br#"{"schemaVersion":1,"projects":[]}"#;
        let blob = encrypt(payload, &key).expect("encrypt");
        // Nonce is the first 12 bytes; ciphertext + tag follows.
        assert!(blob.len() >= NONCE_LEN + payload.len());
        let plain = decrypt(&blob, &key).expect("decrypt");
        assert_eq!(plain, payload);
    }

    #[test]
    fn decrypt_fails_with_wrong_key() {
        let mut k1 = [0u8; 32];
        let mut k2 = [0u8; 32];
        OsRng.fill_bytes(&mut k1);
        OsRng.fill_bytes(&mut k2);
        let blob = encrypt(b"hello", &k1).expect("encrypt");
        assert!(decrypt(&blob, &k2).is_err());
    }

    #[test]
    fn decrypt_short_blob_errors() {
        let key = [0u8; 32];
        let too_short = vec![0u8; NONCE_LEN - 1];
        assert!(decrypt(&too_short, &key).is_err());
    }
}
