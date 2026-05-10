/**
 * Locked Gemini runtime settings (model + accuracy).
 *
 * The API key is stored in the OS keychain via Settings (v0.6.2+).
 * Model and accuracy stay fixed here so every call site shares one id.
 */

/**
 * Locked Gemini model id.
 *
 * Flash-Lite tier for cost/latency; spatial calibration targets production paperwork.
 */
export const LOCKED_MODEL = "gemini-3.1-flash-lite";

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
