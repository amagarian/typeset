import { useEffect, useState, useCallback } from "react";
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
import styles from "./SettingsModal.module.css";

const CUSTOM_OPTION_VALUE = "__custom__";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type TestStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export function SettingsModal({ open, onClose, onSaved }: SettingsModalProps) {
  const [keyInput, setKeyInput] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [presetSelection, setPresetSelection] = useState<string>(DEFAULT_MODEL);
  const [customModelId, setCustomModelId] = useState("");
  const [accuracySelection, setAccuracySelection] =
    useState<AccuracyMode>(DEFAULT_ACCURACY_MODE);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

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
      </div>
    </div>
  );
}
