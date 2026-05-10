import { useState } from "react";
import { ProjectList } from "../ProjectList/ProjectList";
import { EmptyStateArrow } from "./EmptyStateArrow";
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
        v0.5.33 — playful curved arrow shown only when the
        project list is genuinely empty (no projects AND no
        search). We deliberately suppress it when a search
        returns no matches: at that point the empty state is
        about the query, not the app, and a hint pointing at
        "+ New project" would be misleading. Lives between the
        (empty) ProjectList and the trigger button so it reads
        as a directional cue at the latter.
      */}
      {projects.length === 0 && search === "" && <EmptyStateArrow />}
      {/*
        v0.5.33 — collapsed to a centered icon-only "+" trigger.
        Hover anchors to var(--border) (set in the CSS module);
        the glyph color stays pinned in every state so the only
        visual feedback is the row-wide background fade.
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
