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
import {
  setRegistryCredentials,
  getRegistryCredentials,
  clearRegistryCredentials,
  hasRegistryCredentials,
} from "@/services/registrySettings";
import {
  reloadRegistry,
  isRegistryEnabled,
  testRegistryConnection,
  searchTemplates,
  voteOnTemplate,
  type RegistryTemplate,
} from "@/services/templateRegistry";
import type { Template } from "@/types";
import styles from "./SettingsModal.module.css";

const CUSTOM_OPTION_VALUE = "__custom__";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** Called when the user clicks Install on a registry-browser row. */
  onInstallTemplate?: (template: Template) => void;
}

type TestStatus =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; message?: string }
  | { kind: "error"; message: string };

function buildTemplateFromRegistryRow(row: RegistryTemplate): Template {
  const now = new Date().toISOString();
  return {
    id: `tpl-registry-${row.id}`,
    name: row.name,
    status: "local-verified",
    source: "remote-registry",
    registryId: row.id,
    fields: row.fields,
    fingerprint: row.fingerprint,
    pageCount: row.pageCount,
    createdAt: now,
    updatedAt: now,
  };
}

export function SettingsModal({
  open,
  onClose,
  onSaved,
  onInstallTemplate,
}: SettingsModalProps) {
  // -------------------------------------------------------------------------
  // Gemini section state
  // -------------------------------------------------------------------------
  const [keyInput, setKeyInput] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [presetSelection, setPresetSelection] = useState<string>(DEFAULT_MODEL);
  const [customModelId, setCustomModelId] = useState("");
  const [accuracySelection, setAccuracySelection] =
    useState<AccuracyMode>(DEFAULT_ACCURACY_MODE);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // -------------------------------------------------------------------------
  // Template-registry section state
  // -------------------------------------------------------------------------
  const [registryUrlInput, setRegistryUrlInput] = useState("");
  const [registryKeyInput, setRegistryKeyInput] = useState("");
  const [registryConfigured, setRegistryConfigured] = useState(false);
  const [registryTestStatus, setRegistryTestStatus] = useState<TestStatus>({
    kind: "idle",
  });
  const [registryBusy, setRegistryBusy] = useState(false);

  // Browser panel state.
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseResults, setBrowseResults] = useState<RegistryTemplate[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [voteBusyId, setVoteBusyId] = useState<string | null>(null);
  // Track which rows the device has upvoted in this session (we don't
  // round-trip the user's own votes from the server in v0.5.0; this is
  // a UI-only optimistic indicator).
  const [upvotedIds, setUpvotedIds] = useState<Set<string>>(new Set());

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

      // Registry section.
      const creds = await getRegistryCredentials();
      if (cancelled) return;
      setRegistryUrlInput(creds.url ?? "");
      setRegistryKeyInput("");
      setRegistryConfigured(await hasRegistryCredentials());
      setRegistryTestStatus({ kind: "idle" });
      setBrowseQuery("");
      setBrowseResults([]);
      setBrowseError(null);
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

  // -------------------------------------------------------------------------
  // Registry section actions
  // -------------------------------------------------------------------------

  const handleSaveRegistryCreds = useCallback(async () => {
    setRegistryBusy(true);
    setRegistryTestStatus({ kind: "idle" });
    try {
      const url = registryUrlInput.trim();
      const key = registryKeyInput.trim();
      if (!url || !key) {
        setRegistryTestStatus({
          kind: "error",
          message: "Both fields are required.",
        });
        return;
      }
      await setRegistryCredentials(url, key);
      setRegistryConfigured(true);
      setRegistryKeyInput("");
      // Rebuild the in-module Supabase client immediately so the next
      // Save-template click can publish without a restart.
      await reloadRegistry();
      setRegistryTestStatus({
        kind: "ok",
        message: "Saved. Use Test connection to verify the migration ran.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save credentials.";
      setRegistryTestStatus({ kind: "error", message });
    } finally {
      setRegistryBusy(false);
    }
  }, [registryUrlInput, registryKeyInput]);

  const handleClearRegistryCreds = useCallback(async () => {
    setRegistryBusy(true);
    setRegistryTestStatus({ kind: "idle" });
    try {
      await clearRegistryCredentials();
      setRegistryConfigured(false);
      setRegistryUrlInput("");
      setRegistryKeyInput("");
      await reloadRegistry();
      setBrowseResults([]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear credentials.";
      setRegistryTestStatus({ kind: "error", message });
    } finally {
      setRegistryBusy(false);
    }
  }, []);

  const handleTestRegistry = useCallback(async () => {
    setRegistryTestStatus({ kind: "running" });
    try {
      // If the user typed new credentials but hasn't pressed Save, persist
      // them now so the test exercises what they just typed.
      const url = registryUrlInput.trim();
      const key = registryKeyInput.trim();
      if (url && key) {
        await setRegistryCredentials(url, key);
        setRegistryConfigured(true);
        setRegistryKeyInput("");
        await reloadRegistry();
      }
      const count = await testRegistryConnection();
      setRegistryTestStatus({
        kind: "ok",
        message: `OK — ${count} template${count === 1 ? "" : "s"} in registry.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection test failed.";
      setRegistryTestStatus({ kind: "error", message });
    }
  }, [registryUrlInput, registryKeyInput]);

  const handleBrowse = useCallback(async () => {
    if (!isRegistryEnabled()) {
      setBrowseError("Save and verify your Supabase credentials first.");
      return;
    }
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const rows = await searchTemplates(browseQuery, 30);
      setBrowseResults(rows);
      if (rows.length === 0) {
        setBrowseError(
          browseQuery.trim()
            ? `No matches for “${browseQuery.trim()}”.`
            : "No community templates yet — be the first to publish one!"
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Browse failed.";
      setBrowseError(message);
    } finally {
      setBrowseLoading(false);
    }
  }, [browseQuery]);

  const handleInstall = useCallback(
    (row: RegistryTemplate) => {
      const installed = buildTemplateFromRegistryRow(row);
      onInstallTemplate?.(installed);
    },
    [onInstallTemplate]
  );

  const handleUpvote = useCallback(
    async (row: RegistryTemplate) => {
      if (upvotedIds.has(row.id)) return;
      setVoteBusyId(row.id);
      try {
        await voteOnTemplate(row.id, 1);
        setUpvotedIds((prev) => {
          const next = new Set(prev);
          next.add(row.id);
          return next;
        });
        setBrowseResults((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, upvotes: r.upvotes + 1 } : r))
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Vote failed.";
        setBrowseError(message);
      } finally {
        setVoteBusyId(null);
      }
    },
    [upvotedIds]
  );

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

          {/* ---------------------------------------------------------------
              Template registry (Supabase)
              --------------------------------------------------------------- */}
          <div className={styles.divider} />

          <div className={styles.section}>
            <span className={styles.label}>Template registry (Supabase)</span>
            <p className={styles.helpText}>
              Optional. When configured, every template you save is
              automatically shared to the public registry — and other
              users dropping the same form will get your field map
              instantly, no Gemini call required. Credentials live in
              your OS keychain (no rebuild required). See{" "}
              <code>supabase/README.md</code> for setup.
            </p>
            <input
              type="text"
              className={styles.input}
              placeholder="https://your-project.supabase.co"
              value={registryUrlInput}
              onChange={(e) => setRegistryUrlInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <input
              type="password"
              className={`${styles.input} ${styles.maskedInput}`}
              placeholder={
                registryConfigured
                  ? "•••••••••••••••• (saved)"
                  : "sb_publishable_… or eyJhbGciOi… (anon key)"
              }
              value={registryKeyInput}
              onChange={(e) => setRegistryKeyInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {registryConfigured && registryKeyInput.length === 0 && (
              <span className={styles.keyMeta}>Credentials are currently saved.</span>
            )}

            <div className={styles.inputRow}>
              <button
                type="button"
                className={styles.testBtn}
                onClick={handleSaveRegistryCreds}
                disabled={
                  registryBusy ||
                  registryUrlInput.trim().length === 0 ||
                  registryKeyInput.trim().length === 0
                }
              >
                {registryBusy ? "Saving…" : "Save credentials"}
              </button>
              <button
                type="button"
                className={styles.testBtn}
                onClick={handleTestRegistry}
                disabled={
                  registryTestStatus.kind === "running" ||
                  registryBusy ||
                  (!registryConfigured &&
                    (registryUrlInput.trim().length === 0 ||
                      registryKeyInput.trim().length === 0))
                }
              >
                {registryTestStatus.kind === "running"
                  ? "Testing…"
                  : "Test connection"}
              </button>
              {registryConfigured && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={handleClearRegistryCreds}
                  disabled={registryBusy}
                >
                  Clear
                </button>
              )}
            </div>
            {registryTestStatus.kind === "ok" && (
              <span className={styles.statusOk}>
                {registryTestStatus.message ?? "OK — connection works."}
              </span>
            )}
            {registryTestStatus.kind === "error" && (
              <span className={styles.statusError}>{registryTestStatus.message}</span>
            )}
          </div>

          {registryConfigured && (
            <div className={styles.section}>
              <span className={styles.label}>Browse community templates</span>
              <div className={styles.inputRow}>
                <input
                  type="text"
                  className={styles.input}
                  placeholder="Search by name (e.g. payroll, NDA, credit auth)…"
                  value={browseQuery}
                  onChange={(e) => setBrowseQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleBrowse();
                    }
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={styles.testBtn}
                  onClick={handleBrowse}
                  disabled={browseLoading}
                >
                  {browseLoading ? "Searching…" : "Search"}
                </button>
              </div>
              {browseError && (
                <span className={styles.statusError}>{browseError}</span>
              )}
              {browseResults.length > 0 && (
                <ul className={styles.browseList}>
                  {browseResults.map((row) => (
                    <li key={row.id} className={styles.browseRow}>
                      <div className={styles.browseRowMain}>
                        <span className={styles.browseRowName}>{row.name}</span>
                        <span className={styles.browseRowMeta}>
                          {row.pageCount} page{row.pageCount === 1 ? "" : "s"} ·{" "}
                          {row.fieldCount} field{row.fieldCount === 1 ? "" : "s"} ·{" "}
                          {row.upvotes} upvote{row.upvotes === 1 ? "" : "s"}
                          {row.isMine ? " · yours" : ""}
                        </span>
                      </div>
                      <div className={styles.browseRowActions}>
                        <button
                          type="button"
                          className={styles.testBtn}
                          onClick={() => handleUpvote(row)}
                          disabled={
                            voteBusyId === row.id ||
                            upvotedIds.has(row.id) ||
                            row.isMine
                          }
                          title={
                            row.isMine
                              ? "Can't vote on your own publish"
                              : upvotedIds.has(row.id)
                              ? "Already upvoted in this session"
                              : "Upvote"
                          }
                        >
                          {upvotedIds.has(row.id) ? "↑ Voted" : "↑ Upvote"}
                        </button>
                        <button
                          type="button"
                          className={styles.saveBtn}
                          onClick={() => handleInstall(row)}
                        >
                          Install
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
