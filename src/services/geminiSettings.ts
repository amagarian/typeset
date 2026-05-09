/**
 * Persistence and defaults for Gemini-related runtime settings.
 *
 * The API key itself lives in the OS keychain via `geminiClient.ts`.
 * Model preference is renderer-side only and lives in localStorage.
 */

const MODEL_PREF_KEY = "typeset.gemini.model.v1";
const ACCURACY_PREF_KEY = "typeset.gemini.accuracy.v1";

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

/**
 * Accuracy mode for the Gemini detection pipeline.
 *
 * - `"maximum"` runs Pass 1 (existing single-pass detection) followed by
 *   a second Gemini call that audits Pass 1's output against the same
 *   PDF and returns keep/drop/fix corrections. ~12s typical, dramatically
 *   more accurate on dense forms — every misclassification gets a second
 *   look. Default for new users.
 * - `"fast"` is the single-pass behaviour (Pass 1 only). ~6s typical.
 *
 * The persisted value is exposed only on the renderer side; the Rust
 * backend doesn't care how many passes the renderer chooses to run.
 */
export type AccuracyMode = "maximum" | "fast";

export const DEFAULT_ACCURACY_MODE: AccuracyMode = "maximum";

export interface AccuracyOption {
  id: AccuracyMode;
  label: string;
  description: string;
}

export const ACCURACY_OPTIONS: AccuracyOption[] = [
  {
    id: "maximum",
    label: "Maximum (recommended)",
    description:
      "Three-pass review with description-first reasoning (~30-50s, roughly). Best for complex forms with subtle layouts.",
  },
  {
    id: "fast",
    label: "Fast",
    description:
      "Single-pass detection (~6-22s, roughly). Best for simple forms.",
  },
];

function isAccuracyMode(value: unknown): value is AccuracyMode {
  return value === "maximum" || value === "fast";
}

export function getAccuracyMode(): AccuracyMode {
  if (!canUseStorage()) return DEFAULT_ACCURACY_MODE;
  try {
    const raw = window.localStorage.getItem(ACCURACY_PREF_KEY);
    const value = raw?.trim();
    if (!value) return DEFAULT_ACCURACY_MODE;
    if (isAccuracyMode(value)) return value;
    return DEFAULT_ACCURACY_MODE;
  } catch {
    return DEFAULT_ACCURACY_MODE;
  }
}

export function setAccuracyMode(mode: AccuracyMode): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(ACCURACY_PREF_KEY, mode);
  } catch (error) {
    console.warn("Failed to persist accuracy mode", error);
  }
}

const MODEL_MIGRATION_FLAG = "typeset.gemini.model.migrated.v2";
const ACCURACY_MIGRATION_FLAG = "typeset.gemini.accuracy.migrated.v1";

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

/**
 * Bring users to the new "Maximum" accuracy default introduced in
 * v0.4.7. Runs once per install — if the user later flips themselves
 * back to "fast" we don't bounce them back. Idempotent.
 *
 * Why opt-in by default? The user accepted the 6s → 12s speed trade for
 * dramatically better CVV / card-type / bbox-tightness accuracy. Pass 2
 * catches the misclassifications that the deterministic post-processing
 * can't reach (because they manifest before our type guards see them).
 */
export function migrateLegacyAccuracyPreference(): void {
  if (!canUseStorage()) return;
  try {
    if (window.localStorage.getItem(ACCURACY_MIGRATION_FLAG)) return;
    const current = window.localStorage.getItem(ACCURACY_PREF_KEY);
    if (!current) {
      window.localStorage.setItem(ACCURACY_PREF_KEY, DEFAULT_ACCURACY_MODE);
    }
    window.localStorage.setItem(ACCURACY_MIGRATION_FLAG, "1");
  } catch {
    /* ignore */
  }
}
