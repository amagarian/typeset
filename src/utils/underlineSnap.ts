/**
 * Underline snap (v0.5.21).
 *
 * Deterministic post-processor that nudges Gemini-detected text-field
 * bboxes so their BOTTOM EDGE sits exactly on the writable underline
 * stroke actually drawn on the page (`bbox_bottom == strokeRow`) AND
 * so their LEFT/RIGHT edges align with the actual horizontal endpoints
 * of the stroke they snapped onto (`bbox_left == strokeLeft`,
 * `bbox_right == strokeRight`). Runs AFTER `mapToTemplateField` and
 * the dedup pass, so it operates on already-trusted detections — we
 * never use this to invent or drop fields, only to shift `y` (and
 * refine `x`/`width`) by a few points when there is strong geometric
 * evidence of a stroke within the search band.
 *
 * v0.5.19 — adds a horizontal underline snap that runs ONLY on
 * fields the vertical snap successfully moved. The vertical snap
 * tells us the exact image row of the chosen stroke; the horizontal
 * snap then traces that row's continuous dark-pixel run starting
 * from the bbox's horizontal center, and aligns the bbox's `x` and
 * `x + width` to the run's left/right endpoints. Gemini's `x` and
 * `width` come straight through `bboxToPdfRect` with zero post-
 * processing and are noticeably off on some fields (real-user
 * v0.5.18 evidence: bottom-row "Cardholder Name" / Print Name
 * shifted right and not spanning the full underline width). The
 * horizontal snap cleans those up without touching the vertical
 * geometry — the v0.5.18 vertical algorithm and its threshold
 * rationale are preserved verbatim.
 *
 * Three safety caps on the horizontal snap, all designed to fail
 * conservatively (leave x/width alone rather than invent a wrong
 * extent). v0.5.21 splits each cap by mode (resize-fit vs
 * relocate); the relocate column matches v0.5.19's strict defaults,
 * the resize-fit column matches the looser bounds the overlap
 * rule has earned us:
 *   - `maxHorizontalDeltaPoints` (relocate only) — if either edge
 *     would move more than 30pt, abort. Mirrors `maxSnapPoints` for
 *     vertical. In v0.5.21 this cap applies ONLY to relocate
 *     candidates (< 50% bbox-interval overlap on either side —
 *     the snap would be moving the bbox onto a DIFFERENT stroke).
 *     Resize-fit candidates (≥ 50% old-vs-new overlap on BOTH
 *     sides — refining the edges of the SAME stroke the bbox is
 *     already on) skip the per-edge cap entirely: the overlap
 *     rule is itself proof that the new run is the same stroke
 *     the bbox sits on (a wrong-underline neighbour-jump has ~0%
 *     old-side overlap and is automatically classified as
 *     relocate, where the strict 30pt cap still applies). v0.5.20
 *     attempted to absorb resize-fit deltas by doubling the cap
 *     to 60pt, but real Gemini under-detection of left edges
 *     can exceed 60pt on inline-row text fields (e.g. Print
 *     Name on the v0.5.20 form: -70pt to -80pt left delta on a
 *     run with 80%+ overlap). Removing the cap on resize-fit
 *     trusts the overlap rule end-to-end and makes
 *     `maxWidthRatio` the single active bound on runaway
 *     extents.
 *   - `minWidthPoints` (12pt) — if the run is shorter than this, the
 *     center column is probably under a label glyph that happens to
 *     intersect the snap row, not on a real underline; abort. 12pt
 *     ≈ one or two characters of body text, well below any real
 *     fillable underline width. Applies uniformly to both
 *     resize-fit and relocate (unchanged in v0.5.21).
 *   - `maxWidthRatio` (resize-fit 2.0× / relocate 1.5×) — if the
 *     run is more than this multiple of the original bbox width,
 *     abort. Prevents a short field (e.g. "Date") from being
 *     extended across an entire row's underline when the model
 *     meant only a fragment of it. v0.5.21 raises the resize-fit
 *     ratio to 2.0× because (a) with the per-edge cap removed on
 *     resize-fit, this ratio is now the only thing standing
 *     between us and a runaway extension across a connected
 *     multi-segment underline, AND (b) Gemini routinely
 *     under-detects width by 33–45% on real fields, so 1.5× was
 *     clipping legitimate snaps. 2.0× absorbs the worst observed
 *     under-detection without admitting an entire row's connected
 *     underline (which would be ~3–4× the bbox width on dense
 *     forms). Relocate keeps 1.5× — relocate is rare and we want
 *     it to stay conservative.
 *
 * Why the dependency on a successful vertical snap: horizontal snap
 * needs a known stroke row to walk along. Without a vertical snap
 * we don't know which image row IS the underline (the bbox center
 * could land anywhere in label text or in whitespace), and walking
 * the wrong row would produce arbitrary x/width changes — the exact
 * failure mode this module exists to avoid. This is also why we
 * additionally reject a horizontal snap whose center column is
 * light on the snap row (`hSkippedNoStroke`): the vertical snap can
 * occasionally land on a stroke that doesn't extend horizontally
 * under the bbox center (e.g. an adjacent field's stroke that
 * happened to be the closest qualifying row), and we don't want to
 * drag the bbox off into that stroke.
 *
 * Signatures are excluded from horizontal snap (but remain eligible
 * for vertical snap). Signature lines are typically intentionally
 * extensible (the writer assumes the user can scrawl past the
 * printed stroke endpoints), and clamping the bbox to the printed
 * line endpoints would constrict the writable area. The horizontal-
 * snap skip list therefore includes signatures on top of the
 * vertical-snap skip list (checkboxes + multilines).
 *
 * v0.5.18 — snap target stays `bbox_bottom == strokeRow` (Step 8,
 * line below — v0.5.16's geometrically correct text-baseline
 * anchor). The detection-time pre-shift in `geminiFieldDetector.ts`
 * is REMOVED. With the v0.5.16 prompt rule placing Gemini's
 * `raw_y = stroke - height` and the snap targeting the same anchor,
 * any pre-shift is redundant AND drags the snap's row-search center
 * off the real stroke. Removing it converges both paths on the same
 * stroke-anchored y by construction:
 *
 *   - SNAPPED (this file): newY = strokeRow_pt - height,
 *     i.e. `bbox_bottom == strokeRow`. Visually correct.
 *   - UNSNAPPED (mapToTemplateField, no shift): field.y = raw_y,
 *     i.e. `bbox_bottom == strokeRow` (Gemini follows the prompt).
 *     Unsnapped is rare (snap typically catches 16/17 fields), but
 *     when it happens the result is now correct, not v0.5.15's
 *     ~h/2-low fallback.
 *
 * Why removal — the v0.5.17 search-center drift bug:
 *   This file's snap algorithm anchors its row-search center on the
 *   bbox center as it stands AFTER the detection-time pre-shift:
 *     bboxCenterYPx = (field.y + field.height / 2) * pixelsPerPoint
 *   v0.5.17 reverted to a `-height/2` pre-shift on the assumption
 *   that Gemini still placed `bbox_center` on the stroke (v0.5.15
 *   prompt rule). But the v0.5.16 prompt rule had been changed to
 *   "place bbox so its bottom edge sits on the underline" — Gemini
 *   now returns `raw_y = stroke - height`. The v0.5.17 pre-shift
 *   then produced `field.y = stroke - 1.5*height` and a search
 *   center at `stroke - height`, an entire `height` ABOVE the
 *   actual stroke. On dense top-of-form rows (line spacing ~22pt)
 *   the search center landed ~10pt from the row-above stroke and
 *   ~12pt from the intended one; Step 6 picked the wrong one. The
 *   snap target `strokeRow - height` then anchored the bbox onto a
 *   stroke one row above the intended one. Real-user v0.5.17
 *   evidence: Billing Address snapped to COMPANY's stroke; Stylist
 *   Designer Name snapped to CONTACT PHONE / Email's stroke. With
 *   the pre-shift removed, the search center is `stroke - height/2`
 *   — 6pt from intended, ~16pt from row-above — well separated.
 *
 * Why bbox_bottom and not bbox_center: printed text sits ON TOP OF
 * a baseline; the underline IS the baseline. A field bbox centered
 * on its underline overflows ~half its height below the line —
 * which is the "5-6 px too low" symptom the v0.5.15 user report
 * ("all fields still 5px too low") flagged. v0.5.15 had converged
 * the snapped and unsnapped paths on the WRONG reference point
 * (bbox_center). The snap target (`strokeRow - height`) is the
 * right text-baseline anchor; the v0.5.18 fix removes the
 * detection-time pre-shift so the snap's row-search center lines
 * up with the real stroke too.
 *
 * History:
 *   v0.5.11 attempted a typographic baseline calibration here by
 *   subtracting a flat `TEXT_BASELINE_BIAS_PT = 5` from the snap
 *   target. That over-corrected the already-correct fields the snap
 *   was catching. v0.5.13 reverted the snap-side shift and kept a
 *   flat -5pt detection-time correction for unsnapped fields. The
 *   flat constant under-corrected typical 14-18pt heights (where
 *   height/2 is 7-9pt), leaving fields ~3-5pt low — the v0.5.14
 *   user report ("all fields still 5px too low"). v0.5.15 replaced
 *   the constant with `height/2` (bbox_center on stroke) — converged
 *   both paths but on the wrong anchor (printed text needs bbox above
 *   the line, not centered on it). v0.5.16 changed the PROMPT to
 *   "bottom edge on stroke" AND shifted both pre-shift and snap
 *   target to full `-height`. Both paths converged on
 *   `bbox_bottom == strokeRow`, but the shared shift moved the snap
 *   search center too, breaking stroke selection on dense
 *   top-of-form rows. v0.5.17 reverted the pre-shift to `-height/2`
 *   thinking that would restore v0.5.15's working search center.
 *   Wrong: the v0.5.16 prompt change had moved Gemini's `raw_y`
 *   itself by `-height/2`, so the v0.5.17 pre-shift took the search
 *   center an extra `-height/2` past the stroke; Billing Address +
 *   Stylist Designer Name still snapped to the row above on tight
 *   rows. v0.5.18 — removed the detection-time pre-shift entirely.
 *   The prompt does the placement work; the snap acts as a
 *   verifier/corrector against the same anchor. Snapped and
 *   unsnapped paths both converge on `bbox_bottom == strokeRow`
 *   (the v0.5.16 design intent without v0.5.16's search-center
 *   drift). v0.5.19 — adds a horizontal underline snap on top
 *   of the v0.5.18 vertical pipeline. Vertical behaviour is
 *   unchanged; the horizontal pass runs only on fields that just
 *   successfully snapped vertically, traces the chosen stroke row's
 *   continuous dark-pixel run from the bbox center, and aligns the
 *   bbox's left/right edges to the run endpoints. Three safety caps
 *   (`maxHorizontalDeltaPoints` 30pt, `minWidthPoints` 12pt,
 *   `maxWidthRatio` 1.5×) keep the snap from escaping onto adjacent
 *   strokes, snapping onto a label-glyph crossing, or extending a
 *   short field across an entire row's underline. Real-user
 *   v0.5.18 evidence: bottom-row "Cardholder Name" (Print Name)
 *   bbox shifted right and not spanning the full underline width
 *   — fixed by the horizontal snap reading the actual stroke
 *   endpoints off the same render pass already plumbed in for
 *   vertical snap. Signatures are excluded from the horizontal
 *   pass (their lines are intentionally extensible); checkboxes
 *   and multilines are excluded by the same gate as vertical snap.
 *   v0.5.20 (this) — overlap-aware horizontal cap. v0.5.19's
 *   strict 30pt per-edge cap was sized to prevent the run-walk
 *   from dragging a bbox onto a NEIGHBOURING field's underline,
 *   but that single threshold also rejected legitimate
 *   "resize-to-fit" snaps where Gemini's bbox was already
 *   substantially on the right stroke — just sized wrong. Real
 *   v0.5.19 evidence: a "Print Name" field with bbox x=315→436
 *   on an underline that actually runs x=260→420; the run-walk
 *   correctly identified `[260, 420]` and proposed
 *   `x=260, width=160`, but the resulting -55pt left-edge
 *   delta exceeded the 30pt cap and the snap aborted with
 *   `hSkippedTooFar`. v0.5.20 splits the per-edge cap into
 *   resize-fit vs relocate by classifying each candidate snap
 *   on its old/new bbox-interval overlap: ≥ 50% on BOTH sides
 *   ⇒ resize-fit (cap doubles to 60pt — we're refining the same
 *   stroke); otherwise ⇒ relocate (strict 30pt cap — we'd be
 *   moving onto a different stroke, which is risky). The
 *   `minWidthPoints` and `maxWidthRatio` caps are unchanged
 *   and continue to apply uniformly. The Print Name case has
 *   `overlapRatioOld = 105/120.56 ≈ 0.87` and
 *   `overlapRatioNew = 105/160 ≈ 0.66`, both ≥ 0.5 ⇒
 *   resize-fit ⇒ effective cap 60pt ⇒ 55pt edge delta passes
 *   ⇒ snap applies (`x=260, width=160`). A wrong-underline
 *   neighbour-jump has ~0% old-side overlap (entirely different
 *   x range), falls through to the strict 30pt cap, and is
 *   still rejected. Two new counters
 *   (`hSnappedResizeFit`, `hSnappedRelocate`) replace the
 *   single `hSnapped`; the per-page summary line surfaces
 *   the breakdown (`hSnap N/M (X fit, Y relocate)`).
 *   v0.5.21 (this) — drops the per-edge cap entirely on
 *   resize-fit and bumps `maxWidthRatio` (resize-fit only) from
 *   1.5× → 2.0×. Real v0.5.20 evidence: Print Name on the Ruby
 *   form has bbox `x=315.18, width=120.56` (centre 375.46) but
 *   the actual underline starts ~235–245pt — a -70 to -80pt
 *   left-edge delta. The run-walk correctly identifies the
 *   underline (≥ 50% bbox-interval overlap on both sides ⇒
 *   classified as resize-fit), but the v0.5.20 60pt cap rejects
 *   it as `hSkippedTooFar`. The cap was redundant defense:
 *   ≥ 50% overlap on both sides is itself proof we're on the
 *   same stroke (a wrong-underline neighbour-jump has ~0%
 *   old-side overlap, automatically falls into the relocate
 *   branch, and is still capped at 30pt). With the per-edge
 *   cap removed, `maxWidthRatio` becomes the active bound on
 *   resize-fit; bumping it to 2.0× absorbs the observed
 *   33–45% Gemini under-detection of width without admitting
 *   an entire row's connected underline (those score ~3–4× the
 *   bbox width and trip the 2.0× ratio). The relocate-mode
 *   caps (30pt per-edge, 1.5× width) are unchanged — relocate
 *   is rare and stays conservative. v0.5.21 also gates the
 *   per-field snap log on `localStorage["typeset.debug.alignment"]`
 *   (in addition to `import.meta.env.DEV`) so users on a
 *   shipped production build can opt into per-field
 *   diagnostics with the same flag they already use for
 *   `[Typeset Align]` lines, without rebuilding from source.
 *   The aggregate `[underlineSnap] snapped …` summary line
 *   is unchanged and still always logs.
 *
 * Signatures are snap-eligible (added in v0.5.13). They follow the
 * same prompt rule (bottom edge on stroke), receive no detection-
 * time shift, and snap to the signature line via Step 8 just like
 * text underlines.
 *
 * Why this exists:
 *   The v0.5.3 prompt rule and Pass-2 audit rule 4b ask the model to
 *   self-verify the vertical baseline of each bbox on the underline
 *   (v0.5.16: bbox_bottom on stroke; pre-v0.5.16: bbox_center on
 *   stroke). The model can describe the rule but does not measure
 *   pixels reliably at sub-pt precision, so several real fields
 *   still ship sitting visibly above or below the line they're
 *   meant to write on. This snap does the measurement
 *   deterministically.
 *
 * Why it is conservative — and why v0.4.13 ("Precision" mode) failed
 * but this won't:
 *   v0.4.13 made geometric detection the SOLE detector — Gemini was
 *   only consulted for type/label, every bbox came from rasterized
 *   underline analysis. That regressed because the model is far
 *   better than us at noticing that a faint box outline IS a writable
 *   region or that an inline-sentence blank exists. This module is
 *   the opposite: Gemini still detects everything; we only nudge Y
 *   when (a) the field is already a text field (including signatures
 *   as of v0.5.13), (b) we find at least one row within
 *   ±searchRangePoints of the bbox center that scores above the
 *   dark-coverage threshold AND passes a vertical-thinness gate
 *   (the rows ~5px above and below are mostly light — text glyphs
 *   span ~10-25px vertically and fail this check), and
 *   (c) the snap delta is ≤ maxSnapPoints. Otherwise we leave the
 *   field alone.
 *
 * The snap is a no-op for checkboxes and multilines — checkbox
 * glyphs anchor on the box (not a baseline), and multilines span
 * tall regions with no single underline to snap to (snapping one
 * would be actively destructive). Signatures DO snap as of v0.5.13:
 * a signature line is a horizontal stroke just like a text
 * underline.
 *
 * v0.5.10 — thinness offset + cap widening. The v0.5.7 thinness gate
 * sampled rows ±3px from each candidate to verify it was a real
 * stroke. At our 2048-px long-edge render scale (~2.59 px / PDF pt
 * on US-Letter), a 1pt-thick underline spans ~2.6px of solid pixels
 * plus 1-2px of anti-alias blur on each side, for an effective
 * 5-6px footprint. The ±3px samples were therefore landing INSIDE
 * the stroke's own blur and occasionally rejecting real strokes as
 * "text". v0.5.10 moves the offset to ±5px so the sample rows
 * clear the stroke's own anti-aliasing. With the discriminator now
 * reliably accepting real strokes, the safety caps loosen too —
 * search range 18→24pt, max snap 12→18pt, score 0.5→0.45, vertical
 * neighbour max 0.3→0.4. The 18pt cap still rejects wildly-wrong
 * field jumps (typical line-to-line spacing on US-Letter forms is
 * 24-30pt).
 *
 * Threshold rationale (v0.5.10 shipped values):
 *   | name                      | value | why                                                 |
 *   |---------------------------|-------|-----------------------------------------------------|
 *   | searchRangePoints         | 24 pt | one full line on dense forms, w/ thinness gate      |
 *   | scoreThreshold            | 0.45  | thinness gate compensates for permissive coverage   |
 *   | darkLuminance             | 80    | catches near-black strokes, ignores grey shading    |
 *   | verticalNeighborMax       | 0.4   | label glyph rows still well above this; strokes <<  |
 *   | THINNESS_NEIGHBOR_OFFSET  | 5 px  | clears stroke's own blur at 2048-px render scale    |
 *   | ambiguityGapPoints        | 8 pt  | only matters for genuinely equidistant pairs        |
 *   | maxSnapPoints             | 18 pt | < typical line spacing (24-30pt); never crosses row |
 *
 * v0.5.7 — stroke-vs-text discrimination via the vertical-thinness
 * gate (`verticalNeighborMax`) plus closest-to-center candidate
 * selection (instead of highest-score). v0.5.5 counted the longest
 * contiguous dark run on a single row as a fraction of bbox width;
 * on dense forms a row of glyph slices could clear the threshold
 * and either pull the field onto the label text or trigger the
 * ambiguity guard and skip the snap. The thinness gate fixes that.
 *
 * All thresholds (search range, dark luminance, score, vertical
 * neighbor max, ambiguity gap, max snap) are tunable per-call via
 * the options bag; the defaults are the values we ship with.
 */

