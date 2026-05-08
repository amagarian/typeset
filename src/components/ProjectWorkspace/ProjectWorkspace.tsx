import type { Project, ProjectDocument } from "@/types";
import { PdfDropzone } from "../PdfDropzone/PdfDropzone";
import { DocumentList } from "../DocumentList/DocumentList";
import styles from "./ProjectWorkspace.module.css";

interface ProjectWorkspaceProps {
  project: Project | null;
  documents: ProjectDocument[];
  onPdfDrop: (files: File[] | null) => void;
  onEditProject: () => void;
  onDeleteProject: () => void;
  onOpenDocument: (doc: ProjectDocument) => void;
  onDownloadDocument: (doc: ProjectDocument) => void;
  onEditTemplateDocument: (doc: ProjectDocument) => void;
  onPreviewDocument: (doc: ProjectDocument) => void;
  onRemoveDocument: (docId: string) => void;
}

const SUMMARY_FIELDS: { key: keyof Project; label: string }[] = [
  { key: "jobName", label: "JOB NAME" },
  { key: "jobNumber", label: "JOB NO." },
  { key: "productionCompany", label: "COMPANY" },
];

export function ProjectWorkspace({
  project,
  documents,
  onPdfDrop,
  onEditProject,
  onDeleteProject,
  onOpenDocument,
  onDownloadDocument,
  onEditTemplateDocument,
  onPreviewDocument,
  onRemoveDocument,
}: ProjectWorkspaceProps) {
  if (!project) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyText}>Select a project from the sidebar.</p>
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.summaryHeader}>
        <h2 className={styles.summaryTitle}>JOB INFO</h2>
        <div className={styles.headerActions}>
          <button type="button" className={styles.editBtn} onClick={onEditProject} title="Edit project">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          </button>
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={() => {
              if (window.confirm("Delete this project? This cannot be undone.")) {
                onDeleteProject();
              }
            }}
            title="Delete project"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </div>

      <div className={styles.summaryGrid}>
        {SUMMARY_FIELDS.map(({ key, label }) => {
          const value = project[key];
          if (!value) return null;
          return (
            <div key={key} className={styles.summaryField}>
              <span className={styles.summaryLabel}>{label}</span>
              <span className={styles.summaryValue}>{String(value)}</span>
            </div>
          );
        })}
      </div>

      <div className={styles.documentsSection}>
        <DocumentList
          documents={documents}
          onOpen={onOpenDocument}
          onDownload={onDownloadDocument}
          onEditTemplate={onEditTemplateDocument}
          onPreview={onPreviewDocument}
          onRemove={onRemoveDocument}
        />
      </div>

      <div className={styles.dropSection}>
        <PdfDropzone onDrop={onPdfDrop} />
      </div>
    </div>
  );
}
