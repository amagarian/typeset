/**
 * v0.6.0 (Workstream B3) — boxed-field detector.
 *
 * Some forms render a writable field as a label INSIDE a bordered
 * rectangle, with an empty area to the right of the label that the
 * user is meant to fill in. The bordered box's bottom edge IS the
 * underline; the right edge is the field's right boundary; and the
 * label sits in the left portion of the box. v0.5.x detection often
 * either (a) skipped these because there was no per-row underline
 * stroke without a corresponding bottom-of-box, or (b) over-extended
 * the field bbox past the box's right edge into adjacent columns.
 *
 * This post-processor runs AFTER `snapFieldsToUnderlines` and BEFORE
 * the final dedup pass. It is deliberately conservative: it never
 * INVENTS strokes that aren't there, and it tolerates missed
 * detections in favour of zero false positives.
 *
 * Algorithm (simplified from the spec — see comment on each step):
 *
 *   1. Scan each rendered page's ImageData for horizontal dark runs
 *      that look like box edges (uniform width ≥ `minBoxWidthPt`,
 *      ≤ `maxBoxWidthPt`). Cluster pairs of runs at similar x-extents
 *      (within `xToleranceP`) and reasonable inter-run vertical
 *      spacing (`minBoxHeightPt`–`maxBoxHeightPt`) into candidate
 *      box rectangles.
 *
 *   2. For each candidate box, sample two interior columns (~25%
 *      and ~75% of the box width) at three rows (~25%, 50%, 75% of
 *      the box height) — a vertical edge would be solidly dark at
 *      its column for most of those samples; a non-boxed cell
 *      shows mostly-light samples. Reject candidates that fail the
 *      sampling check.
 *
 *   3. Match the box against per-page text rows (the same
 *      `extractTextRowsWithStrings` data we ship to `geminiFieldDetector`)
 *      to find text that falls INSIDE the box. Accept only when
 *      ONE text row sits in the left ~50% of the box AND no text
 *      rows sit in the right ~40-100%.
 *
 *   4. Compute the writable-area rect: from the label's right edge
 *      + 4pt padding to the box's right edge - 2pt padding,
 *      vertically centred on the label's text row with a height
 *      matching the label's row height. Emit one boxed-field
 *      annotation per accepted box.
 *
 *   5. Apply annotations to the field set:
 *      - If an existing Gemini field overlaps the LABEL portion
 *        (within `overlapTolPt`), REPLACE its bbox with the
 *        writable-area rect. This corrects over-extended Gemini
 *        bboxes for label-inside-box fields without losing the
 *        canonical-id resolution Gemini did upstream.
 *      - Otherwise, EMIT a brand-new TemplateField for the
 *        writable area, with the label string carried across as
 *        the visible label and `__prompt__` as the mapped key
 *        (conservative — we don't run alias resolution because
 *        callers can plug in their own canonical-resolver hook
 *        via {@link BoxedFieldDetectorOptions.resolveCanonical}).
 *
 * Why no full corner-detection: full rectangle detection from
 * pixels is high-risk for the v0.6.0 ship window — corner
 * resolution is sensitive to anti-alias artefacts and would need
 * much more careful tuning. The horizontal-run-pair + interior-
 * sampling approximation captures the dominant box pattern
 * (cells with horizontal top + bottom edges visible against a
 * white background) at low complexity. Forms whose box edges are
 * extremely faint or lightweight grey may slip through; the
 * existing snap pipeline keeps those fields working with
 * underline-only geometry.
 */

import type { TemplateField, FieldOption } from "@/types";
import type { PageRender, TextRow } from "@/utils/underlineSnap";

export interface BoxedFieldDetectorOptions {
  /** Min box width in PDF points. Default: 80 — narrower than this is
   *  almost always a checkbox or icon cell, not a writable boxed field. */
  minBoxWidthPt?: number;
  /** Max box width in PDF points. Default: 500 — full-page-width boxes
   *  past this are more often section dividers than writable fields. */
  maxBoxWidthPt?: number;
  /** Min box height. Default: 14pt (≈ one text row). */
  minBoxHeightPt?: number;
  /** Max box height. Default: 50pt — taller boxes are usually
   *  multi-row regions handled by the existing multiline path. */
  maxBoxHeightPt?: number;
  /** Tolerance for matching the x-extents of top + bottom horizontal
   *  runs (PDF points). Default: 4. */
  xTolerancePt?: number;
  /** Tolerance for "field bbox overlaps label rect" check (points). */
  overlapTolPt?: number;
  /** Luminance threshold for "dark pixel" — same as
   *  `optionBlankDetector` and `underlineSnap` (default 80). */
  darkLuminance?: number;
  /** Optional canonical-id resolver. When supplied, used to bind
   *  newly-emitted boxed fields to a canonical id by their label. */
  resolveCanonical?: (label: string) => {
    canonicalFieldId?: string;
    mappedProjectKey?: string;
    fieldKind?: TemplateField["fieldKind"];
  } | undefined;
  /** When true, log per-candidate decisions to the console. */
  verbose?: boolean;
}

