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
 */
export function UpdateBanner({ version, onRelaunch, onDismiss }: UpdateBannerProps) {
  const versionLabel = version ? ` ${version}` : "";
  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <div className={styles.body}>
        <span className={styles.label}>Update{versionLabel} installed</span>
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
