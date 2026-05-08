import { useState, useEffect } from "react";
import type { ProjectDocument } from "@/types";
import styles from "./DocumentList.module.css";

interface DocumentListProps {
  documents: ProjectDocument[];
  onOpen: (doc: ProjectDocument) => void;
  onDownload: (doc: ProjectDocument) => void;
  onEditTemplate: (doc: ProjectDocument) => void;
  onPreview: (doc: ProjectDocument) => void;
  onRemove: (docId: string) => void;
}

// Calibrated against measured timings on Opus 4.7 (~60-90s end-to-end).
// Sonnet 4.6 runs 200-400s but we still cap the time-based curve at 90s
// — once the phase floor takes over (tool_executing → writing → done),
// it drives the bar to completion regardless of clock drift.
const ESTIMATED_DURATION_MS = 90_000;

function ProcessingRow({ doc, onRemove }: { doc: ProjectDocument; onRemove: (id: string) => void }) {
  // `timeProgress` is the smooth elapsed-time curve (asymptotic to ~95%).
  // `phaseFloor` is the discrete progress reported by Gemini's SSE
  // events (uploading → thinking → tool_executing → writing → done).
  // The displayed value is `max(timeProgress, phaseFloor)` so phase
  // events can JUMP the bar forward, while time keeps it crawling
  // between events.
  const [timeProgress, setTimeProgress] = useState(0);
  const phaseFloor = doc.processingProgress ?? 0;

  useEffect(() => {
    const startTime = new Date(doc.createdAt).getTime();

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const raw = elapsed / ESTIMATED_DURATION_MS;
      // 1 - exp(-2.5) ≈ 0.918 at the estimated duration; cap at 0.95
      // so we never show 100% before the detector actually finishes.
      const pct = Math.min(0.95, 1 - Math.exp(-2.5 * raw));
      setTimeProgress(pct);
    };

    tick();
    const id = setInterval(tick, 400);
    return () => clearInterval(id);
  }, [doc.createdAt]);

  const progress = Math.max(timeProgress, phaseFloor);
  const pctDisplay = Math.round(progress * 100);

  return (
    <div className={`${styles.row} ${styles.processingRow}`}>
      <div
        className={styles.progressBar}
        style={{ width: `${pctDisplay}%` }}
      />
      <span className={styles.name}>{doc.fileName}</span>
      <div className={styles.processingIndicator}>
        <div className={styles.inlineSpinner} />
        <span className={styles.processingMsg}>
          {doc.processingMessage || "Processing…"}
        </span>
        <span className={styles.processingPct}>{pctDisplay}%</span>
      </div>
      <button
        type="button"
        className={styles.removeBtn}
        onClick={() => onRemove(doc.id)}
        title="Remove document"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
  );
}

export function DocumentList({ documents, onOpen, onDownload, onEditTemplate, onPreview, onRemove }: DocumentListProps) {
  if (documents.length === 0) return null;

  return (
    <div className={styles.list}>
      <h3 className={styles.heading}>DOCUMENTS</h3>
      {documents.map((doc) => {
        const hasTemplate = Boolean(doc.templateId);
        const isProcessing = doc.status === "pending" || doc.status === "processing";

        if (isProcessing) {
          return <ProcessingRow key={doc.id} doc={doc} onRemove={onRemove} />;
        }

        return (
          <div key={doc.id} className={styles.row}>
            <span className={styles.name}>{doc.fileName}</span>

            {hasTemplate && (
              <span className={`${styles.badge} ${doc.matchResult?.kind === "verified" ? styles.verified : styles.unverified}`}>
                {doc.matchResult?.kind === "verified" ? "Verified" : "Unverified"}
              </span>
            )}

            {hasTemplate && (
              <>
                <button
                  type="button"
                  className={styles.editTemplateBtn}
                  onClick={() => onEditTemplate(doc)}
                  title="Edit template fields"
                >
                  Edit Template
                </button>
                <button
                  type="button"
                  className={styles.previewBtn}
                  onClick={() => onPreview(doc)}
                  title="Preview filled PDF"
                >
                  Preview
                </button>
                <button
                  type="button"
                  className={styles.downloadBtn}
                  onClick={() => onDownload(doc)}
                  title="Download filled PDF"
                >
                  Download
                </button>
              </>
            )}

            {!hasTemplate && (
              <button
                type="button"
                className={styles.openBtn}
                onClick={() => onOpen(doc)}
                title="Open document"
              >
                Open
              </button>
            )}

            <button
              type="button"
              className={styles.removeBtn}
              onClick={() => onRemove(doc.id)}
              title="Remove document"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
