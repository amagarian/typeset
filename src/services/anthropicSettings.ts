/**
 * Persistence and defaults for Anthropic-related runtime settings.
 *
 * The API key itself lives in the OS keychain via `claudeClient.ts`. Model
 * preference is renderer-side only and lives in localStorage.
 */

const MODEL_PREF_KEY = "typeset.anthropic.model.v1";

/**
 * Default Claude model. Anthropic ships dated and aliased IDs; users can
 * override this with the exact dated ID in Settings if a new release lands
 * before we update the default.
 */
export const DEFAULT_MODEL = "claude-opus-4-7";

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

/**
 * Built-in model presets shown in the Settings dropdown. The user can also
 * paste an arbitrary dated ID (e.g. `claude-opus-4-7-20260201`).
 */
export const MODEL_PRESETS: ModelOption[] = [
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7 (best quality)",
    description: "Strongest accuracy on complex forms. Slower and more expensive.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6 (balanced)",
    description: "Strong accuracy, ~10x cheaper than Opus, faster.",
  },
];

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getModelPreference(): string {
  if (!canUseStorage()) return DEFAULT_MODEL;
  try {
    const value = window.localStorage.getItem(MODEL_PREF_KEY);
    return value && value.trim().length > 0 ? value.trim() : DEFAULT_MODEL;
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
