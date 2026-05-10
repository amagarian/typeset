import { useCallback, useRef } from "react";
import type { Project } from "@/types";
import type { SaveStatus } from "@/hooks/useProjects";
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
}

export function NewProjectView({
  initialProject,
  isEditing,
  saveStatus = "idle",
  onChange,
  onClose,
  onImportPdf,
}: NewProjectViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const indicatorVisible = saveStatus === "saved" || saveStatus === "saving";

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
      <ProjectDetailForm project={project} onChange={onChange} />
    </div>
  );
}
