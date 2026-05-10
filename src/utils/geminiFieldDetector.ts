/**
 * Gemini-powered field detection.
 *
 * Flow (image-based as of v0.4.9):
 *
 *   1. Read PDF page sizes via pdfjs (PDF user-space points; we still
 *      need them so the dimensions we report to the canvas/UI match
 *      the points the rest of the app uses).
 *   2. Render every page to a PNG client-side via pdf.js + canvas at
 *      a 2048px long-edge resolution. This is the same approach
 *      Gemini's web app appears to take internally — it eliminates
 *      the systematic vertical offset we saw when sending the PDF
 *      directly (Gemini's internal renderer uses opaque margins/
 *      CropBox handling that don't match pdf.js's MediaBox-based
 *      viewport).
 *   3. Send the resulting PNG bytes to Gemini as `image/png`
 *      `inlineData` parts (one part per page) plus the system+user
 *      prompt and the responseSchema.
 *   4. Parse the strict-JSON response (responseSchema guarantees it
 *      parses).
 *   5. Map Gemini's 0-1000 normalized bboxes → image-pixel space →
 *      PDF user-space using the captured per-page render scale.
 *      Coord system is fully deterministic.
 *   6. Resolve canonical ids (alias → pattern → model semantic),
 *      clean up labels, dedupe, and return as `TemplateField[]`.
 *
 * Two-pass mode (v0.4.7+, default = "maximum"):
 *   When the user picks the "Maximum" accuracy preset, we run a second
 *   Gemini round-trip after Pass 1 finishes. Pass 2 sees the SAME page
 *   images plus a structured dump of every field Pass 1 produced, and
 *   returns keep/drop/fix corrections per field. The corrections are
 *   applied deterministically and re-run through `mapToTemplateField`
 *   so the v0.4.5/v0.4.6 type-guard (CVV-as-checkbox → text) cannot
 *   be weakened by a Pass-2 mistake.
 *
 * Two-stage Pass 1 (v0.4.12+, Maximum mode only):
 *   Pass 1 in Maximum mode is split into two Gemini calls. Stage 1a is
 *   a free-form-text round-trip with NO `responseSchema` that asks
 *   Gemini to walk through the form and describe every fillable field
 *   in plain English (location on the page, what the writable area
 *   looks like, label position relative to the blank, expected type,
 *   nuances). Stage 1b is the existing v0.4.11 Pass-1 call (same
 *   system prompt, same `responseSchema`, same image input) with the
 *   Stage-1a text inlined into the system prompt as an authoritative
 *   field-by-field checklist. Pass 2 QC then runs on Stage 1b's
 *   output exactly as it ran on the old single-stage Pass 1's output.
 *   Fast mode is unchanged: still a single-shot Pass 1.
 *
 * Coordinate-system contract with Gemini (v0.4.9+):
 *   - Gemini returns `[y_min, x_min, y_max, x_max]` as integers in the
 *     0-1000 normalized range, per *image*. Y-first ordering.
 *   - bbox_px = bbox_normalized / 1000 * imageDimensionPx (clean: the
 *     model's frame of reference is the image we sent it).
 *   - bbox_pt = bbox_px / scale, where scale_x = imageWidthPx /
 *     pageWidthPt. We carry the per-page scale alongside the bbox
 *     conversion functions.
 *   - PDF user-space points stored on TemplateField are TOP-DOWN: the
 *     renderer (DraggableField) positions fields with `top: y * scale`,
 *     so y=0 is the top of the page. This matches pdf.js's viewport
 *     convention and matches the (top-down) pixel coords Gemini
 *     returns. No Y flip is required.
 */

import * as pdfjsLib from "pdfjs-dist";
import {
  detectFieldsWithGemini,
  detectFieldsWithGeminiImages,
  GeminiNotConfiguredError,
  GeminiApiError,
  subscribeGeminiProgress,
  type GeminiPageImage,
  type GeminiProgress,
} from "@/services/geminiClient";

// Ensure pdf.js worker is configured before the detector kicks off. The
// PdfPageCanvas component sets this on mount, but the detector can run
// before any canvas has been rendered (e.g. immediately on file drop),
// so we set it here too. Idempotent — repeated assignment to the same
// path is harmless.
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}
import { getAccuracyMode, getModelPreference } from "@/services/geminiSettings";
import {
  type CanonicalFieldId,
  type FieldOption,
  type Project,
  type TemplateField,
  type TemplateFieldKind,
  type TemplateMappedProjectKey,
} from "@/types";
import {
  CANONICAL_FIELD_DEFINITIONS,
  normalizeCardTypeLabel,
} from "@/utils/fieldCatalog";
import { normalizeCardType } from "@/utils/fill";
import {
  snapFieldsToUnderlines,
  type PageRender,
} from "@/utils/underlineSnap";

export {
  GeminiNotConfiguredError as ClaudeNotConfiguredError, // back-compat alias
  GeminiNotConfiguredError,
  GeminiApiError,
};

// ---------------------------------------------------------------------------
// Wire types — match the responseSchema 1:1.
// ---------------------------------------------------------------------------

/**
 * One PDF page rasterized to PNG, plus the captured render scale so we
 * can convert image-pixel bboxes back to PDF user-space points
 * losslessly. The page point dimensions are stored alongside the
 * pixel dimensions so coord helpers don't have to cross-index a
 * separate array.
 */
interface RenderedPage {
  pageNumber: number;
  pngBytes: Uint8Array;
  /** Rendered PNG dimensions in pixels. */
  widthPx: number;
  heightPx: number;
  /** PDF user-space dimensions in points (the same numbers the rest
   *  of the app stores on `TemplateField` rectangles). */
  pageWidthPt: number;
  pageHeightPt: number;
  /**
   * Raw RGBA pixel buffer captured from the same canvas the PNG was
   * encoded from. Used by the v0.5.5 vertical-underline snap
   * post-processor (`snapFieldsToUnderlines`) to measure where the
   * actual stroke sits. Optional because synthetic placeholder
   * pages built inside the QC pass don't carry pixels.
   */
  imageData?: ImageData;
  /**
   * v0.5.25 — per-page text-row geometry extracted from pdf.js. Used
   * by the underline-snap text-row fallback (`tryTextRowSnap` in
   * `underlineSnap.ts`) when a field has no detectable underline
   * stroke nearby — we align the bbox bottom to the baseline of the
   * surrounding text row instead. Coordinates are in PDF user-space
   * points, top-down origin (matching `TemplateField` rect storage).
   */
  textRows?: Array<{ yBottom: number; xMin: number; xMax: number }>;
}

interface RawGeminiField {
  /**
   * Optional canonical-field id (from the catalog) when Gemini is sure.
   * Treated as a fallback — see the three-tier resolution in
   * `mapToTemplateField`.
   */
  canonical_field_id?: string | null;
  /** 2-5 word, Title Case label generated from the surrounding sentence. */
  label?: string;
  /** "text" or "checkbox". */
  field_type?: string;
  /** Higher-fidelity kind from the TemplateFieldKind union. */
  field_kind?: string;
  /** 1-based page index. */
  page_number?: number;
  /**
   * Bounding box in Gemini's native normalized coordinate system:
   * `[y_min, x_min, y_max, x_max]`, 0-1000, per page.
   *
   * NOTE the Y-first ordering. We convert to PDF (x, y, w, h) below.
   */
  bbox?: number[];
  /** For checkbox fields: which value triggers this checkbox. */
  checkbox_value?: string | null;
  /** Optional grouping id (e.g. "card-type"). */
  group_id?: string | null;
  /** Optional estimated label font size in pt. */
  estimated_font_size?: number | null;
  /** Whether the field is in an optional / conditional section. */
  optional?: boolean;
  /** Words IMMEDIATELY before the blank on the same row. */
  context_before?: string;
  /** Words IMMEDIATELY after the blank on the same row. */
  context_after?: string;
  /**
   * For `option-group` fields (v0.5.25): the per-option entries.
   * Each entry has a `label` (the option's display text) and a
   * `bbox` in Gemini's normalized 0-1000 `[y_min, x_min, y_max, x_max]`
   * coordinate frame, sized tightly around just that option's label
   * text.
   */
  options?: Array<{ label?: string; bbox?: number[] }>;
}

interface RawGeminiResponse {
  page_count?: number;
  form_type?: string;
  fields?: RawGeminiField[];
}

// ---------------------------------------------------------------------------
// Constants ported from the previous detector.
// ---------------------------------------------------------------------------

const VALID_CANONICAL_IDS = new Set<string>(
  CANONICAL_FIELD_DEFINITIONS.map((d) => d.id)
);

const VALID_FIELD_KINDS = new Set<TemplateFieldKind>([
  "text",
  "multiline",
  "date",
  "signature",
  "checkbox-group",
  "boolean-checkbox",
  "option-group",
]);

const CREDIT_CARD_CHECKBOX_IDS = new Set<CanonicalFieldId>([
  "creditCardTypeVisa",
  "creditCardTypeMastercard",
  "creditCardTypeDiscover",
  "creditCardTypeAmex",
]);

/**
 * Pre-computed [aliasLowercase, canonicalId] pairs sorted by alias
 * length descending so we always match the most specific alias first
 * (e.g. "credit card number" wins over "card").
 */
const ALIAS_INDEX: ReadonlyArray<{ alias: string; id: CanonicalFieldId }> =
  CANONICAL_FIELD_DEFINITIONS.flatMap((def) =>
    def.aliases.map((alias) => ({
      alias: alias.toLowerCase().trim(),
      id: def.id,
    }))
  ).sort((a, b) => b.alias.length - a.alias.length);

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------

/**
 * Long-edge target resolution for the rendered page images we send to
 * Gemini.
 *
 * Why 2048:
 *   - Gemini accepts inline images up to 20MB total. A 2048-long-edge
 *     PNG of a US-letter form is ~600-1500 KB; a 4-page form fits
 *     comfortably under the inline budget with headroom to spare.
 *   - At 2048px, body text on a standard 8.5×11 form (the dominant
 *     case in this corpus) renders at ~24px tall — well above the
 *     legibility threshold for OCR/multimodal models.
 *   - Lower (e.g. 1536) starts losing fine print and the model emits
 *     fewer / wronger field detections; higher (e.g. 3072) burns
 *     bandwidth without measurable accuracy gains in our forms.
 */
const RENDER_LONG_EDGE_PX = 2048;

/**
 * Render every page of the PDF to a PNG via pdf.js + canvas at a
 * 2048-long-edge resolution. Returns the PNG bytes plus the captured
 * pixel/point dimensions for each page. Used by the v0.4.9+ image-
 * based detection flow.
 *
 * pdf.js's viewport coordinate system is top-down (y=0 is the top of
 * the page), so the rendered PNG has the same top-down origin as the
 * field rectangles we store on `TemplateField`. No Y flip is needed
 * anywhere in the pipeline.
 */
async function renderPagesToPng(
  pdfBytes: Uint8Array,
  onProgress?: (pageNumber: number, totalPages: number) => void
): Promise<RenderedPage[]> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const pdf = await pdfjsLib.getDocument({ data: bytesCopy }).promise;
  const rendered: RenderedPage[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress?.(pageNumber, pdf.numPages);

      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const longEdge = Math.max(baseViewport.width, baseViewport.height);
      const scale = longEdge > 0 ? RENDER_LONG_EDGE_PX / longEdge : 1;
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new GeminiApiError(
          `Could not acquire 2D canvas context to render page ${pageNumber}.`
        );
      }
      // White background so transparency in the source PDF doesn't
      // produce black areas that Gemini might interpret as filled
      // shapes.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      // v0.5.5 — capture the raw RGBA buffer alongside the PNG so the
      // underline-snap post-processor can scan rows for the actual
      // stroke positions. Reading from the same canvas avoids a
      // second render pass (the canvas is about to be discarded
      // anyway). Wrapped in try/catch because some headless
      // environments throw `SecurityError` from a tainted canvas;
      // the snap pass is a no-op when imageData is missing.
      let imageData: ImageData | undefined;
      try {
        imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch (err) {
        console.warn(
          `[Typeset Diag] Could not capture ImageData for page ${pageNumber}; underline snap will skip this page. (${
            err instanceof Error ? err.message : String(err)
          })`
        );
      }

      // v0.5.25 — pull text-row geometry off the same page object
      // (one extra `getTextContent` call per page; cheap relative to
      // the canvas render). Used by the underline-snap text-row
      // fallback when a field has no detectable underline.
      let textRows:
        | Array<{ yBottom: number; xMin: number; xMax: number }>
        | undefined;
      try {
        textRows = await extractTextRows(page, baseViewport.height);
      } catch (err) {
        console.warn(
          `[Typeset Diag] Could not extract text-row geometry for page ${pageNumber}; text-row fallback will skip this page. (${
            err instanceof Error ? err.message : String(err)
          })`
        );
      }

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png")
      );
      if (!blob) {
        throw new GeminiApiError(
          `canvas.toBlob returned null for page ${pageNumber}.`
        );
      }
      const arrayBuffer = await blob.arrayBuffer();

      rendered.push({
        pageNumber,
        pngBytes: new Uint8Array(arrayBuffer),
        widthPx: canvas.width,
        heightPx: canvas.height,
        pageWidthPt: Math.round(baseViewport.width),
        pageHeightPt: Math.round(baseViewport.height),
        imageData,
        textRows,
      });
    }
  } finally {
    pdf.destroy();
  }

  return rendered;
}

/**
 * v0.5.25 — extract text rows from a pdf.js page. A "row" is a
 * cluster of text items at approximately the same baseline (we
 * round `transform[5]` to within 2pt). For each row we report:
 *   - `yBottom`: the baseline y-coordinate in PDF user-space points,
 *     TOP-DOWN origin (matching `TemplateField.y` storage).
 *   - `xMin` / `xMax`: the horizontal extent of the row's combined
 *     text items, in PDF user-space points.
 *
 * pdf.js text items expose a `transform` array whose `[4]`/`[5]`
 * elements are the item's PDF user-space x and BOTTOM-UP y. We flip
 * the y to top-down by subtracting from the page height, so a row
 * whose printed text reads near the top of the page yields a small
 * `yBottom` and a row near the bottom yields a large one — matching
 * how `TemplateField.y` is stored.
 *
 * Empty / whitespace-only items are skipped (they have no x extent
 * worth aligning to). Items whose `width` is 0 or negative are also
 * skipped (degenerate metadata items pdf.js occasionally emits for
 * actual mark sequences inside form fields).
 */
async function extractTextRows(
  page: pdfjsLib.PDFPageProxy,
  pageHeightPt: number
): Promise<Array<{ yBottom: number; xMin: number; xMax: number }>> {
  const textContent = await page.getTextContent();
  // Build a per-row accumulator keyed by rounded baseline y (in
  // bottom-up PDF user-space). 2pt rounding handles the slight jitter
  // between adjacent items on the same baseline (kerned glyphs,
  // superscripts) without merging actual adjacent rows on dense
  // forms (typical row spacing ≥ 10pt, so 2pt rounding never
  // collapses them).
  const ROW_KEY_PT = 2;
  const rows = new Map<
    number,
    { yBottomBottomUp: number; xMin: number; xMax: number }
  >();

  type TextItem = {
    str?: string;
    transform?: number[];
    width?: number;
  };

  for (const item of textContent.items as TextItem[]) {
    const str = (item.str ?? "").trim();
    if (!str) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = transform[4];
    const yBottomUp = transform[5];
    const width = typeof item.width === "number" ? item.width : 0;
    if (!Number.isFinite(x) || !Number.isFinite(yBottomUp) || width <= 0) continue;

    const key = Math.round(yBottomUp / ROW_KEY_PT) * ROW_KEY_PT;
    const existing = rows.get(key);
    if (existing) {
      existing.xMin = Math.min(existing.xMin, x);
      existing.xMax = Math.max(existing.xMax, x + width);
    } else {
      rows.set(key, {
        yBottomBottomUp: yBottomUp,
        xMin: x,
        xMax: x + width,
      });
    }
  }

  return Array.from(rows.values()).map((row) => ({
    yBottom: pageHeightPt - row.yBottomBottomUp,
    xMin: row.xMin,
    xMax: row.xMax,
  }));
}


// ---------------------------------------------------------------------------
// Prompt + schema
// ---------------------------------------------------------------------------

function buildCatalogSummary(): string {
  return CANONICAL_FIELD_DEFINITIONS.map(
    (def) =>
      `  - ${def.id} ("${def.label}", aliases: ${def.aliases.slice(0, 4).join(", ")})`
  ).join("\n");
}

/**
 * The shared system-prompt body used by:
 *   - Fast-mode single-shot Pass 1 (`runPass1Single`).
 *   - Maximum-mode Stage 1b (`runStage1b`), which prepends a
 *     description-from-Stage-1a preamble to this body before sending.
 *
 * Designed to mirror Gemini's desktop-client behaviour: ask for a clean
 * structured-JSON response, not for the model to "show its work" or
 * run any tool. The input is one or more page IMAGES (rendered from
 * the underlying PDF client-side), which removes any ambiguity in the
 * bbox→pixel coordinate mapping.
 */
