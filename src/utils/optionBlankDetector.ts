/**
 * v0.5.36 — option-group "underline blank" detector.
 *
 * Some forms render an option-group selector as `___ Visa  ___
 * Mastercard  ___ Amex  ___ Discover` — each label preceded by a
 * short writable underline that the user is meant to mark with an
 * X (rather than circling the label, which is the convention this
 * codebase already supports via the v0.5.25 hand-drawn-oval render
 * path). When that's the layout, the canvas review and the filled
 * PDF should draw an X centred on the blank instead of an oval
 * around the label — matching how a human would mark the form.
 *
 * Detection runs once per detection pipeline pass (see
 * `geminiFieldDetector.ts`), AFTER `snapFieldsToUnderlines` so the
 * option-group field's `options[i].bbox` rects already sit at their
 * final, snap-corrected coordinates. For each option-group field
 * we scan a small region IMMEDIATELY to the LEFT of each option's
 * label bbox, looking for a horizontal dark-pixel stroke that fits
 * the `___` profile (short, thin, mostly-light rows above and
 * below). When one is found we record:
 *   - `hasUnderlineBlank = true` on that option.
 *   - `blankRect`: the rectangle the renderer should target, sized
 *     so the X sits ABOVE the stroke (text-baseline geometry — same
 *     convention as the v0.5.16+ `bbox_bottom == strokeRow` snap).
 *
 * The detection is per-option, NOT per-field: malformed groups
 * commonly mix styles (e.g. four options with `___` blanks plus a
 * fifth `Other` with no leading blank). Each option carries its own
 * boolean so the renderer can branch independently.
 *
 * Conservative by design — we never invent a blank for an option
 * that has none. If detection is uncertain, the option keeps
 * `hasUnderlineBlank = false` and the renderer falls back to the
 * v0.5.25 circle-around-label rendering. The cost of a missed
 * blank is "renders a circle instead of an X" (still correct under
 * the prior interpretation); the cost of a false positive is "an
 * X appears next to a label that has no blank" (visually wrong),
 * so the asymmetry argues for high precision over high recall.
 *
 * Out of scope (v0.5.36): single-stroke selectors like
 * `Type: ___ Visa  Mastercard  Amex` where ONE underline serves
 * the whole group. The per-option search would find the same
 * stroke for every option (hit different fragments of it), which
 * would render multiple Xs along a single shared blank — wrong.
 * Detection skips the option-group entirely when fewer than half
 * its options have detectable per-option blanks (heuristic gate
 * for "this is probably a single-shared-stroke group").
 */

import type { FieldOption, TemplateField } from "@/types";
import type { PageRender } from "@/utils/underlineSnap";

export interface OptionBlankDetectorOptions {
  /**
   * How far LEFT of each option's label bbox to search for a
   * preceding underline, in PDF user-space points. Captures both
   * tight `___ Visa` (≈ 12pt of stroke + 2pt gap) and looser
   * `_______ Visa` (≈ 30pt + gap). 50pt absorbs the looser case
   * with margin without bleeding into the previous option's label
   * (typical inter-option spacing on US-Letter card-type rows is
   * 60-90pt label-to-label, so 50pt of left-lookback stops well
   * before the prior label).
   *
   * Default: 50pt.
   */
  lookbackPoints?: number;

  /**
   * Vertical search half-band, in PDF user-space points. The
   * underline stroke for `___ Visa` typically sits at the printed
   * baseline of "Visa" — the same y as the bottom of the label
   * bbox (since the label bbox is a tight crop around the printed
   * text). Real strokes drift ±3-4pt from the exact baseline on
   * dense forms; 6pt absorbs that drift while still rejecting
   * strokes from rows above or below.
   *
   * Default: 6pt.
   */
  verticalBandPoints?: number;

  /**
   * Luminance below which a pixel is treated as "dark" (part of a
   * stroke). Same Y = 0.299R + 0.587G + 0.114B threshold the
   * underline-snap uses (`darkLuminance: 80`). 80 cleanly catches
   * near-black PDF strokes without admitting grey shading.
   *
   * Default: 80.
   */
  darkLuminance?: number;

