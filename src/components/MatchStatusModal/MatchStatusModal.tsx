import type { PdfMatchResult } from "@/types";
import styles from "./MatchStatusModal.module.css";

interface MatchStatusModalProps {
  result: PdfMatchResult;
  onClose: () => void;
  onOpenTemplateReview: (templateId: string) => void;
  onFillNow: (templateId: string) => void;
  onPreviewBeforeExport: (templateId: string) => void;
  onCreateNewTemplate: () => void;
  onEditTemplate: (templateId: string) => void;
}

export function MatchStatusModal({
  result,
  onClose,
  onOpenTemplateReview,
  onFillNow,
  onPreviewBeforeExport,
  onCreateNewTemplate,
  onEditTemplate,
}: MatchStatusModalProps) {
  const { kind, verifiedMatch, draftTemplateId, fileName, syncState } = result;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <span className={styles.fileName}>{fileName ?? "document.pdf"}</span>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </header>

        {syncState === "matching" && (
          <p className={styles.statusNote}>Matching...</p>
        )}

        <div className={styles.body}>
          {kind === "verified" && verifiedMatch && (
            <div className={styles.card}>
              <span className={`${styles.badge} ${styles.verified}`}>Saved template</span>
              <h3 className={styles.title}>{verifiedMatch.templateName}</h3>
              <p className={styles.meta}>
                {Math.round(verifiedMatch.confidence * 100)}% match
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.primaryBtn} onClick={() => onFillNow(verifiedMatch.templateId)}>
                  Fill now
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={() => onPreviewBeforeExport(verifiedMatch.templateId)}>
                  Preview
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={() => onEditTemplate(verifiedMatch.templateId)}>
                  Edit
                </button>
              </div>
            </div>
          )}

          {kind === "none" && (
            <div className={styles.card}>
              <span className={`${styles.badge} ${styles.none}`}>No saved template</span>
              <p className={styles.hint}>Open the template editor to confirm Claude&apos;s detected fields, or create a fresh one.</p>
              {draftTemplateId ? (
                <div className={styles.actions}>
                  <button type="button" className={styles.primaryBtn} onClick={() => onOpenTemplateReview(draftTemplateId)}>
                    Open template editor
                  </button>
                  <button type="button" className={styles.secondaryBtn} onClick={onCreateNewTemplate}>
                    Start blank template
                  </button>
                </div>
              ) : (
                <button type="button" className={styles.primaryBtn} onClick={onCreateNewTemplate}>
                  Start blank template
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
