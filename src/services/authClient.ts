/**
 * v0.5.35 — Supabase magic-link authentication.
 *
 * Glue between three subsystems:
 *
 *   1. `@supabase/supabase-js` — owns the auth state machine, magic
 *      link issuance (`signInWithOtp`), token verification
 *      (`verifyOtp`), session refresh, and `onAuthStateChange`.
 *   2. The OS keychain (`auth_save_session` / `auth_load_session` /
 *      `auth_clear_session` Tauri commands in `src-tauri/src/auth.rs`)
 *      — persists the Supabase `Session` JSON across launches.
 *      Critical: we never persist to localStorage; supabase-js is
 *      configured with `persistSession: false` and we hand-roll the
 *      keychain round-trip in this module.
 *   3. The deep-link plugin (`tauri-plugin-deep-link`) — fires the
 *      `deep-link:url` event when the OS hands the running app a
 *      magic-link callback URL of the form
 *      `typeset://auth/callback?token_hash=…&type=magiclink`. The
 *      cold-start case (URL delivered before this module's listener
 *      attaches) is handled by `getCurrent()`.
 *
 * Anonymous-friendly: every call here is a no-op when run outside
 * Tauri (web preview) or before the user signs in. Existing
 * functionality (template registry, contributions, local
 * persistence) keeps working without an auth session — sign-in just
 * unlocks the cross-device features.
 *
 * ## Flow
 *
 * Sign-in:
 *   email → signInWithOtp({ email, emailRedirectTo: REDIRECT })
 *   → user receives email
 *   → user clicks link in browser
 *   → browser opens `typeset://auth/callback?token_hash=…&type=magiclink`
 *   → OS routes URL to Typeset via tauri-plugin-deep-link
 *   → Rust `setup` handler emits `deep-link:url` event
 *   → this module's listener calls verifyOtp(token_hash, type='email')
 *   → supabase-js produces a `Session`; we save it to the keychain
 *   → onAuthStateChange fires; `useAuth` re-renders with session
 *
 * Sign-out:
 *   → supabase.auth.signOut() (revokes server-side refresh token)
 *   → clear keychain
 *   → also clear sync-key keychain (services/syncKey.ts)
 *
 * Sign-in on cold start:
 *   loadSessionFromKeychain() → setSession() → supabase-js validates
 *   refresh token if needed, fires onAuthStateChange.
 *
 * Anonymous → account migration:
 *   On every successful sign-in we kick off `link_anonymous_device`
 *   so registry submissions and contribution stats inherit the new
 *   `user_id`. Best-effort; failures are warned, not blocking.
 */

import {
  createClient,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getDeviceId } from "./deviceId";

// ---------------------------------------------------------------------------
// Constants — mirror what's already in templateRegistry.ts.
//
// We deliberately build a SECOND Supabase client here (separate from
// the one in templateRegistry.ts) because the auth client and the
// registry client have different needs:
//   - The registry client carries `x-device-id` header for RLS and
//     has `persistSession: false` (anonymous reads only).
//   - The auth client owns the user's session, refreshes tokens
//     automatically, and forwards the access token on subsequent
//     registry / sync writes via getSession().
//
// Both clients talk to the same project; supabase-js dedupes the
// underlying realtime socket internally.
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  "https://sxtcmjahbgefqneauzpn.supabase.co";
const SUPABASE_KEY =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
  "sb_publishable_zVIlCZ9YSdPEEiQE3BGSYQ_mFtOLX1e";

/**
 * Custom URL scheme registered in `src-tauri/Info.plist` and in
 * `tauri.conf.json > plugins > deep-link > desktop > schemes`. This
 * is the `emailRedirectTo` we pass to Supabase, and it's what the
 * Supabase dashboard's Authentication → URL Configuration must list
 * as an **allowed redirect URL**.
 */
export const AUTH_REDIRECT_URL = "typeset://auth/callback";

/** Tauri event the Rust side emits when a deep link arrives.
 *  Must match `DEEP_LINK_EVENT` in `src-tauri/src/lib.rs`. */
const DEEP_LINK_EVENT = "deep-link:url";

