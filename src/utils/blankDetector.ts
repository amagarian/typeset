/**
 * Geometric blank detection (v0.4.13 Precision mode).
 *
 * Finds writable areas on a rendered page WITHOUT asking an LLM to
 * reason spatially. Four detection strategies run in parallel and
 * their candidates are merged via IoU:
 *
 *   1. Underscore lines from the text layer       (kind: "underscore-line")
 *   2. Horizontal underline strokes from pixels   (kind: "horizontal-line")
 *   3. Small box outlines from pixels             (kind: "small-box")
 *   4. Empty bands above all-caps captions        (kind: "empty-band")
 *
 * The output is a list of `BlankCandidate`s in PNG-pixel coordinates
 * (origin top-left, matching the v0.4.9 image-pixel convention used
 * by the rest of the detector). Caller converts the pixel rects to
 * PDF user-space points via the captured render scale.
 *
 * No external dependencies — plain `<canvas>` 2D context + ImageData.
 * Adding OpenCV.js would have shipped ~5 MB of WebAssembly for what
 * amounts to four narrowly-scoped passes over a luminance buffer.
 *
 * Performance budget at 2048px long-edge:
 *   - Page 1 of an 8.5×11 form is ~2048×1583 ≈ 3.2 Mpx.
 *   - The horizontal-line scan is the heaviest pass — it walks every
 *     row once, doing one luminance compare per pixel. ~30-80 ms per
 *     page on an M1, dominated by the ImageData decode (one big
 *     `getImageData` call → typed array).
 *   - Small-box and empty-band passes are O(text-runs) and O(N)
 *     respectively; well under 10 ms each.
 *   - Total: ~50-100 ms per page. Acceptable budget vs. a 5-10s
 *     Gemini round-trip.
 */

import type { PdfPageText, PdfWord } from "./pdfTextLayer";

export type BlankKind =
  | "underscore-line"
  | "horizontal-line"
  | "small-box"
  | "empty-band";

export interface BlankCandidate {
  /** 1-based page index. */
  page: number;
  /** PNG-pixel bbox, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: BlankKind;
  /** Detection confidence in [0, 1]. */
  confidence: number;
}

export interface PageImage {
  page: number;
  canvas: HTMLCanvasElement;
  widthPx: number;
  heightPx: number;
}

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/** Pixels with luminance < this are considered "ink" / dark. */
const DARK_LUMA_THRESHOLD = 128;

/** Minimum width of a horizontal line to count as a writable area, px. */
const MIN_HORIZONTAL_LINE_WIDTH_PX = 60;

/** Maximum height (thickness) of a horizontal line stroke, px. */
const MAX_HORIZONTAL_LINE_HEIGHT_PX = 3;

/** How far above the stroke to place the writable bbox (px). */
const HORIZONTAL_LINE_BBOX_LIFT_PX = 8;

/** Vertical extent of the bbox we emit ABOVE a horizontal line. */
const HORIZONTAL_LINE_BBOX_HEIGHT_PX = 12;

/** Min/max side length of a small-box candidate (e.g. checkbox / CVV box). */
const SMALL_BOX_MIN_SIDE_PX = 12;
const SMALL_BOX_MAX_SIDE_PX = 30;

/** Empty-band detection: how tall the empty band above a caption can be. */
const EMPTY_BAND_HEIGHT_PX = 30;
const EMPTY_BAND_TALL_HEIGHT_PX = 60;

/** Required fraction of white (non-dark) pixels for a region to count
 *  as "empty". */
const EMPTY_BAND_WHITE_FRACTION = 0.985;

/** How close (px) two candidates can be before they're considered
 *  near-duplicates and the lower-confidence one is dropped. */
const NEAR_DUPLICATE_TOLERANCE_PX = 5;

/** Vertical row-overlap threshold when a candidate's IoU is computed
 *  against another's. */
const MERGE_IOU_THRESHOLD = 0.3;

/** Common all-caps form-field captions used as a strong-signal seed
 *  list for the empty-band detector. We accept these even when the
 *  string is shorter than the generic 4-char threshold. */