const DEFAULT_OPTS: Required<Omit<BoxedFieldDetectorOptions, "resolveCanonical">> = {
  minBoxWidthPt: 80,
  maxBoxWidthPt: 500,
  minBoxHeightPt: 14,
  maxBoxHeightPt: 50,
  xTolerancePt: 4,
  overlapTolPt: 30,
  darkLuminance: 80,
  verbose: false,
};

interface HorizontalRun {
  yPx: number;
  leftPx: number;
  rightPx: number;
}

/**
 * Scan every row of a page render for the longest contiguous dark
 * pixel run whose length sits in `[minWidthPx, maxWidthPx]`. Returns
 * runs sorted by y ascending. Conservative — only one run per row
 * to keep the output set small (a real boxed-field row has at most
 * one box edge, so we don't lose information).
 */
function findHorizontalRuns(
  render: PageRender,
  minWidthPx: number,
  maxWidthPx: number,
  darkLuminance: number
): HorizontalRun[] {
  const out: HorizontalRun[] = [];
  const data = render.imageData.data;
  const W = render.width;
  const H = render.height;
  const MAX_GAP = 2;

  for (let y = 0; y < H; y += 1) {
    const rowOff = y * W * 4;
    let bestLen = 0;
    let bestLeft = -1;
    let bestRight = -1;
    let curLen = 0;
    let curStart = -1;
    let curGap = 0;
    let lastDark = -1;

    for (let x = 0; x < W; x += 1) {
      const idx = rowOff + x * 4;
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
        if (curStart < 0) curStart = x;
        curLen += curGap + 1;
        curGap = 0;
        lastDark = x;
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
    if (bestLen >= minWidthPx && bestLen <= maxWidthPx && bestLeft >= 0) {
      out.push({ yPx: y, leftPx: bestLeft, rightPx: bestRight });
    }
  }
  return out;
}

/** True if `(x, y)` in `imageData` is "dark" by the threshold. */
function isPixelDark(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  x: number,
  y: number,
  darkLuminance: number
): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const idx = (y * W + x) * 4;
  if (data[idx + 3] < 128) return false;
  const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  return lum < darkLuminance;
}

