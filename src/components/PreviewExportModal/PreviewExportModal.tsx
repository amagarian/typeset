import { useState, useEffect } from "react";
import type { Project, Template } from "@/types";
import type { PromptFieldValues } from "@/utils/fill";
import { writeFilledPdfBytes } from "@/utils/pdfWriter";
import { PdfPageCanvas } from "../PdfPageCanvas/PdfPageCanvas";
import styles from "./PreviewExportModal.module.css";

interface PreviewExportModalProps {
  template: Template;
  project: Project;
  sourceBytes: Uint8Array;
  promptValues?: PromptFieldValues;
  fileName?: string;
  onClose: () => void;
  onExport: () => void;
  exportLabel?: string;
}

export function PreviewExportModal({
  template,
  project,
  sourceBytes,
  promptValues = {},
  fileName,
  onClose,
  onExport,
  exportLabel = "Export PDF",
}: PreviewExportModalProps) {
  const [filledBytes, setFilledBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    let cancelled = false;

    async function generate() {
      try {
        const bytes = await writeFilledPdfBytes(sourceBytes, template, project, {
          defaultFontSize: 10,
          promptValues,
        });
        if (cancelled) return;
        setFilledBytes(bytes);

        const pdfjsLib = await import("pdfjs-dist");
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
        if (!cancelled) setPageCount(doc.numPages);
      } catch (err) {
        if (!cancelled) {
          console.error("Preview generation failed:", err);
          setError(err instanceof Error ? err.message : "Failed to generate preview");
        }
      }
    }

    void generate();
    return () => { cancelled = true; };
  }, [sourceBytes, template, project, promptValues]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="preview-modal-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <div>
            <h2 id="preview-modal-title" className={styles.title}>
              Preview
            </h2>
            <p className={styles.subtitle}>
              {fileName ?? "document.pdf"} · {project.jobName || project.label || "Untitled project"}
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <div className={styles.body}>
          {error && <p className={styles.error}>{error}</p>}

          {!error && !filledBytes && (
            <div className={styles.generating}>Generating preview…</div>
          )}

          {filledBytes && (
            <div className={styles.pdfContainer}>
              <PdfPageCanvas
                pdfBytes={filledBytes}
                pageNumber={currentPage}
                maxWidth={700}
                maxHeight={600}
              />
            </div>
          )}

          {pageCount > 1 && (
            <div className={styles.pager}>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => p - 1)}
              >
                ‹ Prev
              </button>
              <span className={styles.pageInfo}>
                Page {currentPage} of {pageCount}
              </span>
              <button
                type="button"
                className={styles.pageBtn}
                disabled={currentPage >= pageCount}
                onClick={() => setCurrentPage((p) => p + 1)}
              >
                Next ›
              </button>
            </div>
          )}
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            Close
          </button>
          <button type="button" className={styles.primaryBtn} onClick={onExport}>
            {exportLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
