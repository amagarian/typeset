/**
 * PDF text-layer extraction (v0.4.13 Precision mode).
 *
 * Pulls every word out of a PDF's text layer via pdf.js
 * `getTextContent()`, plus the per-word bounding boxes in BOTH PNG-
 * pixel space (matching the v0.4.9 `renderPagesToPng` output) and PDF
 * user-space points. Downstream:
 *
 *   - The pixel bboxes feed `blankDetector` (which works on rendered
 *     canvases) and `blankContextResolver` (which pairs blanks with
 *     surrounding words).
 *   - The user-space bboxes mirror the rest of the app's coordinate
 *     contract (TemplateField stores user-space rects, and the
 *     v0.4.9 image-pixel-to-user-space helpers in
 *     `geminiFieldDetector.ts` round-trip those rects).
 *
 * Conventions
 *   - All Y coordinates are TOP-DOWN (origin top-left, increasing
 *     downward) — same as the rest of the v0.4.9+ pipeline. pdf.js's
 *     `viewport.transform` already converts the bottom-up PDF user
 *     space into top-down device space, so applying it to each text
 *     item's transform gives us baselines in the same frame as the
 *     rendered PNG.
 *   - We convert from device-space (PNG pixels) → user-space
 *     (PDF points) via the captured per-page render scale, NOT via a
 *     second pdf.js viewport call. This is the same identity used by
 *     `bboxToPdfRect` in `geminiFieldDetector.ts`.
 *   - "Words" are pdf.js text-content items as returned by
 *     `getTextContent()`. pdf.js groups glyphs into runs; one run is
 *     usually one word, but punctuation, line breaks, and font shifts
 *     can split a run mid-word. We emit one PdfWord per non-empty
 *     run; the blank detector and context resolver are responsible for
 *     stitching adjacent runs back into phrases when they need to.
 *
 * Scanned-PDF fallback
 *   - When `getTextContent()` returns 0 items for every page, we
 *     report `hasTextLayer = false`. Callers (`detectFieldsImpl` in
 *     `geminiFieldDetector.ts`) treat that as an automatic fallback
 *     to Maximum mode. Tesseract / OCR is intentionally NOT pulled
 *     into this release — too heavy a dependency for the marginal
 *     fraction of scanned PDFs we see in production paperwork.
 */

import * as pdfjsLib from "pdfjs-dist";

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}

/** One word (or text run) from the PDF's text layer. */
export interface PdfWord {
  /** 1-based page index. */
  page: number;
  /** Raw string contents of this run. May contain whitespace. */
  text: string;
  /**
   * PNG-pixel bbox (origin top-left, matching the rendered image
   * we send to Gemini in v0.4.9+). The `widthPx` / `heightPx` fields
   * on {@link PdfPageText} match the page image we render.
   */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * PDF user-space bbox (origin top-left — same convention as
   * `TemplateField.x/y/width/height` everywhere else in the app).
   */
  pdfX: number;
  pdfY: number;
  pdfWidth: number;
  pdfHeight: number;
}

export interface PdfPageText {
  /** 1-based page index. */
  page: number;
  /** PNG-pixel dimensions used for `x/y/width/height` on each word. */
  widthPx: number;
  heightPx: number;
  /** PDF user-space dimensions used for `pdfX/pdfY/...` on each word. */
  pdfWidthPt: number;
  pdfHeightPt: number;
  /** Words on this page in pdf.js's natural reading order. */
  words: PdfWord[];
  /**
   * True iff `words.length > 0`. Computed once at the page level
   * (in addition to the document-wide `hasTextLayer` callers
   * derive from the array) so a partially scanned doc can be
   * handled per-page if we ever need to.
   */
  hasTextLayer: boolean;
}

/** Per-page render scale captured by `renderPagesToPng` in v0.4.9+. */
export interface PdfRenderScale {
  /** 1-based page index. */
  page: number;
  /** widthPx / pdfWidthPt — image pixels per user-space point on X. */
  scaleX: number;
  /** heightPx / pdfHeightPt — image pixels per user-space point on Y. */
  scaleY: number;
}

/**
 * Run pdf.js `getTextContent()` against every page of `pdfBytes` and
 * return word-level boxes in BOTH PNG-pixel and PDF user-space
 * coordinates.
 *
 * `renderScales` carries the exact scale factor used when each page
 * was rasterized in `renderPagesToPng`. We only need scaleX/scaleY
 * (since image pixel dims = page point dims × scale) — the rest of
 * the PNG geometry is derived from the page's own viewport.
 *
 * The function tolerates missing pages in `renderScales` (defaults to
 * 1.0). It also tolerates a completely empty text layer per page,
 * reporting `hasTextLayer = false` in that case.
 */
