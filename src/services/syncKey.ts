/**
 * v0.5.35 — per-account project-sync key.
 *
 * The 256-bit AES-GCM key used by `projectSync.ts` to encrypt
 * project payloads end-to-end. One key per user, generated on
 * first sign-in, stored in:
 *
 *   1. The local OS keychain (service `app.typeset.sync`,
 *      account `sync-key-v1`) via the Tauri commands
 *      `sync_save_key` / `sync_load_key` / `sync_clear_key` in
 *      `src-tauri/src/sync.rs`. Kept locally so we don't pay
 *      a Supabase round-trip on every cold launch.
 *   2. Supabase `auth.users.user_metadata.sync_key_b64`. Acts as
 *      the cross-device source of truth: a fresh device pulls
 *      the key from there on first sign-in.
 *
 * **Trade-off (documented in the Settings UI fine print):**
 * encryption is real (AES-256-GCM on every payload, fresh nonce
 * per write) but the key lives in user_metadata, which Supabase
 * administrators can theoretically read. We pick this convenience
 * vs. zero-knowledge trade for v0.5.35 because asking every user
 * for a passphrase on every sign-in is a worse UX than full
 * cross-device sync that survives losing your laptop. v0.5.36 can
 * layer an optional passphrase on top — the encryption envelope
 * stays unchanged, only the key derivation moves.
 *
 * **Threat model**
 *
 * Protects against:
 *   - Supabase database leaks (ciphertext is opaque without the key).
 *   - Network interception (TLS already covers this; the encryption
 *     means even a compromised TLS endpoint sees only ciphertext).
 *   - Casual local filesystem inspection (key in keychain, not
 *     Application Support).
 *
 * Does NOT protect against:
 *   - A malicious Supabase admin (key is in user_metadata).
 *   - A compromised user account (sign-in to that account = full
 *     decrypt).
 *   - A malicious process running as Typeset (in-process WebCrypto
 *     key material is exposed in memory).
 */

import { invoke } from "@tauri-apps/api/core";
import { getAuthClient } from "./authClient";

const METADATA_FIELD = "sync_key_b64";
const KEY_BYTES = 32;

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

// ---------------------------------------------------------------------------
// Base64 helpers — we round-trip the raw key through base64 because
// the keychain entry is a UTF-8 string and `user_metadata` is JSON.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// In-memory cache. The CryptoKey is an opaque WebCrypto handle —
// reusing it across sync writes saves the (cheap) `importKey` call
// and, on Safari/WebKit, reduces a small per-call sandbox cost.
// ---------------------------------------------------------------------------

interface CachedKey {
  base64: string;
  cryptoKey: CryptoKey;
}

let cached: CachedKey | null = null;

async function importKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function generateRawKey(): Uint8Array {
  const out = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// Local keychain bridge.
// ---------------------------------------------------------------------------

async function keychainLoad(): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  try {
    const value = await invoke<string | null>("sync_load_key");
    return value && value.length > 0 ? value : null;
  } catch (err) {
    console.warn("[syncKey] keychain load failed:", err);
    return null;
  }
}

async function keychainSave(b64: string): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await invoke<void>("sync_save_key", { keyB64: b64 });
  } catch (err) {
    console.warn("[syncKey] keychain save failed:", err);
  }
}

async function keychainClear(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await invoke<void>("sync_clear_key");
  } catch (err) {
    console.warn("[syncKey] keychain clear failed:", err);
  }
}

// ---------------------------------------------------------------------------
// User metadata bridge.
//
// `auth.users.user_metadata` is a JSON column on the auth side —
// Supabase exposes it via `client.auth.updateUser({ data: { … } })`.
// Reads come from the in-memory user object (`getUser()` /
// `getSession().user.user_metadata`) so they're cheap.
// ---------------------------------------------------------------------------

async function readMetadataKey(): Promise<string | null> {
  const { data } = await getAuthClient().auth.getUser();
  const user = data.user;
  if (!user) return null;
  const meta = user.user_metadata as Record<string, unknown> | null;
  if (!meta) return null;
  const value = meta[METADATA_FIELD];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function writeMetadataKey(b64: string): Promise<void> {
  const { error } = await getAuthClient().auth.updateUser({
    data: { [METADATA_FIELD]: b64 },
  });
  if (error) {
    throw new Error(`Failed to publish sync key: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the user's sync key.
 *
 * Lookup order:
 *   1. In-memory cache (fast path, common case).
 *   2. Local OS keychain.
 *   3. Supabase `user_metadata.sync_key_b64`. If found here but
 *      not in the keychain, write it through to the keychain so
 *      subsequent launches hit step 2.
 *   4. Generate a fresh key, persist it to BOTH (metadata and
 *      keychain), and return it.
 *
 * Throws only if step 4 needs to write to user_metadata and the
 * server rejects (network down, RLS, etc.) — at that point we have
 * no key to safely encrypt with, and the caller should surface a
 * "sync unavailable, will retry" status.
 */
export async function getOrCreateSyncKey(): Promise<CryptoKey> {
  if (cached) return cached.cryptoKey;

  // Step 2: local keychain.
  const fromKeychain = await keychainLoad();
  if (fromKeychain) {
    const cryptoKey = await importKey(base64ToBytes(fromKeychain));
    cached = { base64: fromKeychain, cryptoKey };
    return cryptoKey;
  }

  // Step 3: user_metadata.
  const fromMetadata = await readMetadataKey();
  if (fromMetadata) {
    await keychainSave(fromMetadata);
    const cryptoKey = await importKey(base64ToBytes(fromMetadata));
    cached = { base64: fromMetadata, cryptoKey };
    return cryptoKey;
  }

  // Step 4: generate.
  const raw = generateRawKey();
  const b64 = bytesToBase64(raw);
  // Publish to user_metadata BEFORE caching/keychaining locally so
  // a publish failure doesn't leave us with a key that's locally
  // valid but undecryptable on any other device.
  await writeMetadataKey(b64);
  await keychainSave(b64);
  const cryptoKey = await importKey(raw);
  cached = { base64: b64, cryptoKey };
  return cryptoKey;
}

/**
 * Drop the in-memory cache. Called on sign-out so a different user
 * can't accidentally re-use the previous user's key on the same
 * machine. The keychain entry itself is cleared by `signOut()` in
 * `authClient.ts`.
 */
export function forgetSyncKey(): void {
  cached = null;
}

/**
 * Best-effort tear-down of every layer (memory, keychain). Called
 * from `signOut()`. Failures are logged but not thrown — sign-out
 * has to succeed.
 */
export async function clearSyncKey(): Promise<void> {
  cached = null;
  await keychainClear();
}