import type { TemplateField } from "@/types";

/**
 * One page's rasterized image, plus the page's PDF-space scale, fed
 * into {@link snapFieldsToUnderlines}. Producers (the renderer in
 * `geminiFieldDetector`) capture the same canvas they already paint
 * for Gemini and hand the pixel buffer through; no separate render
 * pass is performed.
 */
export interface PageRender {
  /** Raw RGBA pixels in row-major order, length = width * height * 4. */
  imageData: ImageData;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /**
   * Scale factor: PDF user-space points per image pixel. Stored this
   * way (rather than pixels-per-point) because `TemplateField` rects
   * are in PDF points and the snap algorithm is mostly working in
   * pixels — `pixelsPerPoint = 1 / pdfPointsPerPixel`.
   */
  pdfPointsPerPixel: number;
  /**
   * v0.5.25 — per-page text-row geometry pulled from pdf.js, used by
   * the {@link tryTextRowSnap} fallback that runs when the stroke
   * search reports `skipped:no-stroke`. Each row carries a baseline
   * y-coordinate (`yBottom`) and horizontal extent (`xMin`/`xMax`)
   * in PDF user-space points, top-down origin (matching
   * `TemplateField.y` / `TemplateField.x`). Optional — the snap
   * pipeline degrades gracefully (skipped:no-stroke) when text rows
   * are missing.
   */
  textRows?: Array<{ yBottom: number; xMin: number; xMax: number }>;
}

