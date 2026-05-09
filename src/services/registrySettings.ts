/**
 * Renderer-side wrapper over the `registry_*` Tauri commands defined in
 * `src-tauri/src/keychain.rs`. Mirrors the shape of `geminiClient`'s
 * key-management surface so the Settings panel doesn't need to learn a
 * new vocabulary.
 *
 * We deliberately avoid `import.meta.env.VITE_SUPABASE_*` so credentials
 * can be changed at runtime without rebuilding the binary. The URL and
 * publishable / anon key live in the OS keychain alongside the Gemini
 * API key.
 *
 * Both the modern `sb_publishable_*` and the legacy JWT-shaped anon key
 * are accepted as-is — `createClient(url, key)` treats them identically.
 * No format validation here or on the Rust side.
 */

import { invoke } from "@tauri-apps/api/core";

export interface RegistryCredentials {
  url: string | null;
  anonKey: string | null;
}

interface RegistryCredentialsRaw {
  url: string | null;
  anon_key: string | null;
}

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

function normalizeError(message: unknown): Error {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  return new Error(text);
}

/** Persist a fresh URL + anon key into the OS keychain. */
export async function setRegistryCredentials(
  url: string,
  anonKey: string
): Promise<void> {
  if (!isTauriAvailable()) {
    throw new Error(
      "Saving Supabase credentials requires the desktop app (run `npm run tauri dev`)."
    );
  }
  try {
    await invoke<void>("registry_set_credentials", {
      url,
      anonKey,
    });
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Fetch the URL + anon key currently stored in the keychain (either may be null). */
export async function getRegistryCredentials(): Promise<RegistryCredentials> {
  if (!isTauriAvailable()) return { url: null, anonKey: null };
  try {
    const raw = await invoke<RegistryCredentialsRaw>("registry_get_credentials");
    return {
      url: raw.url ?? null,
      anonKey: raw.anon_key ?? null,
    };
  } catch {
    return { url: null, anonKey: null };
  }
}

/** Returns true iff BOTH halves are present. */
export async function hasRegistryCredentials(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    return await invoke<boolean>("registry_has_credentials");
  } catch {
    return false;
  }
}

/** Wipe both halves from the keychain. */
export async function clearRegistryCredentials(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await invoke<void>("registry_clear_credentials");
  } catch (err) {
    throw normalizeError(err);
  }
}
