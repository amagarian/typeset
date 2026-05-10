import { useState } from "react";
import { ProjectList } from "../ProjectList/ProjectList";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  projects: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewProject: () => void;
}

export function Sidebar({ projects, selectedId, onSelect, onNewProject }: SidebarProps) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? projects.filter((p) => p.label.toLowerCase().includes(search.toLowerCase()))
    : projects;

  return (
    <aside className={styles.sidebar}>
      {/*
        v0.5.27 — search rides at the top of the sidebar; the
        v0.5.26 "+ New project" CTA that briefly lived above the
        search has been moved back to the bottom-left footer
        slot per user feedback (the old bare-+ ghost was missed,
        but a full-width labelled CTA at the foot is the right
        compromise). Settings was dropped from the sidebar
        entirely — it now lives only in the macOS menu bar
        (⌘,) which `App.tsx` listens for as `menu:open-settings`.
      */}
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
      {/*
        v0.5.27 — lone footer item. Single hairline divider from the
        list above; the button itself IS the container (no nested
        outlined card). Hover treatment matches `Import from PDF`
        in NewProjectView: bg fades to var(--bg-input), border-color
        to var(--border-focus), color to var(--text), 0.15s.
      */}
      <button
        type="button"
        className={styles.newProjectBtn}
        onClick={onNewProject}
        aria-label="New project"
      >
        <span className={styles.newProjectIcon} aria-hidden="true">+</span>
        <span>New project</span>
      </button>
    </aside>
  );
}