function buildPass1SharedSystemPrompt(): string {
  return [
    "You are extracting fillable form fields from one or more page IMAGES of a paper/PDF form for a film-production assistant. Each image is a single page of the form, in page order.",
    "Return ONLY a JSON object that conforms to the supplied responseSchema. No prose, no markdown fences.",
    "",
    "## What to find",
    "Every blank, underscore-line, drawn box, or checkbox that a human would fill in. This includes:",
    "  - Underscore lines after a label (e.g. `Name: _________`)",
    "  - Inline blanks within body-text sentences (e.g. `I, _________, authorize...`)",
    "  - Drawn rectangles or boxes the form expects values inside",
    "  - Empty checkboxes / radio circles",
    "  - Signature lines",
    "  - Date lines",
    "Skip pre-filled values, decorative lines, table borders, and column dividers.",
    "",
    "## Output schema notes",
    "  - `bbox` MUST be `[y_min, x_min, y_max, x_max]` integers in the normalized 0-1000 range, computed against the dimensions of the image that contains the field. Y-first ordering is mandatory. (0,0) is the TOP-LEFT corner of the image; y increases downward.",
    "  - `page_number` is 1-based and corresponds to the position of the page image in the parts list (page_number=1 → first image, page_number=2 → second image, etc.).",
    "  - `field_type` is `text` or `checkbox`.",
    "  - `field_kind` is one of: text, multiline, date, signature, checkbox-group, boolean-checkbox.",
    "  - `label` is a 2-5 word Title Case description of what belongs in the blank, derived from the surrounding sentence (NOT the literal text after the blank). Example: for `...charged an additional $______ plus a 3.3% fee for my booking...`, the label is `Additional Charge Amount`, not `plus a 3.3% fee`.",
    "  - `context_before` is the text IMMEDIATELY preceding the blank — typically the last 30-80 characters of the sentence (or the row leading into the blank). It does NOT need to include a printed label. If the blank is mid-sentence, capture the words that come before the blank inside that sentence. The label may live elsewhere in the sentence (e.g. after the blank, or as a noun-phrase that the blank is filling in for); that is fine.",
    "  - `context_after` is the text IMMEDIATELY following the blank — typically the next 30-80 characters of the same sentence/row.",
    "  - Use `context_before` AND `context_after` TOGETHER to capture the meaning of the field. Inline-sentence blanks are valid fields and MUST be detected.",
    "  - NEVER omit a field just because it doesn't have a column-header label. Underline-only blanks inside a paragraph are still fields. A blank surrounded by ordinary prose (e.g. `I, _____, authorize...`) is just as valid as a labelled column blank (e.g. `Cardholder Name: _____`).",
    "",
    "  Concrete examples for inline-sentence blanks:",
    "    - Form text: `I, ___________________, authorize Hollywood Depot to charge my credit card...`",
    "      → emit a field with `context_before: \"I,\"`, `context_after: \", authorize Hollywood Depot to charge my credit card...\"`, `label: \"Cardholder Name\"`, `canonical_field_id: \"creditCardHolder\"`, `field_type: \"text\"`.",
    "    - Form text: `to charge the account indicated below on or after _____ (date) Collectively...`",
    "      → emit a field with `context_before: \"...to charge the account indicated below on or after\"`, `context_after: \"(date) Collectively...\"`, `label: \"Date\"`, `canonical_field_id: \"authorizationDate\"`, `field_type: \"text\"`.",
    "    - Form text: `CVV2: ____ (3 digit number on back of Visa/MC, 4 digits on front of AMEX)`",
    "      → `context_before` should contain `CVV2:` (or end with `CVV2`) so the deterministic CVV detector fires; `context_after` should be `(3 digit number on back of Visa/MC, 4 digits on front of AMEX)`. `field_type: \"text\"`, `canonical_field_id: \"ccv\"`.",
    "  - `checkbox_value` is the literal label text next to the checkbox (e.g. `Visa`, `Mastercard`, `Yes`).",
    "",
    "## Canonical field ids",
    "Set `canonical_field_id` ONLY when the surrounding sentence unambiguously identifies the field. NULL is better than a wrong id. Available ids:",
    buildCatalogSummary(),
    "",
    "## Repeats",
    "If the same field type appears multiple times (e.g. cardholder name in two paragraphs), emit one entry per occurrence — each with its own bbox. The downstream system fills repeats with the same value.",
    "",
    "Caveat for repeats: do NOT split a single writable area into multiple repeats. An empty band at the TOP of a paragraph block belongs to the immediately following labeled blank — not to a separate \"name\" field. If you find yourself emitting 4+ entries for what is plainly the same canonical field on a single page (e.g. five Cardholder Name boxes when the form only has two cardholder-name lines), you are over-detecting. Stop, look at the page again, and emit one entry per *distinct writable area*.",
    "",
    "## Label position relative to the writable area — READ FIRST",
    "Before placing any bbox, decide where the printed label sits relative to the empty writable area. There are three real-world layouts. The bbox ALWAYS covers the empty writable area, NEVER the printed label, in every layout.",
    "",
    "### Layout A — label-LEFT (column / row form)",
    "The label is on the SAME horizontal scan line as the blank, immediately to the LEFT of it.",
    "  Example: `Cardholder Name: ____________________`",
    "  → bbox covers ONLY the underscores / empty space to the right of the colon. NEVER covers the label `Cardholder Name:` itself.",
    "",
    "### Layout B — label-ABOVE (header style)",
    "The label sits on the line ABOVE the blank, often centered or left-aligned in the column.",
    "  Example:",
    "    Cardholder Name",
    "    ____________________",
    "  → bbox covers the BLANK BELOW the label (the empty horizontal band on the row directly under the printed label). NEVER overlaps the label text.",
    "",
    "### Layout C — label-BELOW (THIS IS THE COMMON TRIPHAZARD — DO NOT GET IT WRONG)",
    "The label sits on the line BELOW the writable area, frequently in small-caps or a small font, looking like a caption. Common short captions: `PHONE NUMBER`, `EMAIL ADDRESS`, `EXP DATE`, `CVV#`, `CREDIT CARD NUMBER`, `BILLING ADDRESS`, `ZIP CODE`, `STATE`.",
    "  Example (the `204 Credit Card Authorization Form 2019` layout uses this):",
    "    [ empty horizontal band ]",
    "    PHONE NUMBER",
    "  → bbox covers the EMPTY BAND IMMEDIATELY ABOVE the printed `PHONE NUMBER` caption. The bbox MUST NOT cover the words `PHONE NUMBER` themselves.",
    "  → emit `label: \"Phone Number\"`, `canonical_field_id: \"phone\"`, `field_type: \"text\"`, with a bbox whose y-range sits ABOVE the caption's y-range.",
    "",
    "Heuristic for detecting Layout C: when you see a short all-caps or small-caps label (≤ 4 words, ≤ 20 characters, looking like a form-field caption such as `EXP DATE` / `CVV#` / `ZIP CODE`) and the row IMMEDIATELY ABOVE it is empty (whitespace, a thin underline, or a drawn rectangle), the empty row IS the writable area. The caption beneath NAMES the field; it does NOT define the bbox.",
    "",
    "### Mandatory rule for label-BELOW rows",
    "When a printed all-caps or small-caps short label appears in the form, do NOT assume the writable area is at the label's coordinates. Look at the row IMMEDIATELY ABOVE the label. If that preceding row is empty (whitespace, a drawn underline, or an empty rectangle), THAT empty row is the writable area and the bbox MUST cover it. The label below names the field; it does NOT define the bbox.",
    "",
    "When a row's label is BELOW the writable area, populate the field's `label` from that label (Title Case, e.g. `\"Phone Number\"`, `\"Exp Date\"`, `\"CVV\"`, `\"Zip Code\"`, `\"Credit Card Number\"`). Populate `canonical_field_id` by matching the label text against the canonical alias list (the same way you would for a Layout A or Layout B row). For label-BELOW, `context_before` should still capture the surrounding paragraph or row context BEFORE the writable area, and `context_after` MAY include the label that sits BELOW it.",
    "",
    "### Concrete example using the 204 CC-auth form",
    "Form layout fragment (all-caps captions sit BELOW empty bands — Layout C):",
    "  ```",
    "  [ empty band ]              [ empty band ]",
    "  PHONE NUMBER                EMAIL ADDRESS",
    "  [ empty band ]              [ empty band ]",
    "  CREDIT CARD NUMBER          EXP DATE      CVV#",
    "  ```",
    "  → emit four (or more) fields, each with its bbox covering the EMPTY BAND ABOVE the corresponding caption. Do NOT place any bbox on the words `PHONE NUMBER`, `EMAIL ADDRESS`, `CREDIT CARD NUMBER`, `EXP DATE`, or `CVV#`.",
    "",
    "## Be tight — THIS IS THE MOST IMPORTANT RULE",
    "Imagine a user filling the form with a pen. The bbox is the rectangle their handwriting will occupy — and ONLY that rectangle.",
    "",
    "Critical: forms in this corpus rarely use underscore characters. The blanks are DRAWN GRAPHIC LINES sitting next to a printed label. You must distinguish:",
    "  1. The PRINTED LABEL — text already on the form (e.g. `Billing Address`, `Phone#`, `PRODUCTION CO.`). NEVER include this in the bbox.",
    "  2. The WRITABLE LINE — the empty space (with or without an underline drawn beneath it) where the user writes their answer. This is the bbox.",
    "",
    "Rule of thumb: if a horizontal scan-line through your bbox would cross any printed letters, the bbox is wrong — shift it horizontally so it covers ONLY empty space (or only the drawn underline, never the label).",
    "",
    "Concrete examples (positions described relative to the page image):",
    "  - Row `Billing Address ________________` where the label ends near the left third of the row and the line continues to the right edge of the row: bbox starts immediately after the label, NOT at the start of the label.",
    "  - Row `Phone#________ Email________` (two fields on one row): two separate bboxes, each starting just past its own label, never overlapping the label text.",
    "  - Checkbox row `☐ Visa  ☐ MasterCard`: each bbox is a small square aligned with the printed checkbox glyph itself, NOT including the word next to it.",
    "  - Inline `I, _________, authorize…`: bbox spans only the underscore region between the two commas.",
    "",
    "Vertical extent: match the local line height (i.e. the visible row height for body text; signature/date rows are often taller). NEVER include the row above or below.",
    "",
    "Tightness check before emitting each field: imagine cropping the page to your bbox. The crop should show empty space (or a drawn underline), nothing else. If you would see ANY printed letters in the crop, the bbox is too wide — shrink it.",
    "",
    "## Vertical alignment is the most common error (v0.5.13)",
    "When a writable area is a horizontal underline stroke, place the bbox so that its BOTTOM EDGE sits on the underline stroke (text-baseline geometry: bbox_bottom = stroke_y). The bbox should extend UPWARD from the stroke by the local line height (~10-15pt) — covering where typed text will sit ABOVE the line, the way printed letters sit on a baseline. Do NOT center the bbox on the stroke and do NOT place it entirely below the stroke. Verify each bbox: imagine drawing the bbox on the page — does its BOTTOM EDGE land on the stroke? If yes, alignment is correct. If the bbox is centered on or below the stroke, shift it UP so its bottom edge lands on the stroke.",
    "",
    "Same rule for label-BELOW layouts (Layout C): the bbox covers the empty band ABOVE the all-caps caption, but the BOTTOM of the bbox should sit roughly at the top of the caption text — within 2-3pt — not floating with a visible gap. The user's typed text will sit immediately above the caption, not several points above it.",
    "",
    "## Field-type rules (deterministic, do NOT deviate)",
    "  - If a field's surrounding text contains 'CVV', 'CVV2', 'CVC', 'security code', 'verification code', '3 digit', or '4 digit', the field is **always** `text` and `canonical_field_id: 'ccv'`. Do NOT classify it as a credit-card-type checkbox even if 'AMEX' or 'Visa' appears nearby — those words are part of the CVV instructional sentence.",
    "  - CVV / CVV2 / security code / `3 digit number` / `4 digits on front` → always `text`, NEVER `checkbox`. The blank may be drawn with a box outline, but the user types digits in it.",
    "  - Card number, expiration date, signature, name, address, phone, email → always `text`.",
    "  - Visa / MasterCard / Discover / AMEX selector boxes (each with a drawn ☐ checkbox or radio circle next to the label) → `checkbox`.",
    "  - Any ☐ glyph or empty square the size of one letter → `checkbox`.",
    "",
    "## Option-group rule (v0.5.25, tightened v0.5.26) — horizontal label list with NO drawn checkboxes",
    "When you see a horizontal list of mutually-exclusive labels (e.g. `Visa  MasterCard  AMEX  Discover  Other`), where there are NO checkboxes/circles/radio buttons drawn next to each label and the user is expected to circle, underline, or otherwise mark ONE of them — emit a SINGLE field with `field_type: 'option-group'`, `field_kind: 'option-group'`, and an `options` array. Each option entry MUST include:",
    "  - `label`: the option's printed text (Title Case, e.g. `\"Visa\"`, `\"MasterCard\"`, `\"AMEX\"`, `\"Discover\"`, `\"Other\"`).",
    "  - `bbox`: a TIGHT bbox around just THAT option's label text, in normalized 0-1000 `[y_min, x_min, y_max, x_max]` coordinates with the same 2-3pt of padding you would use for any tight label crop.",
    "Do NOT emit individual `checkbox` fields for each label. Do NOT emit five separate `text` fields for the row. ONE field with a populated `options` array. The PARENT bbox covers the entire row of labels (including the leading caption like `Card Type:` if present? — NO: the parent bbox covers ONLY the option labels' horizontal extent, NOT the caption).",
    "",
    "### Eligibility — mandatory hard gates",
    "An option-group field requires ALL of the following. If ANY gate fails, do NOT emit `option-group` for the cluster — emit each label's surrounding writable area as its own field instead.",
    "  1. **Cardinality:** at least THREE mutually-exclusive labels in a single horizontal row. Two-label groupings (e.g. `Yes  No`, `M  F`, `Visa  MasterCard`) are valid ONLY when the labels are clearly mutually-exclusive selector options drawn as a single picker (no extra punctuation, no trailing colons, no role mismatch). When in doubt with two labels, prefer two separate fields over one option-group.",
    "  2. **Same row:** every option's bbox must sit on the SAME visual row. Vertical centers must agree within ~6pt. A pair of labels separated by more than a single line height is two unrelated fields, never an option-group.",
    "  3. **Mutually-exclusive semantics:** every option must read as one of N picker choices (a brand, a method, a tier, etc.). Reject the cluster if any option label has a DIFFERENT semantic role — e.g. one is a write-in continuation tail (`Other:` followed by `____`), one is a separate field's label (`Cardholder Name`, `Card Number`, `Date`), or one is the row caption itself (`Card Type:`).",
    "  4. **No trailing punctuation in option labels.** A label that ends in `:` (`Other:`, `Date:`, `Name:`) is a label-for-blank, NOT an option — it labels a write-in field rather than naming a selector choice. Strip the colon if and only if you are 100% sure the label is a real option (`Other` standing alone in `Visa  MasterCard  Other:____`); otherwise emit the colon-suffixed item as a `text` field's label instead.",
    "",
    "If you cannot satisfy ALL four gates, fall back to per-field emission. We strongly prefer 5 correctly-classified fields over 1 falsely-grouped option-group with stray neighbour labels mixed in.",
    "",
    "If the row has a trailing `Other:___` continuation line (a writable blank after the `Other` option), emit the option-group as described AND ALSO emit a SEPARATE text field for the `Other:___` blank line. The `Other` option's bbox covers the printed word `Other`; the trailing `___` is its own field.",
    "",
    "Set `canonical_field_id: 'cardType'` when the option set matches the credit-card brand pattern (≥ 3 of {Visa, MasterCard, AMEX, Discover, Other}, case-insensitive synonyms allowed: `Mastercard`, `Master Card`, `Amex`, `American Express`, `Discover Card`).",
    "",
    "Few-shot examples for option-group:",
    "  Form text: `Card Type:  Visa  MasterCard  AMEX  Discover  Other:_______`",
    "    → emit ONE field with `field_type: 'option-group'`, `field_kind: 'option-group'`, `canonical_field_id: 'cardType'`, `label: 'Card Type'`, and `options: [{label: 'Visa', bbox: [...]}, {label: 'MasterCard', bbox: [...]}, {label: 'AMEX', bbox: [...]}, {label: 'Discover', bbox: [...]}, {label: 'Other', bbox: [...]}]` — five option entries, each bbox tight around the corresponding label text. The parent `bbox` covers the entire row of options. Do NOT emit four credit-card-checkbox fields.",
    "    → ALSO emit one separate field with `field_type: 'text'`, `label: 'Other Card Type'`, covering the `_______` underscores after `Other:` (this is the user-typed continuation line, distinct from the option-group itself).",
    "  Form text: `Method:  Cash  Check  Wire  Other` (no boxes drawn next to any label)",
    "    → emit ONE field with `field_type: 'option-group'`, `field_kind: 'option-group'`, `label: 'Method'`, `options: [{label: 'Cash', bbox: [...]}, {label: 'Check', bbox: [...]}, {label: 'Wire', bbox: [...]}, {label: 'Other', bbox: [...]}]`. `canonical_field_id: null` (not a card-type pattern).",
    "  Form text with drawn boxes: `☐ Visa  ☐ MasterCard  ☐ AMEX  ☐ Discover`",
    "    → KEEP existing behaviour: emit four separate `field_type: 'checkbox'` fields, NOT an option-group. The drawn ☐ glyphs are the writable area.",
    "  ANTI-EXAMPLE — DO NOT emit an option-group here:",
    "    Page region containing `Other: ____________` on row N (the trailing write-in tail of a prior card-type row) and `Cardholder Name ____________________` on row N+1 (a separate labelled field one row down).",
    "    → WRONG: ONE `option-group` field with `options: [{label: 'Other:'}, {label: 'Cardholder Name'}]`. The two labels fail every gate above (cardinality < 3, different rows, different semantic roles, one ends in `:`).",
    "    → RIGHT: emit `Other:____` as a `text` field for the write-in continuation, and `Cardholder Name ____` as a separate `text` field. No option-group.",
    "",
    "If you cannot precisely locate the writable area, OMIT the field. We strongly prefer 10 correctly-placed fields to 20 fields where half are sitting on labels.",
  ].join("\n");
}

function buildUserPrompt(
  rendered: RenderedPage[],
  filename: string
): string {
  return [
    `Filename: ${filename}`,
    `Page count: ${rendered.length}`,
    "",
    "You have been sent one image per page, in page order. Each image's pixel dimensions are listed below — your normalized 0-1000 bbox values are computed against these dimensions (e.g. y_min=500 means the field starts halfway down the image vertically).",
    "Page images:",
    rendered
      .map(
        (p) =>
          `  page ${p.pageNumber}: ${p.widthPx} × ${p.heightPx} px`
      )
      .join("\n"),
    "",
    "Extract every fillable field per the system prompt's instructions and return the JSON object.",
  ].join("\n");
}

/**
 * v0.4.12 Stage 1a — free-form description pass. Asks Gemini to walk
 * through the form image-by-image and describe every fillable field
 * in plain English. Output is plain text (no `responseSchema`), used
 * only as the "field-by-field checklist" preamble for Stage 1b.
 *
 * This pass intentionally does NOT request coordinates, JSON, or
 * pixel positions — that's Stage 1b's job. Forcing the model to
 * separate "describe" from "place" appears to mirror how Gemini's
 * web UI reasons through forms internally and how a human reviewer
 * walks through the page top-to-bottom.
 */
function buildStage1aSystemPrompt(): string {
  return [
    "You are reviewing a printed form rendered as page images. Walk through the form top-to-bottom and describe every fillable field you find. For each field, write 1-3 sentences in plain English covering:",
    "",
    "  - Where it sits on the page (`top of page 1, just under the title`, `middle of page 2, in the credit card section`, `bottom-right corner of page 1`, etc.)",
    "  - What the visible writable area looks like (long horizontal underline, short underline, empty horizontal band above an all-caps caption, small box outline, checkbox, etc.)",
    "  - The full label or surrounding text that identifies what the field is for. Capture both the on-row label (if any) AND the surrounding sentence context for inline-sentence blanks like `I, ___, authorize Hollywood Depot...`.",
    "  - Layout: is the label LEFT of, ABOVE, or BELOW the writable area? Or is it inline-sentence (the blank is mid-sentence)?",
    "  - The expected field type (text vs checkbox).",
    "  - Any nuances: is it part of a checkbox group (Visa/MasterCard/AMEX/Discover)? Is it a CVV/CVV2 row that draws a box outline but is meant for typing digits? Are there multiple instances of the same field on the form (e.g. two cardholder name lines, two date lines)?",
    "",
    "DO NOT output JSON, coordinates, or pixel positions. This is a natural-language pass — describe like you would in a code review. The next stage will handle coordinates.",
    "",
    "Take your time. Don't omit fields. If you're unsure whether something is fillable, describe it and note the uncertainty.",
    "",
    "End your description with a single line: `END OF FIELD DESCRIPTIONS.`",
  ].join("\n");
}

