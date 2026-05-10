/**
 * Locked Gemini runtime settings.
 *
 * Up to v0.5.36 these were user-tunable: the renderer persisted a
 * `model` string and an `accuracy` mode in localStorage and the
 * SettingsModal exposed both as form controls. v0.5.37 strips that
 * configurability surface — beta testers get a single, paved-path
 * experience: drop a PDF, get fields back. The values are baked in
 * here so any remaining call site (the detector, the project-import
 * helper, the DocumentList progress estimator) keeps compiling
 * without spreading the constants around the codebase.
 */

/**
 * Locked Gemini model id for v0.5.37+.
 *
 * Picks the cheapest tier (Flash-Lite) on the assumption that the
 * user (Aiden) is paying for every detection during the closed beta.
 * The 3.x generation's spatial reasoning is a noticeable lift over
 * 2.5, and Flash-Lite still delivers usable bbox precision on the
 * production-paperwork forms Typeset is calibrated for.
 *
 * The string matches the existing `gemini-3.1-flash-lite` preset id
 * from the v0.5.36 model dropdown; no API-side change is needed.
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
