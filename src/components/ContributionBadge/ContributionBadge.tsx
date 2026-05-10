import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useContributionStats } from "@/hooks/useContributionStats";
import styles from "./ContributionBadge.module.css";

/**
 * v0.5.24 — header badge surfacing the user's community-published
 * template count.
 *
 * Visual: a low-key pill — `12 shared` — with the number in mono
 * (code-shaped, tabular numerals so it stays width-stable as it
 * climbs from 9 → 10) and the label in sans. Clicking the pill
 * opens an anchored popover listing the user's recent submissions
 * with relative timestamps; the popover dismisses on outside click,
 * Escape, or another click of the pill.
 *
 * Empty state: at `count === 0` the badge hides entirely. The
 * teaching tooltip belongs on the publish flow, not on a piece of
 * permanent header chrome — visible chrome that says "0" is noise.
 */
export function ContributionBadge() {
  const { count, submissions } = useContributionStats();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Hide the badge when the user has never published anything.
  // Fetch is in flight on mount; the badge will pop in if the cached
  // / server count is non-zero.
  const hidden = count === 0;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const node = wrapperRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const togglePopover = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const rows = useMemo(() => submissions.slice(0, 50), [submissions]);

  if (hidden) return null;

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={`${styles.badge} ${open ? styles.badgeOpen : ""}`}
        onClick={togglePopover}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${count} templates shared. Click to view list.`}
        title={`${count} template${count === 1 ? "" : "s"} shared`}
      >
        <span className={styles.count}>{count}</span>
        <span className={styles.label}>shared</span>
      </button>
      {open && (
        <div
          className={styles.popover}
          role="dialog"
          aria-label="Your shared templates"
        >
          <div className={styles.popoverHeader}>
            <h3 className={styles.popoverTitle}>Your shared templates</h3>
            <span className={styles.popoverCount}>{count}</span>
          </div>
          {rows.length === 0 ? (
            <p className={styles.empty}>
              You haven&apos;t shared any templates yet. Save a form to
              add it to the community registry.
            </p>
          ) : (
            <ul className={styles.list}>
              {rows.map((submission) => (
                <li key={submission.id} className={styles.row}>
                  <span className={styles.rowName} title={submission.templateName}>
                    {submission.templateName}
                  </span>
                  <span className={styles.rowTime}>
                    {formatRelativeTime(submission.submittedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Lightweight relative-time formatter — avoids pulling in a dep for
 * the popover's only computed string. Resolution tops out at "Xy"
 * because the registry has barely any rows that old in practice.
 */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const deltaMs = Date.now() - ts;
  if (deltaMs < 0) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
