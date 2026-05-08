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
 * Pro is recommended because it ranks 1st on document-understanding
 * benchmarks and finishes a typical 1-3 page production form in
 * 20-30 seconds end-to-end with native multimodal PDF input — no
 * Python sandbox, no agentic loop, no tool calls. That speed is the
 * entire reason we moved off Anthropic.
 *
 * Flash is offered as a "cheaper, faster" option for users with very
 * simple forms; it's typically 2-3x cheaper per call but loses ~5-10%
 * accuracy on dense, irregular layouts.
 */
export const DEFAULT_MODEL = "gemini-2.5-pro";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

/**
 * Built-in model presets shown in the Settings dropdown. Users can
 * also paste an arbitrary dated model id (e.g.
 * `gemini-2.5-pro-preview-06-05`) via the "Custom" option.
 */
export const MODEL_PRESETS: ModelOption[] = [
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro (recommended)",
    description:
      "Highest accuracy on document understanding. ~20-30s per detection on a typical production form.",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash (cheaper, faster)",
    description:
      "~2-3x cheaper per call, ~10-15s per detection. Slight accuracy drop on dense or irregular layouts.",
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
 * Migrate any pre-Gemini model preferences eagerly. Safe to call from
 * app startup; idempotent.
 */
export function migrateLegacyModelPreference(): void {
  if (!canUseStorage()) return;
  try {
    // The pre-Gemini Anthropic preference was stored under a different
    // key; clean it up so users who downgrade and then re-upgrade don't
    // see a ghost setting.
    window.localStorage.removeItem("typeset.anthropic.model.v1");
    window.localStorage.removeItem("typeset.anthropic.effort.v1");
  } catch {
    /* ignore */
  }
}
