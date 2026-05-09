/**
 * Cross-module constants shared by the detection + post-processing
 * pipeline. Lives in its own tiny module so files at very different
 * layers (the Gemini detector + the underline-snap nudger) can both
 * pin to the same value without taking on each other's heavy
 * dependencies.
 */

/**
 * Typographic baseline calibration applied to every detected
 * text-typed bbox (v0.5.11).
 *
 * Why this exists:
 *   The v0.5.3 prompt rule and the v0.5.5–v0.5.10 underline snap
 *   both anchor the bbox CENTER on the writable underline stroke.
 *   That seems intuitive but is wrong for typed text: a typed
 *   character on a writable line sits with its BASELINE on the
 *   stroke, with the visible glyph extending upward (cap height
 *   ~7pt, x-height ~5pt) and only a small descender dipping below.
 *   So a bbox whose center is on the stroke renders text ~5pt below
 *   where the user expects to see it — the symptom shipped in
 *   v0.5.10 (every text field consistently 5px too low across every
 *   form, requiring ~5 ArrowUp presses to correct).
 *
 * Where it is applied:
 *   1. `mapToTemplateField` in `geminiFieldDetector.ts`: subtracts
 *      this many points from `rect.y` for every text-typed field
 *      (NOT checkbox, NOT signature). Acts as a uniform
 *      detection-time correction.
 *   2. `snapFieldsToUnderlines` in `underlineSnap.ts`: when a snap
 *      fires, the new center is `strokeRow_pt - height/2 - bias`
 *      instead of `strokeRow_pt - height/2`. Because the snap
 *      REPLACES `field.y` (it does not add), snapped fields end up
 *      with the bias applied via the snap target rather than via
 *      the detection-time correction — so the bias is never
 *      double-applied to a single field.
 *
 * Why 5pt:
 *   Empirical from the v0.5.10 user report — every text field was
 *   ~5px too low. Cap height for the typed-glyph fonts we render
 *   into form blanks is in the 6-8pt range; choosing 5pt centers
 *   the visible glyph (which sits between baseline and cap height)
 *   on the stroke, give or take half a pt.
 */
export const TEXT_BASELINE_BIAS_PT = 5;