// ---------------------------------------------------------------------------
// Singleton client.
//
// `persistSession: false` because we own session storage (keychain
// via Rust). `autoRefreshToken: true` because the renderer is the
// most convenient place to refresh — it's online when the user is
// active, has a fetch context, and any failure produces a sign-in
// state change we already wire through `onAuthStateChange`.
// ---------------------------------------------------------------------------

let cached: SupabaseClient | null = null;

export function getAuthClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: "typeset.auth.session.unused",
    },
  });
  return cached;
}

// ---------------------------------------------------------------------------
// Tauri detection — same shape used elsewhere in the app.
// ---------------------------------------------------------------------------

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

// ---------------------------------------------------------------------------
// Keychain bridge — wrapped so the rest of the codebase never has to
// remember the Tauri command names.
// ---------------------------------------------------------------------------

async function keychainSaveSession(session: Session): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await invoke<void>("auth_save_session", { json: JSON.stringify(session) });
  } catch (err) {
    console.warn("[Typeset auth] failed to save session to keychain:", err);
  }
}

async function keychainLoadSession(): Promise<Session | null> {
  if (!isTauriAvailable()) return null;
  try {
    const json = await invoke<string | null>("auth_load_session");
    if (!json) return null;
    const parsed = JSON.parse(json) as Session;
    if (!parsed.access_token || !parsed.refresh_token) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn("[Typeset auth] failed to load session from keychain:", err);
    return null;
  }
}

async function keychainClearSession(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await invoke<void>("auth_clear_session");
  } catch (err) {
    console.warn("[Typeset auth] failed to clear session from keychain:", err);
  }
}

// ---------------------------------------------------------------------------
// Listener for Supabase auth state changes — saves to keychain on
// every transition that changes the access/refresh token (sign-in,
// token refresh) and clears on sign-out.
//
// Wired exactly once via `installSessionPersistence()`; the resulting
// unsubscribe is held in this module so React reloads don't double-
// register listeners during HMR.
// ---------------------------------------------------------------------------

let persistenceInstalled = false;

export function installSessionPersistence(): void {
  if (persistenceInstalled) return;
  persistenceInstalled = true;
  const client = getAuthClient();
  client.auth.onAuthStateChange((event, session) => {
    if (session) {
      void keychainSaveSession(session);
    } else if (event === "SIGNED_OUT") {
      void keychainClearSession();
    }
  });
}

// ---------------------------------------------------------------------------
// Cold-start hydration
// ---------------------------------------------------------------------------

/**
 * Pull the persisted session out of the keychain (if any) and hand
 * it to supabase-js so `getSession()` resolves to it on the very
 * first read. Idempotent: re-running it is a no-op once the
 * in-memory client already has a session.
 *
 * Also processes any deep-link URL that triggered the cold start,
 * via `getCurrent()` on the deep-link plugin. Without this step the
 * "user clicked the magic link while the app was closed" path
 * silently drops the token because no `deep-link:url` event fires
 * for the URL that launched the process.
 */
export async function hydrateSession(): Promise<Session | null> {
  const client = getAuthClient();

  // Already hydrated — short-circuit.
  const { data } = await client.auth.getSession();
  if (data.session) return data.session;

  const persisted = await keychainLoadSession();
  if (persisted) {
    const { data: setData, error } = await client.auth.setSession({
      access_token: persisted.access_token,
      refresh_token: persisted.refresh_token,
    });
    if (error) {
      // Session is stale (refresh token rejected). Clear keychain
      // so we don't keep retrying with a dead token on every cold
      // start, and fall through to "no session".
      console.warn("[Typeset auth] persisted session rejected by server:", error);
      await keychainClearSession();
      return null;
    }
    if (setData.session) {
      return setData.session;
    }
  }

  // Cold-start deep link path.
  await maybeProcessColdStartUrl();

  const { data: refreshed } = await client.auth.getSession();
  return refreshed.session;
}