/**
 * v0.4.12 Stage 1a — user prompt. Same image-orientation preamble as
 * the Pass 1 user prompt minus the "return the JSON object" close
 * line, since this pass returns plain text.
 */
function buildStage1aUserPrompt(
  rendered: RenderedPage[],
  filename: string
): string {
  return [
    `Filename: ${filename}`,
    `Page count: ${rendered.length}`,
    "",
    "You have been sent one image per page, in page order. Page images:",
    rendered
      .map((p) => `  page ${p.pageNumber}: ${p.widthPx} × ${p.heightPx} px`)
      .join("\n"),
    "",
    "Walk through every page in order and describe every fillable field per the system prompt. Plain English only. End with `END OF FIELD DESCRIPTIONS.`.",
  ].join("\n");
}

/**
 * v0.4.12 Stage 1b — description-aware structured-JSON system prompt.
 *
 * The body is the v0.4.11 Pass-1 system prompt verbatim (every rule
 * preserved: image-coord contract, label-LEFT/ABOVE/BELOW handling,
 * inline-sentence blanks, CVV preflight, type rules, bbox tightness).
 * On top of that body we prepend a "use this field-by-field
 * description" preamble that injects the Stage-1a free-form text as
 * an authoritative checklist.
 *
 * This sequencing is the whole point of the v0.4.12 experiment: split
 * "decide what fields exist" (Stage 1a, free-form English) from
 * "place a tight bbox on each one" (Stage 1b, structured JSON), and
 * use Stage 1a's output to discipline Stage 1b. responseSchema and
 * structured output are RETAINED on Stage 1b.
 */
function buildStage1bSystemPrompt(stage1aText: string): string {
  return [
    "## Use this field-by-field description",
    "",
    "A senior reviewer has already walked through the form and described every fillable field in plain English. Use this description as your authoritative checklist of which fields exist and what each one represents. For every field in the description, find it on the page image, place a tight bbox on the writable area (NOT the label), and emit it in the JSON. Do not invent fields the description doesn't mention. Do not skip fields the description does mention.",
    "",
    "Field-by-field description (from senior reviewer):",
    "-----",
    stage1aText,
    "-----",
    "",
    "Now produce the JSON per the rules below.",
    "",
    buildPass1SharedSystemPrompt(),
  ].join("\n");
}

/**
 * Gemini's responseSchema dialect. Mirrors `RawGeminiField` 1:1.
 *
 * Gemini's structured-output engine accepts a subset of JSON Schema —
 * see https://ai.google.dev/api/generate-content#FIELDS.response_schema
 * for the full list. We stick to the supported keywords (`type`,
 * `properties`, `items`, `required`, `enum`, `description`,
 * `propertyOrdering`).
 */
