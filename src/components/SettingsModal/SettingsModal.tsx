import { useEffect, useState, useCallback, useRef } from "react";
import { writeLocalTemplates } from "@/services/templateCache";
import { isUpdateInstalled, runUpdateCheck } from "@/utils/autoUpdate";
import { useAuth, useAuthEvents } from "@/hooks/useAuth";
import {
  hasApiKey,
  setApiKey,
  clearApiKey,
  testGeminiConnection,
  getGeminiKeyStatus,
} from "@/services/geminiClient";
import {
  GEMINI_THINKING_OPTIONS,
  LOCKED_MODEL,
  getGeminiThinkingMode,
  setGeminiThinkingMode,
  type GeminiThinkingMode,
} from "@/services/geminiSettings";
import packageJson from "../../../package.json";
import styles from "./SettingsModal.module.css";

// v0.5.26 — single source of truth for the version string we print in
// the Settings "About" footer. Pulled from `package.json` so the
// label always matches the bundled build (no chance of skew with the
// Tauri-installed binary).
const APP_VERSION: string = (packageJson as { version: string }).version;

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

/**
 * Settings panel.
 *
 * Gemini: API key resolution (v0.6.2+): macOS keychain override, else optional
 * compile-time `TYPESET_GEMINI_API_KEY` from release builds. Model and accuracy
 * stay locked in `geminiSettings.ts`. Account, local data, About unchanged.
 *
 * Since v0.5.9 the public template registry is a passive,
 * fingerprint-driven backend with no UI surface here. Drop a PDF
 * and the registry runs invisibly.
 */
