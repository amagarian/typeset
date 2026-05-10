/**
 * v0.5.35 — auth state hook.
 *
 * Single source of truth for "who is the user" in the renderer. Wraps
 * `services/authClient.ts` and exposes the React-friendly
 * `{ session, user, isSignedIn, signIn, signOut, isLoading }` shape.
 *
 * Mounts the listeners exactly once (deep-link, persistence,
 * auth-state-change, error-bus) on the first render of the first
 * consumer; subsequent consumers reuse the cached session from
 * supabase-js. The hook is safe to call from any number of components
 * — they all observe the same module-level state.
 *
 * Side effects fired from this hook:
 *   - Anonymous → account migration (`linkAnonymousDeviceToAccount`)
 *     runs once per fresh sign-in (i.e. when `session` transitions
 *     from null → non-null). Errors are logged, never thrown.
 *   - Toast events for auth errors are propagated via
 *     `subscribeAuthEvents`; the consumer can subscribe directly
 *     too (see `useAuthEvents`).
 *
 * Anonymous users (signed-out) see exactly the same hook shape with
 * `session === null` / `isSignedIn === false` — every other code
 * path can branch on `isSignedIn` without null-checking the hook.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import {
  hydrateSession,
  installDeepLinkListener,
  installSessionPersistence,
  linkAnonymousDeviceToAccount,
  onAuthStateChange,
  signInWithMagicLink,
  signOut as signOutImpl,
  subscribeAuthEvents,
  type AuthEvent,
} from "@/services/authClient";

export interface UseAuthResult {
  session: Session | null;
  user: User | null;
  isSignedIn: boolean;
  /**
   * Waiting for cold-start hydration. False once we know whether the
   * user is signed in, regardless of which way that resolved.
   */
  isLoading: boolean;
  /** Send a magic link. Resolves on dispatch; the actual sign-in
   *  completes asynchronously when the user clicks the link. */
  signIn(email: string): Promise<void>;
  signOut(): Promise<void>;
}

/**
 * Module-level singletons so multiple `useAuth` callers share state
 * and only attach listeners once. The component lifecycle pulls a
 * snapshot via the React state below; updates are pushed through
 * the same supabase-js subscription so the snapshot stays fresh.
 */
let installPromise: Promise<Session | null> | null = null;

async function ensureInstalled(): Promise<Session | null> {
  if (!installPromise) {
    installPromise = (async () => {
      installSessionPersistence();
      await installDeepLinkListener();
      return hydrateSession();
    })();
  }
  return installPromise;
}

export function useAuth(): UseAuthResult {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setLoading] = useState<boolean>(true);
  const previousUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const initial = await ensureInstalled();
        if (cancelled) return;
        setSession(initial);
        previousUserIdRef.current = initial?.user.id ?? null;
      } catch (err) {
        console.warn("[useAuth] hydrate failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const unsubscribe = onAuthStateChange((next) => {
      if (cancelled) return;
      const previousUserId = previousUserIdRef.current;
      const nextUserId = next?.user.id ?? null;
      previousUserIdRef.current = nextUserId;
      setSession(next);

      // Fresh sign-in (null → user, or different user). Run the
      // anonymous → account migration in the background. Failure
      // doesn't roll back the sign-in — it just leaves the user's
      // legacy device-id-bound submissions un-linked, which they can
      // claim on next launch when this fires again.
      if (nextUserId && nextUserId !== previousUserId) {
        void linkAnonymousDeviceToAccount();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string) => {
    await signInWithMagicLink({ email: email.trim() });
  }, []);

  const signOut = useCallback(async () => {
    await signOutImpl();
  }, []);

  return {
    session,
    user: session?.user ?? null,
    isSignedIn: Boolean(session),
    isLoading,
    signIn,
    signOut,
  };
}

/**
 * Subscribe to async auth events that don't fit the
 * supabase-js-driven `session` state machine (e.g. a verifyOtp
 * failure that should surface as a toast). Use sparingly — most
 * consumers should just read `useAuth()` and let supabase-js drive.
 */
export function useAuthEvents(handler: (event: AuthEvent) => void): void {
  useEffect(() => {
    const unsubscribe = subscribeAuthEvents(handler);
    return () => unsubscribe();
  }, [handler]);
}