const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["fields"],
  propertyOrdering: ["page_count", "form_type", "fields"],
  properties: {
    page_count: { type: "integer" },
    form_type: { type: "string" },
    fields: {
      type: "array",
      items: {
        type: "object",
        propertyOrdering: [
          "page_number",
          "bbox",
          "field_type",
          "field_kind",
          "label",
          "canonical_field_id",
          "context_before",
          "context_after",
          "checkbox_value",
          "group_id",
          "optional",
          "estimated_font_size",
          "options",
        ],
        required: ["page_number", "bbox", "field_type", "label"],
        properties: {
          page_number: { type: "integer", minimum: 1 },
          bbox: {
            type: "array",
            description:
              "[y_min, x_min, y_max, x_max], integers in normalized 0-1000 range per page. Y-first.",
            items: { type: "integer", minimum: 0, maximum: 1000 },
            minItems: 4,
            maxItems: 4,
          },
          field_type: {
            type: "string",
            enum: ["text", "checkbox", "option-group"],
          },
          field_kind: {
            type: "string",
            enum: [
              "text",
              "multiline",
              "date",
              "signature",
              "checkbox-group",
              "boolean-checkbox",
              "option-group",
            ],
          },
          label: { type: "string" },
          canonical_field_id: {
            type: "string",
            nullable: true,
            description:
              "One of the canonical ids listed in the system prompt, or null if uncertain.",
          },
          context_before: { type: "string" },
          context_after: { type: "string" },
          checkbox_value: { type: "string", nullable: true },
          group_id: { type: "string", nullable: true },
          optional: { type: "boolean" },
          estimated_font_size: { type: "number", nullable: true },
          // v0.5.25 — option-group sub-rectangles. Required only when
          // `field_type === "option-group"`. Each entry's `bbox` uses
          // the same 0-1000 normalized [y_min, x_min, y_max, x_max]
          // coordinate frame as the parent field's bbox.
          options: {
            type: "array",
            description:
              "For option-group fields: per-option entries. Each entry has a `label` and a tight `bbox` around just that label's text in normalized 0-1000 coords.",
            nullable: true,
            items: {
              type: "object",
              required: ["label", "bbox"],
              properties: {
                label: { type: "string" },
                bbox: {
                  type: "array",
                  items: { type: "integer", minimum: 0, maximum: 1000 },
                  minItems: 4,
                  maxItems: 4,
                },
              },
            },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Post-processing — ported from the Claude flow because these patterns
// are model-agnostic and were the source of our hard-won accuracy.
// ---------------------------------------------------------------------------

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeFieldKind(
  raw: string | undefined,
  fieldType: "text" | "checkbox" | "option-group"
): TemplateFieldKind {
  if (raw && VALID_FIELD_KINDS.has(raw as TemplateFieldKind)) {
    return raw as TemplateFieldKind;
  }
  if (fieldType === "checkbox") return "boolean-checkbox";
  if (fieldType === "option-group") return "option-group";
  return "text";
}

/**
 * Whether the per-field alignment diagnostic block in
 * `mapToTemplateField` should print on this run. True in dev builds
 * (`import.meta.env.DEV`) and whenever the user has set
 * `localStorage.typeset.debug.alignment = "true"` from the production
 * devtools. The localStorage path is the user-facing self-serve
 * channel — see the comment at the diagnostic call-site for the
 * one-line setter the user can paste into devtools.
 *
 * Wrapped in try/catch because:
 *   - `import.meta.env` access can throw in some bundler test
 *     harnesses;
 *   - `localStorage` is unavailable in non-window contexts (e.g.
 *     workers) and accessing it throws.
 */
function alignmentDebugEnabled(): boolean {
  try {
    if (import.meta.env?.DEV === true) return true;
  } catch {
    // ignore
  }
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("typeset.debug.alignment") === "true";
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Body-text patterns that don't have an explicit on-row label. Runs
 * BEFORE Gemini's `canonical_field_id` fallback so identical patterns
 * map identically across the document — language models are
 * occasionally inconsistent across repeats; this nails them down.
 *
 * Returns `undefined` for anything not clearly recognised; do not
 * over-extend, NULL is better than wrong.
 */
function inferByPattern(
  context: string | undefined,
  after: string | undefined,
  fieldType: "text" | "checkbox" | "option-group"
): CanonicalFieldId | undefined {
  if (fieldType !== "text") return undefined;
  const ctx = (context ?? "").toLowerCase().trim();
  const aft = (after ?? "").toLowerCase().trim();

  // "I, ____, authorize..." → cardholder name. The speaker IS the
  // cardholder by definition. Catches both first-paragraph
  // ("I, ___, authorize my credit card to be charged") and second-
  // paragraph ("I, ___, authorize my credit card to be charged an
  // additional $...") instances consistently.
  if (/^i,?$/.test(ctx) && /^,?\s*authoriz/.test(aft)) {
    return "creditCardHolder";
  }

  // "Signature:" / "Signed by:" / row ending in "sign" → signature.
  if (/(?:^|\s)(signature|signed(\s+by)?)\s*[:.]?$/.test(ctx)) {
    return "cardholderSignature";
  }

  // "(date)" or "date:" appearing in the suffix → date blank.
  if (/^\(\s*date\s*\)/.test(aft) || /^date\s*[:.)]?/.test(aft)) {
    return "authorizationDate";
  }

  // Context ends with "exp" / "expir" / "exp date" or suffix begins
  // with "MM/YY" → expiration date.
  if (
    /\bexp(\.|ir(es|ation|y)?)?(\s+date)?\s*[:.]?$/.test(ctx) ||
    /^mm\s*[\/.]\s*yy/.test(aft)
  ) {
    return "expDate";
  }

  return undefined;
}

/**
 * Deterministic canonical-id matching from row context. Only matches
 * against the candidate's OWN row (context_before + context_after) —
 * NEVER falls back to the full page text. On a CC-auth form whose page
 * text contains "credit card" / "card number" everywhere, page-text
 * fallback would force-fit every unlabelled candidate to
 * `creditCardNumber`.
 */
function inferCanonicalId(
  context: string | undefined,
  after: string | undefined,
  fieldType: "text" | "checkbox" | "option-group",
  checkboxValue: string | null | undefined,
  options?: Array<{ label?: string }>
): CanonicalFieldId | undefined {
  const ctx = (context ?? "").toLowerCase();
  const aft = (after ?? "").toLowerCase();

  // v0.5.25 — option-group preflight. If the field carries ≥ 3
  // option labels matching the credit-card brand pattern (Visa,
  // MasterCard, AMEX, Discover, Other), force canonical = `cardType`
  // regardless of label match. The user-confirmed render is a
  // hand-drawn-style oval around the chosen option; the option
  // sub-bboxes are already tight on each label, so no further
  // catalog mapping is needed.
  if (fieldType === "option-group" && Array.isArray(options)) {
    let cardTypeHits = 0;
    for (const opt of options) {
      if (normalizeCardTypeLabel(opt?.label)) cardTypeHits += 1;
    }
    if (cardTypeHits >= 3) return "cardType";
  }

  if (fieldType === "checkbox") {
    // CVV/CVV2/security-code rows are sometimes drawn as a small box
    // and Gemini misclassifies them as a checkbox. We MUST catch them
    // BEFORE the visa/mastercard/amex/discover branches: the CVV
    // instructional sentence often reads "...3 digit number on back of
    // Visa/MC, 4 digits on front of AMEX...", so context_after for the
    // CVV row contains "AMEX" and the AMEX branch below would
    // otherwise hijack it into `creditCardTypeAmex`.
    //
    // Returning "ccv" here puts the field into a text-typed canonical
    // id (fieldKind: "text"), which lets the downstream type-guard in
    // `mapToTemplateField` coerce the field back from checkbox to
    // text deterministically.
    const cvvIndicators = [
      "cvv2",
      "cvv",
      "cvc2",
      "cvc",
      "ccv",
      "security code",
      "verification code",
      "card identification",
      "3 digit",
      "3-digit",
      "3 digits",
      "3-digits",
      "4 digit",
      "4-digit",
      "4 digits",
      "4-digits",
    ];
    const cvvHaystack = `${ctx} ${aft}`;
    for (const indicator of cvvIndicators) {
      if (cvvHaystack.includes(indicator)) return "ccv";
    }

    // Card-type label sits to the RIGHT of the box on standard layouts.
    // CRITICAL: do NOT fall back to `context` for the Visa check —
    // every box from Mastercard onwards has "Visa" in its left context,
    // so context-based visa matching always wins for the first card
    // listed. Use the model's `checkbox_value` as the strong signal.
    const cv = (checkboxValue ?? "").toLowerCase().trim();
    if (cv === "visa" || /\bvisa\b/.test(aft)) return "creditCardTypeVisa";
    if (
      cv === "mastercard" ||
      /\bmaster\s?card\b/.test(aft) ||
      /\bmc\b/.test(aft)
    )
      return "creditCardTypeMastercard";
    if (
      cv === "amex" ||
      cv === "american express" ||
      /\bamex\b|\bamerican\s?express\b/.test(aft)
    )
      return "creditCardTypeAmex";
    if (cv === "discover" || /\bdiscover\b/.test(aft))
      return "creditCardTypeDiscover";
    // No `after` and no `checkbox_value` — try context as a last resort.
    if (!aft.trim() && !cv) {
      if (/\bvisa\b/.test(ctx)) return "creditCardTypeVisa";
      if (/\bmaster\s?card\b|\bmc\b/.test(ctx)) return "creditCardTypeMastercard";
      if (/\bamex\b|\bamerican\s?express\b/.test(ctx)) return "creditCardTypeAmex";
      if (/\bdiscover\b/.test(ctx)) return "creditCardTypeDiscover";
    }
    // CVV is handled explicitly above the card-type branch — see the
    // cvvIndicators preflight at the top of this block. The card-type
    // branches above ALSO short-circuit before we get here, so by this
    // point we have a checkbox whose context did NOT match CVV or any
    // card type. The next thing the original code did was fall
    // through to the text-alias matcher below, which would happily
    // map a confirmation-style checkbox like
    //
    //   ☐ Send PAID invoice to the email address above.
    //
    // to `email` (because "email" appears in `context_after`) — and
    // then the type-guard in `mapToTemplateField` would coerce that
    // canonical id's expected type ("text") back over the field, so
    // the box silently became an Email text field.
    //
    // v0.5.3 guard: if the alias matcher would resolve this checkbox
    // to a non-checkbox canonical (text/multiline/date/signature),
    // the model is wrong about what the box is for. Confirmation
    // checkboxes sit next to text that mentions email/phone/name/etc.
    // but they ARE NOT email/phone/name/etc. fields. Return undefined
    // so the field falls through to a generic boolean checkbox in
    // `mapToTemplateField` (no canonical id, mappedProjectKey =
    // `__prompt__`, fieldKind = `boolean-checkbox`).
    const cbHaystack = `${ctx} ${aft}`.trim();
    if (cbHaystack) {
      for (const { alias, id } of ALIAS_INDEX) {
        if (alias.length < 3) continue;
        if (!cbHaystack.includes(alias)) continue;
        const def = CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === id);
        if (!def) break;
        // Card-type and CVV cases are handled above and never reach
        // here. So a `checkbox-group` / `boolean-checkbox` canonical
        // at this point is a real checkbox-typed match — keep it.
        if (
          def.fieldKind === "checkbox-group" ||
          def.fieldKind === "boolean-checkbox"
        ) {
          return id;
        }
        // Non-checkbox canonical — text, multiline, date, signature.
        // The model is wrong; this box is a confirmation checkbox.
        return undefined;
      }
    }
    return undefined;
  }

  const haystack = `${ctx} ${aft}`.trim();
  if (!haystack) return undefined;
  for (const { alias, id } of ALIAS_INDEX) {
    if (alias.length < 3) continue;
    if (haystack.includes(alias)) return id;
  }
  return undefined;
}

/**
 * Match the field's `label` directly against the canonical alias list.
 * Used as a third-tier resolver for label-BELOW layouts where the
 * actual caption ("PHONE NUMBER", "EXP DATE", "CVV#", "ZIP CODE",
 * etc.) is reported by Gemini as the field's `label` rather than
 * appearing in `context_before` / `context_after`. The alias index
 * is the same one `inferCanonicalId` uses, so a label like
 * `"Phone Number"` resolves the same way `context_before:
 * "Phone#"` would have.
 *
 * Returns `undefined` when the label is empty or no alias matches —
 * we never want to force-fit; the next tier (pattern → model
 * semantic) gets a turn instead.
 */
function inferByLabel(
  label: string | undefined,
  fieldType: "text" | "checkbox" | "option-group",
  checkboxValue: string | null | undefined
): CanonicalFieldId | undefined {
  const lbl = (label ?? "").toLowerCase().trim();
  if (!lbl) return undefined;

  // CVV preflight on the label itself, mirroring the
  // `inferCanonicalId` checkbox preflight — handles label-below CVV#
  // captions that Gemini sends back as a checkbox-typed field.
  if (
    /\bcvv2?\b|\bcvc2?\b|\bccv\b|\bcid\b|\bsecurity\s+code\b|\bverification\s+code\b|\bcard\s+identification\b/.test(
      lbl
    )
  ) {
    return "ccv";
  }

  // v0.5.15 — Name-label preflight. "Print Name" and similar
  // person-name labels denote a cardholder/customer-name field
  // unambiguously when they sit ON the label. They MUST short-circuit
  // here so a neighboring "Date" sibling on the same row (which would
  // otherwise hijack via `inferByPattern`'s `^date` regex on
  // `context_after`) does not steal the canonical id.
  //
  // We deliberately do NOT add these as global aliases on
  // `creditCardHolder` in the catalog: the catalog's alias index is
  // also consulted by `inferCanonicalId` against
  // `context_before + context_after` haystacks, where "print name"
  // would match for the SIBLING blanks on the same row (Signature
  // and Date) — exactly the cross-field hijack we're trying to
  // prevent. Keeping these patterns local to `inferByLabel` makes
  // them label-only signals.
  //
  // Triggers:
  //   - `print name` (the v0.5.14 user report)
  //   - `name` alone, or `name:` / `name.` (typographic variants)
  //   - `first name`, `last name`, `full name`, `customer name`,
  //     `cardholder name`, `card holder name` — covered for parity;
  //     the existing alias index already catches some of these but
  //     this preflight makes the precedence explicit.
  if (
    /^print\s+name$/.test(lbl) ||
    /^(?:first|last|full|customer|cardholder|card\s+holder)\s+name$/.test(lbl) ||
    lbl === "name" ||
    /^name\s*[:.]$/.test(lbl)
  ) {
    return "creditCardHolder";
  }

  // Ignore overly generic or too-short labels (e.g. "Date" alone is
  // ambiguous; we only return a canonical match when the alias is
  // specific enough). Use the same min-length guard as
  // `inferCanonicalId` (alias.length ≥ 3).
  for (const { alias, id } of ALIAS_INDEX) {
    if (alias.length < 3) continue;
    // Word-boundary match: the alias must appear as a complete token
    // sequence in the label, not just a substring (so "card" inside
    // "CARDHOLDER NAME" does not hijack into `creditCardNumber`).
    const isExactMatch = lbl === alias;
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`);
    const isWordMatch = isExactMatch || re.test(lbl);
    if (!isWordMatch) continue;
    // For card-type checkboxes ("VISA"), require the field is
    // actually a checkbox (or the alias itself spans the entire
    // label) — we don't want a label like "Visa Authorization Date"
    // to resolve as `creditCardTypeVisa`.
    if (CREDIT_CARD_CHECKBOX_IDS.has(id)) {
      if (fieldType === "checkbox" || isExactMatch) return id;
      continue;
    }
    // v0.5.3 mirror of the inferCanonicalId checkbox guard: a
    // checkbox whose label matches a non-checkbox canonical (text,
    // multiline, date, signature) is almost always a confirmation
    // checkbox sitting next to that field, not the field itself.
    // E.g. a checkbox labelled `Email me a copy` should NOT resolve
    // to canonical `email`. Card-type ids are handled above and
    // short-circuit before this. CCV is handled by the explicit
    // CVV preflight at the top of this function.
    if (fieldType === "checkbox" && !isExactMatch) {
      const def = CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === id);
      if (
        def &&
        def.fieldKind !== "checkbox-group" &&
        def.fieldKind !== "boolean-checkbox"
      ) {
        continue;
      }
    }
    return id;
  }

  // No alias hit — but still accept an explicit checkbox_value match
  // (e.g. label `Visa` with checkbox_value `visa` resolves cleanly).
  if (fieldType === "checkbox") {
    const cv = (checkboxValue ?? "").toLowerCase().trim();
    if (cv === "visa") return "creditCardTypeVisa";
    if (cv === "mastercard") return "creditCardTypeMastercard";
    if (cv === "amex" || cv === "american express") return "creditCardTypeAmex";
    if (cv === "discover") return "creditCardTypeDiscover";
  }

  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TRAILING_PREP_RE = /\s+(on|of|to|for|in|at|by|with|the|a|an)$/i;
const LEADING_PREP_RE = /^(the|a|an|to|on|for|of|in|at|by|with)\s+/i;

/**
 * Builds a short, presentable preview of the sentence around the blank
 * with `___` standing in for the blank. Used by the Fill modal to show
 * the user what they're filling into.
 */
function buildContextSnippet(
  context: string | undefined,
  after: string | undefined
): string | undefined {
  const left = (context ?? "").trim();
  const right = (after ?? "").trim();
  if (!left && !right) return undefined;
  const leftWords = left.split(/\s+/).filter(Boolean);
  const rightWords = right.split(/\s+/).filter(Boolean);
  const leftKeep = leftWords.slice(-8).join(" ");
  const rightKeep = rightWords.slice(0, 6).join(" ");
  const leftEllipsis = leftWords.length > 8 ? "…" : "";
  const rightEllipsis = rightWords.length > 6 ? "…" : "";
  const snippet = `${leftEllipsis}${leftKeep} ___ ${rightKeep}${rightEllipsis}`.trim();
  return snippet.length > 0 ? snippet : undefined;
}

/**
 * Cleans up a raw context string into a presentable label.
 * Strips trailing punctuation, drops leading + trailing prepositions,
 * caps at 60 chars truncated at a word boundary.
 */
function cleanLabel(context: string | undefined, fallback: string): string {
  const raw = (context ?? "").trim();
  if (!raw) return fallback;
  let cleaned = raw.replace(/[:.,;]+\s*$/g, "").trim();
  cleaned = cleaned.replace(LEADING_PREP_RE, "");
  while (TRAILING_PREP_RE.test(cleaned)) {
    cleaned = cleaned.replace(TRAILING_PREP_RE, "").trim();
  }
  if (cleaned.length === 0) return fallback;
  if (cleaned.length > 60) {
    const cut = cleaned.slice(0, 60);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut) + "…";
  }
  return cleaned;
}

/**
 * Convert Gemini's normalized [y_min, x_min, y_max, x_max] (0-1000)
 * into PDF user-space (x, y, w, h).
 *
 * v0.4.9+: the model sees a rendered image, not the raw PDF, so the
 * normalized coords map FIRST to image-pixel space and THEN to PDF
 * user-space points via the captured render scale. This is how Gemini
 * achieves perfect bbox accuracy in its web app — the image is the
 * model's frame of reference, and the pixel→points conversion is
 * lossless because we own both numbers.
 *
 *   bbox_px   = bbox_norm / 1000 × imageDimensionPx
 *   bbox_pt   = bbox_px / scale         where scale = imageDimensionPx / pageDimensionPt
 *             = bbox_norm / 1000 × pageDimensionPt
 *
 * The math collapses to the same expression as the previous PDF-input
 * path, but the SEMANTIC frame of reference is now the image — the
 * 0-1000 coordinates are guaranteed to be relative to the rendered
 * image's actual dimensions, eliminating the systematic offset
 * Gemini's opaque PDF rasterizer was introducing.
 *
 * Both image dimensions and page dimensions are top-down origin
 * (pdf.js viewport convention) so no Y flip is required.
 */
function bboxToPdfRect(
  bbox: number[] | undefined,
  page: RenderedPage,
  fieldType: "text" | "checkbox" | "option-group"
): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [yMin, xMin, yMax, xMax] = bbox.map((n) =>
    typeof n === "number" && Number.isFinite(n)
      ? clampNumber(n, 0, 1000)
      : NaN
  );
  if ([yMin, xMin, yMax, xMax].some((n) => Number.isNaN(n))) return null;

  const scaleX = page.widthPx / Math.max(1, page.pageWidthPt);
  const scaleY = page.heightPx / Math.max(1, page.pageHeightPt);

  // Normalized 0-1000 → image pixels → PDF points.
  const xPx = (xMin / 1000) * page.widthPx;
  const yPx = (yMin / 1000) * page.heightPx;
  const x2Px = (xMax / 1000) * page.widthPx;
  const y2Px = (yMax / 1000) * page.heightPx;

  const x = xPx / scaleX;
  const y = yPx / scaleY;
  const x2 = x2Px / scaleX;
  const y2 = y2Px / scaleY;

  const minDim = fieldType === "checkbox" ? 8 : 12;
  const width = Math.max(minDim, x2 - x);
  const height = Math.max(minDim, y2 - y);

  return {
    x: clampNumber(x, 0, Math.max(0, page.pageWidthPt - 1)),
    y: clampNumber(y, 0, Math.max(0, page.pageHeightPt - 1)),
    width: clampNumber(width, minDim, page.pageWidthPt - x),
    height: clampNumber(height, minDim, page.pageHeightPt - y),
  };
}

/**
 * Convert a PDF user-space rect back into Gemini's normalized
 * `[y_min, x_min, y_max, x_max]` (0-1000) coordinate system. Inverse of
 * {@link bboxToPdfRect}; used by the QC pass so Pass 2 sees the same
 * coordinate frame Pass 1 produced.
 *
 * Same algebraic identity as the forward path: 0-1000 maps cleanly to
 * the page image's pixel dimensions, which are an exact integer scale
 * of the PDF point dimensions.
 */
function pdfRectToBbox(
  rect: { x: number; y: number; width: number; height: number },
  page: RenderedPage
): [number, number, number, number] {
  const norm = (v: number, max: number) =>
    Math.round(clampNumber((v / Math.max(1, max)) * 1000, 0, 1000));
  return [
    norm(rect.y, page.pageHeightPt),
    norm(rect.x, page.pageWidthPt),
    norm(rect.y + rect.height, page.pageHeightPt),
    norm(rect.x + rect.width, page.pageWidthPt),
  ];
}

function mapToTemplateField(
  raw: RawGeminiField,
  index: number,
  pages: RenderedPage[],
  /** Optional explicit id — used by the QC pass when re-mapping a fixed
   *  field so its id stays stable across passes. */
  explicitId?: string
): TemplateField | null {
  if (!raw || typeof raw !== "object") return null;

  // v0.5.25 — option-group joins text/checkbox as a top-level field
  // type. The model emits `field_type: "option-group"` along with an
  // `options` array; downstream the snap pipeline skips option-group
  // entirely (option sub-bboxes are already locked to label text and
  // there's no underline stroke to snap to).
  const rawFieldType: "text" | "checkbox" | "option-group" =
    raw.field_type === "checkbox"
      ? "checkbox"
      : raw.field_type === "option-group"
        ? "option-group"
        : "text";

  // v0.5.22 — defensive page-number clamp. Gemini is supposed to
  // return `page_number` in `[1, pdf.numPages]` (the prompt says
  // "1-based and corresponds to the position of the page image in
  // the parts list" and the response schema declares
  // `{ type: "integer", minimum: 1 }`), but real evidence proves
  // the model occasionally emits garbage values. v0.5.21 user log
  // on the 204 Credit Card Authorization Form — Field 2
  // (Invoice Number / poNumber) shipped with `page_number=271`,
  // which happened to equal the raw bbox's first element
  // (`y_min=271`), strongly suggesting the JSON returned by
  // Gemini either confused `page_number` with a bbox coord OR
  // emitted a bbox-shaped array in the page slot that we
  // truncated. The downstream effect: `pageRenders[271]` doesn't
  // exist, so the underline snap counts the field as
  // `skippedNoPage` ("1 unrendered" in the aggregate summary
  // line) and we ship Gemini's raw rect with no underline
  // correction. The field also lands in
  // `field.pageNumber === 271`, which means save-time and
  // fill-time consumers that look up the page by number get
  // nothing too. Clamping here recovers the field for the snap
  // pipeline AND for downstream consumers; the worst case
  // (Gemini truly returned page-2 for a page-1 form) is the same
  // as the v0.5.21 worst case (no snap), only with a sane
  // `pageNumber` so the field is at least visible/editable.
  //
  // Strategy: validate `raw.page_number` is a positive integer in
  // `[1, pages.length]`. If invalid (NaN, ≤ 0, > totalPages, or
  // not an integer), warn loudly so the next user report carries
  // evidence and fall back to page 1. Page 1 is the right
  // fallback for single-page forms (the overwhelming majority of
  // production paperwork) and a defensible default for
  // multi-page forms because (a) the snap will still skip the
  // field if the bbox doesn't match anything on page 1 and (b)
  // it's better than `undefined`/`pages[0]` which would silently
  // hide the field on lookup-by-pageNumber paths.
  const totalPages = pages.length;
  const rawPageNumber = raw.page_number;
  let pageNumber: number;
  if (
    typeof rawPageNumber === "number" &&
    Number.isFinite(rawPageNumber) &&
    rawPageNumber >= 1 &&
    rawPageNumber <= totalPages
  ) {
    pageNumber = Math.floor(rawPageNumber);
  } else {
    if (rawPageNumber !== undefined && rawPageNumber !== null) {
      console.warn(
        `[Typeset Diag] Field ${index} returned out-of-range page_number=${JSON.stringify(rawPageNumber)} (totalPages=${totalPages}); clamping to 1. This usually means Gemini emitted a bbox-shaped value in the page slot — see field's raw bbox for correlation.`
      );
    }
    pageNumber = 1;
  }
  const page =
    pages.find((p) => p.pageNumber === pageNumber) ?? pages[0];
  if (!page) return null;

  // Four-tier canonical-id resolution. v0.5.15 reordered so LABEL
  // wins over context/pattern: the user's v0.5.14 "Print Name field
  // detecting as a date field" report was a precedence bug — for a
  // row like `Signature ____ Print Name ____ Date ____`, the Print
  // Name blank's `context_after` starts with "Date", which made
  // `inferByPattern`'s `^date` regex hijack the canonical id even
  // though Gemini correctly returned `label: "Print Name"`. Labels
  // are the most specific local signal Gemini gives us; trust them
  // first, fall back to context only when the label is ambiguous.
  //
  //   1. Label alias / preflight — exact-label canonical match,
  //      including the v0.5.15 name-label preflight that catches
  //      "Print Name" / "First Name" / etc. directly.
  //   2. Context alias — explicit-label rows whose label was empty
  //      or generic, where `context_before + context_after` carries
  //      the canonical signal.
  //   3. Pattern match — body-text patterns alias matching can't see
  //      (e.g. `I, ___, authorize…`).
  //   4. Model semantic — Gemini's `canonical_field_id`, last resort.
  const labelId = inferByLabel(raw.label, rawFieldType, raw.checkbox_value);
  const aliasId = inferCanonicalId(
    raw.context_before,
    raw.context_after,
    rawFieldType,
    raw.checkbox_value,
    raw.options
  );
  const patternId = inferByPattern(raw.context_before, raw.context_after, rawFieldType);
  const geminiId =
    raw.canonical_field_id && VALID_CANONICAL_IDS.has(raw.canonical_field_id)
      ? (raw.canonical_field_id as CanonicalFieldId)
      : undefined;
  let canonicalId: CanonicalFieldId | undefined =
    labelId ?? aliasId ?? patternId ?? geminiId;

  // v0.5.16 — Last-mile label override (5th tier, runs AFTER the
  // four-tier ladder above). Person-name labels on cardholder rows
  // unambiguously denote `creditCardHolder` when they sit ON the
  // label itself. We override here, post-resolution, as a defense
  // against context-based heuristics (`inferByPattern`, alias
  // matching against `context_before + context_after`) leaking the
  // canonical id onto a sibling blank in the same row — e.g. on a
  // `Signature ____ Print Name ____ Date ____` row, the Print Name
  // blank's `context_after` starts with "Date", which the pattern
  // tier can latch onto, and the alias tier can hijack the canonical
  // for the Signature/Date siblings if "print name" were registered
  // as a global alias (the alias index is consulted against
  // `context_before + context_after` haystacks across ALL fields on
  // the row, so a global alias for "print name" would resolve every
  // sibling blank on that row to `creditCardHolder`).
  //
  // Why this can't live in the alias catalog: the catalog is the
  // shared source of truth for both `inferByLabel` (label-only) AND
  // `inferCanonicalId` (context-based). Adding "print name" /
  // "first name" / etc. as catalog aliases for `creditCardHolder`
  // would cause sibling-row leakage via the context path. Keeping
  // the patterns local here makes them strictly label-only.
  //
  // Why it sits HERE and not inside `inferByLabel`: `inferByLabel`
  // already has these patterns (added in v0.5.15) and SHOULD catch
  // them. This block is a robust backstop — if an upstream change
  // ever weakens `inferByLabel`, or if `inferByPattern` /
  // `inferCanonicalId` somehow returns a non-`creditCardHolder` id
  // for a label that's literally "Print Name", we still land on
  // `creditCardHolder`. Label is the most specific local signal
  // Gemini gives us; trust it last so it has the final word.
  if (canonicalId !== "creditCardHolder") {
    const lbl = (raw.label ?? "").trim().toLowerCase();
    if (
      /^print\s+name$/.test(lbl) ||
      /^(?:first|last|full|customer|cardholder|card\s+holder)\s+name$/.test(lbl) ||
      lbl === "name" ||
      /^name\s*[:.]$/.test(lbl)
    ) {
      canonicalId = "creditCardHolder";
    }
  }

  const canonicalDef = canonicalId
    ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
    : undefined;

  // Deterministic field-type guard. Every canonical id has a fixed
  // expected type (CVV is always text; visa/mastercard/etc. are always
  // checkboxes). When Gemini misclassifies — e.g. labelling CVV2 as a
  // checkbox because the form draws a small box around the underline
  // — this override fixes it without trusting the model. Only kicks
  // in when we're confident in the canonical id.
  //
  // v0.5.25 — option-group joins checkbox/text as a third expected
  // type. The `cardType` canonical maps to option-group; coercion
  // both directions (text → option-group, checkbox → option-group)
  // happens here when the canonical id is sure.
  const expectedType: "text" | "checkbox" | "option-group" | null = canonicalDef
    ? canonicalDef.fieldKind === "checkbox-group" ||
      canonicalDef.fieldKind === "boolean-checkbox"
      ? "checkbox"
      : canonicalDef.fieldKind === "option-group"
        ? "option-group"
        : "text"
    : null;
  const fieldType: "text" | "checkbox" | "option-group" =
    expectedType && expectedType !== rawFieldType ? expectedType : rawFieldType;
  const fieldKind = normalizeFieldKind(raw.field_kind, fieldType);

  if (rawFieldType !== fieldType) {
    console.log(
      `[Typeset Gemini] Coerced ${canonicalId} from ${rawFieldType} → ${fieldType} based on canonical type.`
    );
  }

  // [Typeset Diag] Per-field raw bbox log — fires BEFORE the rect
  // conversion so we still see the raw payload for any malformed
  // bboxes that fail to produce a rect. Kept on the standard console
  // flow so the next user run streams diagnostics without a special
  // debug build.
  //
  // v0.5.16 — `canonical=` now prints the FINAL resolved canonical
  // id (after the four-tier ladder + last-mile override), not the
  // raw `raw.canonical_field_id` that Gemini returned. Logging the
  // raw input made Fix 2 unverifiable: a Print Name field could end
  // up with `canonicalFieldId: "creditCardHolder"` on the
  // constructed TemplateField yet still log `canonical=—` (because
  // Gemini didn't return a canonical id). `gemini_canonical=` shows
  // the raw input separately for diagnostic completeness.
  console.log(
    `[Typeset Diag] Field ${index} raw bbox: ${JSON.stringify(raw.bbox)} (page ${pageNumber}, image ${page.widthPx}×${page.heightPx}px, page ${page.pageWidthPt}×${page.pageHeightPt}pt) | label="${(raw.label ?? "").slice(0, 40)}" canonical=${canonicalId ?? "—"} gemini_canonical=${raw.canonical_field_id ?? "—"}`
  );

  const rect = bboxToPdfRect(raw.bbox, page, fieldType);
  if (!rect) {
    console.log(`[Typeset Diag] Field ${index} pdf rect: <none — invalid bbox>`);
    return null;
  }

  // v0.5.18 — detection-time pre-shift is REMOVED. Gemini's prompt
  // already places the bbox so its bottom edge sits on the underline
  // stroke (text-baseline geometry: bbox_bottom = stroke_y), and the
  // snap target in `underlineSnap.ts` is anchored on the same point
  // (`newY = strokeRow - height`). With both ends of the pipeline
  // targeting the same anchor, any detection-time shift is redundant
  // AND actively harmful: it drags the snap's row-search center off
  // the real stroke, where Step 6 picks the closest candidate.
  //
  // Why removal — the v0.5.17 search-center drift bug:
  //   `underlineSnap.ts` computes its row-search center from the
  //   already-shifted bbox:
  //     bboxCenterYPx = (field.y + field.height / 2) * pixelsPerPoint
  //   In v0.5.17 we kept the v0.5.15-style `-height/2` pre-shift on
  //   the assumption that Gemini still placed `bbox_center` on the
  //   stroke. But the v0.5.16 prompt rule had been changed to "place
  //   bbox so its bottom edge sits on the underline" — Gemini now
  //   returns `raw_y = stroke - height`. The v0.5.17 pre-shift then
  //   produced `field.y = stroke - 1.5*height` and a search center at
  //   `stroke - height`, i.e. an entire `height` ABOVE the actual
  //   stroke. On dense top-of-form rows (line spacing ~22pt) the
  //   search center landed within ~10pt of the row-above stroke and
  //   only ~12pt from the intended stroke; Step 6 picked the wrong
  //   one. Real-user v0.5.17 evidence: Billing Address snapping to
  //   COMPANY's stroke; Stylist Designer Name snapping to
  //   CONTACT PHONE / Email's stroke. Bottom-of-page fields with
  //   looser breathing room continued to snap correctly because
  //   their search bands only contained one stroke.
  //
  // Removing the shift restores convergence by construction:
  //   raw_y = stroke - height                    (Gemini follows prompt)
  //   field.y = raw_y                            (no pre-shift)
  //   snap search center = field.y + height/2 = stroke - height/2
  //     → 6pt from intended stroke, ~16pt from row-above stroke ✅
  //   SNAPPED path: newY = strokeRow - height → bbox_bottom = stroke ✅
  //   UNSNAPPED path: stays at field.y = stroke - height
  //     → bbox_bottom = stroke ✅
  //   Both paths land on the same anchor — the v0.5.16 design intent,
  //   without v0.5.16's search-center shift.
  //
  // Geometry (math trace — upper-section field, h = 12, intended
  // stroke at 724.68, prior-row stroke at 702.68 i.e. 22pt above):
  //   raw_y                        = 712.68 (Gemini: stroke - h)
  //   field.y (no shift)           = 712.68
  //   snap search center           = 718.68
  //   distance to intended (724.68)= 6  ← closest, picked ✅
  //   distance to row-above (702.68)= 16 (rejected)
  //   newY = 724.68 - 12           = 712.68 → bbox_bottom = 724.68 ✅
  // Compare v0.5.17 on the same field:
  //   field.y (after -h/2)         = 706.68
  //   snap search center           = 712.68
  //   distance to intended         = 12
  //   distance to row-above        = 10  ← closest, picked ❌
  //   newY                         = 690.68 → wrong row.
  //
  // History:
  //   v0.5.11 flat `TEXT_BASELINE_BIAS_PT = 5` — under-corrected
  //   typical heights.
  //   v0.5.13 kept the flat 5pt — same problem.
  //   v0.5.15 replaced the flat constant with `height/2` (centered on
  //   stroke) — converged unsnapped on `bbox_center == strokeRow`,
  //   but the visual anchor was ~h/2 low (text needs to sit ABOVE
  //   the line, not centered on it).
  //   v0.5.16 changed the PROMPT to "bottom edge on stroke" AND
  //   shifted both pre-shift and snap target to full `-height`. Both
  //   paths converged on bbox_bottom == strokeRow, but the shift
  //   moved the snap search center too, breaking stroke selection
  //   on dense top-of-form rows.
  //   v0.5.17 reverted the pre-shift to `-height/2` thinking that
  //   would restore the v0.5.15 search center. Wrong: the v0.5.16
  //   prompt change had moved Gemini's `raw_y` itself by `-height/2`,
  //   so the v0.5.17 pre-shift took the search center an extra
  //   `-height/2` past the stroke. Billing Address + Stylist Designer
  //   Name still snapped to the row above on tight rows.
  //   v0.5.18 (this) — removes the pre-shift entirely. Prompt does
  //   the placement work; snap acts as a verifier/corrector against
  //   the same anchor. No double-correction; both paths converge.
  //
  // Why this is safe alongside the snap: the snap REPLACES `y` with
  // its stroke-anchored target — it does not ADD to the existing
  // `y`. With the prompt placing `raw_y = stroke - height` and snap
  // target `newY = strokeRow - height`, snapped and unsnapped fields
  // both land at `bbox_bottom == strokeRow` (text-baseline geometry,
  // typed text sits above the line). The snap search center
  // (`field.y + height/2 = stroke - height/2`) is half a height
  // below the stroke — a stable, well-separated anchor against the
  // row-above stroke (~16pt away on typical 22pt line spacing).
  //
  // Predicate ("text-on-a-line") — kept as a no-op flag for now so
  // future shifts (if needed) have a clear target. `correctionApplied`
  // is always false; `rect.y` is always `rawY`. Comment + diag log
  // both reflect this.
  const rawY = rect.y;
  const correctionApplied = false;

  console.log(
    `[Typeset Diag] Field ${index} pdf rect: x=${rect.x.toFixed(2)}, y=${rect.y.toFixed(2)}, w=${rect.width.toFixed(2)}, h=${rect.height.toFixed(2)}`
  );

  const isCardCheckbox = canonicalId && CREDIT_CARD_CHECKBOX_IDS.has(canonicalId);
  const isBooleanCheckbox = fieldType === "checkbox" && !isCardCheckbox;
  // v0.5.25 — option-group field. Convert each option's normalized
  // 0-1000 bbox into PDF user-space points using the same
  // `bboxToPdfRect` helper as the parent rect. We pass `"text"` for
  // the option-level minDim because option labels are short text, not
  // checkboxes, and the 12pt min-dim absorbs degenerate (zero-area)
  // crops without distorting real label rects.
  const isOptionGroup = fieldType === "option-group";
  const fieldOptions: FieldOption[] | undefined = isOptionGroup
    ? (Array.isArray(raw.options) ? raw.options : [])
        .map((opt) => {
          if (!opt || typeof opt !== "object") return null;
          const label = (opt.label ?? "").trim();
          if (!label) return null;
          const optRect = bboxToPdfRect(opt.bbox, page, "text");
          if (!optRect) return null;
          return {
            label,
            bbox: optRect,
          } as FieldOption;
        })
        .filter((o): o is FieldOption => o !== null)
    : undefined;

  // v0.5.22 — height-gated canonical multiline override. Some
  // canonicals (currently only `billingAddress`) carry
  // `fieldKind: "multiline"` in `fieldCatalog.ts` to express that
  // their writable region CAN span multiple rows on forms that
  // bundle Address + City/State/Zip into one boxed area. Prior to
  // v0.5.22 we applied that catalog hint unconditionally, which
  // promoted SINGLE-row Billing Address fields (h ≈ 21pt, one
  // underline only) to `multiline` and made the underline snap
  // skip them — `snapOneField` early-returns on
  // `fieldKind === "multiline"` and counts the field as
  // `skippedNonText`. Real-user v0.5.21 evidence (204 Credit Card
  // Authorization Form): Field 15 "Billing Address" with raw
  // bbox h=21.38pt and a clean single underline was completely
  // absent from the per-field `[underlineSnap]` log and counted
  // toward the aggregate's `7 non-text + 1 unrendered` bucket
  // alongside the 6 visible checkboxes.
  //
  // Why a height heuristic and not a bbox-spans-multiple-strokes
  // check: the snap's row-search hasn't run yet at this point in
  // the pipeline. Bbox height is the only geometric signal we
  // have, and on every form the prompt rule places
  // `bbox_bottom = stroke` so a single-row bbox is just one row
  // tall. 30pt cleanly separates the single-row case (typical
  // 14–21pt heights) from the genuinely-multiline case (Address +
  // City + State + Zip merged into one bbox measures 60–90pt on
  // every form we've seen). Picking 30pt instead of, say, 25pt
  // gives a margin against unusual line-spacing without
  // admitting any single-row bbox we've observed.
  //
  // Only the catalog override is gated. If Gemini's response
  // itself returned `field_kind: "multiline"` (the local
  // `fieldKind` from `normalizeFieldKind` above), we keep that —
  // the model has explicit visual evidence of a multi-row
  // region. The gate ONLY suppresses the case where the catalog
  // unconditionally promotes a canonical to multiline despite
  // the bbox geometry saying otherwise.
  //
  // Safety: `pdfWriter.ts` (fill-renderer), `DraggableField`,
  // `FillPromptModal`, and `TemplateReviewModal` (UI) all branch
  // ONLY on `checkbox-group`, `boolean-checkbox`, and
  // `signature` — none branch on `multiline`. The only consumer
  // of `fieldKind === "multiline"` in v0.5.21 is
  // `underlineSnap.snapOneField`, so changing this kind for
  // single-row bboxes affects nothing except the snap's
  // eligibility gate (the desired behaviour).
  const HEIGHT_MULTILINE_THRESHOLD_PT = 30;
  let resolvedFieldKind: TemplateFieldKind;
  if (isBooleanCheckbox) {
    resolvedFieldKind = "boolean-checkbox";
  } else if (isOptionGroup) {
    // v0.5.25 — option-group is a top-level kind; it never falls back
    // to text/checkbox-group. The catalog override is only meaningful
    // when an option-group field also carries a canonical id (e.g.
    // `cardType`) and that canonical's `fieldKind` is `"option-group"`
    // — already the expected value.
    resolvedFieldKind = "option-group";
  } else if (
    canonicalDef?.fieldKind === "multiline" &&
    fieldKind !== "multiline" &&
    rect.height < HEIGHT_MULTILINE_THRESHOLD_PT
  ) {
    // Catalog says multiline but bbox is single-row → trust geometry,
    // keep Gemini's locally-classified kind so the snap can correct y.
    resolvedFieldKind = fieldKind;
  } else {
    resolvedFieldKind = canonicalDef?.fieldKind ?? fieldKind;
  }

  // Per-field alignment diagnostics. Off by default in production
  // (the regular `[Typeset Diag]` line above already covers the raw
  // bbox + final rect). Users can enable detailed alignment
  // diagnostics from the production devtools (Cmd+Option+I) by
  // running:
  //
  //     localStorage.setItem("typeset.debug.alignment", "true")
  //
  // and reloading the app, then re-running detection. Disable with:
  //
  //     localStorage.removeItem("typeset.debug.alignment")
  //
  // Dev builds (`import.meta.env.DEV`) always print these so we
  // see them locally without flipping the flag.
  if (alignmentDebugEnabled()) {
    // v0.5.18 — `corrected_y` always equals `raw_y` and `corrected`
    // is always false: the detection-time pre-shift was removed,
    // because Gemini's prompt now places the bbox so its bottom
    // edge sits on the underline (`raw_y = stroke - height`) and
    // any further shift here drags the snap's search center off
    // the real stroke. The `pre_shift=` field present in
    // v0.5.15-v0.5.17 logs is gone for the same reason. Snapped and
    // unsnapped fields both land at `bbox_bottom = stroke`; the
    // post-snap y is still reported separately by underlineSnap.
    //
    // v0.5.22 — `kind=` now reports the FINAL `resolvedFieldKind`
    // that will land on the constructed `TemplateField`, not the
    // local `fieldKind` from `normalizeFieldKind`. Prior versions
    // logged the local kind, which masked the canonical-driven
    // multiline override (e.g. Field 15 logged `kind=text` but
    // shipped as `multiline` because of the catalog's billingAddress
    // entry). The mismatch made it look like the snap was
    // misclassifying single-row Billing Address as non-text when in
    // fact `mapToTemplateField` had already promoted it. Logging the
    // resolved kind makes the diag log faithful to the runtime
    // value the snap will see.
    console.log(
      `[Typeset Align] field=${index} label="${(raw.label ?? "").slice(0, 32)}" type=${fieldType} kind=${resolvedFieldKind} raw_y=${rawY.toFixed(2)} corrected_y=${rect.y.toFixed(2)} corrected=${correctionApplied} height=${rect.height.toFixed(2)} anchor=bbox_bottom_on_stroke (no detection-time shift; snapped + unsnapped converge on bbox_bottom=stroke; post-snap y reported separately by underlineSnap)`
    );
  }

  const catalogKey = canonicalDef?.mappedProjectKey ?? "";
  // Label resolution priority:
  //   1. Canonical-mapped → use the catalog's label ("Cardholder Name", etc.).
  //   2. Unmapped CHECKBOX (v0.5.3) → prefer `context_after` for
  //      confirmation checkboxes whose meaning lives in the action
  //      sentence that follows the box (e.g. ☐ followed by
  //      "Send PAID invoice to the email address above"). Gemini's
  //      `label` for these is often generic ("Checkbox", "Yes") or
  //      misleading (an action-verb fragment). The text AFTER the
  //      box is the actual semantic content.
  //   3. Unmapped TEXT → use Gemini's semantic label.
  //   4. Fallback → derive from row context_before.
  const geminiLabel = (raw.label ?? "").trim();
  const isUnmappedCheckbox = !canonicalDef && rawFieldType === "checkbox";
  const contextAfterClean = (raw.context_after ?? "").trim();
  const fieldLabel =
    canonicalDef?.label ??
    (isUnmappedCheckbox && contextAfterClean.length > 0
      ? cleanLabel(raw.context_after, geminiLabel || `Field ${index + 1}`)
      : geminiLabel.length > 0
        ? geminiLabel
        : cleanLabel(raw.context_before, `Field ${index + 1}`));

  // v0.5.25 — option-group fields map to `creditCardType` when the
  // canonical is `cardType`, falling back to `__prompt__` for any
  // option-group with no canonical match (e.g. a Cash/Check/Wire
  // selector). The selected option label is captured at fill time
  // via `selectedOption` rather than via the project value, so the
  // mapping is mostly a hint for the UI's "what does this field
  // bind to" copy.
  const isUnmappedOptionGroup = isOptionGroup && !catalogKey;
  const isUnmappedText =
    !isBooleanCheckbox && !isCardCheckbox && !isOptionGroup && !catalogKey;
  const mappedKey: TemplateMappedProjectKey =
    isBooleanCheckbox || isUnmappedText || isUnmappedOptionGroup
      ? "__prompt__"
      : ((catalogKey || "") as TemplateMappedProjectKey);

  const checkboxValueRaw = raw.checkbox_value ?? canonicalDef?.checkboxValue;
  const checkboxValue = isCardCheckbox
    ? normalizeCardType(checkboxValueRaw ?? "") || canonicalDef?.checkboxValue
    : isBooleanCheckbox
      ? "yes"
      : checkboxValueRaw ?? undefined;

  const estimatedFontSize =
    typeof raw.estimated_font_size === "number" && raw.estimated_font_size > 0
      ? Math.round(raw.estimated_font_size * 10) / 10
      : undefined;

  return {
    id: explicitId ?? `gemini-field-${index}-${Date.now().toString(36)}`,
    label: fieldLabel,
    mappedProjectKey: mappedKey,
    canonicalFieldId: canonicalId,
    pageNumber,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    confidence: 0.92,
    fieldType,
    // v0.5.22 — `resolvedFieldKind` already encodes the boolean-checkbox
    // coercion AND the height-gated canonical multiline override (see
    // the resolution block above). Prior versions inlined
    // `canonicalDef?.fieldKind ?? fieldKind` here, which unconditionally
    // promoted single-row Billing Address bboxes to multiline and then
    // got them silently skipped by `underlineSnap.snapOneField`.
    fieldKind: resolvedFieldKind,
    detectionSource: "gemini",
    checkboxValue,
    options: fieldOptions,
    selectedOption: isOptionGroup ? null : undefined,
    groupId: raw.group_id ?? canonicalDef?.groupId ?? undefined,
    promptLabel:
      isBooleanCheckbox || isUnmappedText || isUnmappedOptionGroup
        ? fieldLabel
        : undefined,
    optional: raw.optional ?? undefined,
    estimatedFontSize,
    contextSnippet: buildContextSnippet(raw.context_before, raw.context_after),
  };
}

/**
 * v0.5.25 — option-group merge pass. Catches the regression case where
 * Gemini emits a card-type row as 3-5 separate text/checkbox fields
 * instead of one option-group field. We merge them back into a single
 * option-group when:
 *
 *   1. ≥ 3 of the candidate fields' labels normalise to a card-type
 *      label (Visa, MasterCard, AMEX, Discover, Other).
 *   2. They sit on the same page and approximately the same row
 *      (vertical center within 8pt).
 *   3. They are horizontally adjacent — the merged horizontal extent
 *      is no more than 1.5× the sum of individual widths plus gaps,
 *      which weeds out cases where a stray "Visa" elsewhere on the
 *      form gets mixed in.
 *
 * The merged option-group inherits the union bbox (min x, min y,
 * max x+w, max y+h) as its parent rect; each option carries its
 * own per-label bbox derived from the original field's rect. The
 * merged field is canonical = `cardType` (the option-group preflight
 * in `inferCanonicalId` would have picked the same id). Original
 * fields are dropped from the output.
 *
 * Conservative scope: only triggers when ≥ 3 card-type labels are
 * detected. Two-label rows (e.g. just `Visa  MasterCard`) are too
 * easy to false-positive against unrelated horizontal lists, and the
 * detector almost never emits exactly two card-type fields on a real
 * card-type row anyway — most credit-card forms list at least
 * Visa/MC/AMEX or Visa/MC/AMEX/Discover.
 *
 * Runs BEFORE `dedupeFields` so the dedup pass operates on the
 * already-merged shape. The merge does not interact with
 * `__prompt__` mapping (the resulting field maps to `creditCardType`
 * via the `cardType` canonical's catalog entry).
 */

/**
 * v0.5.26 — deterministic shape filter for model-emitted option-group
 * fields. Catches the v0.5.25 regression where Gemini occasionally
 * emitted an `option-group` field whose two "options" were
 * semantically heterogeneous (e.g. an `Other:` write-in tail from
 * row N paired with `Cardholder Name` from row N+1). Such groupings
 * never represent a real picker — they're two unrelated fields the
 * model glued together because they sit close to each other.
 *
 * A model-emitted option-group is REJECTED (dropped from the field
 * list) when ANY of the following hold:
 *
 *   1. Fewer than two surviving options after normalisation. A
 *      single-option "group" has nothing to pick from.
 *   2. Any option's label ends in `:` (a colon = label-for-blank,
 *      not selector option text — see the prompt rule).
 *   3. Any two options' bbox vertical centers are separated by more
 *      than ~6pt. Real picker rows lay all labels on the same
 *      visual baseline; cross-row clusters are always misclassified
 *      neighbours.
 *   4. The option count is exactly 2 AND neither option resolves
 *      to a recognised card-type label. Two-label clusters are
 *      ambiguous (Yes/No, M/F are valid; Other/Cardholder Name is
 *      not), and the model has proven untrustworthy with them. We
 *      keep the rare valid 2-label card-type case (Visa/MasterCard
 *      on a low-end form) by allow-listing card-type matches.
 *
 * Rejected fields are dropped entirely. The legitimate user-typeable
 * area each "option" was supposed to identify either re-emerges from
 * Pass 1 as its own text field, or — if it didn't — the user can add
 * it manually in template review. We strictly prefer one missing
 * field to one falsely-grouped field that surfaces a useless
 * `<select>` in the FillPromptModal.
 *
 * Runs BEFORE `mergeCardTypeOptionGroup` so the merge pass sees a
 * clean field list (without spurious model-emitted option-groups
 * sitting alongside the candidates it would otherwise merge).
 */
function dropMisshapenOptionGroups(fields: TemplateField[]): TemplateField[] {
  const out: TemplateField[] = [];
  for (const field of fields) {
    if (field.fieldType !== "option-group") {
      out.push(field);
      continue;
    }
    const options = field.options ?? [];

    // Gate 1: must have at least two options.
    if (options.length < 2) {
      console.log(
        `[Typeset Gemini] Dropping option-group "${field.label}" on page ${field.pageNumber}: <2 options.`
      );
      continue;
    }

    // Gate 2: no option label may end in `:`.
    const colonOption = options.find(
      (opt) => (opt.label ?? "").trim().endsWith(":")
    );
    if (colonOption) {
      console.log(
        `[Typeset Gemini] Dropping option-group "${field.label}" on page ${field.pageNumber}: option label "${colonOption.label}" ends in ':' (label-for-blank, not selector option).`
      );
      continue;
    }

    // Gate 3: every option must sit on the same visual row
    // (vertical centers within ~6pt of one another).
    const centers = options.map((opt) => opt.bbox.y + opt.bbox.height / 2);
    const minCy = Math.min(...centers);
    const maxCy = Math.max(...centers);
    if (maxCy - minCy > 6) {
      console.log(
        `[Typeset Gemini] Dropping option-group "${field.label}" on page ${field.pageNumber}: option vertical centers span ${(maxCy - minCy).toFixed(2)}pt (>6pt → not a single row).`
      );
      continue;
    }

    // Gate 4: 2-label clusters must be a recognised card-type pair.
    // Anything else (Other/Cardholder Name, etc.) is too ambiguous
    // to trust as a picker. Yes/No or M/F-only forms can still
    // emerge as two separate boolean checkboxes from Pass 1; the
    // option-group treatment isn't load-bearing for them.
    if (options.length === 2) {
      const cardTypeHits = options.filter(
        (opt) => normalizeCardTypeLabel(opt.label)
      ).length;
      if (cardTypeHits < 2) {
        console.log(
          `[Typeset Gemini] Dropping 2-label option-group "${field.label}" on page ${field.pageNumber}: labels not a card-type pair (${options.map((o) => o.label).join(", ")}).`
        );
        continue;
      }
    }

    out.push(field);
  }
  return out;
}

function mergeCardTypeOptionGroup(fields: TemplateField[]): TemplateField[] {
  const byPage = new Map<number, TemplateField[]>();
  for (const f of fields) {
    const list = byPage.get(f.pageNumber) ?? [];
    list.push(f);
    byPage.set(f.pageNumber, list);
  }

  const merged: TemplateField[] = [];
  const consumed = new Set<string>();

  for (const [, pageFields] of byPage) {
    // v0.5.26 — refuse to merge any candidate whose ORIGINAL (pre-
    // normalisation) label ends with a colon. A trailing `:` is the
    // unambiguous signal of a label-for-blank (`Other:` followed by
    // `____`, `Date:` followed by an underline) and never of a real
    // selector option. Without this guard, the merge pass would
    // happily fold an `Other:____` write-in tail into the
    // option-group whenever Gemini returned the trailing tail's
    // label as `Other:` instead of the bare `Other` we ask for.
    const cardCandidates = pageFields
      .map((field) => {
        const trimmedLabel = (field.label ?? "").trim();
        if (trimmedLabel.endsWith(":")) return null;
        const norm = normalizeCardTypeLabel(trimmedLabel);
        return norm ? { field, normalized: norm } : null;
      })
      .filter((x): x is { field: TemplateField; normalized: string } => x !== null);

    if (cardCandidates.length < 3) continue;

    // Group by row: cluster candidates whose vertical centers are
    // within 8pt of each other (same row on a normal form).
    const rows: Array<Array<{ field: TemplateField; normalized: string }>> = [];
    for (const cand of cardCandidates) {
      const cy = cand.field.y + cand.field.height / 2;
      const row = rows.find((r) => {
        const refCy = r[0].field.y + r[0].field.height / 2;
        return Math.abs(refCy - cy) <= 8;
      });
      if (row) row.push(cand);
      else rows.push([cand]);
    }

    for (const row of rows) {
      if (row.length < 3) continue;

      // Sort by x — left-to-right reading order.
      row.sort((a, b) => a.field.x - b.field.x);

      // Pick the FIRST occurrence of each canonical label so we don't
      // create duplicate options when (e.g.) two Visa text fields
      // were emitted for one row.
      const seen = new Set<string>();
      const picked: typeof row = [];
      for (const cand of row) {
        if (seen.has(cand.normalized)) continue;
        seen.add(cand.normalized);
        picked.push(cand);
      }
      if (picked.length < 3) continue;

      // Sanity guard: refuse to merge if the row spans more than
      // 75% of a typical US-Letter page width (≈ 460pt). Real
      // card-type rows on real forms span 200–360pt; anything wider
      // is almost certainly a false-positive cluster of unrelated
      // labels with `Visa` somewhere in the form copy.
      const minX = Math.min(...picked.map((p) => p.field.x));
      const maxX = Math.max(...picked.map((p) => p.field.x + p.field.width));
      const minY = Math.min(...picked.map((p) => p.field.y));
      const maxY = Math.max(...picked.map((p) => p.field.y + p.field.height));
      if (maxX - minX > 460) continue;

      const options: FieldOption[] = picked.map((p) => ({
        label: p.normalized,
        bbox: {
          x: p.field.x,
          y: p.field.y,
          width: p.field.width,
          height: p.field.height,
        },
      }));

      const firstField = picked[0].field;
      const mergedField: TemplateField = {
        id: `option-group-cardType-${firstField.pageNumber}-${Math.round(minX)}-${Math.round(minY)}`,
        label: "Card Type",
        mappedProjectKey: "creditCardType",
        canonicalFieldId: "cardType",
        pageNumber: firstField.pageNumber,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        confidence: 0.85,
        fieldType: "option-group",
        fieldKind: "option-group",
        detectionSource: "gemini",
        options,
        selectedOption: null,
      };
      merged.push(mergedField);
      for (const p of picked) consumed.add(p.field.id);

      console.log(
        `[Typeset Gemini] Merged ${picked.length} sibling fields into one option-group cardType field (${picked.map((p) => p.normalized).join(", ")}) on page ${firstField.pageNumber}.`
      );
    }
  }

  if (consumed.size === 0) return fields;
  const out = fields.filter((f) => !consumed.has(f.id));
  return [...out, ...merged];
}

/**
 * De-duplicate detections by spatial overlap. Production paperwork
 * legitimately repeats canonical fields (cardholder name in two
 * paragraphs, dates at top and bottom) and every instance needs to be
 * filled with the same value — so we DON'T dedupe by canonical id.
 * We only drop two detections that sit on top of each other (within
 * 12pt on the same page, same field type), which only happens when
 * the model double-tags one location.
 */
function dedupeFields(fields: TemplateField[]): TemplateField[] {
  const result: TemplateField[] = [];
  for (const field of fields) {
    const overlapping = result.find(
      (existing) =>
        existing.pageNumber === field.pageNumber &&
        Math.abs(existing.x - field.x) < 12 &&
        Math.abs(existing.y - field.y) < 12 &&
        existing.fieldType === field.fieldType
    );
    if (overlapping) continue;
    result.push(field);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Streaming progress → user-facing status
// ---------------------------------------------------------------------------

/**
 * Which Gemini round-trip is currently in flight. As of v0.4.12 the
 * vocabulary is:
 *   - `pass1`    — Fast-mode single-shot Pass 1 (legacy single-stage).
 *   - `stage1a`  — Maximum-mode free-form description pass (v0.4.12).
 *   - `stage1b`  — Maximum-mode description→JSON pass (v0.4.12).
 *   - `qc`       — Pass 2 quality-control audit.
 *
 * Each phase has its own user-facing status text and its own
 * progress-bar fraction band; the rest of the round-trip plumbing
 * (SSE subscription, token interpolation) is identical across phases.
 */
type DetectionPhase = "pass1" | "stage1a" | "stage1b" | "qc";

/**
 * Inner [0, 1] mapping shared by every phase. Calibrated against
 * measured timings on Gemini 2.5/3.x Pro: inline-encode (1-3s) →
 * request fire (1-2s) → streaming (5-25s). Streaming is interpolated
 * by output token count (typical field-map / description / correction
 * payloads run 800-3000 output tokens).
 */
function innerProgressFraction(progress: GeminiProgress): number {
  switch (progress.phase) {
    case "uploading_file":
      return 0.05;
    case "file_uploaded":
      return 0.15;
    case "request_sent":
      return 0.3;
    case "streaming": {
      const tokens = progress.tokens ?? 0;
      const expected = 1500;
      const ratio = Math.min(1, tokens / expected);
      return 0.3 + ratio * 0.65;
    }
    case "done":
    case "error":
      return 1.0;
    default:
      return 0.0;
  }
}

function progressToStatus(
  progress: GeminiProgress,
  elapsedSec: number,
  phase: DetectionPhase
): string {
  const elapsed = elapsedSec > 0 ? ` (${elapsedSec}s)` : "";

  // Stage 1a (v0.4.12 description-first pass) and Stage 1b
  // (description→JSON) get their own user-facing copy so the
  // progress feed shows real motion across the new pipeline.
  if (phase === "stage1a") {
    switch (progress.phase) {
      case "uploading_file":
      case "file_uploaded":
      case "request_sent":
      case "streaming":
        return progress.tokens && progress.phase === "streaming"
          ? `Reviewing form layout (${progress.tokens} tokens)${elapsed}…`
          : `Reviewing form layout${elapsed}…`;
      case "done":
        return `Layout review complete${elapsed}.`;
      case "error":
        return progress.detail
          ? `Layout review error: ${progress.detail}`
          : `Layout review failed.`;
      default:
        return `Reviewing form layout${elapsed}…`;
    }
  }
  if (phase === "stage1b") {
    switch (progress.phase) {
      case "uploading_file":
      case "file_uploaded":
      case "request_sent":
      case "streaming":
        return progress.tokens && progress.phase === "streaming"
          ? `Mapping fields to coordinates (${progress.tokens} tokens)${elapsed}…`
          : `Mapping fields to coordinates${elapsed}…`;
      case "done":
        return `Coordinate mapping complete${elapsed}.`;
      case "error":
        return progress.detail
          ? `Coordinate mapping error: ${progress.detail}`
          : `Coordinate mapping failed.`;
      default:
        return `Mapping fields to coordinates${elapsed}…`;
    }
  }
  if (phase === "qc") {
    switch (progress.phase) {
      case "uploading_file":
        return `Verifying detected fields — uploading PDF${elapsed}…`;
      case "file_uploaded":
        return `Verifying detected fields — Gemini is auditing${elapsed}…`;
      case "request_sent":
        return `Verifying detected fields${elapsed}…`;
      case "streaming":
        return progress.tokens
          ? `Verifying detected fields (${progress.tokens} tokens)${elapsed}…`
          : `Verifying detected fields${elapsed}…`;
      case "done":
        return `Verification complete${elapsed}.`;
      case "error":
        return progress.detail
          ? `Verification error: ${progress.detail}`
          : `Verification failed.`;
      default:
        return `Verifying${elapsed}…`;
    }
  }
  // Fast-mode single-shot Pass 1.
  switch (progress.phase) {
    case "uploading_file":
      return `Uploading PDF to Gemini${elapsed}…`;
    case "file_uploaded":
      return `PDF uploaded — Gemini is reading${elapsed}…`;
    case "request_sent":
      return `Gemini is reading your form${elapsed}…`;
    case "streaming":
      return progress.tokens
        ? `Gemini is writing the field map (${progress.tokens} tokens)${elapsed}…`
        : `Gemini is writing the field map${elapsed}…`;
    case "done":
      return `Done${elapsed}.`;
    case "error":
      return progress.detail
        ? `Gemini error: ${progress.detail}`
        : `Gemini failed.`;
    default:
      return `Gemini${elapsed}…`;
  }
}

/**
 * Maps a phase to a 0-1 progress fraction within a configurable band.
 * The DocumentList progress bar uses the resulting fraction as a hard
 * floor and animates a time-based curve up to it.
 *
 * Bands (v0.4.12):
 *   - Fast mode: pass1 → [0, 1].
 *   - Maximum mode: rendering [0, 0.05] (handled outside this function),
 *     stage1a → [0.05, 0.30], stage1b → [0.30, 0.55], qc → [0.55, 0.95],
 *     applying corrections [0.95, 1.0] (handled by the QC dispatcher).
 */
function progressToFraction(
  progress: GeminiProgress,
  bandStart: number,
  bandEnd: number
): number {
  const inner = innerProgressFraction(progress);
  return bandStart + inner * Math.max(0, bandEnd - bandStart);
}

// ---------------------------------------------------------------------------
// Truncated-JSON salvage
// ---------------------------------------------------------------------------

/**
 * Best-effort recovery from a malformed JSON payload. Two scenarios:
 *
 *   1. The response was truncated mid-array because of `MAX_TOKENS`,
 *      leaving something like
 *        `{"fields":[{"label":"A",...},{"label":"B`
 *      We walk the string forward keeping a balanced bracket/brace
 *      stack, stop at the last comma that completed an array element,
 *      and then close all open scopes.
 *   2. The model leaked preamble text before/after the JSON object.
 *      We trim to the outermost balanced `{...}` we can find.
 *
 * Returns the parsed object on success or null if no salvage is
 * possible. Always defensive — if the salvage attempt itself throws,
 * we just return null and let the caller surface the original error.
 */
function salvageTruncatedJson(raw: string): unknown | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depthCurly = 0;
  let depthSquare = 0;
  let inString = false;
  let escape = false;
  let lastSafeEnd = -1;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depthCurly += 1;
    else if (ch === "}") {
      depthCurly -= 1;
      if (depthCurly === 0 && depthSquare === 0) {
        // We just closed the top-level object cleanly.
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          // Continue scanning — stray `}` inside a string we missed.
        }
      }
    } else if (ch === "[") depthSquare += 1;
    else if (ch === "]") depthSquare -= 1;

    // Mark every position where we just completed an array element —
    // i.e. a `}` immediately followed by `,` inside an array. Those
    // are the points we can rewind to and append `]}` to close cleanly.
    if (
      ch === "}" &&
      depthCurly > 0 &&
      depthSquare > 0 &&
      raw[i + 1] === ","
    ) {
      lastSafeEnd = i;
    }
  }

  // We never closed the top-level object cleanly. If we have a safe
  // rewind point, close everything from there.
  if (lastSafeEnd > 0) {
    let candidate = raw.slice(start, lastSafeEnd + 1);
    // We left off after `}` of the last complete element, so close
    // remaining open arrays/objects. We don't know the exact shape of
    // the partial state at this point, so we close conservatively:
    // strip any trailing comma we may pick up, then append `]}`.
    candidate = candidate.replace(/,\s*$/, "");
    candidate = `${candidate}]}`;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DetectFieldsOptions {
  /** Optional Project hint — currently unused but kept for parity with
   *  the previous detector signature so call sites stay identical. */
  projectHint?: Project | null;
  /** Original filename — only used in the user prompt for context. */
  filename?: string;
}

/**
 * Run a Gemini-powered field detection on a PDF. Returns the resolved
 * TemplateField[] ready for the UI to render.
 *
 * `onStatus` is called repeatedly with (message, progress fraction) as
 * the streaming response advances; the renderer pipes those into
 * `ProjectDocument.processingMessage` + `processingProgress`.
 */
export async function detectFieldsWithClaude(
  pdfBytes: Uint8Array,
  _pageNumber: number = 1,
  onStatus?: (status: string, progress?: number) => void,
  options: DetectFieldsOptions = {}
): Promise<TemplateField[]> {
  // Function name preserved for signature parity with the old Claude
  // entrypoint — saves a wave of churn at every call site. The actual
  // backend is Gemini.
  return detectFieldsImpl(pdfBytes, onStatus, options);
}

/** Preferred name going forward — calls into the same implementation. */
export const detectFieldsWithGeminiPublic = detectFieldsWithClaude;

/**
 * Run a single Gemini round-trip with streaming progress events. Used
 * by both Pass 1 (field detection) and Pass 2 (QC audit). Emits
 * `progressToStatus` / `progressToFraction` values keyed by `phase`
 * so the renderer can show distinct messages and progress-bar bands
 * for each pass.
 *
 * v0.4.9+: the round-trip sends pre-rendered page images (not the raw
 * PDF) to Gemini. The `pages` array is the canonical source of truth
 * for both the request payload (`pngBytes`) and the bbox→points
 * conversion (`widthPx`/`pageWidthPt` etc.).
 */
async function runGeminiRoundTrip(args: {
  pages: RenderedPage[];
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Pass `null` to opt out of structured-output mode (Stage 1a, v0.4.12).
   * Otherwise this is forwarded to Gemini as the responseSchema and we
   * receive strict JSON back.
   */
  responseSchema: Record<string, unknown> | null;
  maxOutputTokens: number;
  temperature: number;
  onStatus?: (status: string, progress?: number) => void;
  phase: DetectionPhase;
  /** Inclusive lower fraction of the progress-bar band for this phase. */
  bandStart: number;
  /** Inclusive upper fraction of the progress-bar band for this phase. */
  bandEnd: number;
}): Promise<{
  text: string;
  finishReason: string | null;
  usage: unknown;
  modelEcho: string;
}> {
  const startedAt = Date.now();
  let lastProgress: GeminiProgress = {
    phase: "uploading_file",
    detail: null,
    tokens: null,
  };
  const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000);
  const pushStatus = () =>
    args.onStatus?.(
      progressToStatus(lastProgress, elapsedSec(), args.phase),
      progressToFraction(lastProgress, args.bandStart, args.bandEnd)
    );

  pushStatus();
  const heartbeat = window.setInterval(pushStatus, 1000);
  const unsubscribe = await subscribeGeminiProgress((progress) => {
    lastProgress = progress;
    pushStatus();
  });

  try {
    const images: GeminiPageImage[] = args.pages.map((p) => ({
      pngBytes: p.pngBytes,
      pageNumber: p.pageNumber,
    }));
    const result = await detectFieldsWithGeminiImages({
      images,
      model: args.model,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      responseSchema: args.responseSchema,
      maxOutputTokens: args.maxOutputTokens,
      temperature: args.temperature,
    });
    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      modelEcho: result.model,
    };
  } finally {
    window.clearInterval(heartbeat);
    unsubscribe();
  }
}

/**
 * Parse a Gemini structured-output response, with the same salvager
 * fallbacks the original Pass 1 used. Shared by Pass 1 and Pass 2.
 */
function parseStructuredResponse<T>(
  text: string,
  finishReason: string | null,
  context: string
): T {
  const truncated = finishReason === "MAX_TOKENS";
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const salvaged = salvageTruncatedJson(text);
    if (salvaged) {
      console.warn(
        `[Typeset Gemini] Recovered ${context} from truncated/malformed response (finishReason=${finishReason}).`
      );
      return salvaged as T;
    }
    const hint = truncated
      ? " The response was truncated by the token limit — try a denser form on Pro instead of Flash, or split the form into fewer pages."
      : "";
    throw new GeminiApiError(
      `Gemini returned non-JSON content during ${context}.${hint} (parse error: ${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
}

interface Pass1Result {
  fields: TemplateField[];
  /** Original raw fields keyed by mapped TemplateField id. The QC pass
   *  uses these to re-map any field whose action is `fix`, so the
   *  deterministic post-processing (alias matcher, type guard, label
   *  cleanup) runs on the corrected raw payload exactly the way it did
   *  for Pass 1. */
  rawByFieldId: Map<string, RawGeminiField>;
}

/**
 * Shared field-mapping pipeline used by both Pass-1 paths
 * (Fast-mode single-shot and Maximum-mode Stage 1b). Takes the raw
 * Gemini-returned fields, runs them through `mapToTemplateField`,
 * dedupes spatially-overlapping detections, and returns the mapped
 * fields paired with the surviving raw entries (the QC pass needs
 * those raw payloads to re-map any field whose action is `fix`).
 */
function mapPass1RawFields(
  rawFields: RawGeminiField[],
  pages: RenderedPage[]
): Pass1Result {
  const mapped: TemplateField[] = [];
  const rawByFieldId = new Map<string, RawGeminiField>();
  for (let i = 0; i < rawFields.length; i += 1) {
    const raw = rawFields[i];
    const field = mapToTemplateField(raw, i, pages);
    if (field) {
      mapped.push(field);
      rawByFieldId.set(field.id, raw);
    }
  }
  // v0.5.26 — drop spurious model-emitted option-groups (e.g. a
  // 2-option `["Other:", "Cardholder Name"]` cluster on the Arrow CC
  // form) BEFORE the merge pass so the merge sees a clean field
  // list. The shape filter inspects only `fieldType === "option-group"`
  // entries; everything else passes through untouched.
  const filtered = dropMisshapenOptionGroups(mapped);
  // v0.5.25 — option-group merge runs BEFORE dedup so the merged
  // cardType field is the one that participates in dedup overlap
  // checks (the original 4-5 sibling text/checkbox fields disappear).
  const groupMerged = mergeCardTypeOptionGroup(filtered);
  const deduped = dedupeFields(groupMerged);

  // Drop any raw entries whose mapped field got dedup'd away — the QC
  // pass should only audit fields we actually kept.
  const keptIds = new Set(deduped.map((f) => f.id));
  for (const id of rawByFieldId.keys()) {
    if (!keptIds.has(id)) rawByFieldId.delete(id);
  }

  return { fields: deduped, rawByFieldId };
}

/**
 * Fast-mode Pass 1 (the v0.4.7-v0.4.11 single-shot detection). Same
 * Gemini call, same system prompt, same `responseSchema`. This path
 * is preserved verbatim so Fast-mode behavior is unchanged in
 * v0.4.12.
 */
async function runPass1Single(
  pages: RenderedPage[],
  filename: string,
  model: string,
  onStatus?: (status: string, progress?: number) => void
): Promise<Pass1Result> {
  const result = await runGeminiRoundTrip({
    pages,
    model,
    systemPrompt: buildPass1SharedSystemPrompt(),
    userPrompt: buildUserPrompt(pages, filename),
    responseSchema: RESPONSE_SCHEMA,
    // Empirical: a typical CCAUTH form with 20-30 fields, each
    // carrying a ~6-word context snippet + 4-element bbox + canonical
    // id, runs ~150-220 output tokens per field. Multi-page vendor
    // packets push past 25 fields. 4096 truncates mid-array on every
    // dense form (manifests as "Expected ']' " parse errors). 32k
    // gives ~3-4x headroom against the worst form we've seen and is
    // well within the 65k output budget on Gemini 2.5/3.x Pro.
    maxOutputTokens: 32768,
    temperature: 0.0,
    onStatus,
    phase: "pass1",
    bandStart: 0,
    bandEnd: 1.0,
  });

  console.log(
    `[Typeset Gemini] pass1 model=${model} stop=${result.finishReason} usage=${JSON.stringify(result.usage)}`
  );

  const parsed = parseStructuredResponse<RawGeminiResponse>(
    result.text,
    result.finishReason,
    "Pass 1"
  );

  return mapPass1RawFields(parsed.fields ?? [], pages);
}

/**
 * v0.4.12 Stage 1a — free-form description pass. Asks Gemini to walk
 * through the form image-by-image and describe every fillable field
 * in plain English. NO `responseSchema`. The output is consumed
 * verbatim as Stage 1b's "field-by-field checklist" preamble; we
 * don't parse it, we just ship it forward.
 *
 * Maximum-mode progress band: [0.05, 0.30] (rendering occupied
 * [0, 0.05] before this is called).
 */
async function runStage1a(
  pages: RenderedPage[],
  filename: string,
  model: string,
  onStatus?: (status: string, progress?: number) => void
): Promise<string> {
  const result = await runGeminiRoundTrip({
    pages,
    model,
    systemPrompt: buildStage1aSystemPrompt(),
    userPrompt: buildStage1aUserPrompt(pages, filename),
    // No responseSchema — this is a free-form natural-language pass.
    // The Rust side detects `null` here and omits both
    // `responseMimeType` and `responseSchema` from generationConfig.
    responseSchema: null,
    // 16k is plenty for a thorough English walk-through of every
    // field on a multi-page form (typically 1-3 sentences per field
    // × 20-40 fields ≈ 1500-3000 tokens). The cap is well within
    // Gemini 3.x Pro's output budget.
    maxOutputTokens: 16384,
    temperature: 0.0,
    onStatus,
    phase: "stage1a",
    bandStart: 0.05,
    bandEnd: 0.30,
  });

  console.log(
    `[Typeset Gemini] stage1a model=${model} stop=${result.finishReason} usage=${JSON.stringify(result.usage)}`
  );

  const text = result.text ?? "";
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
  console.log(
    `[Typeset Diag] Stage 1a response length: ${text.length} chars (preview: ${preview}...)`
  );

  if (text.trim().length === 0) {
    throw new GeminiApiError(
      "Stage 1a returned an empty description; cannot proceed to Stage 1b."
    );
  }

  return text;
}

/**
 * v0.4.12 Stage 1b — description→structured-JSON pass. Same Gemini
 * call shape as the legacy Pass 1 (same images, same `responseSchema`,
 * same maxOutputTokens, every v0.4.6/4.7/4.8/4.9/4.11 prompt rule
 * preserved) PLUS the Stage-1a free-form description prepended to
 * the system prompt as an authoritative checklist.
 *
 * Maximum-mode progress band: [0.30, 0.55].
 */
async function runStage1b(
  pages: RenderedPage[],
  filename: string,
  model: string,
  stage1aText: string,
  onStatus?: (status: string, progress?: number) => void
): Promise<Pass1Result> {
  const result = await runGeminiRoundTrip({
    pages,
    model,
    systemPrompt: buildStage1bSystemPrompt(stage1aText),
    userPrompt: buildUserPrompt(pages, filename),
    responseSchema: RESPONSE_SCHEMA,
    // Same 32k budget as legacy Pass 1 — Stage 1b returns the same
    // shape and dimensionality of output.
    maxOutputTokens: 32768,
    temperature: 0.0,
    onStatus,
    phase: "stage1b",
    bandStart: 0.30,
    bandEnd: 0.55,
  });

  console.log(
    `[Typeset Gemini] stage1b model=${model} stop=${result.finishReason} usage=${JSON.stringify(result.usage)}`
  );

  const parsed = parseStructuredResponse<RawGeminiResponse>(
    result.text,
    result.finishReason,
    "Stage 1b"
  );

  const mapped = mapPass1RawFields(parsed.fields ?? [], pages);
  console.log(`[Typeset Diag] Stage 1b found ${mapped.fields.length} field(s)`);
  return mapped;
}

/**
 * v0.4.12 Maximum-mode Pass 1 orchestrator. Runs Stage 1a (free-form
 * description) and feeds the resulting text into Stage 1b
 * (description→JSON), returning the same {fields, rawByFieldId}
 * shape Pass 2 QC expects. The QC pass downstream is unchanged.
 */
async function runPass1TwoStage(
  pages: RenderedPage[],
  filename: string,
  model: string,
  onStatus?: (status: string, progress?: number) => void
): Promise<Pass1Result> {
  const stage1aText = await runStage1a(pages, filename, model, onStatus);
  return await runStage1b(pages, filename, model, stage1aText, onStatus);
}

async function detectFieldsImpl(
  pdfBytes: Uint8Array,
  onStatus?: (status: string, progress?: number) => void,
  options: DetectFieldsOptions = {}
): Promise<TemplateField[]> {
  const filename = options.filename ?? "document.pdf";
  onStatus?.("Rendering PDF pages…", 0.02);

  const pages = await renderPagesToPng(pdfBytes, (current, total) => {
    onStatus?.(
      `Rendering page ${current}/${total} for Gemini…`,
      0.02 + 0.05 * (current / Math.max(1, total))
    );
  });
  if (pages.length === 0) {
    throw new GeminiApiError("PDF has no readable pages.");
  }

  // [Typeset Diag] Page-size + render-scale dump. Logged once per run
  // so we can correlate any stray bbox offsets with the underlying
  // page geometry.
  for (const p of pages) {
    console.log(
      `[Typeset Diag] Page ${p.pageNumber} size: width=${p.pageWidthPt}pt, height=${p.pageHeightPt}pt | rendered=${p.widthPx}×${p.heightPx}px (scale=${(p.widthPx / Math.max(1, p.pageWidthPt)).toFixed(3)}x)`
    );
  }

  const model = getModelPreference();
  const accuracyMode = getAccuracyMode();
  const twoPass = accuracyMode === "maximum";

  // v0.4.12: Maximum mode runs the new two-stage Pass 1 (free-form
  // description → description-aware structured JSON). Fast mode
  // continues to use the legacy single-shot Pass 1.
  const pass1 = twoPass
    ? await runPass1TwoStage(pages, filename, model, onStatus)
    : await runPass1Single(pages, filename, model, onStatus);

  // v0.5.5 — build the page-render map ONCE here so both Fast-mode
  // and Maximum-mode paths can hand it to the underline-snap
  // post-processor without re-deriving it. PageRender uses
  // PDF-points-per-pixel because the snap algorithm carries its
  // bbox math in pixel space and back-converts at the end.
  const pageRenders: Record<number, PageRender> = {};
  for (const p of pages) {
    if (!p.imageData) continue;
    pageRenders[p.pageNumber] = {
      imageData: p.imageData,
      width: p.widthPx,
      height: p.heightPx,
      pdfPointsPerPixel: p.pageWidthPt / Math.max(1, p.widthPx),
      // v0.5.25 — pass through the text-row geometry pulled in
      // `renderPagesToPng` so the snap's text-row fallback has
      // something to work with on fields whose stroke search comes
      // up empty.
      textRows: p.textRows,
    };
  }

  if (!twoPass) {
    // v0.5.5 snap runs once per detection regardless of accuracy
    // mode, AFTER mapToTemplateField + dedup but BEFORE we hand the
    // fields back to the UI. Verbose logging is on so the snap's
    // per-field decisions land in the diagnostic log next to
    // Pass 1's bbox dumps.
    const snapped = snapFieldsToUnderlines(pass1.fields, pageRenders, {
      verbose: true,
    });
    onStatus?.(`Gemini detected ${snapped.length} field(s).`, 1);
    return snapped;
  }

  // ----- Pass 2: quality-control audit ------------------------------------
  onStatus?.(
    `Pass 1 detected ${pass1.fields.length} field(s); starting verification…`,
    0.55
  );

  let qcFields: TemplateField[];
  try {
    qcFields = await runQualityControlPass({
      pages,
      filename,
      model,
      pass1Fields: pass1.fields,
      rawByFieldId: pass1.rawByFieldId,
      onStatus,
    });
  } catch (err) {
    // Never let a Pass-2 failure regress accuracy below Pass 1. Log the
    // exception loudly and fall back to Pass-1 output.
    console.warn(
      `[Typeset Gemini QC] Verification pass failed; falling back to Pass 1: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    // Snap still runs on the Pass-1 fallback — the v0.5.5 nudge is
    // model-agnostic and is most useful precisely when QC fails.
    const snapped = snapFieldsToUnderlines(pass1.fields, pageRenders, {
      verbose: true,
    });
    onStatus?.(
      `Verification failed; using Pass 1 results (${snapped.length} field(s)).`,
      1
    );
    return snapped;
  }

  const snapped = snapFieldsToUnderlines(qcFields, pageRenders, {
    verbose: true,
  });
  onStatus?.(
    `Detection complete — ${snapped.length} field(s) after verification.`,
    1
  );
  return snapped;
}

// ---------------------------------------------------------------------------
// Quality-control (Pass 2) audit
// ---------------------------------------------------------------------------

interface AuditFieldDescriptor {
  id: string;
  page_number: number;
  bbox: [number, number, number, number];
  field_type: "text" | "checkbox";
  canonical_field_id: string | null;
  label: string;
  context_before: string;
  context_after: string;
}

interface FieldCorrection {
  id?: string;
  action?: string;
  fixed_bbox?: number[] | null;
  fixed_field_type?: string | null;
  fixed_canonical_field_id?: string | null;
  reason?: string;
}

interface CorrectionResponse {
  corrections?: FieldCorrection[];
}

const QC_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["corrections"],
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "action"],
        propertyOrdering: [
          "id",
          "action",
          "fixed_bbox",
          "fixed_field_type",
          "fixed_canonical_field_id",
          "reason",
        ],
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["keep", "drop", "fix"] },
          fixed_bbox: {
            type: "array",
            description:
              "[y_min, x_min, y_max, x_max], integers in normalized 0-1000 range. Required only when action=fix and the bbox is wrong.",
            items: { type: "integer", minimum: 0, maximum: 1000 },
            minItems: 4,
            maxItems: 4,
            nullable: true,
          },
          fixed_field_type: {
            type: "string",
            enum: ["text", "checkbox"],
            nullable: true,
          },
          fixed_canonical_field_id: {
            type: "string",
            nullable: true,
            description:
              "One of the canonical ids listed in the system prompt, or null. Required only when the field's canonical id is wrong.",
          },
          reason: { type: "string" },
        },
      },
    },
  },
};

