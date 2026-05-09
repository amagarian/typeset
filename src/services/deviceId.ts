/**
 * Anonymous, device-bound identity for the public template registry.
 *
 * Typeset has no user accounts. Every install gets a stable 128-bit
 * UUID generated on first run and persisted in localStorage. The id
 * ships with every registry mutation as the `x-device-id` header,
 * which RLS policies in Supabase use to:
 *
 *   - Let publishers update / delete their own rows
 *   - Dedupe votes (one vote per (device, template))
 *   - Provide rate-limit and attribution surfaces
 *
 * It is NOT a security boundary. Anyone who copies localStorage onto
 * another machine inherits publisher access to those existing rows —
 * which is the trade-off for "no signup". Ship a real account model
 * later if abuse forces it.
 *
 * Why localStorage rather than the OS keychain (where the Gemini API
 * key lives)? The keychain is reserved for *secret* material. The
 * device id is deliberately not secret — losing it just forfeits
 * ownership of templates already published under it, no different
 * from forgetting an account password with no recovery email.
 */

const DEVICE_ID_KEY = "typeset.registry.device_id.v1";

function generateUuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

let cachedSessionId: string | null = null;

/**
 * Returns the device id, creating it on first call. Always succeeds —
 * if localStorage is unavailable (rare; SSR or sandboxed contexts) we
 * fall back to a per-session UUID so the publish flow doesn't break,
 * even though it won't be remembered across launches.
 */
export function getDeviceId(): string {
  if (!canUseStorage()) {
    cachedSessionId ??= generateUuid();
    return cachedSessionId;
  }
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.length >= 8) return existing;
    const fresh = generateUuid();
    window.localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    cachedSessionId ??= generateUuid();
    return cachedSessionId;
  }
}

/**
 * Forget the current device id and mint a new one. Useful for a
 * "reset registry identity" affordance — the user will lose ownership
 * of any templates they previously published.
 */
export function rotateDeviceId(): string {
  if (!canUseStorage()) {
    cachedSessionId = generateUuid();
    return cachedSessionId;
  }
  try {
    window.localStorage.removeItem(DEVICE_ID_KEY);
  } catch {
    /* ignore */
  }
  return getDeviceId();
}
