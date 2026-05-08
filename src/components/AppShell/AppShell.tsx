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
}

export function AppShell({
  children,
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  onOpenSettings,
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
      <main className={styles.main}>{children}</main>
    </div>
  );
}