export async function extractPdfText(
  pdfBytes: Uint8Array,
  renderScales: PdfRenderScale[]
): Promise<PdfPageText[]> {
  // pdf.js consumes the buffer; copy so the caller's array stays intact.
  const bytesCopy = new Uint8Array(pdfBytes);
  const pdf = await pdfjsLib.getDocument({ data: bytesCopy }).promise;

  const scaleByPage = new Map<number, PdfRenderScale>();
  for (const s of renderScales) scaleByPage.set(s.page, s);

  const out: PdfPageText[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);

      // Base viewport (scale 1) gives us PDF user-space dimensions in
      // points. We DON'T render the page here; rendering happens in
      // `renderPagesToPng`. We just need user-space dims and the
      // viewport.transform so we can convert text item coords to
      // top-down device coords.
      const baseViewport = page.getViewport({ scale: 1 });
      const pdfWidthPt = baseViewport.width;
      const pdfHeightPt = baseViewport.height;

      const captured = scaleByPage.get(pageNumber);
      const scaleX = captured?.scaleX ?? 1;
      const scaleY = captured?.scaleY ?? 1;
      const widthPx = pdfWidthPt * scaleX;
      const heightPx = pdfHeightPt * scaleY;

      const textContent = await page.getTextContent();
      const items = (textContent.items ?? []) as Array<{
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
      }>;

      const words: PdfWord[] = [];
      for (const item of items) {
        const text = typeof item.str === "string" ? item.str : "";
        // Skip blank-only runs — pdf.js emits these for spaces between
        // words. They have no visible glyphs so they can't anchor a
        // blank-detection candidate.
        if (text.trim().length === 0) continue;

        const transform = Array.isArray(item.transform) ? item.transform : null;
        if (!transform || transform.length !== 6) continue;

        // Compose item.transform with viewport.transform to get the
        // text's matrix in TOP-DOWN device space. Element 4/5 of the
        // result is the baseline (bottom-left of the run) in device
        // coords. For horizontal text, font height in device coords
        // is `Math.hypot(tx[2], tx[3])`.
        const tx = pdfjsLib.Util.transform(baseViewport.transform, transform);
        const baselineX = tx[4];
        const baselineY = tx[5];
        const fontHeight = Math.hypot(tx[2], tx[3]);
        if (!Number.isFinite(fontHeight) || fontHeight <= 0) continue;

        // Width is computed in user-space ("scale 1") units by
        // pdf.js. Multiply by the rendered scale to land in pixels.
        // We also support older pdf.js shapes where `item.width`
        // might already be scaled — we always render at scale 1 here
        // for the textContent call, so this is a clean multiply.
        const userSpaceWidth =
          typeof item.width === "number" && item.width > 0 ? item.width : 0;

        // Top of the run in device coords (top-down). The transform
        // gives us the baseline; for horizontal text the glyph
        // extends upward by ~one font height, which in top-down
        // coords means we subtract.
        const topY = baselineY - fontHeight;

        const pdfXLocal = baselineX;
        const pdfYLocal = topY;
        const pdfWidthLocal = userSpaceWidth;
        const pdfHeightLocal =
          typeof item.height === "number" && item.height > 0
            ? item.height
            : fontHeight;

        words.push({
          page: pageNumber,
          text,
          x: pdfXLocal * scaleX,
          y: pdfYLocal * scaleY,
          width: pdfWidthLocal * scaleX,
          height: pdfHeightLocal * scaleY,
          pdfX: pdfXLocal,
          pdfY: pdfYLocal,
          pdfWidth: pdfWidthLocal,
          pdfHeight: pdfHeightLocal,
        });
      }

      out.push({
        page: pageNumber,
        widthPx,
        heightPx,
        pdfWidthPt,
        pdfHeightPt,
        words,
        hasTextLayer: words.length > 0,
      });
    }
  } finally {
    pdf.destroy();
  }

  return out;
}

/** True if no page on the document carries any extractable text. */
export function isScannedPdf(pages: PdfPageText[]): boolean {
  if (pages.length === 0) return true;
  return pages.every((p) => !p.hasTextLayer);
}
