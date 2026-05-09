/**
 * Vertical-underline snap (v0.5.15).
 *
 * Deterministic post-processor that nudges Gemini-detected text-field
 * bboxes so their CENTER LINE sits exactly on the writable underline
 * stroke actually drawn on the page (`bbox_center == strokeRow`).
 * Runs AFTER `mapToTemplateField` and the dedup pass, so it operates
 * on already-trusted detections — we never use this to invent or
 * drop fields, only to shift `y` by a few points when there is
 * strong geometric evidence of a stroke within the search band.
 *
 * v0.5.15 — paired with a height-aware detection-time correction in
 * `geminiFieldDetector.ts`. Snapped and unsnapped text-on-a-line
 * fields converge on the same target by construction:
 *   - SNAPPED (this file): newY = strokeRow - height/2,
 *     i.e. `bbox_center == strokeRow`.
 *   - UNSNAPPED (mapToTemplateField pre-shift): rect.y -= height/2.
 *     Gemini's raw bbox sits with `bbox_top ≈ strokeRow`, so after
 *     the shift `bbox_center ≈ strokeRow` — the same target.
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
 *   the constant with `height/2` so the geometry is self-aligning.
 *
 * Signatures are snap-eligible (added in v0.5.13) and receive the
 * detection-time `-height/2` shift, so a Cardholder Signature snaps
 * to its line whether or not the snap finds the underline.
 *
 * Why this exists:
 *   The v0.5.3 prompt rule and Pass-2 audit rule 4b ask the model to
 *   self-verify vertical centering on the underline. The model can
 *   describe the rule but does not measure pixels reliably at sub-pt
 *   precision, so several real fields still ship sitting visibly
 *   above or below the line they're meant to write on. This snap
 *   does the measurement deterministically.
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
   * If true AND the build is in development mode (`import.meta.env.DEV`),
   * log per-field snap decisions to the console. Used by the
   * detector's diagnostic dumps and ignored in production builds so
   * shipping bundles stay quiet.
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
 */
interface SnapCounts {
  total: number;
  snapped: number;
  noStroke: number;
  ambiguous: number;
  tooFar: number;
  skippedNonText: number;
  skippedNoPage: number;
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
 * are gated by BOTH the `verbose` option AND the build mode so
 * that production bundles are silent regardless of how the option
 * is plumbed through.
 */
function verboseLogEnabled(opts: Required<SnapOptions>): boolean {
  if (!opts.verbose) return false;
  // Vite injects `import.meta.env.DEV` as a boolean literal at
  // build time; in production builds the whole branch tree-shakes
  // away, which is exactly what we want.
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
 * Vertical-underline snap, one field at a time. See module header
 * for the full algorithm rationale; comments inline annotate each
 * step of the pipeline.
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
  // produces the visually-correct placement (bbox center on the
  // stroke). The `verticalNeighborMax`, `scoreThreshold`, and
  // ambiguity guards still apply unchanged — false positives on
  // signature rows would be filtered the same way they are for
  // text rows.
  if (field.fieldKind === "multiline") {
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

  // Step 8: compute the snap delta. We move the bbox so its CENTER
  // sits exactly on the chosen stroke row — `bbox_center == strokeRow`.
  // This is the user's visual target ("perfect" in the v0.5.10 user
  // report) and is what the v0.5.10 snap was already doing for the
  // fields it caught. v0.5.11 briefly subtracted a flat 5pt bias
  // here to push the bbox above the stroke; that over-corrected the
  // already-correct snapped fields. v0.5.13 reverted to center-on-
  // stroke. v0.5.15's detection-time `-height/2` shift in
  // `geminiFieldDetector.ts` handles UNSNAPPED fields, converging
  // on the same target.
  //
  // Cap absolute movement at maxSnapPoints — anything bigger is
  // almost certainly the model having found a totally different
  // feature, in which case dragging the bbox onto it would damage
  // rather than fix the detection. The cap gates the snap delta
  // only; it doesn't see the detection-time -height/2 that already
  // happened during `mapToTemplateField` (which is fine — that's an
  // independent post-processing layer applied before the snap; with
  // the v0.5.15 height-aware shift, the snap delta is typically near
  // zero on accurate detections, since both targets coincide).
  const newCenterYPt = best.row * render.pdfPointsPerPixel;
  const newY = newCenterYPt - field.height / 2;
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

  // Preserve every other property — we only touch `y`.
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
  };

  const out = fields.map((f) => snapOneField(f, pageRenders, opts, counts));

  // The eligible-text-field count is what the user-facing summary
  // line cares about: of all the text-fields we COULD have snapped,
  // how many did we actually move?
  const textConsidered =
    counts.total - counts.skippedNonText - counts.skippedNoPage;

  console.log(
    `[underlineSnap] snapped ${counts.snapped}/${textConsidered} text fields, skipped ${counts.noStroke} (no stroke), ${counts.ambiguous} (ambiguous), ${counts.tooFar} (too far)` +
      (counts.skippedNonText > 0 || counts.skippedNoPage > 0
        ? ` — ignored ${counts.skippedNonText} non-text + ${counts.skippedNoPage} unrendered`
        : "")
  );

  return out;
}
