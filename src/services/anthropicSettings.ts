/**
 * Persistence and defaults for Anthropic-related runtime settings.
 *
 * The API key itself lives in the OS keychain via `claudeClient.ts`.
 * Model + detection-effort preferences are renderer-side only and live in
 * localStorage.
 */

import type { ClaudeEffort } from "./claudeClient";

const MODEL_PREF_KEY = "typeset.anthropic.model.v1";
const EFFORT_PREF_KEY = "typeset.anthropic.effort.v1";

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

/**
 * Detection-effort tiers mapped to Anthropic's adaptive-thinking
 * `output_config.effort` levels. Lower tiers = faster, slightly less
 * thorough. `xhigh` is Opus-4.7-only and matches Claude.ai when its
 * "Extended thinking" toggle is at its strongest setting.
 *
 * Empirical observations on a typical multi-page production form:
 *   - medium: 30-60s, good for AcroForm PDFs and simple flat forms
 *   - high:   60-120s, the Claude.ai default, very high accuracy
 *   - xhigh:  200-400s, exhaustive — only worth it for novel/messy forms
 */
export type DetectionEffort = "medium" | "high" | "xhigh";

export interface EffortOption {
  id: DetectionEffort;
  label: string;
  description: string;
}

export const DEFAULT_EFFORT: DetectionEffort = "high";

export const EFFORT_PRESETS: EffortOption[] = [
  {
    id: "medium",
    label: "Fast",
    description: "30-60s. Best for AcroForm PDFs and simple layouts.",
  },
  {
    id: "high",
    label: "Balanced",
    description: "60-120s. Recommended. Matches Claude.ai's default depth.",
  },
  {
    id: "xhigh",
    label: "Maximum (Opus 4.7 only)",
    description:
      "200-400s. Exhaustive reasoning — only useful on novel form types where Balanced misfires.",
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

export function getEffortPreference(): DetectionEffort {
  if (!canUseStorage()) return DEFAULT_EFFORT;
  try {
    const value = window.localStorage.getItem(EFFORT_PREF_KEY);
    if (value && EFFORT_PRESETS.some((p) => p.id === value)) {
      return value as DetectionEffort;
    }
    return DEFAULT_EFFORT;
  } catch {
    return DEFAULT_EFFORT;
  }
}

export function setEffortPreference(effort: DetectionEffort): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(EFFORT_PREF_KEY, effort);
  } catch (error) {
    console.warn("Failed to persist effort preference", error);
  }
}

/**
 * Resolves the effective effort for a (model, preference) pair, honoring
 * model-specific caps. xhigh is Opus 4.7 only; on other models it falls
 * back to high. Haiku models don't support adaptive thinking — callers
 * should still pass undefined separately for that case.
 */
export function effectiveEffort(
  model: string,
  preference: DetectionEffort = getEffortPreference()
): ClaudeEffort {
  const lower = model.toLowerCase();
  if (preference === "xhigh") {
    if (lower.includes("opus-4-7") || lower.includes("opus_4_7")) return "xhigh";
    return "high";
  }
  return preference;
}
