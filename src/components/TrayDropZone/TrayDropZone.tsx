import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { emitTo } from "@tauri-apps/api/event";
import styles from "./TrayDropZone.module.css";

type DropStatus = "idle" | "processing" | "done" | "error";

interface ProjectItem {
  id: string;
  label: string;
}

export function TrayDropZone() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectItem | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [status, setStatus] = useState<DropStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    const u1 = listen<ProjectItem[]>("tray-projects-sync", (event) => {
      setProjects(event.payload);
      if (!selectedProject && event.payload.length > 0) {
        setSelectedProject(event.payload[0]);
      }
    });
    return () => { void u1.then((fn) => fn()); };
  }, [selectedProject]);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(async () => {
      const win = getCurrentWebviewWindow();
      await win.hide();
    }, 30000);
  }, []);

  const hideWindow = useCallback(async () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    const win = getCurrentWebviewWindow();
    await win.hide();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") void hideWindow();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideWindow]);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
      resetIdleTimer();
    },
    [resetIdleTimer]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const processPdf = useCallback(
    async (file: File) => {
      if (!selectedProject) return;
      setStatus("processing");
      setStatusMessage(`Processing ${file.name}…`);

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        await emitTo("main", "tray-pdf-dropped", {
          projectId: selectedProject.id,
          fileName: file.name,
          bytesBase64: uint8ArrayToBase64(bytes),
        });

        setStatus("done");
        setStatusMessage(`Added ${file.name}`);

        let granted = await isPermissionGranted();
        if (!granted) {
          const permission = await requestPermission();
          granted = permission === "granted";
        }
        if (granted) {
          sendNotification({
            title: "Typeset",
            body: `${file.name} added to ${selectedProject.label}`,
          });
        }

        setTimeout(() => {
          void hideWindow();
          setStatus("idle");
          setStatusMessage("");
        }, 2000);
      } catch (err) {
        setStatus("error");
        setStatusMessage(
          `Error: ${err instanceof Error ? err.message : "Unknown"}`
        );
        setTimeout(() => {
          setStatus("idle");
          setStatusMessage("");
        }, 4000);
      }
    },
    [selectedProject, hideWindow]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = [...e.dataTransfer.files].filter(
        (f) => f.type === "application/pdf"
      );

      if (files.length === 0) return;

      for (const file of files) {
        void processPdf(file);
      }
    },
    [processPdf]
  );

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>

      <div className={styles.header}>
        <select
          className={styles.jobSelect}
          value={selectedProject?.id ?? ""}
          onChange={(e) => {
            const proj = projects.find((p) => p.id === e.target.value);
            if (proj) setSelectedProject(proj);
          }}
        >
          {projects.length === 0 && (
            <option value="" disabled>No jobs</option>
          )}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label || "Untitled"}
            </option>
          ))}
        </select>
      </div>

      <div
        className={`${styles.dropArea} ${isDragOver ? styles.dragOver : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {status === "idle" && (
          <>
            <span className={styles.dropIcon}>+</span>
            <span className={styles.dropText}>
              Drop PDF here
            </span>
          </>
        )}
        {status === "processing" && (
          <>
            <div className={styles.spinner} />
            <span className={styles.statusText}>{statusMessage}</span>
          </>
        )}
        {status === "done" && (
          <>
            <span className={styles.successIcon}>✓</span>
            <span className={styles.statusText}>{statusMessage}</span>
          </>
        )}
        {status === "error" && (
          <span className={styles.statusText}>{statusMessage}</span>
        )}
      </div>
      </div>
    </div>
  );
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