interface BoxCandidate {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Find boxed-field candidates for a single page render. Pairs
 * horizontal runs as top/bottom edges of a candidate box, then
 * verifies via interior column sampling that vertical edges
 * connect them at the left/right.
 */
function findBoxCandidatesForPage(
  page: number,
  render: PageRender,
  opts: Required<Omit<BoxedFieldDetectorOptions, "resolveCanonical">>
): BoxCandidate[] {
  const ppp = 1 / Math.max(1e-6, render.pdfPointsPerPixel);
  const minWidthPx = opts.minBoxWidthPt * ppp;
  const maxWidthPx = opts.maxBoxWidthPt * ppp;
  const minHeightPx = opts.minBoxHeightPt * ppp;
  const maxHeightPx = opts.maxBoxHeightPt * ppp;
  const xTolPx = Math.max(2, Math.round(opts.xTolerancePt * ppp));

  const runs = findHorizontalRuns(render, minWidthPx, maxWidthPx, opts.darkLuminance);
  if (runs.length < 2) return [];

  const candidates: BoxCandidate[] = [];
  const data = render.imageData.data;
  const W = render.width;
  const H = render.height;

  // For each run, look for a partner run BELOW it within the
  // height range that has matching x-extents. Two-pointer style
  // would be ideal but the run set is small (single-page hits
  // usually < 100), so an O(n²) pairing is fine.
  for (let i = 0; i < runs.length; i += 1) {
    const top = runs[i];
    for (let j = i + 1; j < runs.length; j += 1) {
      const bot = runs[j];
      const dy = bot.yPx - top.yPx;
      if (dy < minHeightPx) continue;
      if (dy > maxHeightPx) break; // runs sorted by y — break out

      // Match x-extents within tolerance (left and right both).
      if (Math.abs(bot.leftPx - top.leftPx) > xTolPx) continue;
      if (Math.abs(bot.rightPx - top.rightPx) > xTolPx) continue;

      // Verify vertical edges. Sample left + right columns at three
      // interior rows (~25%, 50%, 75% of the box height). A real
      // box has both columns dark at most samples; a row of cells
      // (table) has frequent gaps in vertical column intensity.
      const leftCol = Math.round((top.leftPx + bot.leftPx) / 2);
      const rightCol = Math.round((top.rightPx + bot.rightPx) / 2);
      const sampleYs = [
        Math.round(top.yPx + dy * 0.25),
        Math.round(top.yPx + dy * 0.5),
        Math.round(top.yPx + dy * 0.75),
      ];
      let leftHits = 0;
      let rightHits = 0;
      for (const y of sampleYs) {
        if (isPixelDark(data, W, H, leftCol, y, opts.darkLuminance)) leftHits += 1;
        if (isPixelDark(data, W, H, rightCol, y, opts.darkLuminance)) rightHits += 1;
      }
      // Require ≥ 2 of 3 samples on EACH side.
      if (leftHits < 2 || rightHits < 2) continue;

      const xPt = top.leftPx * render.pdfPointsPerPixel;
      const yPt = top.yPx * render.pdfPointsPerPixel;
      const widthPt = (top.rightPx - top.leftPx) * render.pdfPointsPerPixel;
      const heightPt = dy * render.pdfPointsPerPixel;
      candidates.push({ page, x: xPt, y: yPt, width: widthPt, height: heightPt });

      if (opts.verbose) {
        console.log(
          `[boxedField] page=${page} candidate box: x=${xPt.toFixed(1)} y=${yPt.toFixed(1)} ${widthPt.toFixed(1)}×${heightPt.toFixed(1)}`
        );
      }
    }
  }

  return candidates;
}

interface BoxedFieldEmission {
  /** The box's outer rect (PDF user-space points, top-down origin). */
  boxRect: { x: number; y: number; width: number; height: number };
  /** The label text inside the box. */
  labelText: string;
  /** Bbox of the label text (used to compute the writable-area rect
   *  AND to find existing Gemini fields that overlap this label). */
  labelRect: { x: number; y: number; width: number; height: number };
  /** Computed writable-area rect to the right of the label. */
  writableRect: { x: number; y: number; width: number; height: number };
  page: number;
}

/**
 * Match a box against the per-page text rows. Accepts only when
 * exactly one row sits in the LEFT half of the box AND no rows
 * sit in the RIGHT 40-100% — this is the "label inside box,
 * empty writable area to the right" pattern.
 */
function emissionForBox(
  box: BoxCandidate,
  textRows: ReadonlyArray<TextRow & { text?: string }>
): BoxedFieldEmission | null {
  const rowsInside = textRows.filter((row) => {
    if (row.yBottom <= box.y || row.yBottom >= box.y + box.height) return false;
    if (row.xMax <= box.x || row.xMin >= box.x + box.width) return false;
    return true;
  });
  if (rowsInside.length === 0) return null;

  const midX = box.x + box.width * 0.5;
  // Label = a single row whose right edge is left of the box midline.
  const leftRows = rowsInside.filter((r) => r.xMax <= midX);
  if (leftRows.length !== 1) return null;
  // Right 40% must be empty.
  const rightStartX = box.x + box.width * 0.6;
  const rightHasText = rowsInside.some((r) => r.xMax > rightStartX);
  if (rightHasText) return null;

  const label = leftRows[0];
  const labelText = (label.text ?? "").trim();
  if (!labelText) return null;

  const labelHeight = Math.max(8, label.xMax - label.xMin > 0 ? 12 : 12);
  // Use the row's yBottom as the label row's bottom; we don't
  // have row height directly so fall back to a 12pt assumption.
  const labelRect = {
    x: label.xMin,
    y: label.yBottom - labelHeight,
    width: label.xMax - label.xMin,
    height: labelHeight,
  };

  const labelRightEdge = label.xMax;
  const padX = 4;
  const writableRect = {
    x: labelRightEdge + padX,
    y: labelRect.y,
    width: Math.max(20, box.x + box.width - (labelRightEdge + padX) - 2),
    height: labelRect.height,
  };

  return {
    boxRect: { x: box.x, y: box.y, width: box.width, height: box.height },
    labelText,
    labelRect,
    writableRect,
    page: box.page,
  };
}

function bboxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  tolPt: number
): boolean {
  return (
    Math.abs(a.x - b.x) <= tolPt &&
    Math.abs(a.y - b.y) <= tolPt &&
    Math.abs(a.x + a.width - (b.x + b.width)) <= tolPt + 20 &&
    Math.abs(a.y + a.height - (b.y + b.height)) <= tolPt + 12
  );
}

