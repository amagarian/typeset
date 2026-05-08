import styles from "./ProjectList.module.css";

interface ProjectListProps {
  projects: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectList({ projects, selectedId, onSelect }: ProjectListProps) {
  return (
    <nav className={styles.list} aria-label="Projects">
      <ul className={styles.items}>
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={selectedId === p.id ? styles.itemActive : styles.item}
              onClick={() => onSelect(p.id)}
            >
              {p.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
