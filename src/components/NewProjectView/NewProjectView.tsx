import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/types";
import type { SaveStatus, SyncStatus } from "@/hooks/useProjects";
import { ProjectDetailForm } from "../ProjectDetailForm/ProjectDetailForm";
import styles from "./NewProjectView.module.css";

interface NewProjectViewProps {
  initialProject: Partial<Project>;
  isEditing?: boolean;
  /**
   * v0.5.28 — drives the "Saved ✓" indicator in the header. Comes
   * straight from `useProjects()` and transitions
   * `idle → saving → saved → idle` on each debounced autosave.
   * The indicator is purely cosmetic; ignoring this prop just
   * means the user never sees the confirmation.
   */
  saveStatus?: SaveStatus;
  /**
   * v0.5.35 — sync status, also from `useProjects()`. Anonymous users
   * always see `"idle"`; signed-in users see the full
   * `idle → syncing → synced` cycle on every push, plus `error` and
   * `offline` for failure modes. Rendered next to the local "Saved"
   * indicator so the two state machines (local vs cloud) are
   * visually distinguishable.
   */
  syncStatus?: SyncStatus;
  onChange: (updates: Partial<Project>) => void;
  /**
   * v0.5.28 — single close affordance for both the new-project
   * and edit-project flows, replacing the bottom-row Cancel + Save
   * buttons. With autosave handling persistence on every keystroke,
   * the user no longer has to confirm anything; closing just
   * navigates away. The new-project flow's `onClose` may also
   * delete the project if the user typed nothing — see App.tsx's
   * `handleCloseNewProject`.
   */
  onClose: () => void;
  onImportPdf?: (file: File) => void;
  /**
   * v0.6.0 — toast surface for signature-image upload errors
   * (unsupported file type, > 2MB, decode failure). Optional;
   * when omitted, validation failures are silent and the upload
   * is simply ignored.
   */
  onError?: (message: string) => void;
  /**
   * v0.6.0 — explicit Save button. Calls `flushSave` from
   * `useProjects()` to force-write any pending debounced changes,
   * then navigates back to the project list (sidebar selection
   * cleared, returns to the workspace empty state). Coexists with
   * autosave — autosave still runs at 500ms debounce; the button
   * just gives users an explicit "I'm done with this page"
   * affordance plus a `⌘S` keyboard shortcut.
   *
   * Implementation note (Save semantics): we deliberately route
   * Save → workspace empty state (sidebar selection cleared) so
   * the user lands on a neutral surface that confirms "the job
   * is filed" rather than dropping them right back into the
   * preview pane that they may not want to see (especially in
   * the new-project flow where there's no template yet). If they
   * meant to view the project, they can click it in the sidebar
   * — that round-trip is one click and matches the existing
   * sidebar muscle memory.
   */
  onSave?: () => void | Promise<void>;
}

