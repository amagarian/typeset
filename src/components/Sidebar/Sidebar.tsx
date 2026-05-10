import { useState, useCallback } from "react";
import { ProjectList } from "../ProjectList/ProjectList";
import { isUpdateInstalled, runUpdateCheck } from "@/utils/autoUpdate";
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
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "upToDate" | "error">("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const filtered = search.trim()
    ? projects.filter((p) => p.label.toLowerCase().includes(search.toLowerCase()))
    : projects;

  // v0.5.23 — manual "Check for updates" funnels through the shared
  // helper alongside the launch/focus auto-checks. The helper handles
  // the silent download + install; on success it notifies the
  // useAutoUpdate hook (mounted in App.tsx) which raises the
  // relaunch banner. We just surface lightweight status text here.
  const checkForUpdates = useCallback(async () => {
    if (isUpdateInstalled()) {
      // Auto-flow already installed and the banner is showing.
      // No-op per the v0.5.23 behaviour spec.
      console.log("[AutoUpdate] manual click ignored — update already installed this session");
      return;
    }
    setUpdateStatus("checking");
    setErrorDetail(null);
    const result = await runUpdateCheck({ source: "manual" });
    switch (result.kind) {
      case "installed":
      case "already-installed":
        // Banner is now (or was already) visible; clear any sidebar status.
        setUpdateStatus("idle");
        break;
      case "no-update":
        setUpdateStatus("upToDate");
        setTimeout(() => setUpdateStatus("idle"), 3000);
        break;
      case "error": {
        const msg = result.error instanceof Error ? result.error.message : String(result.error);
        setErrorDetail(msg);
        setUpdateStatus("error");
        setTimeout(() => {
          setUpdateStatus("idle");
          setErrorDetail(null);
        }, 8000);
        break;
      }
      case "debounced":
        // Manual source never returns 'debounced' from the helper, but
        // the discriminated union forces us to handle it. Reset to idle.
        setUpdateStatus("idle");
        break;
    }
  }, []);

  const updateLabel =
    updateStatus === "checking" ? "Checking…" :
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
          disabled={updateStatus === "checking"}
        >
          {updateLabel}
        </button>
      </div>
    </aside>
  );
}
