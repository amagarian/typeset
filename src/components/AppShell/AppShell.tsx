import { ReactNode } from "react";
import { Sidebar } from "../Sidebar/Sidebar";
import styles from "./AppShell.module.css";

interface AppShellProps {
  children: ReactNode;
  projects: { id: string; label: string }[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  /**
   * v0.5.27 — kept on the prop surface even though Sidebar no
   * longer renders a Settings button. The App-level handler is
   * still invoked by the macOS menu bar (⌘,) listener registered
   * in App.tsx, so the wiring stays intact at the shell boundary
   * for callers that supply it. Unused locally.
   */
  onOpenSettings?: () => void;
  /**
   * v0.5.24 — top-right slot in the main-window header. Used by App.tsx
   * to mount the contribution tally badge.
   *
   * v0.5.26 — the Typeset wordmark on the left of this strip was
   * removed in the design pass; the strip now exists solely to host
   * the contribution badge over the title-bar drag region.
   */
  headerRight?: ReactNode;
}

export function AppShell({
  children,
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
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
      />
      <main className={styles.main}>
        <header className={styles.mainHeader} data-tauri-drag-region>
          <div className={styles.headerRight}>{headerRight}</div>
        </header>
        {children}
      </main>
    </div>
  );
}
