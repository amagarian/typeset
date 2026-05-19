import { PDFDocument, PDFPage, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import type { Project, Template, TemplateField } from "@/types";

// v0.6.14 — pdfjs worker setup. Matches the lazy-init pattern in
// `geminiFieldDetector.ts` so a fill triggered without prior
// detection (e.g. opening a saved template and clicking Fill
// without re-rendering the canvas) still finds the worker.
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}
import {
  getOptionGroupSelection,
  getTemplateFieldValue,
  normalizeCardType,
  repairTemplateMappings,
  type PromptFieldValues,
} from "@/utils/fill";
import { normalizeCardTypeLabel } from "@/utils/fieldCatalog";

import { trimSignatureDataUrl } from "@/utils/signatureImageTrim";

/**
 * v0.6.14 — printed-text rectangle extracted from the source PDF via
 * pdfjs-dist. Coordinates are in PDF user-space points, TOP-DOWN
 * convention to match `TemplateField.x` / `.y` storage (origin at
 * the top-left corner, y increases downward).
 */
interface PrintedTextRect {
  /** Left edge of the text item's bbox, pt. */
  x: number;
  /** Top edge of the text item's bbox, pt (top-down). */
  y: number;
  /** Width of the text item's bbox, pt. */
  width: number;
  /** Height of the text item's bbox, pt. */
  height: number;
  /** The text content. */
  str: string;
}

/**
 * v0.6.14 — load the source PDF with pdfjs-dist and extract every
 * printed-text item's bbox, keyed by 1-based page number. Used at
 * fill time to deterministically detect printed labels that sit
 * INSIDE the bbox Gemini emitted (Layout A1 boxed-cell-prefix case),
 * regardless of whether the system prompt change took effect on the
 * specific form.
 *
 * Returns an empty record on failure. Callers must treat the absence
 * of an entry as "no printed text known" and fall back to the
 * canonical-id-based heuristic (PATH B).
 */
async function extractPrintedTextByPage(
  pdfBytes: Uint8Array
): Promise<Record<number, PrintedTextRect[]>> {
  const result: Record<number, PrintedTextRect[]> = {};
  try {
    // pdfjs mutates the bytes during parse, so feed it a copy.
    const copy = pdfBytes.slice();
    const loadingTask = pdfjsLib.getDocument({
      data: copy,
      // No worker — we're already on a background thread in the
      // Tauri-side write path, and the worker setup adds complexity
      // for marginal speed gain on a 1-2 page form.
      disableFontFace: true,
      isEvalSupported: false,
    });
    const doc = await loadingTask.promise;
    for (let pageIdx = 1; pageIdx <= doc.numPages; pageIdx++) {
      const page = await doc.getPage(pageIdx);
      const viewport = page.getViewport({ scale: 1 });
      const pageHeightPt = viewport.height;
      const textContent = await page.getTextContent();
      const rects: PrintedTextRect[] = [];
      type RawTextItem = {
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
      };
      for (const raw of textContent.items as RawTextItem[]) {
        const str = (raw.str ?? "").replace(/\s+/g, " ");
        if (!str.trim()) continue;
        const transform = raw.transform;
        if (!Array.isArray(transform) || transform.length < 6) continue;
        const xUserSpace = transform[4];
        const yBottomUp = transform[5];
        const w = typeof raw.width === "number" ? raw.width : 0;
        // pdfjs encodes the rendered font size in transform[3]; use
        // its absolute value as a generous height proxy for vertical
        // overlap checks. Fallback to raw.height or 10pt if missing.
        const h =
          typeof raw.height === "number" && raw.height > 0
            ? raw.height
            : Math.abs(transform[3] ?? 10);
        if (!Number.isFinite(xUserSpace) || !Number.isFinite(yBottomUp)) continue;
        // Convert bottom-up baseline → top-down top-of-bbox.
        // Baseline sits ~0.8 × cap-height below the bbox top; we use
        // h directly as a conservative top-of-bbox proxy.
        const yTopDown = pageHeightPt - yBottomUp - h;
        rects.push({ x: xUserSpace, y: yTopDown, width: w, height: h, str });
      }
      result[pageIdx] = rects;
    }
    try {
      await doc.cleanup();
      await doc.destroy();
    } catch {
      // Cleanup is best-effort; ignore failures.
    }
  } catch (err) {
    console.warn(
      "[pdfWriter] Failed to extract printed text; falling back to heuristic shift only.",
      err
    );
  }
  return result;
}

/**
 * v0.6.14 — find the rightmost edge of any printed text inside a
 * field's bbox whose center sits in the LEFT 60% of the bbox. The
 * "left 60%" gate ensures we only grab printed PREFIX labels (which
 * sit at the bbox's left edge by definition) rather than printed
 * suffix tails like `per rental` on a `Charge up to a limit of $___
 * per rental` row — those sit at the right edge and would yield a
 * misleading shift target.
 *
 * Vertical overlap uses simple bbox intersection; horizontal overlap
 * requires the text item's left edge to be inside the field's bbox.
 *
 * Returns the rightmost rightX of any matching text item, in PDF
 * user-space points (top-down convention, same as field.x). Returns
 * null when no qualifying printed text is present — caller falls
 * back to the canonical-id heuristic (PATH B).
 */
