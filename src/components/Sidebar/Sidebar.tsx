import { useState, useCallback } from "react";
import { ProjectList } from "../ProjectList/ProjectList";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  projects: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewProject: () => void;
  onOpenSettings?: () => void;
}

export function Sidebar({ projects, selectedId, onSelect, onNewProject, onOpenSettings }: SidebarProps) {
  const [search, setSearch] = useState("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "downloading" | "upToDate" | "error">("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const filtered = search.trim()
    ? projects.filter((p) => p.label.toLowerCase().includes(search.toLowerCase()))
    : projects;

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus("checking");
    setErrorDetail(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateStatus("downloading");
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } else {
        setUpdateStatus("upToDate");
        setTimeout(() => setUpdateStatus("idle"), 3000);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorDetail(msg);
      setUpdateStatus("error");
      setTimeout(() => { setUpdateStatus("idle"); setErrorDetail(null); }, 8000);
    }
  }, []);

  // Note: silent auto-check on boot was removed. It would silently call relaunch()
  // when an update was found, causing the dev binary to vanish without warning.
  // Updates now run only when the user clicks "Check for updates" below.

  const updateLabel =
    updateStatus === "checking" ? "Checking…" :
    updateStatus === "downloading" ? "Downloading update…" :
    updateStatus === "upToDate" ? "Up to date" :
    updateStatus === "error" ? (errorDetail ? `Error: ${errorDetail}` : "Update check failed") :
    "Check for updates";

  return (
    <aside className={styles.sidebar}>
      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <ProjectList
        projects={filtered}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <div className={styles.footer}>
        <button type="button" className={styles.addBtn} onClick={onNewProject} title="New project">
          +
        </button>
        {onOpenSettings && (
          <button
            type="button"
            className={styles.settingsBtn}
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Open settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>
        )}
        <button
          type="button"
          className={styles.updateBtn}
          onClick={checkForUpdates}
          disabled={updateStatus === "checking" || updateStatus === "downloading"}
        >
          {updateLabel}
        </button>
      </div>
    </aside>
  );
}