async function maybeProcessColdStartUrl(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    const dl = await import("@tauri-apps/plugin-deep-link");
    const startUrls = await dl.getCurrent();
    if (startUrls && startUrls.length > 0) {
      for (const url of startUrls) {
        await processCallbackUrl(url);
      }
    }
  } catch (err) {
    console.warn("[Typeset auth] cold-start deep-link probe failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Deep-link listener — handles the warm-start case (app already
// running when the user clicks the magic link).
// ---------------------------------------------------------------------------

let deepLinkUnlisten: UnlistenFn | null = null;

export async function installDeepLinkListener(): Promise<void> {
  if (deepLinkUnlisten) return;
  if (!isTauriAvailable()) return;
  try {
    deepLinkUnlisten = await listen<string[] | string>(DEEP_LINK_EVENT, (event) => {
      const urls = Array.isArray(event.payload) ? event.payload : [event.payload];
      for (const url of urls) {
        if (typeof url === "string" && url.length > 0) {
          void processCallbackUrl(url);
        }
      }
    });
  } catch (err) {
    console.warn("[Typeset auth] failed to attach deep-link listener:", err);
  }
}

// ---------------------------------------------------------------------------
// Magic-link OTP handling.
//
// Supabase magic links land at our redirect URL with one of two
// payload shapes:
//   - PKCE / OTP (current default for `signInWithOtp`):
//       ?token_hash=…&type=magiclink
//   - Implicit (older flow / `signUp`):
//       #access_token=…&refresh_token=…&type=magiclink
// We handle both: the first via `verifyOtp`, the second via
// `setSession` directly. supabase-js will then fire the auth
// state change which our keychain persistence listener picks up.
// ---------------------------------------------------------------------------

interface ParsedCallback {
  tokenHash?: string;
  type?: string;
  accessToken?: string;
  refreshToken?: string;
  errorDescription?: string;
}

function parseCallbackUrl(rawUrl: string): ParsedCallback | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // Don't try to be smart — accept any path under the typeset:// scheme.
  if (url.protocol !== "typeset:") return null;

  const search = url.searchParams;
  // Some implementations put the params in the fragment ("#a=b&c=d")
  // rather than the query string. Read both, query string wins.
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragmentParams = new URLSearchParams(fragment);

  const get = (key: string): string | undefined =>
    search.get(key) ?? fragmentParams.get(key) ?? undefined;

  return {
    tokenHash: get("token_hash"),
    type: get("type"),
    accessToken: get("access_token"),
    refreshToken: get("refresh_token"),
    errorDescription: get("error_description") ?? get("error"),
  };
}

async function processCallbackUrl(rawUrl: string): Promise<void> {
  const parsed = parseCallbackUrl(rawUrl);
  if (!parsed) return;
  const client = getAuthClient();

  if (parsed.errorDescription) {
    notifyAuthEvent({
      kind: "error",
      message: humanReadableAuthError(parsed.errorDescription),
    });
    return;
  }

  try {
    if (parsed.tokenHash) {
      // Supabase types 'type' as a union of literals; the wire
      // format collapses several flows ('magiclink', 'signup',
      // 'recovery', 'invite') to the same `email` token type.
      const otpType = (parsed.type === "recovery"
        ? "recovery"
        : parsed.type === "invite"
        ? "invite"
        : parsed.type === "signup"
        ? "signup"
        : "email") as "email" | "signup" | "recovery" | "invite";
      const { data, error } = await client.auth.verifyOtp({
        token_hash: parsed.tokenHash,
        type: otpType,
      });
      if (error) throw error;
      if (data.session) {
        notifyAuthEvent({ kind: "signed-in", session: data.session });
      }
      return;
    }

    if (parsed.accessToken && parsed.refreshToken) {
      const { data, error } = await client.auth.setSession({
        access_token: parsed.accessToken,
        refresh_token: parsed.refreshToken,
      });
      if (error) throw error;
      if (data.session) {
        notifyAuthEvent({ kind: "signed-in", session: data.session });
      }
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notifyAuthEvent({ kind: "error", message: humanReadableAuthError(message) });
  }
}

function humanReadableAuthError(raw: string): string {
  // Supabase's error messages aren't always great UX. Replace the
  // most common cryptic ones with something users can act on; fall
  // through to the raw string otherwise.
  if (/expired/i.test(raw)) {
    return "That sign-in link has expired. Try sending a new one.";
  }
  if (/already been used/i.test(raw)) {
    return "That sign-in link has already been used. Try sending a new one.";
  }
  if (/email_address_invalid/i.test(raw)) {
    return "That email address looks malformed. Double-check it and try again.";
  }
  return raw;
}

// ---------------------------------------------------------------------------
// External event bus — `useAuth` and the SettingsModal listen for
// these to drive their UI (toast on error, switch to "signed in"
// state on success, etc.). Kept distinct from supabase-js's own
// `onAuthStateChange` so we can attach UI-only events (e.g. a
// failed verifyOtp) without inventing a fake session state.
// ---------------------------------------------------------------------------

export type AuthEvent =
  | { kind: "signed-in"; session: Session }
  | { kind: "error"; message: string };

const authEventTarget = new EventTarget();
const AUTH_EVENT_NAME = "typeset-auth";

interface AuthEventDetail extends Event {
  detail?: AuthEvent;
}

function notifyAuthEvent(event: AuthEvent): void {
  const evt = new CustomEvent<AuthEvent>(AUTH_EVENT_NAME, { detail: event });
  authEventTarget.dispatchEvent(evt);
}

export function subscribeAuthEvents(handler: (event: AuthEvent) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as AuthEventDetail).detail;
    if (detail) handler(detail);
  };
  authEventTarget.addEventListener(AUTH_EVENT_NAME, listener);
  return () => authEventTarget.removeEventListener(AUTH_EVENT_NAME, listener);
}