function findInternalLabelRightEdge(
  printedRects: PrintedTextRect[],
  field: TemplateField
): number | null {
  if (printedRects.length === 0) return null;
  const fieldLeft = field.x;
  const fieldRight = field.x + field.width;
  const fieldTop = field.y;
  const fieldBottom = field.y + field.height;
  // Allow text items to extend slightly above/below the bbox; form
  // labels often sit with a baseline very close to the bbox bottom.
  const vTol = Math.max(2, field.height * 0.25);

  // The shift target is the rightmost RIGHT-EDGE of any qualifying
  // text item, capped at the LEFT 60% of the bbox. Items whose right
  // edge sits past 60% are either values we don't want to shift past
  // (the user's existing pre-fill or AcroForm flatten residue) or
  // suffix tails like `per rental` / `(date)` that should never
  // anchor a shift.
  const leftHalfRight = field.x + field.width * 0.6;

  let rightmost: number | null = null;
  for (const rect of printedRects) {
    if (!rect.str.trim()) continue;
    const itemLeft = rect.x;
    const itemRight = rect.x + rect.width;
    const itemTop = rect.y;
    const itemBottom = rect.y + rect.height;
    // Vertical band check (with tolerance both sides).
    if (itemBottom < fieldTop - vTol) continue;
    if (itemTop > fieldBottom + vTol) continue;
    // Horizontal: the item's right edge must sit INSIDE the field
    // bbox (between the field's left edge and the left-60% mark).
    // This catches THREE shapes of printed text relevant to a shift:
    //   1. Label entirely INSIDE the bbox (itemLeft ≥ fieldLeft).
    //   2. Label SPILLING IN from the left (itemLeft < fieldLeft
    //      but itemRight is inside the bbox). v0.6.14 missed this
    //      case, so the `CVV2/Security Code:` label whose bbox
    //      started mid-word kept overlapping the value.
    //   3. Label whose right edge is exactly at the bbox left edge
    //      is OUTSIDE the bbox — don't shift.
    if (itemRight <= fieldLeft + 1) continue;
    if (itemRight > leftHalfRight) continue;
    if (itemLeft > fieldRight + 1) continue;

    if (rightmost === null || itemRight > rightmost) {
      rightmost = itemRight;
    }
  }
  // Clamp the returned edge to NEVER exceed the bbox's left-60% mark
  // even if the qualifying item ends exactly at it — gives the value
  // room to actually render in the writable portion.
  if (rightmost === null) return null;
  return Math.min(rightmost, leftHalfRight);
}

function isCheckboxField(field: TemplateField): boolean {
  return (
    field.fieldType === "checkbox" ||
    field.fieldKind === "checkbox-group" ||
    field.fieldKind === "boolean-checkbox"
  );
}

function isSignatureField(field: TemplateField): boolean {
  return (
    field.fieldKind === "signature" ||
    field.canonicalFieldId === "cardholderSignature" ||
    field.mappedProjectKey === "cardholderSignature"
  );
}

/**
 * v0.5.25 — option-group field check. Identifies the
 * card-type-style horizontal label list the user circles to indicate
 * their selection. The `pdfWriter` draws a hand-drawn-style oval
 * around the selected option's bbox at fill time.
 */
function isOptionGroupField(field: TemplateField): boolean {
  return field.fieldType === "option-group" || field.fieldKind === "option-group";
}

function fitTextToWidth(text: string, width: number, font: any, fontSize: number): string {
  if (!text) return "";
  const maxWidth = Math.max(0, width - 6);
  if (maxWidth <= 0) return text;
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;

  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  const cut = Math.max(0, lo - 1);
  return text.slice(0, cut) + ellipsis;
}

/**
 * v0.6.11 — Layout-A1 (boxed-cell-with-prefix-label) mitigation. Some
 * forms (e.g. Keslow's CC Authorization grid) draw a table where each
 * cell has the printed label as a PREFIX inside the cell, with the
 * writable area to the RIGHT of the colon — `| Cardholder's Name: __ |`.
 * Gemini sometimes emits a bbox covering the WHOLE cell, which causes
 * the renderer to drop the user's value on top of the printed label.
 *
 * Returns the leftward offset (pt, in PDF user-space) the renderer
 * should use to skip past the printed prefix. Returns 0 (no shift)
 * when there's no signal that the label sits inside the bbox.
 *
 * Two trigger paths (either fires the shift, both gated by the same
 * disqualifiers):
 *
 *   PATH A — explicit colon. `printedLabel` ends with a colon
 *   (`:` or `：`), AND bbox is at least ~100pt wide, AND
 *   `contextBefore` doesn't already echo the printed label.
 *
 *   PATH B — known label-prefix canonical (v0.6.12). The field maps
 *   to one of a small set of canonicals that are ALWAYS labelled with
 *   a printed prefix in real-world boxed-cell layouts (cardholder
 *   name, billing address, security code, etc.), AND the bbox is
 *   ≥ ~150pt wide, AND `contextBefore` doesn't already echo the
 *   printed label, AND the field is text-typed. Gemini's `raw.label`
 *   is a Title-Case description (e.g. `"Cardholder Name"`, no colon),
 *   so PATH A misses canonical-mapped fields where the form's literal
 *   prefix has a colon. PATH B catches those.
 *
 * Shared disqualifiers:
 *   - Field is checkbox / option-group / signature (signatures get
 *     their own image-or-typed render path; checkboxes draw glyphs).
 *   - `contextBefore` echoes the printed-label stem → label sits
 *     OUTSIDE the bbox to the left and the bbox already starts past
 *     the colon. Shifting would push the value off the right edge.
 *
 * The shift width is `widthOf(measureLabel) + 4pt` where
 * `measureLabel` is `printedLabel` (path A) or `printedLabel + ":"`
 * fallback (path B; we add a virtual colon so the measurement matches
 * what the form actually prints). The shift is clamped to `0.6 *
 * field.width` so even when the heuristic fires on a wrong label we
 * never push past the bbox midpoint.
 */