  /**
   * Minimum stroke width (in PDF points) for a detection to fire.
   * 5pt ≈ a single-character underline; anything shorter is
   * probably a glyph fragment (descender of a comma, baseline of
   * a small letter) bleeding into the search band rather than a
   * real `___` blank.
   *
   * Default: 5pt.
   */
  minStrokeWidthPoints?: number;

  /**
   * Maximum stroke width (in PDF points). Real per-option blanks
   * stay short; anything longer than ~40pt is almost certainly a
   * single shared stroke spanning multiple options or the bottom
   * border of an enclosing rectangle. Cap at 50pt to leave headroom
   * for unusually long blanks while still rejecting full-row lines.
   *
   * Default: 50pt.
   */
  maxStrokeWidthPoints?: number;

  /**
   * Vertical-thinness gate: the rows ±`thinnessOffsetPoints` above
   * AND below a candidate stroke row must score below
   * `thinnessNeighborMaxRatio` × candidate score on the same column
   * range. Real horizontal strokes are 1-3 px tall (plus blur);
   * label glyph rows are 10-25 px tall and saturate the neighbour
   * test. Identical rationale to `underlineSnap.ts`'s
   * `verticalNeighborMax` / `THINNESS_NEIGHBOR_OFFSET_PX`.
   *
   * Default offset: 2pt (≈ 5px at our 2048-long-edge render
   * scale on US-Letter).
   * Default ratio: 0.4 — neighbours must be < 40% as dark as the
   * candidate.
   */
  thinnessOffsetPoints?: number;
  thinnessNeighborMaxRatio?: number;

  /**
   * If fewer than this fraction of the field's options have a
   * detectable per-option blank, abandon detection for the WHOLE
   * field and leave every option at `hasUnderlineBlank = false`.
   * Catches the "single shared stroke spans the entire row" case
   * where the per-option search fires for some options but not
   * others (because the search-region partition straddles the
   * single stroke unevenly), producing an inconsistent X layout.
   * If the form is truly per-option, ≥ ⅔ of the options will
   * detect a blank; the heuristic is generous to imperfect
   * detection on the tail option (`Other` is often spaced
   * differently and may legitimately miss).
   *
   * Default: 0.5 — at least half the options must hit.
   */
  minHitRatio?: number;

  /**
   * If true, log per-option detection decisions to the console.
   * Off by default to keep production logs quiet; the call site in
   * `geminiFieldDetector.ts` can opt in for diagnostic dumps.
   */
  verbose?: boolean;
}

const DEFAULT_OPTIONS: Required<OptionBlankDetectorOptions> = {
  lookbackPoints: 50,
  verticalBandPoints: 6,
  darkLuminance: 80,
  minStrokeWidthPoints: 5,
  maxStrokeWidthPoints: 50,
  thinnessOffsetPoints: 2,
  thinnessNeighborMaxRatio: 0.4,
  minHitRatio: 0.5,
  verbose: false,
};

/**
 * Trace the longest contiguous dark-pixel run on `row`, restricted
 * to the column range `[leftCol, rightCol]`. Returns the run's
 * length plus its left/right pixel endpoints. A small `MAX_GAP` of
 * light pixels is tolerated mid-run to absorb anti-alias artefacts
 * (matches the convention in `underlineSnap.ts`).
 */
function longestDarkRun(
  imageData: ImageData,
  row: number,
  leftCol: number,
  rightCol: number,
  darkLuminance: number
): { length: number; leftPx: number; rightPx: number } {
  const width = imageData.width;
  const height = imageData.height;
  if (row < 0 || row >= height) return { length: 0, leftPx: -1, rightPx: -1 };

  const left = Math.max(0, Math.floor(leftCol));
  const right = Math.min(width - 1, Math.ceil(rightCol));
  if (right <= left) return { length: 0, leftPx: -1, rightPx: -1 };

  const data = imageData.data;
  const rowOffset = row * width * 4;

  const MAX_GAP = 2;
  let bestLen = 0;
  let bestLeft = -1;
  let bestRight = -1;
  let curLen = 0;
  let curStart = -1;
  let curGap = 0;
  let lastDark = -1;

  for (let col = left; col <= right; col += 1) {
    const idx = rowOffset + col * 4;
    const a = data[idx + 3];
    let isDark: boolean;
    if (a < 128) {
      isDark = false;
    } else {
      const lum =
        0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      isDark = lum < darkLuminance;
    }

    if (isDark) {
      if (curStart < 0) curStart = col;
      curLen += curGap + 1;
      curGap = 0;
      lastDark = col;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestLeft = curStart;
        bestRight = lastDark;
      }
    } else {
      if (curLen > 0 && curGap < MAX_GAP) {
        curGap += 1;
      } else {
        curLen = 0;
        curStart = -1;
        curGap = 0;
      }
    }
  }

  return { length: bestLen, leftPx: bestLeft, rightPx: bestRight };
}

