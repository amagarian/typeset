/**
 * Locked Gemini runtime settings (model + accuracy).
 *
 * The API key is stored in the OS keychain via Settings (v0.6.2+).
 * Model and accuracy stay fixed here so every call site shares one id.
 */

/**
 * Locked Gemini model id.
 *
 * v0.6.32 — upgraded from `gemini-3.1-flash-lite` to `gemini-3.5-flash`
 * after the I/O 2026 launch. Trades roughly 2x per-token cost (Flash-Lite
 * was $0.25/$1.50 per 1M; 3.5 Flash is $0.50/$3) for materially better
 * reasoning at Flash latency. Worth it for field detection: Layout A vs.
 * Layout B disambiguation, party (signer/vendor) inference, and
 * canonical-id resolution all benefit from the stronger reasoning.
 *
 * If Google has not yet promoted this to a stable id (only `-preview`
 * is live), the detector will surface the upstream 404 verbatim via
 * the existing error path in `gemini.rs`; swap to `gemini-3.5-flash-preview`
 * if that happens.
 */
export const LOCKED_MODEL = "gemini-3.5-flash";

/**
 * Locked accuracy mode. v0.5.36 supported `"maximum"` (three-pass —
 * Stage 1a description + Stage 1b structured + Pass 2 QC audit) and
 * `"fast"` (single-pass). v0.5.37 locks to `"fast"` so a beta tester's
 * average drop costs ~one Gemini call instead of three.
 *
 * The Maximum-mode codepaths in `geminiFieldDetector.ts` are still in
 * place but no longer reachable from the UI — `getAccuracyMode()`
 * always returns `"fast"`. Future cleanup can prune the dead branches.
 */
export type AccuracyMode = "maximum" | "fast";
export const LOCKED_ACCURACY_MODE: AccuracyMode = "fast";

/**
 * Gemini 3.5 Flash exposes a hidden-thinking budget. Native Gemini likely
 * benefits from this on hard layout reasoning, but it also explains the
 * latency jump from ~6s on Flash-Lite to 20s+ on 3.5 Flash. Keep it user
 * selectable so normal forms stay quick and difficult forms can opt into
 * more reasoning.
 */
export type GeminiThinkingMode = "fast" | "balanced" | "deep";

export interface GeminiThinkingOption {
  id: GeminiThinkingMode;
  label: string;
  description: string;
}

export const GEMINI_THINKING_OPTIONS: GeminiThinkingOption[] = [
  {
    id: "fast",
    label: "Fast",
    description: "Thinking off. Best latency for normal credit-card forms.",
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Low thinking. Slower, but better for tricky labels and tables.",
  },
  {
    id: "deep",
    label: "Deep",
    description: "Medium thinking. Slowest; use for difficult or messy forms.",
  },
];

const THINKING_MODE_STORAGE_KEY = "typeset.gemini-thinking-mode.v1";

function isGeminiThinkingMode(value: unknown): value is GeminiThinkingMode {
  return value === "fast" || value === "balanced" || value === "deep";
}

/**
 * Back-compat shim. Detector + project-import call this to discover
 * the model id; it now always returns the locked id.
 */
export function getModelPreference(): string {
  return LOCKED_MODEL;
}

/**
 * Back-compat shim. Detector + DocumentList progress estimator both
 * call this; it now always returns `"fast"`.
 */
export function getAccuracyMode(): AccuracyMode {
  return LOCKED_ACCURACY_MODE;
}

export function getGeminiThinkingMode(): GeminiThinkingMode {
  if (typeof window === "undefined") return "fast";
  try {
    const stored = window.localStorage.getItem(THINKING_MODE_STORAGE_KEY);
    return isGeminiThinkingMode(stored) ? stored : "fast";
  } catch {
    return "fast";
  }
}

export function setGeminiThinkingMode(mode: GeminiThinkingMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THINKING_MODE_STORAGE_KEY, mode);
  } catch {
    // Non-fatal: the current session still receives the in-memory state.
  }
}