/**
 * v0.5.25 — single text row, exported for upstream callers that
 * extract their own geometry. Same shape as `PageRender.textRows[i]`.
 */
export interface TextRow {
  yBottom: number;
  xMin: number;
  xMax: number;
}

export interface SnapOptions {
  /**
   * Maximum distance (in PDF points) the snap may move a field. If a
   * stroke is found further than this from the bbox center, we take
   * that as evidence the model found a totally different field and
   * leave the bbox alone rather than dragging it across line
   * boundaries. Default: 18pt.
   *
   * v0.5.10 raised this from 12pt to 18pt: the v0.5.7 cap was clipping
   * legitimate snaps in the 13–18pt range observed on the top section
   * of THERUBYCCAUTHFORM2024 (NAME OF CARDHOLDER → STYLIST/DESIGNER
   * NAME). 18pt is still well below the 24–30pt line spacing typical
   * on US-Letter forms, so the cap continues to reject wildly-wrong
   * cross-line jumps.
   */
  maxSnapPoints?: number;
  /**
   * Half-height of the search band, in PDF points, scanned above
   * AND below the bbox center for an underline stroke. ~24pt is one
   * generous line height — wide enough to find strokes offset by up
   * to a full line on dense forms, narrow enough not to cross-jump
   * past more than one line boundary. Default: 24pt.
   *
   * v0.5.10 raised this from 18pt to 24pt in lockstep with the wider
   * snap cap; the v0.5.7 thinness gate (now sampling at ±5px, see
   * `THINNESS_NEIGHBOR_OFFSET_PX`) reliably filters label rows even
   * with the larger band.
   */
  searchRangePoints?: number;
  /**
   * Minimum stroke score (longest contiguous dark-pixel run divided
   * by bbox width) for a row to qualify as the underline. Default:
   * 0.45 — a stroke must cover at least 45 % of the bbox width to
   * count.
   *
   * v0.5.10 lowered this from 0.5 to 0.45 because the corrected
   * thinness offset (±5px) lets us tolerate slightly fainter or
   * partially-broken strokes without false-positiving onto label
   * rows. Label glyph rows are filtered by the thinness gate
   * regardless of how high they score on coverage.
   */
  scoreThreshold?: number;
  /**
   * Luminance below which a pixel is considered "dark" (and therefore
   * part of a stroke). Y = 0.299*R + 0.587*G + 0.114*B; threshold 80
   * comfortably catches near-black PDF strokes against white paper
   * without triggering on grey shading. Default: 80.
   */
  darkLuminance?: number;
  /**
   * Maximum stroke score allowed on the rows ~5px above AND below a
   * candidate row for the candidate to be treated as a real
   * horizontal underline. Real strokes are 1-3 image pixels tall
   * (plus 1-2px of anti-alias blur on each side), so the rows
   * ±5px around them are mostly light pixels. Text glyph rows are
   * ~10-25px tall, so the rows around them also contain dark
   * pixels and exceed this threshold.
   * Default: 0.4 — neighbours must be < 40% dark to qualify.
   *
   * v0.5.10 raised this from 0.3 to 0.4 once the offset moved out
   * to ±5px (clear of the stroke's own blur). At ±5px the neighbour
   * row of a real stroke is genuinely background-dominated, so we
   * can afford a more permissive threshold without admitting glyph
   * rows (which still score ≫ 0.4 even 5px from their centre).
   *
   * Introduced in v0.5.7 to discriminate strokes from label-text
   * rows that happened to score above `scoreThreshold` because
   * glyph slices contain many dark pixels horizontally.
   */
  verticalNeighborMax?: number;
  /**
   * If two qualifying rows are nearly equidistant from the bbox
   * center (within ±1pt of each other) AND more than this many
   * points apart vertically, treat the field as truly ambiguous
   * (no signal which stroke the model meant — e.g. a tightly
   * boxed region whose top and bottom borders fall on opposite
   * sides of center) and skip the snap. Default: 8pt.
   *
   * v0.5.7 raised this from 6pt to 8pt and replaced the old
   * "any two qualifying rows > 6pt apart" rule with the
   * equidistant test. With the vertical-thinness gate every
   * qualifying row is a real stroke; if one is clearly closer to
   * the model's bbox center, that's the one the model meant.
   * (Unchanged in v0.5.10.)
   */
  ambiguityGapPoints?: number;
  /**
   * Maximum per-edge delta (in PDF points) for relocate-mode
   * horizontal snaps — i.e. snaps where the proposed new bbox
   * interval overlaps < 50% of the original interval on either
   * side ("we'd be moving the bbox onto a different stroke").
   * Mirrors `maxSnapPoints` for the vertical snap: anything
   * bigger is almost certainly the run-walk having escaped onto
   * a wrong stroke (e.g. the underline of an adjacent field on
   * the same row, joined to ours by a thin connecting line), so
   * we leave `x`/`width` alone rather than drag the bbox into a
   * wrong extent. Default: 30pt.
   *
   * 30pt is generous on relocate: the worst-observed Gemini drift
   * on a normal label is ~20pt, and 30pt easily absorbs that
   * while still rejecting whole-row extensions on a US-Letter
   * form (typical row underlines are 80-300pt wide, far past
   * this cap on either side).
   *
   * v0.5.21 narrowed the scope of this cap to relocate ONLY.
   * Resize-fit candidates (≥ 50% old-vs-new interval overlap on
   * BOTH sides — refining the edges of the same stroke the bbox
   * is already on) skip the per-edge cap entirely: the overlap
   * rule is itself the proof that the new run is the same stroke
   * the bbox sits on, so the cap is redundant defense. Real
   * Gemini under-detection of left/right edges on inline-row
   * text fields exceeds the v0.5.20 60pt resize-fit cap (Print
   * Name on the v0.5.20 Ruby form: -70 to -80pt left-edge
   * delta), and the only thing the cap was doing was rejecting
   * legitimate snaps. With it gone on resize-fit, `maxWidthRatio`
   * is the single active bound (resize-fit 2.0× / relocate 1.5×)
   * — runaway extensions across a connected multi-segment line
   * trip the ratio at ~3–4× regardless of how big a per-edge
   * delta the cap removal would otherwise allow.
   *
   * v0.5.19 introduced this alongside the horizontal snap with a
   * uniform 30pt cap. v0.5.20 made the cap overlap-aware
   * (relocate 30pt / resize-fit 60pt). v0.5.21 (current) drops
   * the resize-fit branch entirely; relocate keeps the strict
   * 30pt default.
   */
  maxHorizontalDeltaPoints?: number;
  /**
   * Minimum width (in PDF points) of the horizontal-snap run for the
   * snap to be applied. If the continuous dark run starting at the
   * bbox center is shorter than this, the center column is probably
   * sitting on a label glyph that happens to intersect the snap row
   * (rather than on a real underline), so we abort the horizontal
   * snap. Default: 12pt.
   *
   * 12pt ≈ one or two characters of typical 10–11pt body text;
   * even the shortest realistic fillable underline (a single-digit
   * "Date" segment) is wider than that, so the cap rejects only
   * pathological label-glyph crossings.
   *
   * Introduced in v0.5.19 alongside the horizontal snap.
   */
  minWidthPoints?: number;
  /**
   * Maximum ratio of new horizontal-snap width to the original
   * bbox width, FOR RELOCATE-MODE snaps. If the run is more than
   * `maxWidthRatio × original width`, abort. Default: 1.5.
   *
   * Prevents a short field (e.g. "Date") from being extended across
   * an entire row's underline when the row is one continuous stroke
   * the model deliberately chunked into multiple bboxes. The
   * complementary cap on shrinkage is implicit: shrinkage cannot
   * happen here because the run-walk starts AT the bbox center and
   * extends outward, so the new width is always ≥ 0; the
   * `minWidthPoints` cap above handles the case where the run is
   * just a glyph slice.
   *
   * v0.5.21 SPLIT this cap by mode. For resize-fit candidates the
   * effective cap is 2.0× (hard-coded inside `tryHorizontalSnap`,
   * not exposed as an option). The 1.5× → 2.0× bump matters
   * because (a) v0.5.21 removed the per-edge cap on resize-fit,
   * making this ratio the only active runaway-extent bound, and
   * (b) Gemini routinely under-detects width by 33–45% on real
   * text fields, so 1.5× was rejecting legitimate snaps. 2.0×
   * absorbs the observed under-detection without admitting an
   * entire row's connected underline (those score ~3–4× the bbox
   * width). Relocate keeps 1.5× — relocate is rare and stays
   * conservative.
   *
   * Introduced in v0.5.19 alongside the horizontal snap; mode
   * split added in v0.5.21.
   */
  maxWidthRatio?: number;
  /**
   * v0.5.25 — text-row fallback (vertical-only). When the stroke
   * search reports `skipped:no-stroke`, a secondary pass tries to
   * align the bbox bottom to the baseline of the surrounding text
   * row. Settings:
   *   - `textRowMaxDeltaPoints` (default 12pt): the baseline must be
   *     within this many points of the field's current bbox bottom
   *     for the fallback to trigger. Bigger deltas are almost always
   *     a wrong row pick (e.g. one paragraph above or below).
   *   - `textRowMinHorizontalOverlap` (default 0.25): the row's
   *     horizontal extent must overlap the field's `x` range by at
   *     least this fraction of the field's width. Filters out rows
   *     on the other side of the page that happen to share a
   *     baseline (multi-column forms).
   *   - `textRowEligibleKinds` is the set of field kinds the
   *     fallback applies to. By default text/multiline/date — NOT
   *     signatures (signatures should stay where Gemini placed them
   *     since they often sit above an extensible line that may or
   *     may not have a printed stroke).
   */
  textRowMaxDeltaPoints?: number;
  textRowMinHorizontalOverlap?: number;
  /**
   * If true, log per-field snap decisions to the console when
   * EITHER `localStorage["typeset.debug.alignment"] === "true"` OR
   * the build is in DEV mode (`import.meta.env.DEV`). The
   * localStorage opt-in (added in v0.5.21) lets users on a
   * shipped production bundle diagnose alignment issues with the
   * same flag that already gates the `[Typeset Align]` lines,
   * without rebuilding from source. Used by the detector's
   * diagnostic dumps; the call sites pass `verbose: true`
   * unconditionally and the localStorage gate keeps shipping
   * bundles quiet for users who haven't opted in.
   *
   * The aggregate `[underlineSnap] snapped …` summary line is
   * unconditional and ignores both this flag and the
   * localStorage opt-in.
   */
  verbose?: boolean;
}