/**
 * v0.6.13 — per-canonical minimum-shift table. Gemini's `raw.label`
 * is a short Title-Case description (`"Cardholder Name"`, `"CVV"`),
 * but the form's PRINTED prefix label is usually longer (e.g.
 * `"Cardholder's Name:"`, `"CVV2/Security Code:"`). Measuring the
 * canonical name alone underestimates the shift on the Keslow CC
 * Auth grid, leaving the value's first few characters on top of the
 * tail of the printed label.
 *
 * The minimum-shift values below are the typical PRINTED prefix
 * widths at 12pt across the real-world corpus we test against (a
 * mix of Keslow, Arrow, 204, and Hollywood Depot CC-auth grids).
 * The actual shift used is `max(measuredLabelWidth + 4, perCanonicalMin)`,
 * then clamped to `0.5 * field.width` so even a wildly wrong canonical
 * mapping can never shift past the bbox midpoint.
 */
const LABEL_PREFIX_MIN_SHIFT_BY_CANONICAL: Record<string, number> = {
  creditCardHolder: 100, // "Cardholder's Name:"
  billingAddress: 95, // "Billing Address:" / "Cardholder Billing Address:"
  ccv: 120, // "CVV2/Security Code:" / "CVV (3 digit):"
  cardholderSignature: 65, // "Signature:"
  creditCardNumber: 55, // "Card #:" (short) — wider when "Credit Card Number:"
  phone: 60, // "Phone Number:" / "Phone:"
  email: 55, // "Email:" / "Email Address:"
  authorizationDate: 250, // "Authorization is valid through (MM/DD/YYY):"
  cardType: 65, // "Card Type:" / "Type:"
};

function computePrefixLabelShiftX(
  field: TemplateField,
  font: any,
  fontSize: number
): number {
  if (
    isCheckboxField(field) ||
    isSignatureField(field) ||
    isOptionGroupField(field)
  ) {
    return 0;
  }

  const printed = (field.printedLabel ?? "").trim();
  if (!printed) return 0;

  const endsWithColon = /[:：]\s*$/.test(printed);
  const canonicalId =
    typeof field.canonicalFieldId === "string"
      ? field.canonicalFieldId
      : undefined;
  const canonicalMin =
    canonicalId && canonicalId in LABEL_PREFIX_MIN_SHIFT_BY_CANONICAL
      ? LABEL_PREFIX_MIN_SHIFT_BY_CANONICAL[canonicalId]
      : 0;
  const canonicalMatch = canonicalMin > 0;

  // PATH A (explicit colon in printedLabel) — width gate 100pt.
  // PATH B (canonical-min only) — width gate 180pt. Canonical-only
  // paths are riskier than the explicit-colon path, so we demand a
  // wider bbox before shifting to prevent over-shifting a narrow
  // genuinely-post-colon writable area (e.g. an EXP cell).
  const widthOk =
    (endsWithColon && field.width >= 100) ||
    (canonicalMatch && field.width >= 180);
  if (!widthOk) return 0;

  // v0.6.13 — only treat `contextBefore` as a "label sits OUTSIDE
  // bbox to the LEFT" signal when the printed-label stem appears in
  // the LAST ~40 chars of contextBefore. A contains-anywhere check
  // was too loose: Gemini sometimes packs the entire row's leading
  // sentence into context_before regardless of where the bbox
  // actually starts, so the stem could appear mid-string even when
  // the bbox engulfs the printed label.
  const ctx = (field.contextBefore ?? "").trim().toLowerCase();
  if (ctx.length > 0) {
    const stem = printed
      .toLowerCase()
      .replace(/[:：]\s*$/, "")
      .trim();
    if (stem.length >= 4) {
      const probe = stem.slice(0, Math.min(stem.length, 16));
      const tail = ctx.slice(Math.max(0, ctx.length - 40));
      if (tail.includes(probe)) return 0;
    }
  }

  const measureLabel = endsWithColon ? printed : `${printed}:`;
  const labelWidth = font.widthOfTextAtSize(measureLabel, fontSize);
  const shift = Math.max(labelWidth + 4, canonicalMin);
  const ceiling = field.width * 0.5;
  return Math.min(shift, ceiling);
}

/**
 * v0.6.8 — shrink the font down to a floor before resorting to
 * ellipsis-truncation. The Arrow CC Authorization Billing Address
 * single-line render at 9pt ran ~30pt past the right edge of the
 * row band, so v0.6.7 chopped it to `1115 W SUNSET BLVD #510, LOS
 * ANGELES, …`. We'd rather see the whole address smaller than half
 * of it at the "correct" size — addresses are short and stay legible
 * down to 6.5pt easily, so we step the size down in 0.5pt increments
 * until the value fits or we hit the floor.
 */