interface DetectionResult {
  strokeRow: number;
  strokeLeftPx: number;
  strokeRightPx: number;
  strokeWidthPt: number;
}

/**
 * Per-option underline search. Returns the stroke geometry in
 * pixel space (with the stroke width in PDF points for caller-side
 * cap checks), or null when no qualifying stroke is found.
 *
 * Search region:
 *   - Horizontal: `[opt.bbox.x - lookbackPt, opt.bbox.x]` —
 *     immediately to the LEFT of the printed label, never beyond.
 *   - Vertical: ±`verticalBandPt` around the option's BASELINE
 *     (`opt.bbox.y + opt.bbox.height`). PDF underlines sit on the
 *     text baseline, so this is the correct anchor; ±6pt absorbs
 *     stroke drift from the exact baseline on real forms.
 *
 * For each row in the band, compute the longest contiguous dark
 * run; reject candidates that fail the width gate (too short = a
 * glyph fragment; too long = a shared full-row stroke) or the
 * thinness gate (neighbour rows ±2pt also dark = label text, not
 * a stroke). Among surviving candidates, pick the LONGEST run —
 * the strongest signal of a real underline.
 */
function detectOptionBlank(
  opt: FieldOption,
  render: PageRender,
  opts: Required<OptionBlankDetectorOptions>
): DetectionResult | null {
  const ppp = 1 / Math.max(1e-6, render.pdfPointsPerPixel);

  const baselinePt = opt.bbox.y + opt.bbox.height;
  const searchTopPx = Math.max(
    0,
    Math.floor((baselinePt - opts.verticalBandPoints) * ppp)
  );
  const searchBotPx = Math.min(
    render.height - 1,
    Math.ceil((baselinePt + opts.verticalBandPoints) * ppp)
  );
  const searchLeftPx = Math.max(
    0,
    Math.floor((opt.bbox.x - opts.lookbackPoints) * ppp)
  );
  // Don't search past the label's left edge — the printed label
  // glyphs themselves are dense enough to satisfy the dark-run
  // gates and would produce false positives on every option.
  const searchRightPx = Math.max(
    0,
    Math.floor(opt.bbox.x * ppp) - 1
  );

  if (searchRightPx <= searchLeftPx) return null;
  if (searchBotPx < searchTopPx) return null;

  const minWidthPx = opts.minStrokeWidthPoints * ppp;
  const maxWidthPx = opts.maxStrokeWidthPoints * ppp;
  const thinnessOffsetPx = Math.max(1, Math.round(opts.thinnessOffsetPoints * ppp));

  let best: DetectionResult | null = null;

  for (let row = searchTopPx; row <= searchBotPx; row += 1) {
    const run = longestDarkRun(
      render.imageData,
      row,
      searchLeftPx,
      searchRightPx,
      opts.darkLuminance
    );
    if (run.length < minWidthPx) continue;
    if (run.length > maxWidthPx) continue;

    const above = longestDarkRun(
      render.imageData,
      row - thinnessOffsetPx,
      run.leftPx,
      run.rightPx,
      opts.darkLuminance
    );
    const below = longestDarkRun(
      render.imageData,
      row + thinnessOffsetPx,
      run.leftPx,
      run.rightPx,
      opts.darkLuminance
    );
    if (above.length >= run.length * opts.thinnessNeighborMaxRatio) continue;
    if (below.length >= run.length * opts.thinnessNeighborMaxRatio) continue;

    if (!best || run.length > (best.strokeRightPx - best.strokeLeftPx + 1)) {
      best = {
        strokeRow: row,
        strokeLeftPx: run.leftPx,
        strokeRightPx: run.rightPx,
        strokeWidthPt: run.length * render.pdfPointsPerPixel,
      };
    }
  }

  return best;
}

