import { useEffect, useState, useCallback, useRef } from "react";
import {
  setApiKey,
  hasApiKey,
  clearApiKey,
  testGeminiConnection,
  GeminiNotConfiguredError,
} from "@/services/geminiClient";
import {
  ACCURACY_OPTIONS,
  DEFAULT_ACCURACY_MODE,
  DEFAULT_MODEL,
  MODEL_PRESETS,
  getAccuracyMode,
  getModelPreference,
  setAccuracyMode,
  setModelPreference,
  type AccuracyMode,
} from "@/services/geminiSettings";
import { writeLocalTemplates } from "@/services/templateCache";
import { isUpdateInstalled, runUpdateCheck } from "@/utils/autoUpdate";
import { useAuth, useAuthEvents } from "@/hooks/useAuth";
import packageJson from "../../../package.json";
import styles from "./SettingsModal.module.css";

// v0.5.26 — single source of truth for the version string we print in
// the Settings "About" footer. Pulled from `package.json` so the
// label always matches the bundled build (no chance of skew with the
// Tauri-installed binary).
const APP_VERSION: string = (packageJson as { version: string }).version;

const CUSTOM_OPTION_VALUE = "__custom__";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type TestStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; message?: string }
  | { kind: "error"; message: string };

/**
 * Settings panel — Gemini configuration only.
 *
 * Since v0.5.9 the public template registry is a passive,
 * fingerprint-driven backend with no UI surface here. Drop a PDF
 * and the registry runs invisibly: high-confidence matches are
 * auto-installed and surface a single toast in the main window;
 * everything else falls through to Gemini detection. Saves
 * auto-publish in the background. There is no manual browse,
 * search, install, or upvote here.
 */