const DEFAULT_OPTIONS: Required<SnapOptions> = {
  maxSnapPoints: 18,
  searchRangePoints: 24,
  scoreThreshold: 0.45,
  darkLuminance: 80,
  verticalNeighborMax: 0.4,
  ambiguityGapPoints: 8,
  maxHorizontalDeltaPoints: 30,
  minWidthPoints: 12,
  maxWidthRatio: 1.5,
  textRowMaxDeltaPoints: 12,
  textRowMinHorizontalOverlap: 0.25,
  verbose: false,
};

/**
 * Hard-coded distance tolerance (in PDF points) for the
 * "equidistant within ±1pt" arm of the ambiguity guard. Two
 * candidates whose distance from the bbox center differs by less
 * than this are considered equidistant — the model has not given us
 * a y-preference between them, so if they're also far apart
 * vertically we skip rather than guess.
 */
const AMBIGUITY_DISTANCE_TOLERANCE_PT = 1;

/** Vertical pixel offset checked above/below a candidate row for the
 *  thinness gate. Five pixels clears the stroke's own anti-aliased
 *  blur at our 2048-px long-edge render scale: a US-Letter page
 *  (792 PDF pt tall) renders at ~2.59 px/pt, so a 1pt-thick underline
 *  spans ~2.6px of solid pixels plus ~1-2px of anti-alias blur on
 *  each side — an effective 5-6px footprint. Sampling at ±5px lands
 *  outside that footprint (the neighbour row is genuinely background)
 *  while still being well inside any label glyph row (~10-25px tall),
 *  so it cleanly separates strokes from text without per-DPI tuning.
 *
 *  v0.5.10 raised this from 3 to 5: at ±3px the sample rows could
 *  fall INSIDE the stroke's own blur and report a non-trivial
 *  neighbour score, occasionally rejecting real strokes as text. */
const THINNESS_NEIGHBOR_OFFSET_PX = 5;

/**
 * Aggregate counters for one snap pass — surfaced via the
 * `[underlineSnap]` log line in `detectFieldsImpl`.
 *
 * The `h*` counters (v0.5.19) cover the horizontal-snap stage, which
 * runs only on fields that successfully snapped vertically. They sum
 * to ≤ `snapped`; any field counted in `snapped` either had its
 * x/width updated (counted in `hSnappedResizeFit` or
 * `hSnappedRelocate`, see below), was skipped by one of the four
 * horizontal-skip gates (`hSkipped*`), or — for signatures — was
 * not eligible for the horizontal pass at all (no horizontal
 * counter incremented; signatures keep their vertical-snapped y).
 *
 * v0.5.20 split the previous single `hSnapped` counter into
 * `hSnappedResizeFit` vs `hSnappedRelocate` to reflect the
 * overlap-aware per-edge cap (resize-fit: ≥50% bbox-overlap on
 * both sides, larger cap; relocate: < 50% on either side, strict
 * cap). The total `hSnapped` is just their sum and is computed
 * inline where the summary line needs it.
 */
interface SnapCounts {
  total: number;
  snapped: number;
  noStroke: number;
  ambiguous: number;
  tooFar: number;
  skippedNonText: number;
  skippedNoPage: number;
  /**
   * v0.5.25 — text-row fallback fired. Counts fields where the
   * stroke search reported `skipped:no-stroke` AND a nearby text
   * row baseline was found within the `textRowMaxDeltaPoints`
   * window. The field's `y` is shifted so `bbox_bottom = textRow.yBottom`.
   */
  textRowSnapped: number;
  /**
   * v0.5.25 — counter for fields where BOTH the stroke search and
   * the text-row fallback failed. Distinct from `noStroke` because
   * we want to know how often the fallback couldn't find anything
   * usable (vs how often the fallback succeeded). The sum
   * `noStroke + textRowSnapped + textRowNoMatch` equals the total
   * stroke-skipped count on the old reporting axis.
   */
  textRowNoMatch: number;
  /**
   * Horizontal snap fired AND the new run substantially
   * overlapped (≥ 50% on both old and new) the original bbox —
   * we were refining edges of the same stroke. v0.5.21: no
   * per-edge cap on resize-fit (the overlap rule subsumes it);
   * the 2.0× width-ratio bound is the only active runaway-extent
   * guard.
   */
  hSnappedResizeFit: number;
  /**
   * Horizontal snap fired AND the new run did NOT substantially
   * overlap the original bbox — we'd be moving the bbox onto a
   * different stroke. Strict per-edge cap (30pt default) and
   * 1.5× width-ratio cap apply. Rare in practice because the
   * run-walk anchors at the bbox center, so a relocate that
   * survives both caps is unusual.
   */
  hSnappedRelocate: number;
  hSkippedNoStroke: number;
  hSkippedTooFar: number;
  hSkippedTooNarrow: number;
  hSkippedTooWide: number;
  /**
   * v0.5.22 — the run-walk traced an underline whose width is
   * MUCH larger than the field's bbox (newWidth > 2.5× oldWidth).
   * On dense forms (e.g. 204 Credit Card Authorization Form) a
   * single horizontal stroke spans Address + City + State + Zip,
   * or Credit Card Number + Exp Date + CVV, or Name on Card +
   * Email + Phone. The walker correctly identifies the connected
   * stroke and proposes the entire row as the new extent; for
   * each individual field the resulting snap is geometrically
   * wrong (it would extend across all sibling fields' columns).
   *
   * Pre-v0.5.22 these tripped `hSkippedTooWide` (relocate-mode
   * 1.5× cap or resize-fit 2.0× cap) — but lumping them with
   * "Date extended across the whole row" obscured the form-design
   * signal: 16 fields all blocked at the SAME `newWidth ≈ 480pt`
   * means the row underline is the issue, not Gemini's bbox
   * sizing. v0.5.22 splits the "obvious row connector"
   * (newWidth > 2.5× oldWidth, well past every other cap) into
   * its own counter so the per-page summary surfaces the form
   * geometry directly.
   *
   * Behaviourally identical to `hSkippedTooWide` from the user's
   * perspective: the field stays at Gemini's vertical-snapped
   * `(x, width)`, and the layout is unchanged. Only the
   * classification — and the per-field log line — differs.
   */
  hSkippedRowConnector: number;
}

/**
 * One row that passed both `scoreThreshold` and the vertical-
 * thinness gate. `score` is retained for diagnostic logging — the
 * candidate-selection step uses distance-from-bbox-center, not
 * score.
 */
interface StrokeCandidate {
  row: number;
  score: number;
}

/**
 * True iff per-field verbose logging should print. Per-field logs
 * are gated by `opts.verbose` AND one of two opt-ins: the
 * typeset-wide alignment debug flag in localStorage (preferred —
 * users on a production build can flip it from DevTools without
 * rebuilding) OR the Vite-injected `import.meta.env.DEV` boolean
 * (true in development bundles, baked false in production
 * bundles). The localStorage check runs first so a user with the
 * flag set sees per-field decisions even on a release build.
 *
 * v0.5.21: previously the gate was `opts.verbose && DEV` only, so
 * production bundles were unconditionally quiet — users had to
 * rebuild from source to diagnose snap behaviour. The aggregate
 * `[underlineSnap] snapped …` summary line is logged
 * unconditionally and is unaffected by this gate.
 */
function verboseLogEnabled(opts: Required<SnapOptions>): boolean {
  if (!opts.verbose) return false;
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("typeset.debug.alignment") === "true"
    ) {
      return true;
    }
  } catch {
    // localStorage may be inaccessible (e.g. SSR or sandboxed
    // contexts). Fall through to the DEV check.
  }
  // Vite injects `import.meta.env.DEV` as a boolean literal at
  // build time; in production builds the whole branch tree-shakes
  // away — the localStorage check above is what surfaces logs in
  // shipped bundles.
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

/**
 * Compute the longest contiguous dark-pixel run on a single image
 * row, restricted to the column range `[leftCol, rightCol]`. The
 * run length is allowed to span small (≤ 2 px) light gaps — PDF
 * underlines are anti-aliased and can show 1-2 lighter pixels in the
 * middle of an otherwise solid stroke; treating those as
 * disqualifying gaps would cause us to miss real strokes.
 *
 * Returns the run length divided by the bbox width (the "stroke
 * score"). 1.0 means the bbox is fully covered by a continuous dark
 * stroke; 0 means no dark pixels at all. Out-of-bounds rows return
 * 0, which the vertical-thinness gate relies on (a missing
 * neighbour row is treated as "light", i.e. the page edge counts
 * as confirmation of thinness).
 */
function rowStrokeScore(
  imageData: ImageData,
  row: number,
  leftCol: number,
  rightCol: number,
  darkLuminance: number
): number {
  const width = imageData.width;
  const height = imageData.height;
  if (row < 0 || row >= height) return 0;

  const left = Math.max(0, Math.floor(leftCol));
  const right = Math.min(width - 1, Math.ceil(rightCol));
  if (right <= left) return 0;

  const bboxWidth = right - left + 1;
  const data = imageData.data;
  const rowOffset = row * width * 4;

  let bestLen = 0;
  let curLen = 0;
  // Allow up to MAX_GAP light pixels in the middle of a run before
  // we treat the run as broken. Tolerates anti-aliasing artefacts.
  const MAX_GAP = 2;
  let curGap = 0;

  for (let col = left; col <= right; col += 1) {
    const idx = rowOffset + col * 4;
    const a = data[idx + 3];
    let isDark: boolean;
    if (a < 128) {
      isDark = false;
    } else {
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      isDark = lum < darkLuminance;
    }

    if (isDark) {
      curLen += curGap + 1;
      curGap = 0;
      if (curLen > bestLen) bestLen = curLen;
    } else {
      if (curLen > 0 && curGap < MAX_GAP) {
        curGap += 1;
      } else {
        curLen = 0;
        curGap = 0;
      }
    }
  }

  return bestLen / bboxWidth;
}