/**
 * Walk every option-group field in `fields` and annotate each
 * option with `hasUnderlineBlank` + `blankRect` when a per-option
 * underline is detected. Returns a NEW array; never mutates the
 * input or its option entries.
 *
 * The `minHitRatio` gate is applied at the field level: if fewer
 * than half (default) of a field's options detect a blank, the
 * whole field is left untouched (every option keeps the v0.5.25
 * circle-around-label render path). This catches the "single
 * shared stroke spans the entire row" case where per-option search
 * partial-fires inconsistently.
 */
export function annotateOptionGroupBlanks(
  fields: TemplateField[],
  pageRenders: Record<number, PageRender>,
  options: OptionBlankDetectorOptions = {}
): TemplateField[] {
  const opts: Required<OptionBlankDetectorOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  let totalGroups = 0;
  let annotatedGroups = 0;
  let totalOptions = 0;
  let annotatedOptions = 0;

  const out = fields.map((field) => {
    const isOptionGroup =
      field.fieldType === "option-group" || field.fieldKind === "option-group";
    if (!isOptionGroup) return field;
    if (!Array.isArray(field.options) || field.options.length === 0) return field;

    const render = pageRenders[field.pageNumber];
    if (!render) {
      if (opts.verbose) {
        console.log(
          `[optionBlankDetector] field=${field.id} skipped: no page render for page ${field.pageNumber}`
        );
      }
      return field;
    }

    totalGroups += 1;
    totalOptions += field.options.length;

    // First pass: detect per-option blanks (without committing to
    // the field-level result). We need the hit count BEFORE we
    // decide whether to keep them.
    const detections = field.options.map((opt) =>
      detectOptionBlank(opt, render, opts)
    );
    const hits = detections.filter((d) => d !== null).length;
    const ratio = hits / field.options.length;

    if (ratio < opts.minHitRatio) {
      if (opts.verbose) {
        console.log(
          `[optionBlankDetector] field=${field.id} dropped: only ${hits}/${field.options.length} options detected a blank (ratio=${ratio.toFixed(2)} < ${opts.minHitRatio.toFixed(2)}; probably single-shared-stroke or no per-option blanks)`
        );
      }
      return field;
    }

    annotatedGroups += 1;
    const newOptions: FieldOption[] = field.options.map((opt, i) => {
      const det = detections[i];
      if (!det) return opt;
      annotatedOptions += 1;

      // blankRect covers where the X glyph will be drawn:
      //   - x: stroke's left endpoint
      //   - width: stroke's horizontal extent
      //   - height: the option label's height (so the X has
      //     vertical room to render visibly)
      //   - y: positioned so the rect's BOTTOM edge sits on the
      //     stroke (text-baseline geometry — the same convention
      //     used everywhere else in this codebase, including
      //     `bbox_bottom == strokeRow` in underlineSnap.ts). The X
      //     drawn 80% of the rect's height (per the renderer)
      //     therefore visually crosses the stroke from above,
      //     matching how a human writes an X on `___`.
      const strokeLeftPt = det.strokeLeftPx * render.pdfPointsPerPixel;
      const strokeYPt = det.strokeRow * render.pdfPointsPerPixel;
      const widthPt = det.strokeWidthPt;
      const heightPt = Math.max(8, opt.bbox.height);

      return {
        ...opt,
        hasUnderlineBlank: true,
        blankRect: {
          x: strokeLeftPt,
          y: strokeYPt - heightPt,
          width: widthPt,
          height: heightPt,
        },
      };
    });

    if (opts.verbose) {
      console.log(
        `[optionBlankDetector] field=${field.id} annotated ${hits}/${field.options.length} options (page=${field.pageNumber})`
      );
    }

    return { ...field, options: newOptions };
  });

  console.log(
    `[optionBlankDetector] processed ${totalGroups} option-group field(s): annotated ${annotatedGroups} field(s) / ${annotatedOptions}/${totalOptions} option(s) with underline blanks.`
  );

  return out;
}