// ---------------------------------------------------------------------------
// Public sign-in / sign-out helpers.
// ---------------------------------------------------------------------------

export interface SignInOptions {
  /** Email address to send the magic link to. */
  email: string;
}

export async function signInWithMagicLink(options: SignInOptions): Promise<void> {
  const client = getAuthClient();
  const { error } = await client.auth.signInWithOtp({
    email: options.email,
    options: {
      emailRedirectTo: AUTH_REDIRECT_URL,
      // shouldCreateUser: true (default) is what we want — Typeset
      // is anonymous-by-default, so first-time sign-in implicitly
      // creates the account. That's the simplest UX and matches
      // the "no friction" v0.5.x positioning. We can flip this if
      // a v0.5.36 invite flow needs the opposite.
    },
  });
  if (error) {
    throw new Error(humanReadableAuthError(error.message));
  }
}

/**
 * v0.5.36 — Sign in with Apple via Supabase OAuth + Tauri shell:open.
 *
 * Web-based OAuth flow (NOT the native AuthenticationServices SDK).
 * Why web-based:
 *   - Native ASAuthorizationAppleIDProvider would require shipping
 *     a Rust↔ Swift bridge for AuthenticationServices.framework, plus
 *     the macOS-Catalyst entitlement plumbing. The web flow keeps
 *     v0.5.36 a pure-Tauri-2 release with no platform-specific code.
 *   - Supabase normalises Apple's OIDC token into a standard
 *     `#access_token=…&refresh_token=…` callback URL, so the same
 *     deep-link handler that already powers the magic-link
 *     flow (v0.5.35) catches the response without any new parser
 *     logic — see `parseCallbackUrl` above, which already accepts
 *     both the `?token_hash=…` (magic link) and `#access_token=…`
 *     (OAuth implicit) shapes.
 *
 * Flow:
 *   1. Ask supabase-js to mint the Apple authorize URL (it takes
 *      care of attaching the `state`, `nonce`, `redirect_uri`, etc.
 *      that the Apple OAuth dance requires). `skipBrowserRedirect`
 *      tells supabase-js to return the URL instead of trying to
 *      `window.location = …`, since the renderer is inside Tauri's
 *      webview and can't navigate the system browser directly.
 *   2. Hand the URL to Tauri's `shell:open` plugin so the OS
 *      opens it in the user's default browser. The capability scope
 *      in `tauri.conf.json > plugins > shell > open` is locked to
 *      `https://(*.supabase.co|appleid.apple.com)/...` so this
 *      command can't be abused to open arbitrary URLs even if the
 *      `data.url` were tampered with.
 *   3. The user signs in with Apple in the system browser; Apple
 *      redirects to Supabase's `/auth/v1/callback`; Supabase
 *      redirects to `typeset://auth/callback#access_token=…`.
 *   4. The OS hands the URL to Typeset via `tauri-plugin-deep-link`;
 *      the v0.5.35 `processCallbackUrl` reads the access/refresh
 *      tokens out of the URL fragment, calls `setSession`, and
 *      `onAuthStateChange` flips `isSignedIn` → true via
 *      `useAuth`'s subscription.
 *
 * Caveats:
 *   - Web preview / non-Tauri contexts: `invoke` will throw.
 *     We don't try to fall back to `window.open` because the
 *     `typeset://` callback won't reach a browser-only build
 *     anyway; the right response is "this needs the desktop
 *     app".
 *   - `data.url` can theoretically be `null` if Supabase changes
 *     its API; we throw a typed error rather than silently no-op.
 */