function fitWithShrink(
  text: string,
  width: number,
  font: any,
  baseFontSize: number,
  minFontSize: number = 6.5
): { text: string; fontSize: number } {
  if (!text) return { text: "", fontSize: baseFontSize };
  // v0.6.13 — proportional right margin. A flat 6pt margin worked on
  // 200pt+ bboxes but ate too much of the writable area on narrow
  // boxes (e.g. an EXP cell ~30pt wide that's bbox'd correctly past
  // the colon — 6pt is 20% of the cell, dropping us below the shrink
  // floor for `01/31`). The new floor of 15% of width caps the
  // margin at 6pt for wide bboxes but scales down to ~3pt on narrow
  // cells, letting shrink find a fit.
  const rightMargin = Math.min(6, width * 0.15);
  const maxWidth = Math.max(0, width - rightMargin);
  if (maxWidth <= 0) return { text, fontSize: baseFontSize };
  if (font.widthOfTextAtSize(text, baseFontSize) <= maxWidth) {
    return { text, fontSize: baseFontSize };
  }
  for (let size = baseFontSize - 0.5; size >= minFontSize; size -= 0.5) {
    if (font.widthOfTextAtSize(text, size) <= maxWidth) {
      return { text, fontSize: size };
    }
  }
  return { text: fitTextToWidth(text, width, font, minFontSize), fontSize: minFontSize };
}

export interface WritePdfOptions {
  defaultFontSize?: number;
  promptValues?: PromptFieldValues;
}

/**
 * v0.6.25 — page-tree acquisition with a rasterize-and-overlay
 * fallback for damaged PDFs.
 *
 * Some vendor PDFs ship with structurally invalid object
 * references (the SGPS / ShowRig CC auth form is the motivating
 * example — pdf-lib emits `Invalid object ref: 29 0 R` warnings
 * on load, then `PDFCatalog.Pages` later crashes with
 * `"Expected instance of PDFDict, but got instance of
 * undefined"`). pdfjs-dist is far more tolerant — it can read and
 * render those pages without issue.
 *
 * When the normal pdf-lib load + page enumeration fails, we
 * rasterize each page via pdfjs to a JPEG, build a fresh
 * pdf-lib document with one page per JPEG (preserving the
 * original page dimensions in user-space pt), and continue with
 * the rest of the writer pipeline against THAT doc. The output
 * is image-backed rather than vector — text in the original PDF
 * is no longer selectable — but the form fills correctly and the
 * PDF prints / signs as expected.
 */
async function preparePdfDocForWrite(
  sourcePdfBytes: Uint8Array
): Promise<{ pdfDoc: PDFDocument; pages: PDFPage[]; isFallback: boolean }> {
  try {
    const pdfDoc = await PDFDocument.load(sourcePdfBytes, {
      ignoreEncryption: true,
    });
    try {
      const form = pdfDoc.getForm();
      const fields = form.getFields();
      if (fields.length > 0) {
        console.log(
          `[pdfWriter] Flattening ${fields.length} existing AcroForm fields`
        );
        form.flatten();
      }
    } catch {
      // No form or form access failed — safe to continue.
    }
    // pdf-lib's page-tree resolution is lazy — getPages() may
    // throw on damaged docs even when load() succeeds. Trigger it
    // here so we catch and fall back early, before we've started
    // embedding fonts / drawing.
    const pages = pdfDoc.getPages();
    return { pdfDoc, pages, isFallback: false };
  } catch (err) {
    console.warn(
      `[pdfWriter] pdf-lib load/getPages failed; switching to rasterize-and-overlay fallback. (${
        err instanceof Error ? err.message : String(err)
      })`
    );
    return rasterizePdfWithPdfJsFallback(sourcePdfBytes);
  }
}

async function rasterizePdfWithPdfJsFallback(
  sourcePdfBytes: Uint8Array
): Promise<{ pdfDoc: PDFDocument; pages: PDFPage[]; isFallback: true }> {
  const bytesCopy = new Uint8Array(sourcePdfBytes);
  const pdfjsDoc = await pdfjsLib.getDocument({ data: bytesCopy }).promise;
  const newDoc = await PDFDocument.create();
  const pages: PDFPage[] = [];
  try {
    for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum += 1) {
      const pdfjsPage = await pdfjsDoc.getPage(pageNum);
      const viewportPt = pdfjsPage.getViewport({ scale: 1 });
      // Render at ~2× DPI so the raster looks crisp at 100% zoom
      // in a viewer and prints cleanly. Higher scales bloat file
      // size disproportionately; 2× is a good middle ground.
      const renderScale = 2;
      const renderVp = pdfjsPage.getViewport({ scale: renderScale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(renderVp.width);
      canvas.height = Math.round(renderVp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error(
          `Could not acquire 2D canvas context to rasterize page ${pageNum}.`
        );
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pdfjsPage.render({ canvasContext: ctx, viewport: renderVp })
        .promise;
      // JPEG at 92% quality keeps file size reasonable while
      // preserving form-line legibility. Empty white space
      // compresses extremely well at this quality.
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92)
      );
      if (!blob) {
        throw new Error(`canvas.toBlob returned null for page ${pageNum}.`);
      }
      const jpegBytes = new Uint8Array(await blob.arrayBuffer());
      const pdfImage = await newDoc.embedJpg(jpegBytes);
      // The fresh page uses the ORIGINAL page dimensions in
      // user-space points (not the rasterization scale). All field
      // bboxes in `template.fields` are in user-space pt, so this
      // keeps every coordinate consistent.
      const newPage = newDoc.addPage([viewportPt.width, viewportPt.height]);
      newPage.drawImage(pdfImage, {
        x: 0,
        y: 0,
        width: viewportPt.width,
        height: viewportPt.height,
      });
      pages.push(newPage);
    }
  } finally {
    try {
      await pdfjsDoc.destroy();
    } catch {}
  }
  return { pdfDoc: newDoc, pages, isFallback: true };
}

