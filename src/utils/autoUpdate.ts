/**
 * v0.5.23 — single source of truth for the Tauri updater flow.
 *
 * Shared by two callers:
 *   1. `useAutoUpdate` (mounted from App.tsx) — runs on app launch and
 *      whenever the window regains focus. Result drives the banner.
 *   2. `Sidebar.checkForUpdates` — manual menu click. Surfaces lightweight
 *      status text in the sidebar button and (if an install completes)
 *      reveals the same banner via the listener registry below.
 *
 * Design decisions baked in:
 *   - Auto-download is silent. There is no "do you want to update?" prompt.
 *     Tauri's `update.downloadAndInstall()` runs to completion in the
 *     background; the user only sees UI on a successful install-ready state.
 *   - Failures are silent: any error (network down, GitHub rate limit,
 *     signature mismatch, no update available) logs `console.warn` with the
 *     `[AutoUpdate]` prefix and never surfaces in the UI. Dev-mode errors
 *     from the updater plugin (no signed artifact at the endpoint) follow
 *     the same path — yellow warns, not red errors.
 *   - Focus-triggered checks debounce to one per 30 minutes per session
 *     using a real `Date.now()` clock, not `setTimeout` ticks (so the
 *     debounce survives a sleeping/resuming machine cleanly).
 *   - In-flight checks are serialized via a module-level promise so a
 *     manual click landing on top of a launch/focus check joins the
 *     running check rather than starting a duplicate request to the
 *     GitHub releases endpoint.
 *   - Once a successful install lands we set `updateInstalled = true`
 *     and short-circuit every subsequent check for the rest of the
 *     session. Replaying late subscribers via `subscribeUpdateInstalled`
 *     (e.g. a remount) keeps the banner sticky even if the auto path
 *     resolved before the listener attached.
 */

const FOCUS_DEBOUNCE_MS = 30 * 60 * 1000;

export type UpdateCheckSource = "launch" | "focus" | "manual";

export type UpdateCheckResult =
  | { kind: "installed"; version: string }
  | { kind: "no-update" }
  | { kind: "debounced" }
  | { kind: "already-installed"; version: string }
  | { kind: "error"; error: unknown };

interface InstalledInfo {
  version: string;
}

let lastCheckAt: number | null = null;
let inFlight: Promise<UpdateCheckResult> | null = null;
let installedInfo: InstalledInfo | null = null;

const listeners = new Set<(info: InstalledInfo) => void>();

export function subscribeUpdateInstalled(
  listener: (info: InstalledInfo) => void
): () => void {
  listeners.add(listener);
  // Replay current state for late subscribers — important because the
  // launch-time check can resolve before App's effect mounts the hook.
  if (installedInfo) {
    const snapshot = installedInfo;
    queueMicrotask(() => {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn("[AutoUpdate] subscriber threw on replay", err);
      }
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

export function isUpdateInstalled(): boolean {
  return installedInfo !== null;
}

export function getInstalledVersion(): string | null {
  return installedInfo?.version ?? null;
}

function notifyInstalled(info: InstalledInfo): void {
  installedInfo = info;
  for (const listener of listeners) {
    try {
      listener(info);
    } catch (err) {
      console.warn("[AutoUpdate] subscriber threw", err);
    }
  }
}

/**
 * Run a single update check. Always safe to call; never throws.
 *
 * - `source: 'launch'` — runs unconditionally (other than the once-installed
 *   short-circuit). The launch check is the user's primary surface for new
 *   versions, so we never want to skip it.
 * - `source: 'focus'` — debounced to once per 30 minutes per session so we
 *   don't hammer the GitHub releases endpoint every time the user alt-tabs.
 * - `source: 'manual'` — runs unconditionally. The button in the sidebar
 *   is the user's explicit "check now" affordance and should always do
 *   something visible (even if "something" is "join an in-flight check").
 */
export async function runUpdateCheck(opts: {
  source: UpdateCheckSource;
}): Promise<UpdateCheckResult> {
  if (installedInfo) {
    return { kind: "already-installed", version: installedInfo.version };
  }

  if (
    opts.source === "focus" &&
    lastCheckAt !== null &&
    Date.now() - lastCheckAt < FOCUS_DEBOUNCE_MS
  ) {
    return { kind: "debounced" };
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async (): Promise<UpdateCheckResult> => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      // Stamp the clock as soon as the network round-trip finishes so the
      // 30-min window starts when the request actually completed, not when
      // the (potentially long) downloadAndInstall finishes.
      lastCheckAt = Date.now();

      if (!update) {
        return { kind: "no-update" };
      }

      // Silent download + install. Per the locked spec: no "Update
      // available" prompt, no progress UI. The user only learns about
      // the update once it's already on disk and ready to relaunch.
      await update.downloadAndInstall();

      const version = update.version ?? "";
      notifyInstalled({ version });
      return { kind: "installed", version };
    } catch (error) {
      // Includes the dev-mode case: in `cargo tauri dev` the updater
      // plugin returns errors because there's no signed installer at
      // the endpoint. Catch silently — code path stays exercised in dev.
      console.warn(`[AutoUpdate] check failed (source=${opts.source})`, error);
      return { kind: "error", error };
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Test-only / future: drop module state. Not exported from `index.ts`;
 * exists so this module is straightforward to unit-test if we ever wire
 * a vitest harness. Kept here rather than added to a separate test util
 * to avoid splitting the closure across files.
 */
export function __resetAutoUpdateForTests(): void {
  lastCheckAt = null;
  inFlight = null;
  installedInfo = null;
  listeners.clear();
}