export async function signInWithApple(): Promise<void> {
  const client = getAuthClient();
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "apple",
    options: {
      redirectTo: AUTH_REDIRECT_URL,
      skipBrowserRedirect: true,
    },
  });
  if (error) {
    throw new Error(humanReadableAuthError(error.message));
  }
  if (!data?.url) {
    throw new Error("Supabase did not return an Apple authorize URL.");
  }
  if (!isTauriAvailable()) {
    throw new Error(
      "Sign in with Apple requires the Typeset desktop app (the OAuth callback is delivered via the typeset:// URL scheme)."
    );
  }
  // Tauri 2 plugin invoke convention: `plugin:<name>|<command>`.
  // Mirrors the `@tauri-apps/plugin-shell` JS wrapper without
  // pulling in another npm dep — the only call site is here.
  await invoke<void>("plugin:shell|open", { path: data.url });
}

export async function signOut(): Promise<void> {
  const client = getAuthClient();
  // Don't fail the sign-out if the network call rejects; we always
  // clear local state. supabase-js will mark the local session
  // signed-out regardless.
  try {
    await client.auth.signOut();
  } catch (err) {
    console.warn("[Typeset auth] signOut: server call failed (continuing):", err);
  }
  await keychainClearSession();
  // Sync key is account-bound; clearing it on sign-out is correct.
  // See `services/syncKey.ts`.
  try {
    if (isTauriAvailable()) {
      await invoke<void>("sync_clear_key");
    }
  } catch (err) {
    console.warn("[Typeset auth] failed to clear sync key on sign-out:", err);
  }
}

export async function getCurrentSession(): Promise<Session | null> {
  const client = getAuthClient();
  const { data } = await client.auth.getSession();
  return data.session;
}

export async function getCurrentUser(): Promise<User | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}

/**
 * Subscribe to supabase-js's own auth state. Wraps the underlying
 * subscription so consumers get a plain `() => void` unsubscriber.
 */
export function onAuthStateChange(
  handler: (session: Session | null) => void
): () => void {
  const client = getAuthClient();
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    handler(session);
  });
  return () => data.subscription.unsubscribe();
}

// ---------------------------------------------------------------------------
// Anonymous → account migration.
//
// Triggered after a successful sign-in (see `useAuth`). Supabase
// migration RPC `link_anonymous_device(text)` updates rows in
// `template_submissions` whose `publisher_device_id` matches our
// localStorage device id, setting their `user_id` to `auth.uid()`.
// Idempotent server-side and best-effort client-side: a network
// failure here doesn't break sign-in.
// ---------------------------------------------------------------------------

export async function linkAnonymousDeviceToAccount(): Promise<void> {
  const client = getAuthClient();
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) return;
  const deviceId = getDeviceId();
  try {
    const { error } = await client.rpc("link_anonymous_device", {
      p_device_id: deviceId,
    });
    if (error) {
      console.warn("[Typeset auth] link_anonymous_device RPC error:", error.message);
    }
  } catch (err) {
    console.warn("[Typeset auth] link_anonymous_device failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Tear-down (HMR friendliness only)
// ---------------------------------------------------------------------------

export async function disposeAuthListeners(): Promise<void> {
  if (deepLinkUnlisten) {
    try {
      deepLinkUnlisten();
    } catch {
      /* ignore */
    }
    deepLinkUnlisten = null;
  }
}
