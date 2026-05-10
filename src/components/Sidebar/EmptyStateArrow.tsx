import styles from "./EmptyStateArrow.module.css";

/*
 * v0.5.33 — playful curved arrow for the empty project list.
 *
 * Drawn with two paths so the wings feel like deliberate
 * pen-strokes rather than a closed polygon:
 *   1. The main curve — a smooth quadratic Bezier that swoops
 *      from the upper-right of the empty list area down and to
 *      the left, ending just above the `+` button. The `T`
 *      mirror command introduces a gentle S-shape so the line
 *      reads hand-drawn rather than mechanical.
 *   2. The arrowhead — two short strokes meeting at the tip,
 *      with intentional asymmetry (different lengths/angles)
 *      so the head doesn't look stamped from a 90° template.
 *
 * `stroke="currentColor"` lets the wrapper CSS govern the
 * tone (var(--text-muted)), and the SVG itself is decorative
 * (aria-hidden) since the only meaning is "look down here" —
 * the button beneath already carries its own aria-label.
 */
export function EmptyStateArrow() {
  return (
    <svg
      className={styles.arrow}
      width="160"
      height="320"
      viewBox="0 0 200 400"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M 160 60 Q 70 170, 95 290 T 48 365" />
      <path d="M 22 340 L 48 365 L 72 332" />
    </svg>
  );
}
