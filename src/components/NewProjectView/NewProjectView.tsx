import { useCallback, useRef } from "react";
import type { Project } from "@/types";
import { ProjectDetailForm } from "../ProjectDetailForm/ProjectDetailForm";
import styles from "./NewProjectView.module.css";

interface NewProjectViewProps {
  initialProject: Partial<Project>;
  isEditing?: boolean;
  onChange: (updates: Partial<Project>) => void;
  onSave: () => void;
  onCancel: () => void;
  onImportPdf?: (file: File) => void;
}

export function NewProjectView({
  initialProject,
  isEditing,
  onChange,
  onSave,
  onCancel,
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

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h2 className={styles.title}>JOB INFO</h2>
        <div className={styles.headerActions}>
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
          <button type="button" className={styles.closeBtn} onClick={onCancel} aria-label="Close" title="Cancel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
      <ProjectDetailForm project={project} onChange={onChange} />
      <div className={styles.actions}>
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.saveBtn} onClick={onSave}>
          {isEditing ? "Save" : "Create project"}
        </button>
      </div>
    </div>
  );
}