/**
 * Trace the continuous dark-pixel run on `row` that contains
 * `centerCol`, walking outward in both directions, and return its
 * left/right pixel endpoints. Allows the same `MAX_GAP = 2` light-
 * pixel tolerance used by {@link rowStrokeScore} so that PDF anti-
 * aliasing artefacts in the middle of an otherwise solid stroke
 * don't terminate the walk early.
 *
 * Returns `null` when there is no dark pixel under (or within
 * `MAX_GAP` of) the center column on `row`. This is the
 * "no-stroke-at-center" guard used by {@link tryHorizontalSnap}:
 * the vertical snap can occasionally land on a stroke that doesn't
 * extend horizontally under the bbox center (e.g. an adjacent
 * field's stroke that happened to be the closest qualifying row),
 * and we don't want to pretend we found a run when we didn't.
 *
 * Out-of-bounds `row` or `centerCol` also returns `null`. This
 * is a column-walking cousin of {@link rowStrokeScore} (which is
 * row-internal and integrates dark coverage as a fraction of bbox
 * width); the two share the same dark-luminance and gap-tolerance
 * conventions on purpose so the horizontal and vertical passes
 * agree on what "stroke pixel" means.
 *
 * Introduced in v0.5.19 for the horizontal underline snap.
 */
function findHorizontalRun(
  imageData: ImageData,
  row: number,
  centerCol: number,
  darkLuminance: number
): { leftPx: number; rightPx: number } | null {
  const width = imageData.width;
  const height = imageData.height;
  if (row < 0 || row >= height) return null;

  const center = Math.round(centerCol);
  if (center < 0 || center >= width) return null;

  const data = imageData.data;
  const rowOffset = row * width * 4;
  const MAX_GAP = 2;

  const isDark = (col: number): boolean => {
    if (col < 0 || col >= width) return false;
    const idx = rowOffset + col * 4;
    const a = data[idx + 3];
    if (a < 128) return false;
    const lum =
      0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    return lum < darkLuminance;
  };

  // Confirm the center column actually sits on (or within MAX_GAP
  // of) a stroke. Without this guard, an off-stroke vertical snap
  // would still find a "run" by walking left/right far enough to
  // hit some unrelated dark pixel; the horizontal snap would then
  // drag x/width arbitrarily. If center is light, accept only if
  // there's a dark pixel within MAX_GAP on either side (i.e. the
  // center landed in the stroke's anti-alias gap, not off-stroke).
  let centerOnStroke = isDark(center);
  if (!centerOnStroke) {
    for (let off = 1; off <= MAX_GAP; off += 1) {
      if (isDark(center - off) || isDark(center + off)) {
        centerOnStroke = true;
        break;
      }
    }
  }
  if (!centerOnStroke) return null;

  // Walk left from center, allowing up to MAX_GAP consecutive light
  // pixels before terminating. `leftPx` tracks the leftmost dark
  // pixel observed so far; the trailing gap is intentionally NOT
  // included in the run (it's only tolerated for continuation).
  let leftPx = isDark(center) ? center : center;
  let gap = 0;
  for (let col = center - 1; col >= 0; col -= 1) {
    if (isDark(col)) {
      leftPx = col;
      gap = 0;
    } else {
      gap += 1;
      if (gap > MAX_GAP) break;
    }
  }

  // Walk right from center, mirroring the left walk.
  let rightPx = isDark(center) ? center : center;
  gap = 0;
  for (let col = center + 1; col < width; col += 1) {
    if (isDark(col)) {
      rightPx = col;
      gap = 0;
    } else {
      gap += 1;
      if (gap > MAX_GAP) break;
    }
  }

  // If the center column itself was light (we accepted it because a
  // dark pixel sat within MAX_GAP), make sure the resolved endpoints
  // bracket the center. Without this, a center landing just past
  // the right edge of a short stroke could yield rightPx < leftPx.
  if (rightPx < leftPx) return null;

  return { leftPx, rightPx };
}

/**
 * Format a per-field snap decision in the canonical
 * `[underlineSnap] field=… page=… result=… deltaY=…pt strokeRow=…`
 * form. Centralised so every code path (snap / skip-no-stroke /
 * skip-too-far / skip-ambiguous) emits the same shape and the log
 * stays grep-friendly.
 */
function logDecision(
  field: TemplateField,
  result: "snapped" | "skipped:no-stroke" | "skipped:too-far" | "skipped:ambiguous",
  deltaPt: number,
  strokeRow: number,
  extra?: string
): void {
  const suffix = extra ? ` ${extra}` : "";
  console.log(
    `[underlineSnap] field=${field.id} page=${field.pageNumber} result=${result} deltaY=${deltaPt.toFixed(2)}pt strokeRow=${strokeRow}${suffix}`
  );
}

/**
 * Horizontal underline snap (v0.5.19, mode-aware caps v0.5.21).
 * Called from {@link snapOneField} ONLY after a successful vertical
 * snap, with `strokeRow` being the image row the vertical snap
 * chose. Returns the new `{ x, width }` in PDF points if the snap
 * fires, or `null` if any skip gate trips (in which case the
 * caller leaves x/width alone).
 *
 * The algorithm:
 *   1. Find the continuous dark-pixel run on `strokeRow` that
 *      contains the bbox's horizontal center
 *      ({@link findHorizontalRun}). Returns null → no stroke at
 *      center → abort (`hSkippedNoStroke`). Guards against the
 *      case where the vertical snap landed on a stroke that
 *      doesn't extend horizontally under the bbox (e.g. an
 *      adjacent field's stroke that happened to be the closest
 *      qualifying row).
 *   2. Convert the run endpoints to PDF points and compute new
 *      `x`/`width`.
 *   3. Classify the candidate snap (v0.5.20):
 *        - Compute interval overlap between
 *          `[oldX, oldX + oldWidth]` and
 *          `[newX, newX + newWidth]` and the two ratios
 *          `overlapWidth/oldWidth` and `overlapWidth/newWidth`.
 *        - If BOTH ratios ≥ 0.5 → "resize-to-fit" (we're refining
 *          the edges of the SAME stroke the bbox is already on).
 *        - Otherwise → "relocate" (we'd be moving onto a different
 *          stroke, which is risky).
 *   4. Apply safety caps:
 *        - `minWidthPoints` (`hSkippedTooNarrow`): applies in BOTH
 *          modes. A run shorter than 12pt (default) is probably
 *          under a label glyph crossing the snap row, not a real
 *          underline.
 *        - `maxWidthRatio` (`hSkippedTooWide`): mode-dependent.
 *          Resize-fit uses 2.0× (hard-coded), relocate uses the
 *          option default 1.5×. A run wider than this multiple of
 *          the original almost certainly means the bbox was meant
 *          for a fragment of a continuous row underline. v0.5.21
 *          made this the single active runaway-extent bound on
 *          resize-fit.
 *        - `maxHorizontalDeltaPoints` (`hSkippedTooFar`): RELOCATE
 *          ONLY. Resize-fit candidates skip the per-edge cap
 *          entirely — the ≥ 50% overlap rule is itself the
 *          proof that the new run is the same stroke the bbox
 *          sits on; a wrong-underline neighbour-jump has ~0%
 *          old-side overlap and is automatically classified as
 *          relocate, where the strict 30pt cap still applies.
 *          v0.5.20 had a relaxed 60pt resize-fit cap, but real
 *          Gemini under-detection of left edges on inline-row
 *          fields exceeds 60pt (Print Name on the v0.5.20 Ruby
 *          form: -70 to -80pt), so the cap was rejecting
 *          legitimate snaps it had no other reason to gate.
 *
 * Skip list — signatures are excluded BEFORE step 1. Their
 * underlines are intentionally extensible (the writer assumes the
 * user can scrawl past the printed line endpoints) and clamping
 * x/width to the printed extent would constrict the writable area.
 * Checkboxes and multilines are already filtered upstream by the
 * vertical-snap eligibility gate; they cannot reach this function
 * because horizontal snap only runs on fields that just snapped
 * vertically.
 */
