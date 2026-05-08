/**
 * Anonymous, device-bound identity for the public template registry.
 *
 * We don't have user accounts in Typeset. Every install gets a stable
 * 128-bit UUID generated on first run and persisted in localStorage.
 * The id ships with every registry mutation as the `x-device-id`
 * header, which the server uses for:
 *
 *   - Rate-limiting publishes (max N/day per device)
 *   - Letting publishers update / delete their own templates
 *   - Deduping votes (one vote per (device, template) pair)
 *
 * It is NOT a security boundary. Anyone who copies their localStorage
 * onto another machine gets full publisher access to their existing
 * templates — which is the trade-off for "no signup". If we ever need
 * a real account model we can layer it on top without breaking anyone.
 *
 * Why localStorage instead of the OS keychain?
 *   The keychain is reserved for *secret* material (the Anthropic API
 *   key). The device id is intentionally not secret — losing it just
 *   means you forfeit ownership of templates you previously published
 *   under it, no different from forgetting your account password with
 *   no recovery email. Keeping it in localStorage means it's the same
 *   shape as every other renderer-side preference.
 */

const DEVICE_ID_KEY = "typeset.registry.device_id.v1";

function generateUuid(): string {
  // Prefer the platform's crypto.randomUUID where available (modern
  // browsers + Tauri's webview both expose it). Fall back to a
  // hand-rolled v4 UUID built from getRandomValues for older runtimes.
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

/**
 * Returns the device id, creating it on first call. Always succeeds —
 * if localStorage is unavailable (rare; SSR or sandboxed contexts) we
 * fall back to a per-session UUID so the publish flow doesn't break,
 * even though it won't be remembered across launches.
 */
export function getDeviceId(): string {
  if (!canUseStorage()) {
    // Memoise within the module so all calls in this session agree.
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

let cachedSessionId: string | null = null;

/**
 * Forget the current device id and mint a new one. Useful if the user
 * wants a "reset my registry identity" affordance — they lose ownership
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
