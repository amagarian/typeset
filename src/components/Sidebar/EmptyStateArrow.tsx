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
      width="180"
      height="360"
      viewBox="0 0 200 400"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M 140 80 Q 80 200, 100 280 T 40 380" />
      <path d="M 29 365 L 40 380 L 52 367" />
    </svg>
  );
}