export function SettingsModal({
  open,
  onClose,
  onSaved,
}: SettingsModalProps) {
  const [keyInput, setKeyInput] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [presetSelection, setPresetSelection] = useState<string>(DEFAULT_MODEL);
  const [customModelId, setCustomModelId] = useState("");
  const [accuracySelection, setAccuracySelection] =
    useState<AccuracyMode>(DEFAULT_ACCURACY_MODE);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
  const { user, isSignedIn, signIn, signOut, isLoading: authLoading } = useAuth();
  const [emailInput, setEmailInput] = useState("");
  const [signInStatus, setSignInStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signOutPending, setSignOutPending] = useState(false);

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
    let cancelled = false;
    void (async () => {
      const configured = await hasApiKey();
      if (cancelled) return;
      setKeyConfigured(configured);
      setKeyInput("");

      const stored = getModelPreference();
      const matchesPreset = MODEL_PRESETS.some((p) => p.id === stored);
      if (matchesPreset) {
        setPresetSelection(stored);
        setCustomModelId("");
      } else {
        setPresetSelection(CUSTOM_OPTION_VALUE);
        setCustomModelId(stored);
      }
      setAccuracySelection(getAccuracyMode());
      setTestStatus({ kind: "idle" });
      setSaveError(null);
      setResetConfirming(false);
      setResetStatus(null);
      // v0.5.35 — reset the in-modal auth flow state every time the
      // modal opens so the previous "Check your email" panel
      // doesn't linger across opens.
      setEmailInput("");
      setSignInStatus("idle");
      setSignInError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (resetStatusTimerRef.current !== null) {
        window.clearTimeout(resetStatusTimerRef.current);
      }
    };
  }, []);

  const effectiveModel =
    presetSelection === CUSTOM_OPTION_VALUE ? customModelId.trim() : presetSelection;

  const canSave =
    effectiveModel.length > 0 && (keyConfigured || keyInput.trim().length > 0);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (keyInput.trim().length > 0) {
        await setApiKey(keyInput.trim());
        setKeyConfigured(true);
        setKeyInput("");
      }
      setModelPreference(effectiveModel);
      setAccuracyMode(accuracySelection);
      onSaved?.();
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save settings.";
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [keyInput, effectiveModel, accuracySelection, onSaved, onClose]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await clearApiKey();
      setKeyConfigured(false);
      setKeyInput("");
      setTestStatus({ kind: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear key.";
      setSaveError(message);
    } finally {
      setSaving(false);
    }
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

  const handleTest = useCallback(async () => {
    if (!effectiveModel) return;
    setTestStatus({ kind: "running" });
    try {
      // If user typed a new key but didn't save yet, save it first so the
      // Rust side can read it from the keychain when it runs the ping.
      if (keyInput.trim().length > 0) {
        await setApiKey(keyInput.trim());
        setKeyConfigured(true);
        setKeyInput("");
      }
      await testGeminiConnection(effectiveModel);
      setTestStatus({ kind: "ok" });
    } catch (err) {
      if (err instanceof GeminiNotConfiguredError) {
        setTestStatus({
          kind: "error",
          message:
            "API key not configured. Paste your key first, then test the connection.",
        });
      } else {
        const message =
          err instanceof Error ? err.message : "Connection test failed.";
        setTestStatus({ kind: "error", message });
      }
    }
  }, [effectiveModel, keyInput]);

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
            <span className={styles.label}>Gemini API key</span>
            <p className={styles.helpText}>
              Stored in your operating system&apos;s secure keychain. Never written to
              disk in plain text. Get a key at{" "}
              <code>aistudio.google.com/app/apikey</code>.
            </p>
            <input
              type="password"
              className={`${styles.input} ${styles.maskedInput}`}
              placeholder={keyConfigured ? "•••••••••••••••• (saved)" : "AIza..."}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {keyConfigured && keyInput.length === 0 && (
              <span className={styles.keyMeta}>A key is currently saved.</span>
            )}
          </div>

          <div className={styles.section}>
            <span className={styles.label}>Model</span>
            <select
              className={styles.select}
              value={presetSelection}
              onChange={(e) => setPresetSelection(e.target.value)}
            >
              {MODEL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              <option value={CUSTOM_OPTION_VALUE}>Custom (paste exact API model id)</option>
            </select>
            {presetSelection === CUSTOM_OPTION_VALUE && (
              <input
                type="text"
                className={styles.input}
                placeholder="e.g. gemini-2.5-pro-preview-06-05"
                value={customModelId}
                onChange={(e) => setCustomModelId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            {presetSelection !== CUSTOM_OPTION_VALUE && (
              <p className={styles.modelDescriptions}>
                {MODEL_PRESETS.find((p) => p.id === presetSelection)?.description}
              </p>
            )}
          </div>

          <div className={styles.section}>
            <span className={styles.label}>Accuracy</span>
            <div className={styles.radioGroup} role="radiogroup" aria-label="Accuracy mode">
              {ACCURACY_OPTIONS.map((option) => {
                const active = accuracySelection === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`${styles.radioOption} ${active ? styles.radioOptionActive : ""}`}
                    onClick={() => setAccuracySelection(option.id)}
                  >
                    <span className={styles.radioOptionLabel}>{option.label}</span>
                    <span className={styles.radioOptionDescription}>
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.inputRow}>
              <button
                type="button"
                className={styles.testBtn}
                onClick={handleTest}
                disabled={
                  testStatus.kind === "running" ||
                  saving ||
                  effectiveModel.length === 0 ||
                  (!keyConfigured && keyInput.trim().length === 0)
                }
              >
                {testStatus.kind === "running" ? "Testing…" : "Test connection"}
              </button>
              {testStatus.kind === "ok" && (
                <span className={styles.statusOk}>OK — connection works.</span>
              )}
              {testStatus.kind === "error" && (
                <span className={styles.statusError}>{testStatus.message}</span>
              )}
            </div>
          </div>

          {saveError && <span className={styles.statusError}>{saveError}</span>}

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
                    Sign in with your email to sync projects across
                    devices and keep your community contributions
                    attributed when you switch machines. We&apos;ll send a
                    one-time magic link — no password.
                  </p>
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
                        signInStatus === "sending"
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
          <div className={styles.footerLeft}>
            {keyConfigured && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={handleClear}
                disabled={saving}
              >
                Clear key
              </button>
            )}
          </div>
          <div className={styles.footerRight}>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={!canSave || saving}
            >
              {saving ? "Saving…" : "Save"}
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