function buildQualityControlSystemPrompt(): string {
  return [
    "You are auditing field detection on a paper/PDF form. You have been sent one IMAGE per page (in page order). A previous pass produced a list of detected fields; for each one, decide whether it is correctly placed and typed given the actual page images.",
    "",
    "Return ONLY a JSON object that conforms to the supplied responseSchema. No prose, no markdown fences.",
    "",
    "## Coordinate system",
    "Bounding boxes use the SAME native system as Pass 1: `[y_min, x_min, y_max, x_max]` integers in the normalized 0-1000 range, computed against the dimensions of the page image that contains the field. Y-first ordering is mandatory; (0,0) is the TOP-LEFT corner of the image, y increasing downward.",
    "",
    "## Output shape",
    "For every input field, emit exactly one entry in `corrections` keyed by its `id`. Use:",
    "  - `action: \"keep\"` — the field is correct as-is. Set every `fixed_*` to null.",
    "  - `action: \"drop\"` — there is no writable area at this location, or the field is a duplicate of another. Set every `fixed_*` to null.",
    "  - `action: \"fix\"` — at least one of the field's properties is wrong. Set ONLY the `fixed_*` properties that need to change; leave the others null.",
    "",
    "Always include the original `id` exactly as provided. Never invent new fields and never re-key.",
    "",
    "## Label position relative to the writable area",
    "Before judging any field, identify which of three real-world layouts the form uses for that row, because the bbox ALWAYS covers the empty writable area — NEVER the printed label — regardless of layout:",
    "  - Layout A (label-LEFT): label on the same horizontal scan line as the blank, e.g. `Cardholder Name: ____`. Bbox covers ONLY the underscores / empty space to the right of the colon.",
    "  - Layout B (label-ABOVE): label sits on the line above the blank, e.g. `Cardholder Name` printed above an empty line. Bbox covers the EMPTY LINE below the label.",
    "  - Layout C (label-BELOW): label sits on the line BELOW the blank as a small-caps or all-caps caption, e.g. `[empty band]` over `PHONE NUMBER`. Bbox covers the EMPTY BAND ABOVE the caption — NEVER the caption text itself. Common examples: `PHONE NUMBER`, `EMAIL ADDRESS`, `EXP DATE`, `CVV#`, `CREDIT CARD NUMBER`, `ZIP CODE`, `BILLING ADDRESS`.",
    "",
    "## Audit rules — apply EVERY rule to EVERY field",
    "",
    "Overall posture: BIAS TOWARD `keep`. False drops are worse than false keeps — the user can manually delete an unwanted field downstream, but a dropped field is lost silently. Only `drop` when you are highly confident the field is invalid; only `fix` when you are confident the input is wrong AND you can express the correct value.",
    "",
    "### 0. Label-below-line check — RUN THIS FIRST",
    "If a field's bbox is placed ON or OVERLAPPING what looks like a printed all-caps or small-caps form-field caption (≤ 4 words, ≤ 20 characters, e.g. `PHONE NUMBER`, `EMAIL ADDRESS`, `EXP DATE`, `CVV#`, `CREDIT CARD NUMBER`, `ZIP CODE`, `STATE`), then the bbox is wrong: that label is NOT the writable area. The writable area is the EMPTY BAND IMMEDIATELY ABOVE the label.",
    "  - `action: \"fix\"` with a `fixed_bbox` whose y-range sits IMMEDIATELY ABOVE the label's y-range. Match the label's x-range (or extend slightly) and use the local row height for the band's vertical extent.",
    "  - Do NOT `drop` such a field — the writable area exists, it's just one row above where the previous pass placed the bbox. Re-place it; don't delete it.",
    "  - Use the printed label text to populate `fixed_canonical_field_id` when it matches the canonical alias list (`PHONE NUMBER` → `phone`, `EXP DATE` → `expDate`, `CVV#` → `ccv`, `CREDIT CARD NUMBER` → `creditCardNumber`, `ZIP CODE` → `billingZipCode`, `EMAIL ADDRESS` → `email`, `BILLING ADDRESS` → `billingAddress`, `CITY` → `billingCity`, `STATE` → `billingState`).",
    "  - This rule MUST run BEFORE the \"when uncertain, KEEP\" guidance below — confidently-detectable label-below regressions get fixed, not silently kept.",
    "",
    "### 1. Bbox tightness — prefer `fix` over `drop`",
    "The bbox must hug the writable blank only. If a horizontal scan line through the current bbox would cross printed letters of a label, the bbox is wrong — but PREFER `action: \"fix\"` with a tighter `fixed_bbox` over `action: \"drop\"`. Only choose `drop` when you are CERTAIN there is no writable line, drawn box, or empty fillable area at any reasonable nearby position. If the current bbox is misplaced but a writable area DOES exist within ~40 PDF points (≈ 50 normalized units) of where the bbox sits, choose `fix` and emit a corrected `fixed_bbox` that covers the actual blank. Underline strokes can be subtle in a rasterized view — assume the writable line exists if the surrounding context implies a fillable field, even when the underline isn't crisply visible.",
    "",
    "### 2. Type accuracy — CVV / security code is ALWAYS text",
    "If the surrounding text contains any of: 'CVV', 'CVV2', 'CVC', 'security code', 'verification code', 'card identification', '3 digit', '3-digit', '4 digit', '4-digit', the field MUST be `text` with `canonical_field_id: \"ccv\"` — even if the form draws a small rectangle around it. The 'Visa', 'MC', or 'AMEX' tokens that often appear in CVV instructional text (e.g. '3-digit number on back of Visa/MC, 4 digits on front of AMEX') are NOT card-type checkboxes; they are part of the CVV's instructional sentence. If the input field has any of these properties wrong, `action: \"fix\"` with the corrected values.",
    "",
    "### 3. Card-type checkboxes",
    "A Visa / MasterCard / AMEX / Discover field is a checkbox ONLY when:",
    "  (a) the box is one of a row of card-type selectors (e.g. `☐ Visa  ☐ MasterCard  ☐ AMEX  ☐ Discover`), AND",
    "  (b) the printed card name appears IMMEDIATELY to the right of the box on the same horizontal scan line, AND",
    "  (c) the row context does NOT mention CVV / CVC / security / verification code / 'digit'.",
    "If those conditions don't hold, the field is not a card-type checkbox. Fix it accordingly.",
    "",
    "### 3b. Option-group misses (v0.5.25)",
    "If Pass 1 emitted four or five SEPARATE checkbox fields for a card-type row but there are NO drawn ☐/circle glyphs next to each label on the page (the labels are just bare horizontal text the user is meant to circle), the row should have been ONE `option-group` field, not four checkboxes. Action: `keep` each of the existing fields (do NOT drop them — Pass 1 is a separate pass and the merge happens deterministically downstream). Mark Pass-1's misclassification by leaving them as `keep` and trust the post-processing merge step. Symmetric: if Pass 1 emitted ONE `option-group` field for a row that DOES have drawn ☐ glyphs next to each label, mark each as `keep` — the merge step is one-way (split → group). The post-processing merge runs in `geminiFieldDetector.ts` regardless of Pass 2's output.",
    "",
    "### 4. Duplicates — IoU > 0.5 AND same canonical id",
    "Only treat two fields as duplicates when ALL of the following hold:",
    "  (a) they share the SAME `canonical_field_id` (different ids → never duplicates), AND",
    "  (b) their bbox intersection-over-union (IoU) exceeds 0.5.",
    "Compute IoU as area(intersection) / area(union); use IoU, NOT \"% overlap of either box\". This is intentionally stricter than naive overlap and avoids dropping a small bbox that merely sits near a larger one.",
    "Two fields with the same canonical id at DIFFERENT positions on the page are LEGITIMATE repeats and BOTH must be kept. Examples that occur in this corpus and MUST survive:",
    "  - Two `creditCardHolder` (Cardholder Name) lines: one inline-sentence (`I, _____, authorize...`) at the top of the form, plus a column-style `Cardholder Name: _____` mid-form.",
    "  - Two `expDate` (Expiration Date) columns: e.g. `Card Number: _____ Exp Date: _____` and a second exp-date column elsewhere on the form.",
    "  - Multiple signature/date pairs on the same form.",
    "When in doubt about whether two repeats are duplicates, KEEP both.",
    "",
    "### 4b. Vertical baseline check (v0.5.16) — apply BEFORE the keep-bias",
    "If a field's bbox is centered on its underline stroke OR sits entirely below the stroke (the bbox BOTTOM EDGE does NOT land on the stroke), the bbox is misaligned vertically — `action: \"fix\"` with a `fixed_bbox` whose bottom edge sits on the stroke and which extends UPWARD from there (text-baseline geometry: bbox_bottom = stroke_y, total height matching the local line height of typed text). This is the most common Pass-1 alignment error: a bbox correctly horizontal but anchored centered-on or below the underline, so the typed text overflows past the line. For Layout C (label-BELOW), the bottom of the bbox MUST sit within 2-3pt of the top of the caption text — if there's a noticeable gap, shift the bbox DOWN until it abuts the caption. Apply this fix even when otherwise uncertain — vertical baseline alignment is mechanical and easy to verify by inspection.",
    "",
    "### 5. When uncertain, KEEP",
    "False drops are worse than false keeps. If you cannot decide between `keep` and `drop`, choose `keep`. If you cannot decide between `keep` and `fix`, choose `keep`. Only `drop` when you are highly confident the field is invalid (no writable area at all anywhere nearby) or a true duplicate per Rule 4. Only `fix` when you are confident the input is wrong AND you can express the corrected value. (Rule 4b is an explicit exception: vertical baseline errors should be fixed because the corrective bbox is mechanically determinable from the underline position.)",
    "",
    "### 6. Default",
    "When the field looks correct, return `action: \"keep\"` with all `fixed_*` null. Do not churn fields that are already right.",
    "",
    "## Canonical field ids",
    "When you set `fixed_canonical_field_id`, it MUST be one of the ids below or null. Inventing ids breaks the downstream mapping:",
    buildCatalogSummary(),
    "",
    "## `reason`",
    "One short sentence (≤ 15 words) explaining why you took the chosen action. Used for diagnostic logs.",
  ].join("\n");
}