function tryHorizontalSnap(
  field: TemplateField,
  render: PageRender,
  strokeRow: number,
  opts: Required<SnapOptions>,
  counts: SnapCounts,
  wantLog: boolean
): { x: number; width: number } | null {
  if (field.fieldKind === "signature") {
    if (wantLog) {
      console.log(
        `[underlineSnap] field=${field.id} hSnap=skipped:signature (signatures keep their bbox extent — line is user-extensible)`
      );
    }
    return null;
  }

  const pixelsPerPoint = 1 / Math.max(1e-6, render.pdfPointsPerPixel);
  const bboxCenterXPx = (field.x + field.width / 2) * pixelsPerPoint;

  const run = findHorizontalRun(
    render.imageData,
    strokeRow,
    bboxCenterXPx,
    opts.darkLuminance
  );

  if (!run) {
    counts.hSkippedNoStroke += 1;
    if (wantLog) {
      console.log(
        `[underlineSnap] field=${field.id} hSnap=skipped:no-stroke (centerCol=${Math.round(bboxCenterXPx)} on strokeRow=${strokeRow} is light)`
      );
    }
    return null;
  }

  // Run endpoints in PDF points. `+1` on the width converts
  // inclusive pixel endpoints to a half-open span (matches the
  // `bboxToPdfRect` convention upstream: width = pixel count).
  const newX = run.leftPx * render.pdfPointsPerPixel;
  const newWidth =
    (run.rightPx - run.leftPx + 1) * render.pdfPointsPerPixel;
  const newRight = newX + newWidth;
  const oldX = field.x;
  const oldWidth = field.width;
  const oldRight = oldX + oldWidth;

  const leftDeltaPt = newX - oldX;
  const rightDeltaPt = newRight - oldRight;

  // v0.5.20–v0.5.21: classify the snap as either "resize-to-fit"
  // (the new run substantially overlaps the original bbox —
  // we're refining edges of the SAME stroke the bbox is already
  // on) or "relocate" (little/no overlap — we'd be moving the
  // bbox onto a DIFFERENT stroke, which is risky and usually
  // wrong). The classification controls which safety caps fire:
  //   - resize-fit: NO per-edge cap (overlap rule subsumes it),
  //                 width ratio bound at 2.0×.
  //   - relocate:   strict 30pt per-edge cap, width ratio
  //                 bound at the option default 1.5×.
  //
  // Detection rule: ≥ 50% overlap on BOTH the old and new
  // intervals. Both sides matter — a wrong-underline neighbour-
  // jump has ~0% old-side overlap (the new run is in a different
  // x range entirely), and a runaway extension across a multi-
  // segment connected line has `oldWidth / newWidth` new-side
  // overlap that drops below 0.5 once the new run is more than
  // 2× the old. 50% on both sides cleanly separates "we're
  // refining the same stroke" from "we'd be jumping onto a new
  // stroke" / "we'd be ballooning past the original extent".
  //
  // Why no per-edge cap on resize-fit (v0.5.21): the ≥ 50%
  // bbox-interval overlap on BOTH sides is itself the geometric
  // proof that the new run shares the same stroke the bbox sits
  // on. A "wrong stroke" snap (neighbour-jump or runaway
  // extension) cannot satisfy both overlap halves: it either has
  // ~0% old-side overlap (entirely different x range) or its new
  // run is wider than ~2× the old (so new-side overlap drops
  // below 0.5). Either way it falls into the relocate branch,
  // where the strict 30pt cap still applies. With the cap
  // removed on resize-fit, `maxWidthRatio` (2.0× for resize-fit)
  // is the only thing keeping a single fragment from being
  // extended across a connected multi-segment underline; 2.0× is
  // tight enough to gate that — connected multi-segment runs
  // routinely measure 3–4× the original fragment width on dense
  // forms — while loose enough to absorb Gemini's observed
  // 33–45% width under-detection on real text fields.
  //
  // Real evidence motivating the cap removal: Print Name on the
  // v0.5.20 Ruby form had bbox `x=315.18, width=120.56`
  // (centre 375.46) but the actual underline starts ~235–245pt,
  // a -70 to -80pt left-edge delta. The bbox-interval overlap
  // was ~80%+ on both sides (resize-fit), but the v0.5.20 60pt
  // cap rejected it. With the cap gone, the snap fires; the
  // 2.0× width-ratio bound still rejects the case where the
  // run-walk escapes onto a connected adjacent fragment.
  const overlapLeft = Math.max(oldX, newX);
  const overlapRight = Math.min(oldRight, newRight);
  const overlapWidth = Math.max(0, overlapRight - overlapLeft);
  const overlapRatioOld = oldWidth > 0 ? overlapWidth / oldWidth : 0;
  const overlapRatioNew = newWidth > 0 ? overlapWidth / newWidth : 0;
  const isResizeToFit = overlapRatioOld >= 0.5 && overlapRatioNew >= 0.5;

  const mode: "resizeFit" | "relocate" = isResizeToFit
    ? "resizeFit"
    : "relocate";
  // Resize-fit gets a looser 2.0× width-ratio bound (hard-coded;
  // see module header for rationale). Relocate uses the option
  // default 1.5× — relocate is rare and stays conservative.
  const widthRatioCap = isResizeToFit ? 2.0 : opts.maxWidthRatio;

  // Cap 1: minWidthPoints — a run shorter than 12pt (default) is
  // probably under a label glyph that happens to intersect the
  // snap row, not a real underline. Real fillable underlines are
  // wider than this even for single-character entries. Applies
  // uniformly to both modes.
  if (newWidth < opts.minWidthPoints) {
    counts.hSkippedTooNarrow += 1;
    if (wantLog) {
      console.log(
        `[underlineSnap] field=${field.id} hSnap=skipped:too-narrow mode=${mode} (newWidth=${newWidth.toFixed(2)}pt < ${opts.minWidthPoints}pt)`
      );
    }
    return null;
  }

  // Cap 2a (v0.5.22): row-connector skip class. When the run-walk
  // traces a stroke MUCH wider than the bbox (newWidth > 2.5× the
  // old width), it almost always means we walked along a row
  // underline that spans multiple sibling fields without internal
  // separators — e.g. on the 204 Credit Card Authorization Form
  // the Billing Address row is one continuous stroke under
  // Address + City + State + Zip; same for Credit Card Number +
  // Exp Date + CVV and Name on Card + Email + Phone. v0.5.21
  // evidence: 16 fields on that form all rejected at the same
  // `newWidth ≈ 480pt` despite `oldWidth` ranging from 60 to
  // 130pt. That's a form-design signal worth surfacing
  // separately from "Gemini sized a single field too narrow"
  // (`hSkippedTooWide`). 2.5× sits well past every other active
  // cap (resize-fit 2.0× / relocate 1.5×), so anything that
  // trips this check would have tripped tooWide anyway — we
  // just classify it more informatively.
  //
  // Behavioural intent: SAME outcome as v0.5.21 (no x/width
  // change, field stays at Gemini's bbox), just routed through
  // a distinct counter and log line so the user can tell at a
  // glance "this form has connected row underlines" vs "Gemini
  // under-sized this individual field". A future v0.6.x could
  // try to bisect the connected run at sibling-field boundaries
  // (option B in the v0.5.22 design discussion); we don't
  // attempt that here because different forms use different
  // sub-division conventions (gap pixels, vertical separators,
  // label text in between) and getting it wrong would drag
  // bboxes across the wrong column boundary.
  //
  // Order: this cap fires BEFORE `hSkippedTooWide` so the more
  // specific row-connector classification wins on the
  // overlap. The `mode` (resizeFit/relocate) is logged for
  // completeness — connected rows almost always classify as
  // relocate (the new run barely overlaps the old bbox by
  // ratio) but the threshold doesn't depend on mode.
  const ROW_CONNECTOR_RATIO = 2.5;
  if (newWidth > oldWidth * ROW_CONNECTOR_RATIO) {
    counts.hSkippedRowConnector += 1;
    if (wantLog) {
      const ratio = oldWidth > 0 ? newWidth / oldWidth : 0;
      console.log(
        `[underlineSnap] field=${field.id} hSnap=skipped:rowConnector mode=${mode} runWidth=${newWidth.toFixed(2)}pt oldWidth=${oldWidth.toFixed(2)}pt ratio=${ratio.toFixed(2)}× (newWidth > ${ROW_CONNECTOR_RATIO.toFixed(1)}× oldWidth — stroke spans multiple sibling fields, leaving bbox at Gemini's extent)`
      );
    }
    return null;
  }

  // Cap 2: maxWidthRatio — a run more than `widthRatioCap` ×
  // (resize-fit 2.0× / relocate 1.5×) the original bbox width
  // almost certainly means the bbox was meant for a fragment of
  // a continuous row underline (e.g. a "Date" segment of a long
  // combined line). Extending across the whole row would overlap
  // adjacent fields and damage the layout. This is the single
  // active runaway-extent bound on resize-fit (v0.5.21 dropped
  // the per-edge cap on resize-fit, see classification block
  // above); it backstops both modes uniformly.
  //
  // v0.5.22: the more obvious "row connector" case
  // (newWidth > 2.5× oldWidth) is now caught above with a
  // dedicated counter and log line; this remains the catch-all
  // for the 1.5×–2.5× / 2.0×–2.5× band where the run is wider
  // than the field expects but not so much wider that the
  // row-connector heuristic is the more informative
  // classification.
  if (newWidth > oldWidth * widthRatioCap) {
    counts.hSkippedTooWide += 1;
    if (wantLog) {
      console.log(
        `[underlineSnap] field=${field.id} hSnap=skipped:too-wide mode=${mode} widthRatioCap=${widthRatioCap.toFixed(1)}× (newWidth=${newWidth.toFixed(2)}pt > ${(oldWidth * widthRatioCap).toFixed(2)}pt = ${widthRatioCap.toFixed(1)}× original ${oldWidth.toFixed(2)}pt)`
      );
    }
    return null;
  }

  // Cap 3: per-edge delta — RELOCATE ONLY (v0.5.21). Resize-fit
  // candidates skip this cap entirely; the ≥ 50% overlap rule is
  // itself proof we're on the same stroke (any wrong-stroke snap
  // — neighbour-jump or runaway extension — fails the overlap
  // rule and falls into the relocate branch). For relocate, a
  // run that pushes either edge past the strict 30pt default is
  // almost always the run-walk having escaped onto an adjacent
  // stroke, so we abort.
  if (mode === "relocate") {
    if (
      Math.abs(leftDeltaPt) > opts.maxHorizontalDeltaPoints ||
      Math.abs(rightDeltaPt) > opts.maxHorizontalDeltaPoints
    ) {
      counts.hSkippedTooFar += 1;
      if (wantLog) {
        console.log(
          `[underlineSnap] field=${field.id} hSnap=skipped:too-far mode=${mode} cap=${opts.maxHorizontalDeltaPoints}pt (leftΔ=${leftDeltaPt.toFixed(2)}pt rightΔ=${rightDeltaPt.toFixed(2)}pt > ±${opts.maxHorizontalDeltaPoints}pt, overlapOld=${overlapRatioOld.toFixed(2)} overlapNew=${overlapRatioNew.toFixed(2)})`
        );
      }
      return null;
    }
  }

  if (isResizeToFit) {
    counts.hSnappedResizeFit += 1;
  } else {
    counts.hSnappedRelocate += 1;
  }
  if (wantLog) {
    console.log(
      `[underlineSnap] field=${field.id} hSnap=snapped mode=${mode} widthRatioCap=${widthRatioCap.toFixed(1)}× (x: ${oldX.toFixed(2)}→${newX.toFixed(2)}pt [Δ=${leftDeltaPt.toFixed(2)}pt], width: ${oldWidth.toFixed(2)}→${newWidth.toFixed(2)}pt, right: ${oldRight.toFixed(2)}→${newRight.toFixed(2)}pt [Δ=${rightDeltaPt.toFixed(2)}pt], overlapOld=${overlapRatioOld.toFixed(2)} overlapNew=${overlapRatioNew.toFixed(2)}, runPx=[${run.leftPx},${run.rightPx}])`
    );
  }

  return { x: newX, width: newWidth };
}

/**
 * v0.5.25 — text-row fallback eligibility. The fallback runs only on
 * text-typed fields (the outer `fieldType !== "text"` guard already
 * excludes checkboxes / option-groups before this is consulted) and
 * skips signatures. Signatures often sit above an EXTENSIBLE printed
 * line that may or may not have a corresponding text-layer baseline;
 * aligning them to a text row would force-clamp the writable area,
 * negating the user-extensible nature of signature lines.
 *
 * Multiline kinds reach this point too (the snap currently early-
 * returns on multiline, but the fallback gate stays open in case a
 * future revision allows multiline to pass), so we accept them
 * explicitly.
 */
