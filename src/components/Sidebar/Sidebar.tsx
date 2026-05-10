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
        v0.5.29 — collapsed to a centered icon-only "+" trigger.
        The "New project" word-mark is gone; discoverability now
        comes from the native title tooltip ("New project") and
        the still-full-width hit target inherited from v0.5.27.
        Hover treatment is anchored to the row background (fades
        to var(--bg-input) — the same surface the Import-from-PDF
        button uses) so the primary visual feedback is the full
        button shading, not the icon glyph color.
      */}
      <button
        type="button"
        className={styles.newProjectBtn}
        onClick={onNewProject}
        title="New project"
        aria-label="New project"
      >
        <span className={styles.newProjectIcon} aria-hidden="true">+</span>
      </button>
    </aside>
  );
}
