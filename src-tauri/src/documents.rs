//! v0.6.32 — encrypted local document persistence.
//!
//! Companion to `projects.rs`. Whereas `projects.enc` holds the small,
//! frequently-edited Project records, documents are large (the actual
//! PDF bytes are typically 100 KB – 5 MB) but their metadata changes
//! frequently while their bytes change exactly once (on import). To
//! avoid churning multi-MB blobs on every status / template update,
//! the on-disk layout is split:
//!
//! - `documents.enc`           encrypted JSON for ALL document metadata
//!                             (one blob; small, debounce-rewritten).
//! - `documents/{docId}.bin`   encrypted PDF bytes for a single doc
//!                             (written once at import, read lazily).
//!
//! ## On-disk format (both files)
//!
//! ```text
//! [0..12]   12-byte AES-GCM nonce, fresh per write (`OsRng`)
//! [12..]    AES-256-GCM ciphertext + 16-byte auth tag (concatenated)
//! ```
//!
//! ## Key management
//!
//! A separate 256-bit AES key from the projects key, stored under
//! `service = "com.typeset.app"`, `account = "documents-encryption-key-v1"`.
//! Distinct keys keep the two stores independently rotatable and let
//! "clear all documents" tooling scope by account without touching
//! projects.
//!
//! ## Metadata JSON shape
//!
//! ```jsonc
//! {
//!   "schemaVersion": 1,
//!   "documents": [<ProjectDocument>, ...]   // flat list; group by projectId on the TS side
//! }
//! ```
//!
//! The renderer strips `pdfBytes` from each `ProjectDocument` before
//! handing the JSON to `write_documents`; bytes are routed through
//! `write_document_pdf` instead.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYCHAIN_SERVICE: &str = "com.typeset.app";
const KEYCHAIN_ACCOUNT: &str = "documents-encryption-key-v1";

const APP_DIR: &str = "Typeset";
const META_FILE_NAME: &str = "documents.enc";
const META_TMP_FILE_NAME: &str = "documents.enc.tmp";
const PDF_SUBDIR: &str = "documents";

const NONCE_LEN: usize = 12;

const KEYCHAIN_DENIED_MSG: &str =
    "Cannot access macOS Keychain. Documents can't be saved until you allow Typeset access in System Settings.";

/// Serialise concurrent metadata writes from rapid autosaves. PDF
/// byte writes are inherently per-file and don't share this lock —
/// they're protected by the atomic rename at the filesystem level.
static META_WRITE_LOCK: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .ok_or_else(|| "Could not resolve Application Support directory.".to_string())?;
    let dir = base.join(APP_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    }
    Ok(dir)
}

fn pdf_subdir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join(PDF_SUBDIR);
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create documents subdir: {e}"))?;
    }
    Ok(dir)
}

fn meta_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(META_FILE_NAME))
}

fn meta_tmp_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(META_TMP_FILE_NAME))
}

/// Guard against path-traversal / shell injection. Document ids
/// come from the TS layer (`doc-{Date.now()}-{random}`), so the
/// expected character set is narrow.
fn sanitize_doc_id(doc_id: &str) -> Result<String, String> {
    if doc_id.is_empty() || doc_id.len() > 128 {
        return Err("Invalid document id length".into());
    }
    for ch in doc_id.chars() {
        if !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_' {
            return Err(format!("Invalid character in document id: {ch:?}"));
        }
    }
    Ok(doc_id.to_string())
}

fn pdf_path(doc_id: &str) -> Result<PathBuf, String> {
    let safe = sanitize_doc_id(doc_id)?;
    Ok(pdf_subdir()?.join(format!("{safe}.bin")))
}

