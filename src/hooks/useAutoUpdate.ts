import { useCallback, useEffect, useState } from "react";
import { runUpdateCheck, subscribeUpdateInstalled } from "@/utils/autoUpdate";

export interface UpdateBannerInfo {
  version: string;
}

/**
 * v0.5.23 — drives the "Update X.Y.Z installed — Relaunch now / Later"
 * banner. Mounted exactly once from `App.tsx`'s `MainApp` (the dropzone
 * webview is a separate React tree that returns `<TrayDropZone />`
 * before this hook would ever attach).
 *
 * Lifecycle:
 *   1. On mount: subscribe to install notifications (covers the case
 *      where the launch check completes before this effect attaches)
 *      and kick off the launch-time check.
 *   2. Subscribe to `tauri://focus` via `getCurrentWindow().onFocusChanged`.
 *      Only fire a check when `focused === true`. The shared helper
 *      handles the 30-minute debounce.
 *   3. On unmount: tear down both subscriptions.
 *
 * All errors flow through the helper's catch-all and surface as
 * `[AutoUpdate]`-prefixed `console.warn`s — the banner is the single
 * UI surface for this feature.
 */
export function useAutoUpdate(): {
  banner: UpdateBannerInfo | null;
  dismissBanner: () => void;
} {
  const [banner, setBanner] = useState<UpdateBannerInfo | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeUpdateInstalled(({ version }) => {
      setBanner({ version });
    });

    void runUpdateCheck({ source: "launch" });

    let cleanupFocus: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const unlisten = await win.onFocusChanged(({ payload: focused }) => {
          if (!focused) return;
          void runUpdateCheck({ source: "focus" });
        });
        if (cancelled) {
          unlisten();
          return;
        }
        cleanupFocus = unlisten;
      } catch (err) {
        // Dev/browser preview: window API is unavailable. Treat as a
        // no-op — launch check still ran, the manual sidebar button
        // still works. No UI surface.
        console.warn("[AutoUpdate] focus listener setup failed", err);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      cleanupFocus?.();
    };
  }, []);

  const dismissBanner = useCallback(() => {
    setBanner(null);
  }, []);

  return { banner, dismissBanner };
}