export interface BoxedFieldDetectorTextSource {
  /** Page text rows WITH strings, indexed by page number. */
  textRows: Record<number, Array<TextRow & { text?: string }>>;
}

/**
 * Public entry point. Walks every page render, collects boxed-field
 * candidates, and produces a NEW field array with bbox corrections
 * for existing Gemini fields plus newly-emitted fields for boxes
 * that had no Gemini coverage.
 */
export function annotateBoxedFields(
  fields: TemplateField[],
  pageRenders: Record<number, PageRender>,
  text: BoxedFieldDetectorTextSource,
  options: BoxedFieldDetectorOptions = {}
): TemplateField[] {
  const opts: Required<Omit<BoxedFieldDetectorOptions, "resolveCanonical">> = {
    ...DEFAULT_OPTS,
    ...(Object.fromEntries(
      Object.entries(options).filter(([k]) => k !== "resolveCanonical")
    ) as Partial<Required<Omit<BoxedFieldDetectorOptions, "resolveCanonical">>>),
  };

  const emissions: BoxedFieldEmission[] = [];
  for (const [pageStr, render] of Object.entries(pageRenders)) {
    const page = Number(pageStr);
    const candidates = findBoxCandidatesForPage(page, render, opts);
    const rows = text.textRows[page] ?? [];
    for (const box of candidates) {
      const e = emissionForBox(box, rows);
      if (e) emissions.push(e);
    }
  }

  if (emissions.length === 0) {
    console.log("[boxedField] no boxed-field candidates met all gates.");
    return fields;
  }

  const out: TemplateField[] = [...fields];
  let replaced = 0;
  let added = 0;

  for (const e of emissions) {
    // Find an existing field whose bbox overlaps the LABEL portion
    // of the box. A field whose bbox covers the label is a candidate
    // for replacement (Gemini latched onto the label location and
    // produced a wide bbox bleeding to the right).
    const idx = out.findIndex(
      (f) =>
        f.pageNumber === e.page &&
        bboxesOverlap(
          { x: f.x, y: f.y, width: f.width, height: f.height },
          e.labelRect,
          opts.overlapTolPt
        )
    );

    if (idx >= 0) {
      const existing = out[idx];
      out[idx] = {
        ...existing,
        x: e.writableRect.x,
        y: e.writableRect.y,
        width: e.writableRect.width,
        height: e.writableRect.height,
      };
      replaced += 1;
      if (opts.verbose) {
        console.log(
          `[boxedField] replaced existing field "${existing.label}" with writable rect ${JSON.stringify(e.writableRect)}`
        );
      }
      continue;
    }

    const resolved = options.resolveCanonical?.(e.labelText);
    const newField: TemplateField = {
      id: `boxed-${e.page}-${Math.round(e.writableRect.x)}-${Math.round(e.writableRect.y)}-${Date.now().toString(36)}`,
      label: e.labelText,
      mappedProjectKey: (resolved?.mappedProjectKey ?? "__prompt__") as TemplateField["mappedProjectKey"],
      canonicalFieldId: resolved?.canonicalFieldId as TemplateField["canonicalFieldId"],
      pageNumber: e.page,
      x: e.writableRect.x,
      y: e.writableRect.y,
      width: e.writableRect.width,
      height: e.writableRect.height,
      confidence: 0.85,
      fieldType: "text",
      fieldKind: resolved?.fieldKind ?? "text",
      detectionSource: "geometry-box",
      promptLabel: !resolved?.canonicalFieldId ? e.labelText : undefined,
      // Initialise option-only fields to undefined so the type stays clean.
      options: undefined as FieldOption[] | undefined,
    };
    out.push(newField);
    added += 1;
    if (opts.verbose) {
      console.log(
        `[boxedField] emitted new field "${e.labelText}" at ${JSON.stringify(e.writableRect)}`
      );
    }
  }

  console.log(
    `[boxedField] processed ${emissions.length} boxed-field emission(s): replaced=${replaced}, added=${added}.`
  );

  return out;
}