export function NewProjectView({
  initialProject,
  isEditing,
  saveStatus = "idle",
  syncStatus = "idle",
  onChange,
  onClose,
  onImportPdf,
  onError,
  onSave,
}: NewProjectViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // v0.6.0 — local "Saved ✓" pulse for the explicit Save button.
  // Distinct from `saveStatus` (the autosave-driven indicator),
  // which fires once every 500ms while the user types and is
  // already busy reflecting autosave activity. The Save-button
  // pulse is a one-shot 1.2s confirmation tied to the click,
  // routed entirely off the autosave state machine so it always
  // shows even when the autosave debounce already fired and
  // would otherwise leave `saveStatus === "idle"`.
  const [savePulseVisible, setSavePulseVisible] = useState(false);
  const savePulseTimerRef = useRef<number | null>(null);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file?.type === "application/pdf" && onImportPdf) {
        onImportPdf(file);
      }
      e.target.value = "";
    },
    [onImportPdf]
  );

  const handleSave = useCallback(async () => {
    if (!onSave) return;
    try {
      await onSave();
    } finally {
      // Show the pulse regardless of whether the flush completed
      // before navigation — `onSave` typically returns after the
      // store-write but the parent may have already navigated.
      // The pulse is harmless on a navigated-away view.
      setSavePulseVisible(true);
      if (savePulseTimerRef.current !== null) {
        window.clearTimeout(savePulseTimerRef.current);
      }
      savePulseTimerRef.current = window.setTimeout(() => {
        setSavePulseVisible(false);
        savePulseTimerRef.current = null;
      }, 1200);
    }
  }, [onSave]);

  // v0.6.0 — global ⌘S / Ctrl+S handler scoped to this view.
  // Captures at the document level so it fires regardless of
  // which form input has focus; preventDefault stops the
  // browser/OS "save page" affordance which would otherwise
  // open a file dialog. Cleanup on unmount keeps the listener
  // from firing when the user navigates back to the workspace.
  useEffect(() => {
    if (!onSave) return;
    const handler = (e: KeyboardEvent) => {
      const isMac = /Mac|iP/.test(navigator.platform);
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      if (cmdOrCtrl && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
    };
  }, [handleSave, onSave]);

  useEffect(() => {
    return () => {
      if (savePulseTimerRef.current !== null) {
        window.clearTimeout(savePulseTimerRef.current);
        savePulseTimerRef.current = null;
      }
    };
  }, []);

  // v0.5.28 — every Project field declared on the type lives in this
  // template so the form is total over the type even when the
  // caller passes a partial. v0.6.0 optional fields are NOT pre-seeded
  // — they spread off `initialProject` only when the caller has them.
  const project = {
    id: "",
    label: "",
    jobName: "",
    jobNumber: "",
    poNumber: "",
    authorizationDate: "",
    shootDate: "",
    productionCompany: "",
    billingAddress: "",
    billingCity: "",
    billingState: "",
    billingZipCode: "",
    producer: "",
    email: "",
    phone: "",
    creditCardType: "",
    creditCardHolder: "",
    cardholderSignature: "",
    creditCardNumber: "",
    expDate: "",
    ccv: "",
    createdAt: "",
    updatedAt: "",
    ...initialProject,
  } as Project;

  // v0.5.28 — show the indicator while a save is mid-flight or for
  // the 1-second `saved` hold the hook tacks onto each successful
  // write. Both states keep the indicator visible (CSS handles the
  // 150ms fade); the `saving` window is usually too brief to see
  // but we keep the indicator on rather than flicker it off and
  // back on for sub-frame writes. Gray tone, never green.
  // v0.6.0 — also driven by the explicit-Save pulse so a user who
  // hasn't typed since the last debounce sees confirmation when
  // they hit ⌘S.
  const indicatorVisible =
    saveStatus === "saved" || saveStatus === "saving" || savePulseVisible;

  // v0.5.35 — sync indicator. Independent of the local Saved
  // indicator; rendered alongside it so both state machines have
  // their own surface. Only shown when there's something to say —
  // anonymous users (syncStatus always "idle") never see this slot.
  const syncIndicatorVisible =
    syncStatus === "syncing" ||
    syncStatus === "synced" ||
    syncStatus === "error" ||
    syncStatus === "offline";

  const syncIndicatorLabel =
    syncStatus === "syncing"
      ? "Syncing…"
      : syncStatus === "synced"
      ? "Synced"
      : syncStatus === "offline"
      ? "Offline"
      : syncStatus === "error"
      ? "Sync error"
      : "";

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h2 className={styles.title}>JOB INFO</h2>
        <div className={styles.headerActions}>
          <span
            className={`${styles.savedIndicator} ${
              indicatorVisible ? styles.savedIndicatorVisible : ""
            }`}
            aria-hidden={indicatorVisible ? "false" : "true"}
            aria-live="polite"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className={styles.savedIndicatorLabel}>Saved</span>
          </span>
          {syncIndicatorVisible && (
            <span
              className={`${styles.syncIndicator} ${
                syncStatus === "error"
                  ? styles.syncIndicatorError
                  : ""
              }`}
              aria-live="polite"
              title={
                syncStatus === "error"
                  ? "Sync to your account failed; we'll retry on the next edit."
                  : syncStatus === "offline"
                  ? "Working offline. Local changes will sync when you reconnect."
                  : undefined
              }
            >
              {syncIndicatorLabel}
            </span>
          )}
          {onImportPdf && (
            <>
              <button
                type="button"
                className={styles.importBtn}
                onClick={() => fileInputRef.current?.click()}
                title="Import fields from a filled PDF"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Import from PDF
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                className={styles.hiddenInput}
                onChange={handleFileInput}
              />
            </>
          )}
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={isEditing ? "Close" : "Done"}
            title={isEditing ? "Close" : "Done"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      <ProjectDetailForm project={project} onChange={onChange} onSignatureError={onError} />
      {/*
        v0.6.0 — explicit Save button. Bottom-left of the form
        column, matching the v0.5.x button language. Coexists
        with autosave (autosave keeps running on every keystroke);
        this button is a "done editing, take me back" affordance
        that flushes any pending debounce, pulses Saved ✓, and
        navigates to the workspace empty state. ⌘S is wired up
        in the parent-level keydown listener above.
      */}
      {onSave && (
        <div className={styles.saveBar}>
          <button
            type="button"
            className={styles.saveBtn}
            onClick={() => void handleSave()}
            title="Save and return to workspace (⌘S)"
          >
            Save
            <span className={styles.saveBtnShortcut} aria-hidden="true">
              ⌘S
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
