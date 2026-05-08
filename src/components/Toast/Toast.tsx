import { useEffect } from "react";
import styles from "./Toast.module.css";

export interface ToastState {
  message: string;
  type?: "success" | "error" | "info";
}

interface ToastProps {
  toast: ToastState | null;
  onDismiss: () => void;
  durationMs?: number;
}

export function Toast({ toast, onDismiss, durationMs = 2600 }: ToastProps) {
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => onDismiss(), durationMs);
    return () => window.clearTimeout(t);
  }, [toast, onDismiss, durationMs]);

  if (!toast) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.message}>{toast.message}</span>
      <button type="button" className={styles.close} onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