function buildQualityControlUserPrompt(
  pages: RenderedPage[],
  filename: string,
  fields: AuditFieldDescriptor[]
): string {
  return [
    `Filename: ${filename}`,
    `Page count: ${pages.length}`,
    "",
    "You have been sent one image per page, in page order. Each image's pixel dimensions are listed below — bbox values are normalized 0-1000 against these dimensions.",
    "Page images:",
    pages
      .map(
        (p) => `  page ${p.pageNumber}: ${p.widthPx} × ${p.heightPx} px`
      )
      .join("\n"),
    "",
    `Pass 1 detected ${fields.length} field(s). Audit each one and return the corrections JSON.`,
    "",
    "Detected fields:",
    JSON.stringify(fields, null, 2),
  ].join("\n");
}

/**
 * Apply a single correction to a Pass-1 field. Re-runs the
 * `mapToTemplateField` pipeline on the corrected raw payload so the
 * deterministic post-processing (alias matcher, type guard, label
 * cleanup) runs identically to Pass 1. Returns null when the field
 * should be dropped.
 *
 * The v0.4.5/v0.4.6 type guard is preserved here by definition: we
 * patch the raw `field_type` / `canonical_field_id` / `bbox`, then
 * delegate to `mapToTemplateField`, which still runs the canonical-id
 * resolver, the type guard ("CVV is always text"), and the dedup-
 * relevant rect normalization. Pass 2 cannot weaken these protections
 * because the same code path validates the result.
 */