// ---------------------------------------------------------------------------
// Keychain-backed AES key
// ---------------------------------------------------------------------------

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("Failed to open keychain entry: {e}"))
}

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
        .map_err(|e| format!("Stored documents key is malformed: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "Stored documents key has unexpected length {}",
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
// Tauri commands — metadata
// ---------------------------------------------------------------------------

/// Decrypt and return the on-disk document metadata as a JSON string.
///
/// Behaviour matches `read_projects`:
/// - Missing file → `Ok("{}")`. First-launch path — UI shows empty.
/// - Decrypt failure → rename to `documents.enc.broken-{epoch}`,
///   return `Ok("{}")`, log to stderr.
/// - Keychain denied → `Err(KEYCHAIN_DENIED_MSG)`.
#[tauri::command]
pub async fn read_documents() -> Result<String, String> {
    let path = meta_path()?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    let key = load_or_create_key()?;
    let blob =
        fs::read(&path).map_err(|e| format!("Failed to read documents metadata: {e}"))?;
    match decrypt(&blob, &key) {
        Ok(plaintext) => String::from_utf8(plaintext)
            .map_err(|e| format!("Decrypted documents blob is not valid UTF-8: {e}")),
        Err(err) => {
            eprintln!(
                "[Typeset] documents.enc decrypt failed ({err}); backing up and starting fresh."
            );
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let broken = path.with_file_name(format!("documents.enc.broken-{timestamp}"));
            if let Err(rename_err) = fs::rename(&path, &broken) {
                eprintln!("[Typeset] Could not rename corrupted documents file: {rename_err}");
            }
            Ok("{}".to_string())
        }
    }
}

/// Encrypt + atomically write the document metadata JSON blob.
#[tauri::command]
pub async fn write_documents(json: String) -> Result<(), String> {
    let _guard = META_WRITE_LOCK
        .lock()
        .map_err(|e| format!("write lock poisoned: {e}"))?;
    let key = load_or_create_key()?;
    let blob = encrypt(json.as_bytes(), &key)?;
    let tmp = meta_tmp_path()?;
    let final_path = meta_path()?;
    fs::write(&tmp, &blob).map_err(|e| format!("Failed to write tmp metadata file: {e}"))?;
    fs::rename(&tmp, &final_path)
        .map_err(|e| format!("Failed to commit documents metadata: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands — per-document PDF binary
// ---------------------------------------------------------------------------

/// Read the encrypted PDF bytes for a single document. Returns
/// `Ok(None)` when the file doesn't exist (caller decides whether
/// that's "deleted" or "never persisted") and silently scrubs a
/// corrupt file before returning `Ok(None)` so the renderer falls
/// back to the "ask user to re-upload" path.
#[tauri::command]
pub async fn read_document_pdf(doc_id: String) -> Result<Option<Vec<u8>>, String> {
    let path = pdf_path(&doc_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let key = load_or_create_key()?;
    let blob = fs::read(&path).map_err(|e| format!("Failed to read PDF file: {e}"))?;
    match decrypt(&blob, &key) {
        Ok(plaintext) => Ok(Some(plaintext)),
        Err(err) => {
            eprintln!("[Typeset] document PDF decrypt failed for {doc_id} ({err}); removing.");
            let _ = fs::remove_file(&path);
            Ok(None)
        }
    }
}

/// Encrypt + atomically write the PDF bytes for a single document.
#[tauri::command]
pub async fn write_document_pdf(doc_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let key = load_or_create_key()?;
    let blob = encrypt(&bytes, &key)?;
    let final_path = pdf_path(&doc_id)?;
    let tmp = final_path.with_extension("bin.tmp");
    fs::write(&tmp, &blob).map_err(|e| format!("Failed to write tmp PDF file: {e}"))?;
    fs::rename(&tmp, &final_path).map_err(|e| format!("Failed to commit PDF file: {e}"))?;
    Ok(())
}

/// Best-effort delete of the on-disk PDF file. Missing file is a
/// no-op — the metadata-side delete is the source of truth, and we
/// don't want a stale-file mismatch to fail the user-facing delete.
#[tauri::command]
pub async fn delete_document_pdf(doc_id: String) -> Result<(), String> {
    let path = pdf_path(&doc_id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete PDF file: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_encrypt_decrypt() {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        let payload = br#"{"schemaVersion":1,"documents":[]}"#;
        let blob = encrypt(payload, &key).expect("encrypt");
        assert!(blob.len() >= NONCE_LEN + payload.len());
        let plain = decrypt(&blob, &key).expect("decrypt");
        assert_eq!(plain, payload);
    }

    #[test]
    fn sanitize_accepts_valid_ids() {
        assert!(sanitize_doc_id("doc-1700123456-abc123").is_ok());
        assert!(sanitize_doc_id("a_b-c").is_ok());
    }

    #[test]
    fn sanitize_rejects_traversal() {
        assert!(sanitize_doc_id("../etc/passwd").is_err());
        assert!(sanitize_doc_id("doc/with/slash").is_err());
        assert!(sanitize_doc_id("").is_err());
    }
}
