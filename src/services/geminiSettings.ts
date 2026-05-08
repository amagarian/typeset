/**
 * Persistence and defaults for Gemini-related runtime settings.
 *
 * The API key itself lives in the OS keychain via `geminiClient.ts`.
 * Model preference is renderer-side only and lives in localStorage.
 */

const MODEL_PREF_KEY = "typeset.gemini.model.v1";

/**
 * Default Gemini model.
 *
 * 3.1 Pro is recommended because Gemini 3.x added a major leap in
 * spatial understanding / bounding-box accuracy over the 2.5
 * generation. The 2.5 family is rated ~YOLO-V3-2018 level on bbox
 * tasks (~0.34 mAP); Gemini 3 is "notably improved." The desktop
 * client uses 3.x by default and that's the experience we're trying
 * to mirror.
 *
 * Pro takes ~30-40s per detection vs Flash's ~12-18s, but is
 * dramatically more accurate on dense forms (which is what we have).
 */
export const DEFAULT_MODEL = "gemini-3.1-pro-preview";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

/**
 * Built-in model presets shown in the Settings dropdown. Users can
 * also paste an arbitrary dated model id (e.g.
 * `gemini-3.1-pro-preview-2026-04`) via the "Custom" option.
 */
export const MODEL_PRESETS: ModelOption[] = [
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (recommended)",
    description:
      "Top accuracy on bbox / form-field detection. ~30-40s per detection on a typical production form. Mirrors the desktop client's default.",
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash (faster)",
    description:
      "~12-18s per detection. Frontier 3.0-line throughput. Slightly less precise than 3.1 Pro on dense forms but a big speed win on simple ones.",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite (cheapest)",
    description:
      "~10-15s per detection. Cost-efficient general-use tier — best for simple AcroForm or short single-page documents.",
  },
];

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * IDs of models that used to be presets but are no longer recommended.
 * If a user has one stored from a previous version, we silently migrate
 * them back to {@link DEFAULT_MODEL}. The Anthropic ids land here so
 * users coming from earlier Typeset versions don't get stuck on a
 * model the new backend can't speak to.
 */
const DEPRECATED_MODELS = new Set<string>([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
]);

export function getModelPreference(): string {
  if (!canUseStorage()) return DEFAULT_MODEL;
  try {
    const raw = window.localStorage.getItem(MODEL_PREF_KEY);
    const value = raw?.trim();
    if (!value) return DEFAULT_MODEL;
    if (DEPRECATED_MODELS.has(value)) {
      window.localStorage.removeItem(MODEL_PREF_KEY);
      return DEFAULT_MODEL;
    }
    return value;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function setModelPreference(model: string): void {
  if (!canUseStorage()) return;
  const trimmed = model.trim();
  try {
    if (trimmed.length === 0) {
      window.localStorage.removeItem(MODEL_PREF_KEY);
    } else {
      window.localStorage.setItem(MODEL_PREF_KEY, trimmed);
    }
  } catch (error) {
    console.warn("Failed to persist model preference", error);
  }
}

export function clearModelPreference(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(MODEL_PREF_KEY);
  } catch {
    /* ignore */
  }
}

const MODEL_MIGRATION_FLAG = "typeset.gemini.model.migrated.v2";

/**
 * Migrate any pre-Gemini model preferences eagerly, plus run a one-
 * shot bump from the original `gemini-2.5-pro` default to the new
 * `gemini-3.1-pro-preview` default. Safe to call from app startup;
 * idempotent.
 *
 * Why bump existing prefs? The 2.5 → 3.1 generation jump is large for
 * spatial reasoning (~YOLO-V3 → notably-improved on bbox tasks). Users
 * who picked up 2.5 as the install-time default are almost certainly
 * happier on 3.1; users who actively *chose* 2.5 can flip it back in
 * Settings and won't be migrated again because the flag is set.
 */
export function migrateLegacyModelPreference(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem("typeset.anthropic.model.v1");
    window.localStorage.removeItem("typeset.anthropic.effort.v1");

    if (window.localStorage.getItem(MODEL_MIGRATION_FLAG)) return;
    const current = window.localStorage.getItem(MODEL_PREF_KEY);
    if (current === "gemini-2.5-pro") {
      window.localStorage.setItem(MODEL_PREF_KEY, DEFAULT_MODEL);
    }
    window.localStorage.setItem(MODEL_MIGRATION_FLAG, "1");
  } catch {
    /* ignore */
  }
}
