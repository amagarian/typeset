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
        v0.5.36 — empty-state hint moved from a decorative arrow
        (v0.5.33, didn't read as an arrow) to a soft background
        pulse on the `+` button itself. Pulse fires only when the
        project list is genuinely empty (no projects AND no
        search) — a "no search results" state isn't about the
        app being empty, so the pulse would be misleading there.
        The hover/focus rules in the CSS module win over the
        pulse, so once the user mouses to the button the pulse
        snaps to the solid hover background.
      */}
      <button
        type="button"
        className={`${styles.newProjectBtn} ${
          projects.length === 0 && search === "" ? styles.newProjectBtnPulse : ""
        }`}
        onClick={onNewProject}
        title="New project"
        aria-label="New project"
      >
        <span className={styles.newProjectIcon} aria-hidden="true">+</span>
      </button>
    </aside>
  );
}