function applyCorrectionToField(
  field: TemplateField,
  raw: RawGeminiField,
  correction: FieldCorrection,
  index: number,
  pages: RenderedPage[]
): TemplateField | null {
  const action = (correction.action ?? "keep").toLowerCase();
  if (action === "drop") return null;
  if (action !== "fix") return field;

  const patched: RawGeminiField = { ...raw };

  if (Array.isArray(correction.fixed_bbox) && correction.fixed_bbox.length === 4) {
    patched.bbox = correction.fixed_bbox.slice(0, 4);
  }

  if (typeof correction.fixed_field_type === "string") {
    const t = correction.fixed_field_type.toLowerCase();
    if (t === "text" || t === "checkbox") {
      patched.field_type = t;
    }
  }

  if (typeof correction.fixed_canonical_field_id === "string") {
    const candidate = correction.fixed_canonical_field_id.trim();
    if (VALID_CANONICAL_IDS.has(candidate)) {
      patched.canonical_field_id = candidate;
    } else {
      console.warn(
        `[Typeset Gemini QC] Ignoring invalid fixed_canonical_field_id "${candidate}" on ${field.id}.`
      );
    }
  }

  // Re-run the full mapping pipeline on the patched raw. The type
  // guard inside `mapToTemplateField` still has the final word — e.g.
  // a fixed_field_type of "checkbox" with canonical_field_id "ccv"
  // will still be coerced back to "text" because ccv's canonical type
  // is text.
  const remapped = mapToTemplateField(patched, index, pages, field.id);
  return remapped ?? field;
}

