/**
 * Vertical-underline snap (v0.5.5).
 *
 * Deterministic post-processor that nudges Gemini-detected text-field
 * bboxes so their CENTER LINE sits on the writable underline stroke
 * actually drawn on the page. Runs AFTER `mapToTemplateField` and the
 * dedup pass, so it operates on already-trusted detections — we
 * never use this to invent or drop fields, only to shift `y` by a
 * few points when there is strong geometric evidence of a stroke
 * within the search band.
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
 *   when (a) the field is already a text field, (b) we find a
 *   single, unambiguous, mostly-bbox-wide horizontal dark run within
 *   ±12pt of the bbox center, and (c) the snap delta is ≤ 8pt.
 *   Otherwise we leave the field alone.
 *
 * The snap is a no-op for checkboxes, signatures, and multilines —
 * those don't have a single underline to snap to and snapping a
 * multiline (whose center is far from any one stroke) would be
 * actively destructive.
 *
 * All thresholds (search range, dark luminance, score, ambiguity gap,
 * max snap) are tunable per-call via the options bag; the defaults
 * are the values we ship with.
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
   * boundaries. Default: 8pt.
   */
  maxSnapPoints?: number;
  /**
   * Half-height of the search band, in PDF points, scanned above
   * AND below the bbox center for an underline stroke. ~12pt is one
   * line height — generous enough to find an offset line, narrow
   * enough not to cross-jump to another field's underline.
   * Default: 12pt.
   */
  searchRangePoints?: number;
  /**
   * Minimum stroke score (longest contiguous dark-pixel run divided
   * by bbox width) for a row to qualify as the underline. Default:
   * 0.6 — a stroke must cover at least 60 % of the bbox width to
   * count.
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
   * If two qualifying rows are more than this many points apart
   * vertically, treat the field as ambiguous (probably a boxed
   * region with top + bottom borders, or two adjacent line items)
   * and skip the snap. Default: 6pt.
   */
  ambiguityGapPoints?: number;
  /**
   * If true, log per-field snap decisions to the console. Used by
   * the detector's diagnostic dumps and ignored in normal builds.
   */
  verbose?: boolean;
}

const DEFAULT_OPTIONS: Required<SnapOptions> = {
  maxSnapPoints: 8,
  searchRangePoints: 12,
  scoreThreshold: 0.6,
  darkLuminance: 80,
  ambiguityGapPoints: 6,
  verbose: false,
};

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
 * Compute the longest contiguous dark-pixel run on a single image
 * row, restricted to the column range `[leftCol, rightCol]`. The
 * run length is allowed to span small (≤ 2 px) light gaps — PDF
 * underlines are anti-aliased and can show 1-2 lighter pixels in the
 * middle of an otherwise solid stroke; treating those as
 * disqualifying gaps would cause us to miss real strokes.
 *
 * Returns the run length divided by the bbox width (the "stroke
 * score"). 1.0 means the bbox is fully covered by a continuous dark
 * stroke; 0 means no dark pixels at all.
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
  // Step 1: only snap text-typed fields. Checkboxes, signatures, and
  // multilines either don't have a single underline (signatures often
  // sit above a long line that may or may not be visible; multilines
  // span big regions) or shouldn't be moved at all (a checkbox glyph
  // we shifted vertically would no longer cover the box).
  if (field.fieldType !== "text") {
    counts.skippedNonText += 1;
    return field;
  }
  // We additionally exclude `multiline` and `signature` field-kinds —
  // both are typed as `text` in `fieldType` but their rendering
  // semantics expect a tall region or a separate underline stroke
  // that lives below a printed name line, not the centred-on-stroke
  // layout typed-text uses.
  if (field.fieldKind === "multiline" || field.fieldKind === "signature") {
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

  // Step 4: define the search band. searchRangePx scales 12pt into
  // pixels so the band is one line-height tall regardless of the
  // page's render DPI.
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

  // Step 5: scan every row in the band, score each, remember the
  // best-scoring row, and collect every row that cleared the
  // threshold (those drive the ambiguity check below).
  let bestRow = -1;
  let bestScore = 0;
  const qualifyingRows: number[] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    const score = rowStrokeScore(
      render.imageData,
      row,
      bboxLeftPx,
      bboxRightPx,
      opts.darkLuminance
    );
    if (score >= opts.scoreThreshold) {
      qualifyingRows.push(row);
    }
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  if (bestRow < 0 || bestScore < opts.scoreThreshold) {
    counts.noStroke += 1;
    if (opts.verbose) {
      console.log(
        `[underlineSnap] field=${field.id} (${field.label}) no stroke (best score ${bestScore.toFixed(2)} < ${opts.scoreThreshold})`
      );
    }
    return field;
  }

  // Step 6: ambiguity guard. If two qualifying rows are more than
  // ambiguityGapPoints apart vertically, we're probably looking at
  // a boxed region (top + bottom borders) or two adjacent strokes —
  // either way, we don't know which one to snap to, so we leave the
  // field where Gemini placed it.
  if (qualifyingRows.length >= 2) {
    const spreadPx =
      qualifyingRows[qualifyingRows.length - 1] - qualifyingRows[0];
    const spreadPt = spreadPx * render.pdfPointsPerPixel;
    if (spreadPt > opts.ambiguityGapPoints) {
      counts.ambiguous += 1;
      if (opts.verbose) {
        console.log(
          `[underlineSnap] field=${field.id} (${field.label}) ambiguous (${qualifyingRows.length} qualifying rows spanning ${spreadPt.toFixed(1)}pt > ${opts.ambiguityGapPoints}pt)`
        );
      }
      return field;
    }
  }

  // Step 7: compute the snap delta. We move the bbox so its CENTER
  // sits on the strongest stroke row. Cap absolute movement at
  // maxSnapPoints — anything bigger is almost certainly the model
  // having found a totally different feature, in which case dragging
  // the bbox onto it would damage rather than fix the detection.
  const newCenterYPt = bestRow * render.pdfPointsPerPixel;
  const newY = newCenterYPt - field.height / 2;
  const deltaPt = newY - field.y;

  if (Math.abs(deltaPt) > opts.maxSnapPoints) {
    counts.tooFar += 1;
    if (opts.verbose) {
      console.log(
        `[underlineSnap] field=${field.id} (${field.label}) too-far (delta=${deltaPt.toFixed(2)}pt > ±${opts.maxSnapPoints}pt)`
      );
    }
    return field;
  }

  counts.snapped += 1;
  if (opts.verbose) {
    console.log(
      `[underlineSnap] field=${field.id} (${field.label}) snapped Δy=${deltaPt.toFixed(2)}pt (score=${bestScore.toFixed(2)}, row=${bestRow}, qualifying=${qualifyingRows.length})`
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
