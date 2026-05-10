import { ReactNode } from "react";
import { Sidebar } from "../Sidebar/Sidebar";
import styles from "./AppShell.module.css";

interface AppShellProps {
  children: ReactNode;
  projects: { id: string; label: string }[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onOpenSettings?: () => void;
  /**
   * v0.5.24 — top-right slot in the main-window header. Used by App.tsx
   * to mount the contribution tally badge alongside the Typeset
   * wordmark. Optional so legacy call sites (none today) keep working.
   */
  headerRight?: ReactNode;
}

export function AppShell({
  children,
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  onOpenSettings,
  headerRight,
}: AppShellProps) {
  return (
    <div className={styles.shell}>
      <div className={styles.dragRegion} data-tauri-drag-region />
      <Sidebar
        projects={projects}
        selectedId={selectedProjectId}
        onSelect={onSelectProject}
        onNewProject={onNewProject}
        onOpenSettings={onOpenSettings}
      />
      <main className={styles.main}>
        <header className={styles.mainHeader} data-tauri-drag-region>
          <span className={styles.brand}>Typeset</span>
          <div className={styles.headerRight}>{headerRight}</div>
        </header>
        {children}
      </main>
    </div>
  );
}
