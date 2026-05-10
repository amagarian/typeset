import styles from "./UpdateBanner.module.css";

interface UpdateBannerProps {
  version: string;
  onRelaunch: () => void;
  onDismiss: () => void;
}

/**
 * v0.5.23 — non-blocking banner shown after the auto-updater has finished
 * downloading + installing a new version. The user is never prompted
 * before the install; this banner is the first (and only) UI surface for
 * the auto-update flow. "Later" applies the update on next quit naturally.
 *
 * v0.5.24 — typography: the label / message / buttons render as system
 * sans (set on the banner root). The version literal is wrapped in a
 * mono `.version` span so `0.5.24` reads as the code-shaped value it
 * is, contrasted against the surrounding sans label copy.
 */
export function UpdateBanner({ version, onRelaunch, onDismiss }: UpdateBannerProps) {
  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <div className={styles.body}>
        <span className={styles.label}>
          Update
          {version ? <> <span className={styles.version}>{version}</span></> : null}
          {" "}installed
        </span>
        <span className={styles.message}>Relaunch to apply.</span>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={onRelaunch}
        >
          Relaunch now
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={onDismiss}
        >
          Later
        </button>
        <button
          type="button"
          className={styles.close}
          onClick={onDismiss}
          aria-label="Dismiss update notice"
        >
          ×
        </button>
      </div>
    </div>
  );
}