export function SettingsModal({
  open,
  onClose,
  onSaved: _onSaved,
}: SettingsModalProps) {
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const resetStatusTimerRef = useRef<number | null>(null);
  // v0.5.26 — manual "Check for updates" relocated here from the
  // sidebar footer. Auto-update on launch / focus (v0.5.23) handles
  // the common case; this surface is the power-user opt-in.
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "upToDate" | "error"
  >("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);

  // v0.5.35 — magic-link auth state. `isLoading` only matters on
  // cold start; once we know whether the user is signed in we
  // render the corresponding section. The two locally-tracked
  // statuses (`signInPending` and `signInError`) are scoped to
  // the in-modal flow — they live and die with the modal close.
  const {
    user,
    isSignedIn,
    signIn,
    signInWithApple,
    signOut,
    isLoading: authLoading,
  } = useAuth();
  const [emailInput, setEmailInput] = useState("");
  const [signInStatus, setSignInStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signOutPending, setSignOutPending] = useState(false);
  // v0.5.36 — separate spinner for the Apple OAuth flow so the email
  // form's "Sending…" state doesn't share its disabled affordance
  // with the Apple button (and vice versa). Both flows can be
  // started from the same panel; only one should ever be in flight.
  const [applePending, setApplePending] = useState(false);

  const [geminiHasKey, setGeminiHasKey] = useState(false);
  /** Saved keychain key only (not the optional compile-time release key). */
  const [geminiKeychainPresent, setGeminiKeychainPresent] = useState(false);
  const [geminiBuildTimeKey, setGeminiBuildTimeKey] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [geminiBusy, setGeminiBusy] = useState(false);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [geminiOk, setGeminiOk] = useState<string | null>(null);
  const [geminiThinkingMode, setGeminiThinkingModeState] =
    useState<GeminiThinkingMode>(() => getGeminiThinkingMode());

  // Bubble verifyOtp / token-rejected errors into the modal as toast-
  // style copy. Local state (not the global Toast) because the modal
  // is the user's current focus — they need feedback at the action
  // surface, not a corner.
  useAuthEvents((event) => {
    if (event.kind === "error") {
      setSignInError(event.message);
      setSignInStatus("error");
    } else if (event.kind === "signed-in") {
      setSignInStatus("idle");
      setSignInError(null);
      setEmailInput("");
    }
  });

  useEffect(() => {
    if (!open) return;
    setResetConfirming(false);
    setResetStatus(null);
    // v0.5.35 — reset the in-modal auth flow state every time the
    // modal opens so the previous "Check your email" panel
    // doesn't linger across opens.
    setEmailInput("");
    setSignInStatus("idle");
    setSignInError(null);
    setGeminiKeyInput("");
    setGeminiError(null);
    setGeminiOk(null);
    setGeminiThinkingModeState(getGeminiThinkingMode());
    void (async () => {
      const status = await getGeminiKeyStatus();
      if (status) {
        setGeminiBuildTimeKey(status.buildTimeKeyPresent);
        setGeminiKeychainPresent(status.keychainKeyPresent);
        setGeminiHasKey(status.buildTimeKeyPresent || status.keychainKeyPresent);
      } else {
        void hasApiKey().then(setGeminiHasKey);
        setGeminiKeychainPresent(false);
        setGeminiBuildTimeKey(false);
      }
    })();
  }, [open]);

  useEffect(() => {
    return () => {
      if (resetStatusTimerRef.current !== null) {
        window.clearTimeout(resetStatusTimerRef.current);
      }
    };
  }, []);

  // v0.5.26 — same flow as the v0.5.23 sidebar handler: route through
  // the shared `runUpdateCheck` helper so the auto-update banner
  // takes over once an install completes. We just surface the
  // lightweight "Checking…" / "Up to date" / error state inline next
  // to the version line.
  const handleCheckForUpdates = useCallback(async () => {
    if (isUpdateInstalled()) return;
    setUpdateStatus("checking");
    setUpdateError(null);
    const result = await runUpdateCheck({ source: "manual" });
    switch (result.kind) {
      case "installed":
      case "already-installed":
        setUpdateStatus("idle");
        break;
      case "no-update":
        setUpdateStatus("upToDate");
        window.setTimeout(() => setUpdateStatus("idle"), 3000);
        break;
      case "error": {
        const msg =
          result.error instanceof Error ? result.error.message : String(result.error);
        setUpdateError(msg);
        setUpdateStatus("error");
        window.setTimeout(() => {
          setUpdateStatus("idle");
          setUpdateError(null);
        }, 8000);
        break;
      }
      case "debounced":
        setUpdateStatus("idle");
        break;
    }
  }, []);

  const handleSendMagicLink = useCallback(async () => {
    const email = emailInput.trim();
    if (!email) return;
    setSignInStatus("sending");
    setSignInError(null);
    try {
      await signIn(email);
      setSignInStatus("sent");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't send the link.";
      setSignInError(message);
      setSignInStatus("error");
    }
  }, [emailInput, signIn]);

  // v0.5.36 — Apple OAuth handler. signInWithApple resolves as soon
  // as the system browser is asked to open the Supabase-issued
  // authorize URL; the actual sign-in completes asynchronously when
  // Apple → Supabase → typeset:// callback fires the deep-link
  // listener (see services/authClient.ts). The "Opening Apple
  // sign-in…" UI state lasts only until shell:open returns;
  // post-shell-open the modal is back in idle state, ready for
  // either the deep-link to flip isSignedIn or the user to retry.
  const handleSignInWithApple = useCallback(async () => {
    setApplePending(true);
    setSignInError(null);
    setSignInStatus("idle");
    try {
      await signInWithApple();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Couldn't open the Apple sign-in page.";
      setSignInError(message);
      setSignInStatus("error");
    } finally {
      setApplePending(false);
    }
  }, [signInWithApple]);

  const handleSignOut = useCallback(async () => {
    setSignOutPending(true);
    try {
      await signOut();
    } catch (err) {
      console.warn("[Settings] sign-out failed:", err);
    } finally {
      setSignOutPending(false);
    }
  }, [signOut]);

  const handleSaveGeminiKey = useCallback(async () => {
    const key = geminiKeyInput.trim();
    if (!key) return;
    setGeminiBusy(true);
    setGeminiError(null);
    setGeminiOk(null);
    try {
      await setApiKey(key);
      setGeminiHasKey(true);
      setGeminiKeychainPresent(true);
      setGeminiKeyInput("");
      setGeminiOk("API key saved to your keychain.");
      window.setTimeout(() => setGeminiOk(null), 4000);
    } catch (err) {
      setGeminiError(err instanceof Error ? err.message : "Couldn't save the key.");
    } finally {
      setGeminiBusy(false);
    }
  }, [geminiKeyInput]);

  const handleClearGeminiKey = useCallback(async () => {
    setGeminiBusy(true);
    setGeminiError(null);
    setGeminiOk(null);
    try {
      await clearApiKey();
      const status = await getGeminiKeyStatus();
      const stillHasKey =
        Boolean(status?.buildTimeKeyPresent) || Boolean(status?.keychainKeyPresent);
      setGeminiKeychainPresent(Boolean(status?.keychainKeyPresent));
      setGeminiBuildTimeKey(Boolean(status?.buildTimeKeyPresent));
      setGeminiHasKey(stillHasKey);
      setGeminiKeyInput("");
      if (status?.buildTimeKeyPresent) {
        setGeminiOk("Keychain override removed. Field detection still uses the built-in key.");
      } else {
        setGeminiOk("API key removed.");
      }
      window.setTimeout(() => setGeminiOk(null), 4000);
    } catch (err) {
      setGeminiError(err instanceof Error ? err.message : "Couldn't remove the key.");
    } finally {
      setGeminiBusy(false);
    }
  }, []);

  const handleTestGemini = useCallback(async () => {
    setGeminiBusy(true);
    setGeminiError(null);
    setGeminiOk(null);
    try {
      await testGeminiConnection(LOCKED_MODEL);
      setGeminiOk("Connection OK.");
      window.setTimeout(() => setGeminiOk(null), 4000);
    } catch (err) {
      setGeminiError(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setGeminiBusy(false);
    }
  }, []);

  const handleGeminiThinkingChange = useCallback((mode: GeminiThinkingMode) => {
    setGeminiThinkingModeState(mode);
    setGeminiThinkingMode(mode);
    setGeminiOk(
      mode === "fast"
        ? "Gemini thinking set to Fast."
        : mode === "balanced"
          ? "Gemini thinking set to Balanced."
          : "Gemini thinking set to Deep."
    );
    window.setTimeout(() => setGeminiOk(null), 2500);
  }, []);

  const handleResetLocalTemplates = useCallback(() => {
    writeLocalTemplates([]);
    setResetConfirming(false);
    setResetStatus("Local template cache cleared.");
    if (resetStatusTimerRef.current !== null) {
      window.clearTimeout(resetStatusTimerRef.current);
    }
    resetStatusTimerRef.current = window.setTimeout(() => {
      setResetStatus(null);
      resetStatusTimerRef.current = null;
    }, 3500);
  }, []);

  if (!open) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <h2 id="settings-title" className={styles.title}>
            Settings
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.section}>
            <span className={styles.label}>Gemini</span>
            <p className={styles.helpText}>
              {geminiBuildTimeKey ? (
                <>
                  This build includes a key for field detection. You can optionally save your
                  own in the keychain to override it. Or create a key in{" "}
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noreferrer"
                    className={styles.inlineLink}
                  >
                    Google AI Studio
                  </a>
                  .
                </>
              ) : (
                <>
                  Field detection uses the Gemini API. Create a key in{" "}
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noreferrer"
                    className={styles.inlineLink}
                  >
                    Google AI Studio
                  </a>
                  . It is stored in your macOS keychain only.
                </>
              )}
            </p>
            {geminiKeychainPresent && (
              <p className={styles.helpText}>A keychain key is on file. Paste below to replace it.</p>
            )}
            <div className={styles.subsection}>
              <span className={styles.subLabel}>Thinking strength</span>
              <p className={styles.helpText}>
                Higher thinking can improve tricky table/label reasoning, but it will take longer.
              </p>
              <div className={styles.radioGroup}>
                {GEMINI_THINKING_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${styles.radioOption} ${
                      geminiThinkingMode === option.id ? styles.radioOptionActive : ""
                    }`}
                    onClick={() => handleGeminiThinkingChange(option.id)}
                  >
                    <span className={styles.radioOptionLabel}>{option.label}</span>
                    <span className={styles.radioOptionDescription}>
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <input
              type="password"
              className={styles.input}
              placeholder={
                geminiKeychainPresent
                  ? "New API key (optional)"
                  : geminiBuildTimeKey
                    ? "Override with your own key (optional)"
                    : "Paste API key"
              }
              value={geminiKeyInput}
              onChange={(e) => setGeminiKeyInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={geminiBusy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && geminiKeyInput.trim() && !geminiBusy) {
                  e.preventDefault();
                  void handleSaveGeminiKey();
                }
              }}
            />
            <div className={styles.inputRow}>
              <button
                type="button"
                className={styles.signInBtn}
                disabled={geminiBusy || !geminiKeyInput.trim()}
                onClick={() => void handleSaveGeminiKey()}
              >
                {geminiBusy ? "Saving…" : "Save key"}
              </button>
              <button
                type="button"
                className={styles.testBtn}
                disabled={geminiBusy || !geminiHasKey}
                onClick={() => void handleTestGemini()}
              >
                Test connection
              </button>
              <button
                type="button"
                className={styles.clearBtn}
                disabled={geminiBusy || !geminiKeychainPresent}
                onClick={() => void handleClearGeminiKey()}
              >
                Remove keychain key
              </button>
            </div>
            {geminiError && (
              <span className={styles.statusError}>{geminiError}</span>
            )}
            {geminiOk && <span className={styles.statusOk}>{geminiOk}</span>}
          </div>

          {/*
            v0.5.35 — Account section.

            States:
              1. authLoading: render nothing (cold-start hydration in
                 flight; we're about to know which side of the fence
                 we're on, so flashing "Sign in" first is a worse UX
                 than a brief blank).
              2. !isSignedIn && status !== "sent": email input +
                 "Send magic link" button.
              3. !isSignedIn && status === "sent": "Check your email"
                 confirmation. The user clicks the link in their email,
                 which deep-links back into the app and flips
                 isSignedIn → true via the auth state subscription.
              4. isSignedIn: email + "Sign out" button.
          */}
          {!authLoading && (
            <div className={styles.section}>
              <span className={styles.label}>Account</span>

              {!isSignedIn && signInStatus !== "sent" && (
                <>
                  <p className={styles.helpText}>
                    Sign in to sync projects across devices and keep
                    your community contributions attributed when you
                    switch machines.
                  </p>
                  {/*
                    v0.5.36 — Apple's Human Interface Guidelines ask
                    that "Sign in with Apple" be presented at least as
                    prominently as any other sign-in option, so the
                    Apple button leads. Black background + white text
                    + Apple glyph (U+F8FF private-use char that the
                    SF Pro family renders as the  glyph on Apple
                    platforms; falls back to a small box on Linux/
                    Windows but Typeset is macOS-only today, so the
                    glyph always renders correctly in production).
                    aria-label is set on the button itself so screen
                    readers don't read "PUA character + Sign in with
                    Apple"; the visual span is hidden from a11y.
                  */}
                  <button
                    type="button"
                    className={styles.appleSignInBtn}
                    onClick={handleSignInWithApple}
                    disabled={applePending || signInStatus === "sending"}
                    aria-label="Sign in with Apple"
                  >
                    <span className={styles.appleGlyph} aria-hidden="true">
                      
                    </span>
                    <span className={styles.appleLabel}>
                      {applePending ? "Opening…" : "Sign in with Apple"}
                    </span>
                  </button>
                  <div
                    className={styles.authDivider}
                    role="separator"
                    aria-label="or"
                  >
                    <span className={styles.authDividerLabel}>or</span>
                  </div>
                  <input
                    type="email"
                    className={styles.input}
                    placeholder="you@studio.com"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    autoComplete="email"
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        emailInput.trim().length > 0 &&
                        signInStatus !== "sending"
                      ) {
                        e.preventDefault();
                        void handleSendMagicLink();
                      }
                    }}
                  />
                  <div className={styles.accountActions}>
                    <button
                      type="button"
                      className={styles.signInBtn}
                      onClick={handleSendMagicLink}
                      disabled={
                        emailInput.trim().length === 0 ||
                        signInStatus === "sending" ||
                        applePending
                      }
                    >
                      {signInStatus === "sending"
                        ? "Sending…"
                        : "Send magic link"}
                    </button>
                  </div>
                  {signInStatus === "error" && signInError && (
                    <span className={styles.statusError}>{signInError}</span>
                  )}
                  <p className={styles.syncDisclosure}>
                    Project data is encrypted on your device before
                    upload (AES-256-GCM). The encryption key is stored
                    in your account so you can decrypt on a fresh
                    device — Supabase, our backend, has theoretical
                    access to that key. A future update will offer an
                    optional passphrase for full zero-knowledge sync.
                  </p>
                </>
              )}

              {!isSignedIn && signInStatus === "sent" && (
                <>
                  <p className={styles.checkEmailNote}>
                    Check your email — we sent a sign-in link to{" "}
                    <strong>{emailInput.trim()}</strong>. Click the
                    link in the message and Typeset will pick it up
                    automatically.
                  </p>
                  <div className={styles.accountActions}>
                    <button
                      type="button"
                      className={styles.signOutBtn}
                      onClick={() => {
                        setSignInStatus("idle");
                        setSignInError(null);
                      }}
                    >
                      Use a different email
                    </button>
                  </div>
                </>
              )}

              {isSignedIn && user && (
                <>
                  <span className={styles.accountEmail}>
                    {user.email ?? "(no email on file)"}
                  </span>
                  <span className={styles.accountStatusLine}>
                    Signed in. Projects sync to your account; community
                    submissions are attributed to you.
                  </span>
                  <div className={styles.accountActions}>
                    <button
                      type="button"
                      className={styles.signOutBtn}
                      onClick={handleSignOut}
                      disabled={signOutPending}
                    >
                      {signOutPending ? "Signing out…" : "Sign out"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className={styles.section}>
            <span className={styles.label}>Local data</span>
            <p className={styles.helpText}>
              Saved templates are cached locally for instant matching on
              re-drops. Resetting clears that cache only — your published
              registry templates stay intact, and any matched form will
              re-pull from the community registry on the next drop.
            </p>
            {resetConfirming ? (
              <div className={styles.inputRow}>
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={handleResetLocalTemplates}
                >
                  Confirm reset
                </button>
                <button
                  type="button"
                  className={styles.testBtn}
                  onClick={() => setResetConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className={styles.inputRow}>
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => setResetConfirming(true)}
                >
                  Reset local templates
                </button>
                {resetStatus && (
                  <span className={styles.statusOk}>{resetStatus}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerLeft} />
          <div className={styles.footerRight}>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </footer>

        {/* v0.5.26 — About row. Quiet version line + manual update
            opt-in, relocated here from the sidebar footer so the
            sidebar can carry only its primary actions. */}
        <div className={styles.about}>
          <span className={styles.aboutVersion}>Typeset {APP_VERSION}</span>
          <span className={styles.aboutSeparator}>—</span>
          {updateStatus === "checking" ? (
            <span className={styles.aboutStatus}>Checking…</span>
          ) : updateStatus === "upToDate" ? (
            <span className={styles.aboutStatus}>Up to date</span>
          ) : updateStatus === "error" ? (
            <span className={styles.aboutError}>
              {updateError ? `Update check failed — ${updateError}` : "Update check failed"}
            </span>
          ) : (
            <button
              type="button"
              className={styles.aboutLink}
              onClick={handleCheckForUpdates}
            >
              Check for updates
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