function isTextRowEligible(field: TemplateField): boolean {
  if (field.fieldKind === "signature") return false;
  if (field.fieldKind === "option-group") return false;
  return true;
}

/**
 * v0.5.25 — text-row fallback. Find the text row whose baseline
 * `yBottom` is closest to the field's current `bbox_bottom`, within
 * `textRowMaxDeltaPoints` of the field. Filter to rows whose
 * horizontal extent overlaps the field's `x` range by at least
 * `textRowMinHorizontalOverlap × field.width`. If a candidate is
 * found, return the corrected `y` so `bbox_bottom = row.yBottom`.
 *
 * Returns `null` if:
 *   - The field is not eligible (signature, option-group).
 *   - No text rows are available on this page.
 *   - No text row is within the vertical / horizontal-overlap
 *     gates.
 *
 * The caller is responsible for incrementing the appropriate
 * counter and logging.
 */
function tryTextRowSnap(
  field: TemplateField,
  render: PageRender,
  opts: Required<SnapOptions>,
  wantLog: boolean
): { newY: number; row: { yBottom: number; xMin: number; xMax: number } } | null {
  if (!isTextRowEligible(field)) return null;
  const textRows = render.textRows;
  if (!Array.isArray(textRows) || textRows.length === 0) return null;

  const fieldBottom = field.y + field.height;
  const fieldLeft = field.x;
  const fieldRight = field.x + field.width;
  const fieldWidth = Math.max(1, field.width);

  let best: { row: typeof textRows[number]; absDelta: number } | null = null;
  for (const row of textRows) {
    const absDelta = Math.abs(row.yBottom - fieldBottom);
    if (absDelta > opts.textRowMaxDeltaPoints) continue;
    const overlapLeft = Math.max(fieldLeft, row.xMin);
    const overlapRight = Math.min(fieldRight, row.xMax);
    const overlap = Math.max(0, overlapRight - overlapLeft);
    if (overlap / fieldWidth < opts.textRowMinHorizontalOverlap) continue;
    if (!best || absDelta < best.absDelta) {
      best = { row, absDelta };
    }
  }

  if (!best) return null;

  const newY = best.row.yBottom - field.height;
  const deltaY = newY - field.y;
  if (wantLog) {
    console.log(
      `[underlineSnap] field=${field.id} page=${field.pageNumber} result=snapped-text-row deltaY=${deltaY.toFixed(2)}pt textRowY=${best.row.yBottom.toFixed(2)} (no stroke nearby; aligned to text baseline; |Δ|=${best.absDelta.toFixed(2)}pt ≤ ${opts.textRowMaxDeltaPoints}pt)`
    );
  }
  return { newY, row: best.row };
}

/**
 * Vertical-underline snap, one field at a time. See module header
 * for the full algorithm rationale; comments inline annotate each
 * step of the pipeline. v0.5.19 layers a horizontal snap on top:
 * after the vertical snap fires (Step 8), {@link tryHorizontalSnap}
 * traces the chosen stroke's row to refine `x`/`width`. The
 * vertical pipeline is unchanged — every threshold, gate, and
 * snap-target equation is preserved verbatim from v0.5.18. v0.5.25
 * adds a {@link tryTextRowSnap} fallback that runs when the stroke
 * search reports `skipped:no-stroke`, aligning `bbox_bottom` to the
 * baseline of the nearest text row in the PDF text layer.
 */
function snapOneField(
  field: TemplateField,
  pageRenders: Record<number, PageRender>,
  opts: Required<SnapOptions>,
  counts: SnapCounts
): TemplateField {
  const wantLog = verboseLogEnabled(opts);

  // Step 1: only snap text-typed fields. Checkboxes don't have a
  // single underline to snap to (a checkbox glyph we shifted
  // vertically would no longer cover the box).
  if (field.fieldType !== "text") {
    counts.skippedNonText += 1;
    return field;
  }
  // We additionally exclude `multiline` field-kinds — they cover
  // tall regions with no single underline, and the closest stroke
  // is often far from the bbox center, so a snap would drag the
  // whole region off its intended writable area.
  //
  // v0.5.13: signatures ARE now eligible. A signature line is a
  // horizontal stroke just like a text underline; the same snap
  // produces the visually-correct placement (v0.5.16 anchor:
  // bbox_bottom on stroke). The `verticalNeighborMax`,
  // `scoreThreshold`, and ambiguity guards still apply unchanged —
  // false positives on signature rows would be filtered the same
  // way they are for text rows.
  //
  // v0.5.25: option-group fields ARE NOT eligible. Their option
  // sub-bboxes are already locked to label positions (no underline
  // stroke to snap to); the parent rect's `fieldType` is
  // `"option-group"` so this `fieldType !== "text"` check above
  // already handles them — this block is for kind-only safety.
  if (field.fieldKind === "multiline" || field.fieldKind === "option-group") {
    counts.skippedNonText += 1;
    return field;
  }

  // Step 2: if we don't have a render for this page (shouldn't happen
  // in production but defensive against future plumbing changes),
  // pass through untouched.
  const render = pageRenders[field.pageNumber];
  if (!render) {
    counts.skippedNoPage += 1;
    return field;
  }

  const pixelsPerPoint = 1 / Math.max(1e-6, render.pdfPointsPerPixel);

  // Step 3: convert the bbox into image-pixel space. We need the
  // horizontal range (to compute per-row stroke scores) and the
  // vertical center (to anchor the search band).
  const bboxLeftPx = field.x * pixelsPerPoint;
  const bboxRightPx = (field.x + field.width) * pixelsPerPoint;
  const bboxCenterYPx = (field.y + field.height / 2) * pixelsPerPoint;

  // Step 4: define the search band. searchRangePx scales
  // searchRangePoints into pixels so the band is consistent at any
  // render DPI.
  const searchRangePx = opts.searchRangePoints * pixelsPerPoint;
  const minRow = Math.max(0, Math.floor(bboxCenterYPx - searchRangePx));
  const maxRow = Math.min(
    render.height - 1,
    Math.ceil(bboxCenterYPx + searchRangePx)
  );
  if (maxRow < minRow) {
    counts.skippedNoPage += 1;
    return field;
  }

  // Step 5: scan every row in the band and collect candidates that
  // pass BOTH the score threshold AND the vertical-thinness gate.
  // The thinness gate is the v0.5.7 fix, sharpened in v0.5.10: a
  // real horizontal stroke is 1-3 image pixels tall plus 1-2 px of
  // anti-alias blur on each side, so the rows ±5 px around it are
  // mostly light (background) pixels. Glyph rows belonging to label
  // text span ~10-25 px vertically, so their ±5-px neighbours are
  // also dark and they're rejected here. `rowStrokeScore` already
  // returns 0 for out-of-bounds rows, so neighbour rows that fall
  // off the page edge automatically pass (a missing neighbour is
  // "light").
  const candidates: StrokeCandidate[] = [];
  let highestScore = 0;
  for (let row = minRow; row <= maxRow; row += 1) {
    const score = rowStrokeScore(
      render.imageData,
      row,
      bboxLeftPx,
      bboxRightPx,
      opts.darkLuminance
    );
    if (score > highestScore) highestScore = score;
    if (score < opts.scoreThreshold) continue;

    const above = rowStrokeScore(
      render.imageData,
      row - THINNESS_NEIGHBOR_OFFSET_PX,
      bboxLeftPx,
      bboxRightPx,
      opts.darkLuminance
    );
    const below = rowStrokeScore(
      render.imageData,
      row + THINNESS_NEIGHBOR_OFFSET_PX,
      bboxLeftPx,
      bboxRightPx,
      opts.darkLuminance
    );
    if (above >= opts.verticalNeighborMax) continue;
    if (below >= opts.verticalNeighborMax) continue;

    candidates.push({ row, score });
  }

  if (candidates.length === 0) {
    // v0.5.25 — text-row fallback (vertical-only). Some forms render
    // a label like `Expiration Date (MM/YY)` with NO printed
    // underline next to it; the user just writes after the label.
    // Gemini's bbox is its best guess at where the typed text will
    // sit, but Gemini routinely places it visibly low because there
    // is no stroke to anchor on. The fallback aligns
    // `bbox_bottom` to the baseline of the nearest text row in the
    // PDF text layer.
    //
    // Conservative: only runs on text/multiline/date kinds. Signatures
    // are excluded — signature fields often sit above an extensible
    // line that may or may not exist; aligning them to a text-row
    // baseline can constrict the writable area.
    const textRowResult = tryTextRowSnap(field, render, opts, wantLog);
    if (textRowResult) {
      counts.textRowSnapped += 1;
      return { ...field, y: textRowResult.newY };
    }

    if (
      Array.isArray(render.textRows) &&
      render.textRows.length > 0 &&
      isTextRowEligible(field)
    ) {
      counts.textRowNoMatch += 1;
      if (wantLog) {
        console.log(
          `[underlineSnap] field=${field.id} page=${field.pageNumber} result=skipped:no-stroke-no-text-row deltaY=0.00pt strokeRow=-1 (highestScore=${highestScore.toFixed(2)} < ${opts.scoreThreshold}; no text row within ±${opts.textRowMaxDeltaPoints}pt with ≥${(opts.textRowMinHorizontalOverlap * 100).toFixed(0)}% overlap)`
        );
      }
    } else {
      counts.noStroke += 1;
      if (wantLog) {
        logDecision(
          field,
          "skipped:no-stroke",
          0,
          -1,
          `(highestScore=${highestScore.toFixed(2)} < ${opts.scoreThreshold} or failed thinness gate)`
        );
      }
    }
    return field;
  }

  // Step 6: pick the candidate whose row is CLOSEST to the bbox
  // center (not the highest-scoring one). Among true strokes,
  // "the model probably wanted this one" almost always means
  // "the nearest one" — the model is usually within a few pt of
  // the right field, and a slightly thicker or darker stroke
  // elsewhere shouldn't outweigh proximity.
  const ranked = candidates
    .map((c) => ({ ...c, distPx: Math.abs(c.row - bboxCenterYPx) }))
    .sort((a, b) => a.distPx - b.distPx);
  const best = ranked[0];

  // Step 7: smarter ambiguity guard. With the thinness gate every
  // qualifying row is a real stroke, so two candidates > 8pt apart
  // typically means a boxed field with both a top and a bottom
  // border — and the model's bbox center will be closer to one of
  // them, so we trust that proximity. We only skip when there's a
  // SECOND candidate whose distance from center matches the best
  // within ±1pt (genuinely equidistant, no proximity signal) AND
  // it's > ambiguityGapPoints away vertically (so the two candidates
  // really are on different lines, not just a thick stroke spanning
  // 2-3 rows).
  for (let i = 1; i < ranked.length; i += 1) {
    const cand = ranked[i];
    const distDiffPt =
      (cand.distPx - best.distPx) * render.pdfPointsPerPixel;
    const verticalGapPt =
      Math.abs(cand.row - best.row) * render.pdfPointsPerPixel;
    if (
      distDiffPt <= AMBIGUITY_DISTANCE_TOLERANCE_PT &&
      verticalGapPt > opts.ambiguityGapPoints
    ) {
      counts.ambiguous += 1;
      if (wantLog) {
        logDecision(
          field,
          "skipped:ambiguous",
          0,
          best.row,
          `(equidistant pair |Δdist|=${distDiffPt.toFixed(2)}pt, gap=${verticalGapPt.toFixed(1)}pt > ${opts.ambiguityGapPoints}pt)`
        );
      }
      return field;
    }
  }

  // Step 8: compute the snap delta. We move the bbox so its BOTTOM
  // EDGE sits exactly on the chosen stroke row —
  // `bbox_bottom == strokeRow` (text-baseline geometry: the user's
  // typed text will sit ABOVE the line, the way printed letters sit
  // on a baseline). The snap target equation `strokeRow - height` is
  // unchanged from v0.5.16; v0.5.16 bottom-of-form evidence proved
  // it's the geometrically right anchor.
  //
  // What CHANGED in v0.5.18: the detection-time pre-shift in
  // `geminiFieldDetector.ts` was REMOVED. With the v0.5.16 prompt
  // rule placing Gemini's `raw_y = stroke - height` and this snap
  // targeting the same anchor, any pre-shift is redundant AND
  // drags Step 5's row-search center off the real stroke. With the
  // pre-shift gone, the search center sits at `field.y + height/2 =
  // stroke - height/2` — half a height BELOW the real stroke, with
  // ~16pt of separation from the row-above stroke on typical 22pt
  // line spacing. Snapped and unsnapped paths now converge on
  // `bbox_bottom == strokeRow` by construction (the v0.5.16 design
  // intent without v0.5.16's search-center drift).
  //
  // Math trace (v0.5.18, upper-section field, raw_y=712.68, h=12,
  // intended stroke at 724.68, prior-row stroke at 702.68):
  //   field.y (no pre-shift)            = 712.68
  //   snap search center (Step 3)       = 718.68
  //   distance to intended stroke       = 6   ← closest, picked ✅
  //   distance to row-above stroke      = 16  (rejected)
  //   newY = 724.68 - 12                = 712.68
  //   bbox_bottom                       = 724.68 == intended stroke ✅
  // Compare v0.5.17 on the same field (had `-height/2` pre-shift,
  // didn't realize Gemini was now placing bbox_bottom on stroke):
  //   field.y (after -h/2)              = 706.68
  //   snap search center                = 712.68
  //   distance to intended (724.68)     = 12
  //   distance to row-above (702.68)    = 10  ← closest, picked ❌
  //   newY                              = 690.68 → wrong row.
  //
  // Cap absolute movement at maxSnapPoints — anything bigger is
  // almost certainly the model having found a totally different
  // feature, in which case dragging the bbox onto it would damage
  // rather than fix the detection. The cap gates the snap delta
  // only. With the v0.5.18 no-shift pre-shift, accurate detections
  // produce a snap delta of ≈ 0 (Gemini's `raw_y` is already on
  // the bottom-on-stroke target); only stroke-jitter or off-by-a-
  // pixel cases produce non-trivial deltas, all well within
  // `maxSnapPoints` for typical 10-18pt heights.
  const strokeYPt = best.row * render.pdfPointsPerPixel;
  const newY = strokeYPt - field.height;
  const deltaPt = newY - field.y;

  if (Math.abs(deltaPt) > opts.maxSnapPoints) {
    counts.tooFar += 1;
    if (wantLog) {
      logDecision(
        field,
        "skipped:too-far",
        deltaPt,
        best.row,
        `(|Δ|=${Math.abs(deltaPt).toFixed(2)}pt > ${opts.maxSnapPoints}pt)`
      );
      // Near-miss diagnostic (v0.5.10): if a candidate passed the
      // thinness gate and is rejected for being JUST over the cap
      // (within 1.25× of `maxSnapPoints`), surface a warning so
      // future "still not aligned" reports can quickly tell whether
      // the cap is the bottleneck (warn fires) or the candidate
      // filter is (no warn). Gated on verbose+DEV like the per-field
      // logs above.
      const absDeltaPt = Math.abs(deltaPt);
      if (absDeltaPt <= opts.maxSnapPoints * 1.25) {
        console.warn(
          `[underlineSnap] near-miss: field=${field.id} page=${field.pageNumber} deltaY=${absDeltaPt.toFixed(2)}pt cap=${opts.maxSnapPoints}pt — consider tuning`
        );
      }
    }
    return field;
  }

  counts.snapped += 1;
  if (wantLog) {
    logDecision(
      field,
      "snapped",
      deltaPt,
      best.row,
      `(score=${best.score.toFixed(2)}, candidates=${candidates.length})`
    );
  }

  // v0.5.19: horizontal snap. Runs only on fields that just
  // successfully snapped vertically (above), using `best.row` as
  // the chosen stroke row. Returns `null` if any of the four skip
  // gates trips, in which case x/width pass through untouched.
  // Vertical y is unaffected either way.
  const hResult = tryHorizontalSnap(
    field,
    render,
    best.row,
    opts,
    counts,
    wantLog
  );

  if (hResult) {
    return { ...field, x: hResult.x, y: newY, width: hResult.width };
  }
  // Vertical-only snap (v0.5.18 behaviour): preserve every other
  // property — we only touch `y`.
  return { ...field, y: newY };
}