/**
 * Build the audit-input payload that gets sent to Pass 2. The QC pass
 * receives the SAME PDF Gemini saw during Pass 1, plus a structured
 * dump of every Pass-1 field — bbox in normalized coordinates, field
 * type, canonical id, label, and row context.
 */
function buildAuditDescriptors(
  pass1Fields: TemplateField[],
  rawByFieldId: Map<string, RawGeminiField>,
  pages: RenderedPage[]
): AuditFieldDescriptor[] {
  return pass1Fields.map((field) => {
    const raw = rawByFieldId.get(field.id);
    const page =
      pages.find((p) => p.pageNumber === field.pageNumber) ?? pages[0];
    const fallbackPage: RenderedPage = page ?? {
      pageNumber: 1,
      pngBytes: new Uint8Array(),
      widthPx: 1,
      heightPx: 1,
      pageWidthPt: 612,
      pageHeightPt: 792,
    };
    const bbox = pdfRectToBbox(
      { x: field.x, y: field.y, width: field.width, height: field.height },
      fallbackPage
    );
    return {
      id: field.id,
      page_number: field.pageNumber,
      bbox,
      field_type: (field.fieldType ?? "text") as "text" | "checkbox",
      canonical_field_id: field.canonicalFieldId ?? null,
      label: field.label,
      context_before: (raw?.context_before ?? "").trim(),
      context_after: (raw?.context_after ?? "").trim(),
    };
  });
}

interface QcArgs {
  pages: RenderedPage[];
  filename: string;
  model: string;
  pass1Fields: TemplateField[];
  rawByFieldId: Map<string, RawGeminiField>;
  onStatus?: (status: string, progress?: number) => void;
}

async function runQualityControlPass(args: QcArgs): Promise<TemplateField[]> {
  if (args.pass1Fields.length === 0) return args.pass1Fields;

  const descriptors = buildAuditDescriptors(
    args.pass1Fields,
    args.rawByFieldId,
    args.pages
  );

  const result = await runGeminiRoundTrip({
    pages: args.pages,
    model: args.model,
    systemPrompt: buildQualityControlSystemPrompt(),
    userPrompt: buildQualityControlUserPrompt(args.pages, args.filename, descriptors),
    responseSchema: QC_RESPONSE_SCHEMA,
    // The audit response is much smaller than Pass 1 (one record per
    // input field, no bbox unless action=fix). 16k is comfortable for
    // ~150 fields and keeps us well below the model's 65k output cap.
    maxOutputTokens: 16384,
    temperature: 0.0,
    onStatus: args.onStatus,
    phase: "qc",
    // Pass 2 occupies [0.55, 0.95] in Maximum mode; the final 0.05 is
    // reserved for the deterministic correction-application step
    // ("Applying verification corrections…") below.
    bandStart: 0.55,
    bandEnd: 0.95,
  });

  console.log(
    `[Typeset Gemini QC] model=${args.model} stop=${result.finishReason} usage=${JSON.stringify(result.usage)}`
  );

  const parsed = parseStructuredResponse<CorrectionResponse>(
    result.text,
    result.finishReason,
    "Pass 2 (QC)"
  );

  const corrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
  const correctionsById = new Map<string, FieldCorrection>();
  for (const c of corrections) {
    if (typeof c.id === "string") correctionsById.set(c.id, c);
  }

  args.onStatus?.("Applying verification corrections…", 0.95);

  const corrected: TemplateField[] = [];
  let kept = 0;
  let fixed = 0;
  let dropped = 0;
  let dropOverrides = 0;

  for (let i = 0; i < args.pass1Fields.length; i += 1) {
    const field = args.pass1Fields[i];
    const correction = correctionsById.get(field.id);
    const raw = args.rawByFieldId.get(field.id);
    if (!correction || !raw) {
      // Model didn't return a correction for this field (or we don't
      // have the raw to re-map against) — keep it as-is rather than
      // silently dropping.
      corrected.push(field);
      kept += 1;
      continue;
    }
    const action = (correction.action ?? "keep").toLowerCase();
    const reason = (correction.reason ?? "").trim();

    if (action === "drop") {
      // Deterministic guardrail: a `drop` action against a field that
      // already resolved to a known canonical id (i.e. it was
      // confidently mapped via the alias / pattern / model-semantic
      // ladder in `mapToTemplateField`) is almost always a false drop
      // — Pass 2 can't see the underline strokes as well as Pass 1 in
      // some renderings, and we'd rather keep a confidently-mapped
      // field than silently delete it. Demote `drop` → `keep` here
      // and log the override loudly. This protects the v0.4.6 CVV
      // text-coercion path and the legitimate-repeat detection
      // (multiple Cardholder Name / Expiration Date instances on the
      // CC-auth form).
      if (
        field.canonicalFieldId &&
        VALID_CANONICAL_IDS.has(field.canonicalFieldId)
      ) {
        console.warn(
          `[Typeset Gemini QC] Drop overridden → keep for confidently-mapped field ${field.id} (${field.canonicalFieldId}, ${field.label}): ${
            reason || "no reason given"
          }`
        );
        corrected.push(field);
        kept += 1;
        dropOverrides += 1;
        continue;
      }
      console.log(
        `[Typeset Gemini QC] Dropped ${field.id} (${field.canonicalFieldId ?? "—"}, ${field.label}): ${
          reason || "no reason given"
        }`
      );
      dropped += 1;
      continue;
    }

    if (action === "fix") {
      const next = applyCorrectionToField(field, raw, correction, i, args.pages);
      if (!next) {
        console.log(
          `[Typeset Gemini QC] Fix → drop ${field.id} (${field.canonicalFieldId ?? "—"}, ${field.label}): ${
            reason || "fix produced no rect"
          }`
        );
        dropped += 1;
        continue;
      }
      const changedBbox =
        Math.abs(next.x - field.x) > 0.5 ||
        Math.abs(next.y - field.y) > 0.5 ||
        Math.abs(next.width - field.width) > 0.5 ||
        Math.abs(next.height - field.height) > 0.5;
      const changedType = next.fieldType !== field.fieldType;
      const changedCanonical = next.canonicalFieldId !== field.canonicalFieldId;
      console.log(
        `[Typeset Gemini QC] Fixed ${field.id} (${field.canonicalFieldId ?? "—"} → ${
          next.canonicalFieldId ?? "—"
        }, ${field.fieldType ?? "—"} → ${next.fieldType ?? "—"}, bbox-changed=${changedBbox}): ${
          reason || "no reason given"
        }`
      );
      if (changedBbox || changedType || changedCanonical) fixed += 1;
      else kept += 1;
      corrected.push(next);
      continue;
    }

    // Default: keep.
    corrected.push(field);
    kept += 1;
  }

  // Re-run dedup so any newly-overlapping fixed rects collapse the way
  // Pass 1 would have collapsed them.
  const deduped = dedupeFields(corrected);
  const dedupedDropped = corrected.length - deduped.length;

  console.log(
    `[Typeset Gemini QC] Summary: kept=${kept} fixed=${fixed} dropped=${dropped} drop-overrides=${dropOverrides} dedup-dropped=${dedupedDropped} (input=${args.pass1Fields.length}, output=${deduped.length})`
  );

  return deduped;
}

// ---------------------------------------------------------------------------
// Project-import helper (replaces the old extractProjectFromPdfWithClaude)
// ---------------------------------------------------------------------------

/**
 * Reads pre-filled values out of a completed PDF and returns them as
 * a `Partial<Project>`. Used by the "Import from PDF" affordance on
 * the project edit screen.
 *
 * A second, much simpler Gemini call: no responseSchema for fields,
 * just a tightly-scoped JSON object describing the project metadata.
 */
export async function extractProjectFromPdfWithClaude(
  pdfBytes: Uint8Array,
  options: { model?: string } = {}
): Promise<{ fields: Partial<Project>; fieldCount: number }> {
  const model = options.model ?? getModelPreference();

  const projectSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      label: { type: "string" },
      jobName: { type: "string" },
      jobNumber: { type: "string" },
      poNumber: { type: "string" },
      authorizationDate: { type: "string" },
      productionCompany: { type: "string" },
      billingAddress: { type: "string" },
      billingCity: { type: "string" },
      billingState: { type: "string" },
      billingZipCode: { type: "string" },
      producer: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      creditCardType: {
        type: "string",
        enum: ["visa", "mastercard", "discover", "amex"],
      },
      creditCardHolder: { type: "string" },
      creditCardNumber: { type: "string" },
      expDate: { type: "string" },
      ccv: { type: "string" },
    },
  };

  const systemPrompt = [
    "You are reading a filled-in production paperwork PDF and extracting any project metadata that has already been written into the form.",
    "",
    "Map extracted values to the fields in the responseSchema. Omit any keys you cannot confidently fill — do not guess.",
    "Return ONLY a JSON object conforming to the schema. No prose.",
    "Date format: MM/DD/YY or MM/DD/YYYY.",
  ].join("\n");

  const userPrompt =
    "Extract any pre-filled values from this PDF and return them as the JSON object described in the responseSchema.";

  const result = await detectFieldsWithGemini(pdfBytes, {
    model,
    systemPrompt,
    userPrompt,
    responseSchema: projectSchema,
    maxOutputTokens: 2048,
    temperature: 0.0,
  });

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(result.text) as Record<string, unknown>;
  } catch (err) {
    throw new GeminiApiError(
      `Gemini returned non-JSON content while extracting project fields. (parse error: ${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }

  const fields: Partial<Project> = {};
  let fieldCount = 0;

  const stringKeys: Array<keyof Project> = [
    "label",
    "jobName",
    "jobNumber",
    "poNumber",
    "authorizationDate",
    "productionCompany",
    "billingAddress",
    "billingCity",
    "billingState",
    "billingZipCode",
    "producer",
    "email",
    "phone",
    "creditCardHolder",
    "creditCardNumber",
    "expDate",
    "ccv",
  ];

  for (const key of stringKeys) {
    const value = parsed[key as string];
    if (typeof value === "string" && value.trim().length > 0) {
      (fields as Record<string, string>)[key as string] = value.trim();
      fieldCount += 1;
    }
  }

  if (typeof parsed.creditCardType === "string") {
    const normalized = normalizeCardType(parsed.creditCardType);
    if (normalized) {
      fields.creditCardType = normalized;
      fieldCount += 1;
    }
  }

  return { fields, fieldCount };
}
