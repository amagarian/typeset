import { useState } from "react";
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

  const filtered = search.trim()
    ? projects.filter((p) => p.label.toLowerCase().includes(search.toLowerCase()))
    : projects;

  return (
    <aside className={styles.sidebar}>
      {/*
        v0.5.26 — primary "+ New project" CTA above the search input.
        The bare-`+` ghost button at the bottom of the footer was
        the wrong affordance: too small, no label, easy to miss.
        Linear/Notion both surface their primary "create" action
        above the list it adds to. The full-width labelled CTA is
        the standard pattern.
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
        v0.5.26 — sidebar footer carries only the Settings entry.
        "Check for updates" was relocated into the Settings modal's
        About row alongside the version literal; the auto-update
        flow (v0.5.23) handles the common case so the manual button
        is now a power-user opt-in and doesn't deserve persistent
        sidebar real estate.
      */}
      {onOpenSettings && (
        <div className={styles.footer}>
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
        </div>
      )}
    </aside>
  );
}