/**
 * Snap text-field bboxes onto the nearest underline stroke (per the
 * conservative algorithm in this module's header). Returns a NEW
 * array; never mutates `fields` or any individual `TemplateField`.
 *
 * This function is intentionally pure-deterministic given the same
 * inputs and options, so a Pass-1 + snap run produces identical
 * coordinates on every replay.
 */
export function snapFieldsToUnderlines(
  fields: TemplateField[],
  pageRenders: Record<number, PageRender>,
  options: SnapOptions = {}
): TemplateField[] {
  const opts: Required<SnapOptions> = { ...DEFAULT_OPTIONS, ...options };

  const counts: SnapCounts = {
    total: fields.length,
    snapped: 0,
    noStroke: 0,
    ambiguous: 0,
    tooFar: 0,
    skippedNonText: 0,
    skippedNoPage: 0,
    textRowSnapped: 0,
    textRowNoMatch: 0,
    hSnappedResizeFit: 0,
    hSnappedRelocate: 0,
    hSkippedNoStroke: 0,
    hSkippedTooFar: 0,
    hSkippedTooNarrow: 0,
    hSkippedTooWide: 0,
    hSkippedRowConnector: 0,
  };

  const out = fields.map((f) => snapOneField(f, pageRenders, opts, counts));

  // The eligible-text-field count is what the user-facing summary
  // line cares about: of all the text-fields we COULD have snapped,
  // how many did we actually move?
  const textConsidered =
    counts.total - counts.skippedNonText - counts.skippedNoPage;

  // v0.5.19 — append horizontal-snap counters after the vertical
  // ones, separated by `|` for grep-friendliness. The horizontal
  // snap can only fire on fields that successfully snapped
  // vertically, so its denominator is `counts.snapped` (NOT
  // `textConsidered`). Ratios above sum to ≤ snapped because
  // signatures pass through the horizontal stage without
  // incrementing any horizontal counter.
  // v0.5.20 — break out the snapped total into resize-fit vs
  // relocate (overlap-aware cap classification). A reader can
  // tell at a glance how many snaps were the "refining the same
  // stroke" case vs the rarer "moving onto a new stroke" case;
  // an unexpectedly high relocate count is a signal to inspect
  // the per-field log.
  const hSnappedTotal =
    counts.hSnappedResizeFit + counts.hSnappedRelocate;
  // v0.5.22 — surface `hSkippedRowConnector` next to the other
  // horizontal skip counters. Connected row underlines (one
  // stroke spanning multiple sibling fields) are common enough
  // on dense forms — 16 fields on the 204 Credit Card
  // Authorization Form trip it — that lumping them with
  // `hSkippedTooWide` was hiding a real form-design pattern.
  // The order of the skip counters mirrors the order of the
  // checks in `tryHorizontalSnap` so a reader can match the
  // summary back to the per-field decisions.
  // v0.5.25 — surface `textRowSnapped` and `textRowNoMatch` next to
  // the existing `noStroke` counter. Together they account for every
  // field where the stroke search reported `skipped:no-stroke`:
  //   - `textRowSnapped`: text-row fallback fired (bbox aligned to
  //     baseline of nearest text row in the PDF text layer).
  //   - `noStroke`: still skipped (signature, no eligible text row,
  //     or text rows missing on this page).
  //   - `textRowNoMatch`: eligible field with text rows present but
  //     none within the gate (vertical Δ ≤ textRowMaxDeltaPoints AND
  //     horizontal-overlap ≥ textRowMinHorizontalOverlap).
  console.log(
    `[underlineSnap] snapped ${counts.snapped}/${textConsidered} text fields, skipped ${counts.noStroke} (no stroke), ${counts.ambiguous} (ambiguous), ${counts.tooFar} (too far)` +
      (counts.textRowSnapped > 0 || counts.textRowNoMatch > 0
        ? ` — text-row fallback ${counts.textRowSnapped} snapped, ${counts.textRowNoMatch} no-match`
        : "") +
      (counts.skippedNonText > 0 || counts.skippedNoPage > 0
        ? ` — ignored ${counts.skippedNonText} non-text + ${counts.skippedNoPage} unrendered`
        : "") +
      ` | hSnap ${hSnappedTotal}/${counts.snapped} (${counts.hSnappedResizeFit} fit, ${counts.hSnappedRelocate} relocate), hSkipped ${counts.hSkippedNoStroke} (no stroke), ${counts.hSkippedTooFar} (too far), ${counts.hSkippedTooNarrow} (too narrow), ${counts.hSkippedTooWide} (too wide), ${counts.hSkippedRowConnector} (row connector)`
  );

  return out;
}