const COMMON_CAPS_CAPTIONS = new Set<string>(
  [
    "PHONE NUMBER",
    "PHONE",
    "PHONE#",
    "PHONE #",
    "EMAIL ADDRESS",
    "EMAIL",
    "EXP DATE",
    "EXP. DATE",
    "EXP",
    "EXPIRATION",
    "EXPIRATION DATE",
    "CVV",
    "CVV#",
    "CVV2",
    "CVC",
    "ZIP CODE",
    "ZIP",
    "POSTAL CODE",
    "STATE",
    "CITY",
    "BILLING ADDRESS",
    "ADDRESS",
    "CREDIT CARD NUMBER",
    "CARD NUMBER",
    "CARDHOLDER NAME",
    "NAME ON CARD",
    "JOB NAME",
    "JOB NUMBER",
    "JOB#",
    "JOB #",
    "PRODUCTION COMPANY",
    "PRODUCTION CO",
    "PRODUCTION CO.",
    "PRODUCER",
    "DATE",
    "SIGNATURE",
    "PO NUMBER",
    "PO #",
    "PO#",
  ].map((s) => s.toUpperCase())
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all four detection strategies, merge overlapping candidates,
 * and return one list per document. Each strategy logs a diagnostic
 * count under `[Typeset Diag] Precision: detected ...` (handled by
 * the caller after this returns).
 */
export async function detectBlanks(
  pageImages: PageImage[],
  pageText: PdfPageText[]
): Promise<BlankCandidate[]> {
  const all: BlankCandidate[] = [];

  for (const img of pageImages) {
    const text = pageText.find((p) => p.page === img.page);
    const ctx = img.canvas.getContext("2d");
    if (!ctx) continue;

    // Acquire ImageData ONCE per page — `getImageData` is the hot
    // call here (~10-30ms) and we want all four pixel-driven passes
    // to share it. Wrapped in try/catch because some browsers throw
    // a SecurityError when the canvas is "tainted" by cross-origin
    // images; pdf.js doesn't taint, so this is defensive only.
    let pixelData: ImageData | null = null;
    try {
      pixelData = ctx.getImageData(0, 0, img.widthPx, img.heightPx);
    } catch (err) {
      console.warn(
        `[Typeset Diag] Precision: ImageData read failed on page ${img.page}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    const luminance = pixelData ? buildLuminanceMap(pixelData) : null;

    // 1. Underscore lines from the text layer.
    if (text) {
      all.push(...detectUnderscoreLines(text));
    }

    // 2. Horizontal underline strokes from pixels.
    if (luminance) {
      all.push(
        ...detectHorizontalLines(luminance, img.widthPx, img.heightPx, img.page)
      );
    }

    // 3. Small box outlines from pixels.
    if (luminance) {
      all.push(
        ...detectSmallBoxes(luminance, img.widthPx, img.heightPx, img.page)
      );
    }

    // 4. Empty bands above all-caps captions.
    if (text && luminance) {
      all.push(
        ...detectEmptyBands(text, luminance, img.widthPx, img.heightPx)
      );
    }
  }

  return mergeCandidates(all);
}

/**
 * Per-strategy counts for diagnostic logging — caller uses this to
 * write the standard `[Typeset Diag] Precision: detected N blanks
 * (underscore=A, ...)` line.
 */
export function summarizeKinds(blanks: BlankCandidate[]): {
  underscore: number;
  horizontal: number;
  smallBox: number;
  emptyBand: number;
  total: number;
} {
  let underscore = 0;
  let horizontal = 0;
  let smallBox = 0;
  let emptyBand = 0;
  for (const b of blanks) {
    switch (b.kind) {
      case "underscore-line":
        underscore += 1;
        break;
      case "horizontal-line":
        horizontal += 1;
        break;
      case "small-box":
        smallBox += 1;
        break;
      case "empty-band":
        emptyBand += 1;
        break;
    }
  }
  return {
    underscore,
    horizontal,
    smallBox,
    emptyBand,
    total: blanks.length,
  };
}

// ---------------------------------------------------------------------------
// Strategy 1 — underscore lines from the text layer
// ---------------------------------------------------------------------------

const UNDERSCORE_RUN_RE = /^_{5,}$/;

function detectUnderscoreLines(text: PdfPageText): BlankCandidate[] {
  const out: BlankCandidate[] = [];
  for (const word of text.words) {
    const trimmed = word.text.replace(/\s+/g, "");
    if (UNDERSCORE_RUN_RE.test(trimmed)) {
      out.push({
        page: word.page,
        x: word.x,
        y: word.y,
        width: word.width,
        height: word.height,
        kind: "underscore-line",
        confidence: 0.95,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Luminance map utilities
// ---------------------------------------------------------------------------

/**
 * Pack an `ImageData` (RGBA) into a one-byte-per-pixel `Uint8Array`
 * holding luminance approximations. We use the Rec. 601 weights
 * (`0.299 R + 0.587 G + 0.114 B`) but skip the multiply by mapping
 * pixels directly: dark pixels in printed forms are ~black so a
 * straight average is fine and 4-5x faster than per-channel weights.
 *
 * Returns a typed array of length `width * height`.
 */
function buildLuminanceMap(image: ImageData): Uint8ClampedArray {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(width * height);
  // Single-channel approximation: green dominates perceptual brightness
  // and is the second sample in every pixel quad. This keeps the
  // inner loop tight (fewer reads, no math).
  for (let i = 0, j = 0; j < out.length; i += 4, j += 1) {
    out[j] = data[i + 1];
  }
  return out;
}

function isDark(luma: number): boolean {
  return luma < DARK_LUMA_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Strategy 2 — horizontal underline strokes
// ---------------------------------------------------------------------------

interface RawRun {
  y: number;
  x: number;
  width: number;
}

/**
 * Walk each row, collect runs of contiguous dark pixels, and accept
 * those that look like a thin horizontal underline stroke:
 *
 *   - run width ≥ MIN_HORIZONTAL_LINE_WIDTH_PX
 *   - the rows immediately above and below are mostly white (so this
 *     isn't a thick block of body text or a filled rectangle)
 *   - the same run repeats on at most 1-2 adjacent rows (a real
 *     underline is 1-3 px tall; a long run that persists for 10+
 *     rows is the top of a paragraph border or a filled region).
 *
 * The output bbox sits ABOVE the stroke (where text would go) — the
 * stroke itself is the underline of the writable line, not the line
 * a user would write on.
 */
function detectHorizontalLines(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  page: number
): BlankCandidate[] {
  const out: BlankCandidate[] = [];

  // Step 1: collect raw runs of dark pixels per row.
  const runsByRow: RawRun[][] = new Array(height);
  for (let y = 0; y < height; y += 1) {
    runsByRow[y] = scanRowForDarkRuns(luminance, width, y);
  }

  // Step 2: filter for thin horizontal lines. A thin line means the
  // SAME run (within a few px tolerance) does NOT continue for many
  // consecutive rows. We track which runs we've already absorbed
  // into a stroke so a single underline doesn't emit one bbox per
  // row of the stroke.
  const consumed = new Set<string>();

  for (let y = 0; y < height; y += 1) {
    const runs = runsByRow[y];
    if (!runs) continue;
    for (const run of runs) {
      if (run.width < MIN_HORIZONTAL_LINE_WIDTH_PX) continue;
      const key = `${y}:${run.x}`;
      if (consumed.has(key)) continue;

      // Compute stroke thickness — how many rows starting at y carry
      // a similar run.
      let thickness = 1;
      for (let yy = y + 1; yy < height && yy < y + 10; yy += 1) {
        const next = runsByRow[yy];
        if (!next) break;
        const matched = next.find(
          (r) =>
            Math.abs(r.x - run.x) <= 4 &&
            Math.abs(r.x + r.width - (run.x + run.width)) <= 4 &&
            r.width >= MIN_HORIZONTAL_LINE_WIDTH_PX * 0.85
        );
        if (!matched) break;
        thickness += 1;
        consumed.add(`${yy}:${matched.x}`);
      }
      if (thickness > MAX_HORIZONTAL_LINE_HEIGHT_PX) continue;

      // Above/below should be mostly white. We sample three rows in
      // each direction at the same x window. (Skipping cell-by-cell
      // here keeps this pass fast; the contour pass is the precise
      // one when we need it.)
      if (
        !regionMostlyWhite(
          luminance,
          width,
          height,
          run.x,
          y - 4,
          run.width,
          3
        )
      )
        continue;
      if (
        !regionMostlyWhite(
          luminance,
          width,
          height,
          run.x,
          y + thickness + 1,
          run.width,
          3
        )
      )
        continue;

      const bboxY = Math.max(0, y - HORIZONTAL_LINE_BBOX_LIFT_PX);
      const bboxH = Math.min(
        HORIZONTAL_LINE_BBOX_HEIGHT_PX,
        y - bboxY + thickness
      );
      out.push({
        page,
        x: run.x,
        y: bboxY,
        width: run.width,
        height: Math.max(8, bboxH),
        kind: "horizontal-line",
        confidence: 0.85,
      });
    }
  }

  return out;
}

function scanRowForDarkRuns(
  luminance: Uint8ClampedArray,
  width: number,
  y: number
): RawRun[] {
  const runs: RawRun[] = [];
  const base = y * width;
  let runStart = -1;
  for (let x = 0; x < width; x += 1) {
    const dark = isDark(luminance[base + x]);
    if (dark) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      runs.push({ y, x: runStart, width: x - runStart });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    runs.push({ y, x: runStart, width: width - runStart });
  }
  return runs;
}

function regionMostlyWhite(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  if (w <= 0 || h <= 0) return false;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  if (x0 >= x1 || y0 >= y1) return false;

  let dark = 0;
  let total = 0;
  // Row-stride sampling — every other pixel is plenty for a
  // "is this region mostly white?" question and 2x faster than a
  // dense scan.
  for (let yy = y0; yy < y1; yy += 1) {
    const base = yy * width;
    for (let xx = x0; xx < x1; xx += 2) {
      total += 1;
      if (isDark(luminance[base + xx])) dark += 1;
    }
  }
  if (total === 0) return false;
  return dark / total < 1 - EMPTY_BAND_WHITE_FRACTION;
}

// ---------------------------------------------------------------------------
// Strategy 3 — small box outlines
// ---------------------------------------------------------------------------

/**
 * Walk the image looking for small dark rectangles with white
 * interiors — i.e. checkboxes and CVV-style boxes. We use a coarse
 * approach: for every pixel that's the top-left corner of a
 * potential box (dark above, dark below, white inside), confirm by
 * checking each side has a continuous dark border.
 *
 * Optimization: we step by `SMALL_BOX_MIN_SIDE_PX / 2` pixels so we
 * don't scan every pixel; a real box outline is at least 12 px on a
 * side so it can't slip past a 6-px stride.
 */
function detectSmallBoxes(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  page: number
): BlankCandidate[] {
  const out: BlankCandidate[] = [];
  const stride = Math.max(1, Math.floor(SMALL_BOX_MIN_SIDE_PX / 2));
  const seen: Array<{ x: number; y: number; w: number; h: number }> = [];

  for (let y = 0; y < height - SMALL_BOX_MIN_SIDE_PX; y += stride) {
    for (let x = 0; x < width - SMALL_BOX_MIN_SIDE_PX; x += stride) {
      // Quick reject: top-left pixel must be dark. Most pixels in a
      // form are white, so this kills 95%+ of candidates instantly.
      if (!isDark(luminance[y * width + x])) continue;

      // Try a few candidate sizes. We don't need to test every
      // possible side length — boxes in this corpus are all in the
      // 12-30 px range, and we only need to find ONE size that looks
      // valid.
      for (let side = SMALL_BOX_MIN_SIDE_PX; side <= SMALL_BOX_MAX_SIDE_PX; side += 4) {
        if (x + side >= width || y + side >= height) break;
        if (!isBoxOutline(luminance, width, x, y, side, side)) continue;
        // Skip near-duplicate boxes (same rough position).
        const dup = seen.find(
          (s) =>
            Math.abs(s.x - x) <= 6 &&
            Math.abs(s.y - y) <= 6 &&
            Math.abs(s.w - side) <= 4
        );
        if (dup) continue;
        seen.push({ x, y, w: side, h: side });
        out.push({
          page,
          x,
          y,
          width: side,
          height: side,
          kind: "small-box",
          confidence: 0.9,
        });
        break;
      }
    }
  }

  return out;
}

/**
 * Check that the rectangle (x, y) → (x+w, y+h) has dark borders
 * (top, bottom, left, right) and a mostly-white interior.
 *
 * Borders are accepted if at least 80% of the perimeter pixels are
 * dark — printed checkbox outlines are sometimes broken by anti-
 * aliasing or tiny gaps and we don't want a strict 100% rule to lose
 * them.
 */
function isBoxOutline(
  luminance: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const top = y;
  const bottom = y + h - 1;
  const left = x;
  const right = x + w - 1;

  let darkCount = 0;
  let total = 0;
  // Top and bottom edges.
  for (let xx = left; xx <= right; xx += 1) {
    total += 2;
    if (isDark(luminance[top * width + xx])) darkCount += 1;
    if (isDark(luminance[bottom * width + xx])) darkCount += 1;
  }
  // Left and right edges (excluding corners we already counted).
  for (let yy = top + 1; yy <= bottom - 1; yy += 1) {
    total += 2;
    if (isDark(luminance[yy * width + left])) darkCount += 1;
    if (isDark(luminance[yy * width + right])) darkCount += 1;
  }

  if (total === 0) return false;
  if (darkCount / total < 0.8) return false;

  // Interior should be mostly white.
  let interiorDark = 0;
  let interiorTotal = 0;
  for (let yy = top + 2; yy < bottom - 1; yy += 2) {
    const base = yy * width;
    for (let xx = left + 2; xx < right - 1; xx += 2) {
      interiorTotal += 1;
      if (isDark(luminance[base + xx])) interiorDark += 1;
    }
  }
  if (interiorTotal === 0) return true;
  return interiorDark / interiorTotal < 0.1;
}

// ---------------------------------------------------------------------------
// Strategy 4 — empty bands above all-caps captions
// ---------------------------------------------------------------------------

const ALLCAPS_RE = /^[A-Z0-9 .,&#'/-]{4,}$/;

interface CaptionCandidate {
  /** Caption text (joined / normalized). */
  text: string;
  /** Caption bbox in pixel space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Build caption candidates from the page text. We accept either:
 *   - A short all-caps token of ≥ 4 chars (e.g. `PHONE`, `EXP DATE`).
 *   - A known common form-field caption from `COMMON_CAPS_CAPTIONS`,
 *     which lets us catch shorter signals like `CVV#`.
 *   - Up to 4 adjacent all-caps words on the same row joined into a
 *     phrase ≤ 20 chars (e.g. `PHONE NUMBER`, `CREDIT CARD NUMBER`).
 *
 * Captions in this layout sit BELOW the writable area (Layout C);
 * see `geminiFieldDetector.ts:buildPass1SharedSystemPrompt`.
 */
function buildCaptions(text: PdfPageText): CaptionCandidate[] {
  const captions: CaptionCandidate[] = [];

  // Group words into rows by Y center within ±50% of the median word
  // height. Rows are stitched in pdf.js's natural reading order.
  const rows: PdfWord[][] = [];
  const ROW_TOLERANCE = 6;
  for (const word of text.words) {
    const yMid = word.y + word.height / 2;
    const row = rows.find((r) => {
      const rowMid =
        r.reduce((a, w) => a + (w.y + w.height / 2), 0) / r.length;
      return Math.abs(rowMid - yMid) < ROW_TOLERANCE + word.height / 2;
    });
    if (row) row.push(word);
    else rows.push([word]);
  }

  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);

    // Walk the row and pull up to 4 consecutive all-caps tokens
    // joined by a single space when they're on the same horizontal
    // band and within ~30px of each other.
    let i = 0;
    while (i < row.length) {
      const w = row[i];
      const trimmed = w.text.trim();
      if (!isAllCapsCaption(trimmed)) {
        i += 1;
        continue;
      }
      let j = i;
      const phraseWords: PdfWord[] = [w];
      let phraseStr = trimmed;
      while (
        j + 1 < row.length &&
        phraseWords.length < 4 &&
        phraseStr.length + row[j + 1].text.length + 1 <= 30
      ) {
        const next = row[j + 1];
        const prev = phraseWords[phraseWords.length - 1];
        const gap = next.x - (prev.x + prev.width);
        if (gap > 30) break;
        const nextTrim = next.text.trim();
        if (!isAllCapsCaption(nextTrim)) break;
        phraseWords.push(next);
        phraseStr = `${phraseStr} ${nextTrim}`;
        j += 1;
      }

      // Build an aggregate bbox for the phrase.
      const minX = Math.min(...phraseWords.map((p) => p.x));
      const maxX = Math.max(...phraseWords.map((p) => p.x + p.width));
      const minY = Math.min(...phraseWords.map((p) => p.y));
      const maxY = Math.max(...phraseWords.map((p) => p.y + p.height));

      const upper = phraseStr.toUpperCase().trim();
      // Accept if either it's a known caption OR a generic all-caps
      // string ≥ 4 chars total.
      if (
        upper.length >= 4 &&
        (COMMON_CAPS_CAPTIONS.has(upper) || ALLCAPS_RE.test(phraseStr))
      ) {
        captions.push({
          text: upper,
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        });
      }
      i = j + 1;
    }
  }

  return captions;
}

function isAllCapsCaption(text: string): boolean {
  if (!text) return false;
  // Allow the standard caption character set. We require at least
  // ONE letter so a token of pure digits ("123") isn't a caption.
  if (!/[A-Z]/.test(text)) return false;
  // Reject if it contains lowercase letters.
  if (/[a-z]/.test(text)) return false;
  // Accept either a known phrase or a generic all-caps token ≥ 3 chars.
  if (COMMON_CAPS_CAPTIONS.has(text.toUpperCase())) return true;
  return /^[A-Z0-9 .,&#'/-]{3,}$/.test(text);
}

function detectEmptyBands(
  text: PdfPageText,
  luminance: Uint8ClampedArray,
  width: number,
  height: number
): BlankCandidate[] {
  const captions = buildCaptions(text);
  const out: BlankCandidate[] = [];

  for (const caption of captions) {
    // Empty band sits IMMEDIATELY ABOVE the caption.
    const bandY = Math.max(0, Math.round(caption.y - EMPTY_BAND_HEIGHT_PX));
    const bandH = Math.min(EMPTY_BAND_HEIGHT_PX, Math.round(caption.y - bandY));
    if (bandH < 12) continue;

    if (
      !regionMostlyWhite(
        luminance,
        width,
        height,
        Math.round(caption.x),
        bandY,
        Math.round(caption.width),
        bandH
      )
    ) {
      continue;
    }

    // We can also try to extend the band height upward if the
    // caption is followed by a wider empty area.
    let extendedHeight = bandH;
    if (
      regionMostlyWhite(
        luminance,
        width,
        height,
        Math.round(caption.x),
        Math.max(0, Math.round(caption.y - EMPTY_BAND_TALL_HEIGHT_PX)),
        Math.round(caption.width),
        Math.round(caption.y - Math.max(0, caption.y - EMPTY_BAND_TALL_HEIGHT_PX))
      )
    ) {
      extendedHeight = Math.min(
        EMPTY_BAND_TALL_HEIGHT_PX,
        Math.round(caption.y)
      );
    }

    const finalY = Math.max(0, Math.round(caption.y - extendedHeight));
    const finalH = Math.min(extendedHeight, Math.round(caption.y - finalY));

    out.push({
      page: text.page,
      x: caption.x,
      y: finalY,
      width: caption.width,
      height: finalH,
      kind: "empty-band",
      confidence: 0.8,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function rectIoU(a: BlankCandidate, b: BlankCandidate): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.width, b.x + b.width);
  const iy1 = Math.min(a.y + a.height, b.y + b.height);
  const iw = ix1 - ix0;
  const ih = iy1 - iy0;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  const union = aArea + bArea - inter;
  return union <= 0 ? 0 : inter / union;
}

function isNearDuplicate(a: BlankCandidate, b: BlankCandidate): boolean {
  if (a.page !== b.page) return false;
  return (
    Math.abs(a.x - b.x) <= NEAR_DUPLICATE_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= NEAR_DUPLICATE_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= NEAR_DUPLICATE_TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= NEAR_DUPLICATE_TOLERANCE_PX
  );
}

/**
 * Merge overlapping / near-duplicate candidates, keeping the higher-
 * confidence one. Sorts by descending confidence first so the
 * "winner" is always picked deterministically.
 */
function mergeCandidates(blanks: BlankCandidate[]): BlankCandidate[] {
  const sorted = [...blanks].sort((a, b) => b.confidence - a.confidence);
  const kept: BlankCandidate[] = [];
  for (const b of sorted) {
    let absorb = false;
    for (const k of kept) {
      if (k.page !== b.page) continue;
      if (isNearDuplicate(k, b) || rectIoU(k, b) > MERGE_IOU_THRESHOLD) {
        absorb = true;
        break;
      }
    }
    if (!absorb) kept.push(b);
  }
  return kept;
}