export async function writeFilledPdfBytes(
  sourcePdfBytes: Uint8Array,
  template: Template,
  project: Project,
  options: WritePdfOptions = {}
): Promise<Uint8Array> {
  // v0.6.22 — vendor PDFs are frequently saved with "Restrict
  // editing" / owner-password encryption (Acrobat's default when
  // someone hits "Protect → Restrict Editing"). pdf-lib refuses to
  // load these by default and surfaces:
  //   "Input document to `PDFDocument.load` is encrypted."
  // The AcroForm ingestor already passes `ignoreEncryption: true`
  // (see `acroFormIngest.ts`), so failing here while succeeding
  // there left the user with detected fields but a broken export.
  // Matching the ingestor's flag closes that gap. Owner-password
  // restrictions are cosmetic — pdf-lib still reads + writes the
  // page contents — so the resulting filled PDF is valid.
  //
  // v0.6.25 — `preparePdfDocForWrite` also adds a
  // rasterize-and-overlay fallback for PDFs whose object refs are
  // structurally damaged (pdf-lib crashes at `PDFCatalog.Pages`
  // with "Expected instance of PDFDict, but got instance of
  // undefined"). pdfjs handles those PDFs fine, so we
  // re-rasterize via pdfjs and overlay fields on the raster.
  const { pdfDoc, pages, isFallback } = await preparePdfDocForWrite(
    sourcePdfBytes
  );
  if (isFallback) {
    console.warn(
      "[pdfWriter] Rasterize-and-overlay fallback in use. The exported PDF " +
        "will be image-backed; text in the source PDF will no longer be " +
        "selectable, but field values will overlay correctly."
    );
  }
  // v0.6.14 — extract every printed-text rectangle from the source
  // PDF up front so the per-field loop can deterministically
  // shift the rendered value past any printed prefix label sitting
  // INSIDE the bbox (Layout A1 boxed-cell-prefix forms). This runs
  // ONCE per fill, not per field, and falls back to {} on failure.
  // Note: we still extract from the SOURCE bytes (not the fallback
  // doc), because pdfjs is more lenient than pdf-lib and the
  // printed-text positions live in the source PDF's user-space
  // coordinates, which `template.fields` was detected against.
  const printedTextByPage = await extractPrintedTextByPage(sourcePdfBytes);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const signatureFont = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic);

  const defaultFontSize = options.defaultFontSize ?? 10;
  const promptValues = options.promptValues ?? {};

  const repairedTemplate = repairTemplateMappings(template);
  const siblingKeys = new Set(
    repairedTemplate.fields.map((f) => f.mappedProjectKey).filter(Boolean)
  );

  // v0.6.0 — signature image embed. We embed the user-uploaded
  // signature image (if any) ONCE up front and re-use the resulting
  // PDFImage object for every signature field. pdf-lib only ships
  // `embedPng` / `embedJpg`; SVGs are pre-rasterized to PNG by the
  // upload handler in `ProjectDetailForm.tsx`, so by the time we
  // get here the dataUrl always starts with `data:image/png` or
  // `data:image/jpeg`. If the dataUrl is malformed or pdf-lib
  // rejects the bytes, we silently fall back to the typed-Caveat
  // signature path — better to ship a typed signature than a
  // broken PDF.
  let signatureImagePdf: import("pdf-lib").PDFImage | undefined;
  if (project.signatureImage?.dataUrl) {
    const dataUrl = project.signatureImage.dataUrl;
    try {
      const trimmed = await trimSignatureDataUrl(dataUrl);
      const commaIdx = trimmed.indexOf(",");
      if (commaIdx > 0) {
        const meta = trimmed.slice(0, commaIdx);
        const b64 = trimmed.slice(commaIdx + 1);
        const isPng = /image\/png/i.test(meta);
        const isJpeg = /image\/jpe?g/i.test(meta);
        if (isPng || isJpeg) {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          signatureImagePdf = isPng
            ? await pdfDoc.embedPng(bytes)
            : await pdfDoc.embedJpg(bytes);
        }
      }
    } catch (err) {
      console.warn(
        "[pdfWriter] Failed to embed signature image; falling back to typed signature.",
        err
      );
      signatureImagePdf = undefined;
    }
  }

  for (const field of repairedTemplate.fields) {
    // v0.6.29 — vendor (counterparty) fields are NEVER filled by
    // Wrapkit. They're left blank in the output PDF for the other
    // party to fill in by hand or with their own software. This
    // mirrors the no-prompt behaviour in `getPromptFields`. See
    // `annotateFieldsWithParty` in `geminiFieldDetector.ts` for
    // the tagging heuristic.
    if (field.party === "vendor") continue;

    const pageIndex = Math.max(0, Math.min(pages.length - 1, field.pageNumber - 1));
    const page = pages[pageIndex];

    const pageHeight = page.getHeight();

    // v0.5.25 — option-group fields render BEFORE the value gate
    // because their "value" is the selected option label rather than
    // a project-string lookup. We skip cleanly when nothing is
    // selected (no oval drawn — fill-time skip yields a blank field).
    if (isOptionGroupField(field)) {
      if (!Array.isArray(field.options) || field.options.length === 0) continue;
      const selectedLabel = getOptionGroupSelection(
        project,
        field,
        promptValues
      );
      if (!selectedLabel) continue;
      const targetLabel = selectedLabel.toLowerCase();
      const targetNormalised = normalizeCardTypeLabel(selectedLabel);
      const chosen = field.options.find((opt) => {
        if (opt.label.toLowerCase() === targetLabel) return true;
        if (
          targetNormalised &&
          normalizeCardTypeLabel(opt.label) === targetNormalised
        ) {
          return true;
        }
        return false;
      });
      if (!chosen) continue;

      // v0.6.0 (B4) — shared-stroke X. When the field carries a
      // single shared underline (`sharedUnderline === true` with
      // `sharedUnderlineRect`), the chosen option's mark is an X
      // centred horizontally on the option label's x-centre and
      // vertically on the shared stroke. We render BEFORE the
      // per-option blank check because shared-stroke and per-
      // option blanks are mutually exclusive paths in the
      // detector — but the field-level shared marker takes
      // priority over any option-level oval that would
      // otherwise apply.
      if (field.sharedUnderline && field.sharedUnderlineRect) {
        const xRect = field.sharedUnderlineRect;
        const optCenterX = chosen.bbox.x + chosen.bbox.width / 2;
        const xSize = Math.max(8, chosen.bbox.height * 0.8);
        const half = xSize / 2;
        const cx = optCenterX;
        const cyTopDown = xRect.y + xRect.height / 2;
        const cyPdf = pageHeight - cyTopDown;
        const color = rgb(0.08, 0.08, 0.08);
        const thickness = Math.max(1, xSize * 0.12);
        page.drawLine({
          start: { x: cx - half, y: cyPdf - half },
          end: { x: cx + half, y: cyPdf + half },
          thickness,
          color,
        });
        page.drawLine({
          start: { x: cx - half, y: cyPdf + half },
          end: { x: cx + half, y: cyPdf - half },
          thickness,
          color,
        });
        continue;
      }

      // v0.5.36 — X-on-blank rendering. Forms whose option-group
      // options carry a writable `___` blank to the LEFT of each
      // label (e.g. `___ Visa  ___ Mastercard`) get the chosen
      // option's blank rect marked with a hand-written-style X
      // glyph instead of the v0.5.25 oval around the label. The
      // X mirrors the on-canvas review rendering in
      // `DraggableField.tsx` — two crossed lines centred on
      // `blankRect`, sized to ~80% of its height — so what the
      // user reviews on the canvas matches the printed result.
      // `hasUnderlineBlank` and `blankRect` are populated by
      // `optionBlankDetector.ts` during the detection pipeline
      // (v0.5.36 wiring in `geminiFieldDetector.ts`).
      if (chosen.hasUnderlineBlank && chosen.blankRect) {
        const xRect = chosen.blankRect;
        const xSize = Math.max(4, xRect.height * 0.8);
        const half = xSize / 2;
        const cx = xRect.x + xRect.width / 2;
        // The blank rect is stored top-down (pageHeight-anchored
        // origin matches `TemplateField.y` storage). Flip its
        // top-down y-centre to pdf-lib's bottom-up convention by
        // subtracting the centre's distance from the top of the
        // page.
        const cyTopDown = xRect.y + xRect.height / 2;
        const cyPdf = pageHeight - cyTopDown;
        const color = rgb(0.08, 0.08, 0.08);
        // Stroke thickness scales with the X size so the mark
        // reads as a single confident pen stroke at any scale —
        // ~12% of the X arm length, with a 1pt floor for very
        // small blanks.
        const thickness = Math.max(1, xSize * 0.12);

        page.drawLine({
          start: { x: cx - half, y: cyPdf - half },
          end: { x: cx + half, y: cyPdf + half },
          thickness,
          color,
        });
        page.drawLine({
          start: { x: cx - half, y: cyPdf + half },
          end: { x: cx + half, y: cyPdf - half },
          thickness,
          color,
        });
        continue;
      }

      // Hand-drawn-style oval around the selected option's bbox. ~3pt
      // padding on each side, ~1pt stroke. pdf-lib's `drawEllipse`
      // takes a center point + xScale/yScale (radii), drawing a true
      // ellipse with no fill. The slight imperfection users perceive
      // as hand-drawn comes naturally from the rounded geometry; we
      // don't try to wobble the path because pdf-lib's stroke
      // renderer is exact, and a wobble would feel artificial.
      const padding = 3;
      const ovalCenterX = chosen.bbox.x + chosen.bbox.width / 2;
      const ovalCenterYTop = chosen.bbox.y + chosen.bbox.height / 2;
      const ovalCenterYPdf = pageHeight - ovalCenterYTop;
      const ovalRx = chosen.bbox.width / 2 + padding;
      const ovalRy = chosen.bbox.height / 2 + padding;

      page.drawEllipse({
        x: ovalCenterX,
        y: ovalCenterYPdf,
        xScale: ovalRx,
        yScale: ovalRy,
        borderColor: rgb(0.08, 0.08, 0.08),
        borderWidth: 1.0,
      });
      continue;
    }

    const rawValue = getTemplateFieldValue(project, field, promptValues, siblingKeys);
    // v0.6.0 — signature fields fall through the empty-value gate
    // when an uploaded signature image is available, even if the
    // typed-Caveat string is blank. The image alone is enough to
    // render the field.
    if (!rawValue && !(isSignatureField(field) && signatureImagePdf)) continue;

    const x = field.x;
    const yPdfBottom = pageHeight - (field.y + field.height);

    if (isCheckboxField(field)) {
      const isCreditCardCheckbox = field.canonicalFieldId?.startsWith("creditCardType");
      const shouldCheck = isCreditCardCheckbox
        ? field.checkboxValue && normalizeCardType(rawValue) === normalizeCardType(field.checkboxValue)
        : rawValue === "yes";

      if (shouldCheck) {
        const s = Math.min(field.width, field.height) * 0.7;
        const cx = x + field.width / 2;
        const cy = yPdfBottom + field.height / 2;
        const color = rgb(0.1, 0.1, 0.1);
        const thickness = Math.max(1.2, s * 0.15);

        page.drawLine({
          start: { x: cx - s / 2, y: cy },
          end: { x: cx - s / 6, y: cy - s / 2.5 },
          thickness,
          color,
        });
        page.drawLine({
          start: { x: cx - s / 6, y: cy - s / 2.5 },
          end: { x: cx + s / 2, y: cy + s / 2.5 },
          thickness,
          color,
        });
      }
    } else if (isSignatureField(field)) {
      // v0.6.0 — image-first signature rendering. If the user
      // uploaded a signature image, scale it to fit the field bbox
      // while preserving aspect ratio and centre it horizontally
      // inside the field width with a small inset (~3pt) so the
      // image doesn't bleed into the form's underline or column
      // border. Falls through to the typed-Caveat path when no
      // image is uploaded OR when the embed step at the top of the
      // function failed.
      if (signatureImagePdf) {
        const insetX = 3;
        const insetY = 2;
        const availW = Math.max(1, field.width - 2 * insetX);
        const availH = Math.max(1, field.height - 2 * insetY);
        const imgW = signatureImagePdf.width;
        const imgH = signatureImagePdf.height;
        const contain = Math.min(availW / Math.max(imgW, 1), availH / Math.max(imgH, 1));
        const scale = Math.max(0.05, Math.min(1, contain * 0.94));
        const drawW = imgW * scale;
        const drawH = imgH * scale;
        const drawX = x + (field.width - drawW) / 2;
        // Bottom-align inside the field so the ink sits on the signature line.
        const drawY = yPdfBottom + insetY;
        page.drawImage(signatureImagePdf, {
          x: drawX,
          y: drawY,
          width: drawW,
          height: drawH,
        });
      } else {
        const baseFontSize = field.estimatedFontSize
          ? field.estimatedFontSize * 3
          : Math.floor(field.height * 0.85);
        const sigFontSize = Math.max(10, Math.min(28, baseFontSize));
        const value = fitTextToWidth(rawValue, field.width, signatureFont, sigFontSize);

        page.drawText(value, {
          x: x + 3,
          y: yPdfBottom + Math.max(4, (field.height - sigFontSize) / 2) + 2,
          size: sigFontSize,
          font: signatureFont,
          color: rgb(0.08, 0.08, 0.08),
        });
      }
    } else {
      // v0.6.5 — multiline-aware rendering. v0.6.6 broadened the
      // trigger from `fieldKind === "multiline"` to also include any
      // single-line field whose value contains a newline.
      // v0.6.7 rebuilt the baseline math: line 1's baseline sits
      // ~1pt below the TOP edge of the bbox (treating the bbox top as
      // the first underline level — which matches how detection
      // emits address-block bboxes), and subsequent lines step down
      // by a `rowHeight` estimated from either the bbox-vs-line-count
      // ratio or `fontSize × 1.25`, whichever is larger. This keeps
      // a single-line value on the FIRST underline of a tall merged
      // bbox instead of the geometric centre.
      const valueHasNewline = rawValue.includes("\n");
      const isMultiline = field.fieldKind === "multiline" || valueHasNewline;
      // v0.6.10 — bumped left padding from 7pt → 10pt. 7pt revealed
      // the asterisk after `(MM/YY)` (which v0.6.7 had been covering)
      // but the `01/31` still sat flush against it. 10pt clears a
      // typical caption tail like `(MM/YY)*` cleanly, and on wider
      // fields the value still has plenty of room before the right
      // edge.
      const baseInsetX = 10;

      // v0.6.11 — pick the rendering font size up-front so the
      // Layout-A1 prefix-label width measurement happens at the same
      // size we'll actually draw at. Mirrors the shrink-on-fit logic
      // below; the per-branch `baseFontSize` is recomputed inside
      // each branch but starts from the same numbers.
      let probeFontSize = defaultFontSize;
      if (field.estimatedFontSize) {
        probeFontSize = Math.max(
          7,
          Math.min(16, Math.round(field.estimatedFontSize * 1.5))
        );
      } else if (!isMultiline && field.height > 0) {
        probeFontSize = Math.max(7, Math.min(12, Math.floor(field.height * 0.75)));
      }

      // v0.6.14 — deterministic shift from extracted printed text.
      // If pdfjs found any printed text item inside the field's bbox
      // whose left edge sits in the LEFT 60% of the bbox, the value
      // MUST render past the rightmost such item. This is the
      // strongest signal we can get for boxed-cell prefix labels and
      // it works even when Gemini emits a bbox that engulfs the
      // printed label (the case the v0.6.11 system prompt fix
      // failed to correct reliably on the Keslow form).
      const pagePrinted = printedTextByPage[field.pageNumber] ?? [];
      const printedRightEdge = isCheckboxField(field) || isSignatureField(field) || isOptionGroupField(field)
        ? null
        : findInternalLabelRightEdge(pagePrinted, field);
      const printedShift =
        printedRightEdge !== null
          ? Math.max(0, printedRightEdge - field.x + 6)
          : 0;

      const heuristicShift = computePrefixLabelShiftX(field, font, probeFontSize);
      // Whichever shift is larger wins. Clamp to 60% of width as a
      // hard upper bound so a wildly-wrong measurement (e.g. pdfjs
      // returning a stray decoration item) cannot push past the bbox
      // midpoint.
      const combinedShift = Math.min(
        field.width * 0.6,
        Math.max(printedShift, heuristicShift)
      );
      const insetX = Math.max(baseInsetX, combinedShift > 0 ? combinedShift : 0);

      if (isMultiline) {
        const lines = rawValue.split(/\r?\n/).filter((s) => s.length > 0);
        if (lines.length === 0) continue;

        let baseFontSize: number;
        if (field.estimatedFontSize) {
          baseFontSize = Math.max(7, Math.min(16, Math.round(field.estimatedFontSize * 1.5)));
        } else {
          const perLine = field.height / Math.max(1, lines.length);
          baseFontSize = Math.max(7, Math.min(12, Math.floor(perLine * 0.6)));
        }

        let yBaseline = yPdfBottom + field.height - 1;
        // v0.6.13 — restore the v0.6.10 "field.width - (insetX - 3)"
        // formula. v0.6.11 changed this to `field.width - insetX - 3`,
        // which is the mathematically correct net subtraction but
        // shaved 6pt of slack off narrow bboxes — enough to push the
        // post-Layout-A1 EXP cell (now correctly bbox'd at ~30pt
        // starting past the colon) below the shrink-floor and into
        // ellipsis territory ("EXP: 0..."). Restoring the v0.6.10
        // expression buys back the slack while keeping wide bboxes
        // (Cardholder Name, Billing Address) unaffected.
        const usableWidth = Math.max(8, field.width - (insetX - 3));

        for (const line of lines) {
          const { text: fitted, fontSize: actualFontSize } = fitWithShrink(
            line,
            usableWidth,
            font,
            baseFontSize
          );
          page.drawText(fitted, {
            x: x + insetX,
            y: yBaseline,
            size: actualFontSize,
            font,
            color: rgb(0.1, 0.1, 0.1),
          });
          const rowHeight = Math.max(
            actualFontSize * 1.25,
            field.height / Math.max(lines.length, 1)
          );
          yBaseline -= rowHeight;
          if (yBaseline < yPdfBottom - actualFontSize) break;
        }
        continue;
      }

      let baseFontSize = defaultFontSize;
      if (field.estimatedFontSize) {
        baseFontSize = Math.max(7, Math.min(16, Math.round(field.estimatedFontSize * 1.5)));
      } else if (field.height > 0) {
        baseFontSize = Math.max(7, Math.min(12, Math.floor(field.height * 0.75)));
      }

      const usableWidth = Math.max(8, field.width - (insetX - 3));
      const { text: value, fontSize: actualFontSize } = fitWithShrink(
        rawValue,
        usableWidth,
        font,
        baseFontSize
      );

      // v0.6.37 — baseline anchor on the bbox BOTTOM (= stroke),
      // not vertically centered. The detection pipeline places
      // every text-field bbox with `bbox_bottom == stroke_y`
      // (text-baseline geometry; see the v0.5.18 comment block in
      // `geminiFieldDetector.ts`). The correct visual placement is
      // therefore "baseline a few pt above the bottom edge so the
      // typed text sits ON the underline, the way printed labels
      // do". Earlier versions (pre-v0.6.37) used a centered-in-bbox
      // formula `(field.height - fontSize) / 2 + 2`, which works
      // OK for underline-style forms whose bbox height is close to
      // line-height, but breaks on TABLE/GRID forms where the bbox
      // spans a full row cell and is much taller than the font.
      //
      // Real evidence (v0.6.36 CC Auth Form USD): Cardholder
      // (h=24.55, fs=11) → 8.78pt above bottom; Billing Address
      // shrunk to ~7pt to fit a long string (h=26.93, fs=7) →
      // 11.97pt above bottom — text floated near the TOP of the
      // 27pt cell while the printed "Billing Address:" label sat
      // at the cell's BOTTOM border. The shorter the font (after
      // shrink-to-fit), the higher the centered text drifted.
      //
      // Fix: a constant 3pt baseline padding. Text descenders sit
      // safely above the stroke, text caps extend up by the
      // font's cap height (~7pt for 10pt body text), and the
      // visual position is invariant across font sizes — so a
      // shrunken billing address renders flush with the printed
      // label, exactly like an unshrunken cardholder name.
      const baselineAboveBottom = 3;

      page.drawText(value, {
        x: x + insetX,
        y: yPdfBottom + baselineAboveBottom,
        size: actualFontSize,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }

  const bytes = await pdfDoc.save();
  return bytes;
}
