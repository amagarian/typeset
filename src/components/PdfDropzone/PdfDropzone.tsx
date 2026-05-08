import { useCallback, useRef, useState } from "react";
import styles from "./PdfDropzone.module.css";

interface PdfDropzoneProps {
  onDrop: (files: File[] | null) => void;
}

export function PdfDropzone({ onDrop }: PdfDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const files = [...e.dataTransfer.files].filter(
        (file) => file.type === "application/pdf"
      );
      if (files.length > 0) {
        onDrop(files);
      } else {
        onDrop(null);
      }
    },
    [onDrop]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = [...(e.target.files ?? [])].filter(
        (file) => file.type === "application/pdf"
      );
      if (files.length > 0) {
        onDrop(files);
      } else {
        onDrop(null);
      }
      e.target.value = "";
    },
    [onDrop]
  );

  return (
    <div
      className={`${styles.dropzone} ${isDragOver ? styles.dragOver : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={styles.iconBox}
        onClick={() => fileInputRef.current?.click()}
      >
        <span className={styles.icon}>+</span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,application/pdf"
        className={styles.hiddenInput}
        onChange={handleFileInput}
        aria-label="Upload PDF"
      />
    </div>
  );
}
