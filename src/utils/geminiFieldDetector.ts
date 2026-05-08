/**
 * Gemini-powered field detection.
 *
 * Flow (mirrors what the Gemini desktop client appears to do under the
 * hood — single round-trip, no agentic dance):
 *
 *   1. Render PDF page sizes via pdfjs (we still need page dimensions
 *      locally to convert Gemini's 0-1000 normalized bbox coords back
 *      into PDF user-space).
 *   2. Send PDF + system+user prompt + responseSchema to Gemini.
 *      Gemini natively understands PDFs as a multimodal modality, so
 *      we DON'T pre-render to images and DON'T run a Python sandbox.
 *   3. Parse the strict-JSON response (responseSchema guarantees it
 *      parses).
 *   4. Map raw fields → TemplateField[] with deterministic canonical-id
 *      resolution and label cleanup. This is the same three-tier
 *      resolver from the previous Claude flow (alias match → pattern
 *      match → model-supplied semantic id) — keeping it preserves the
 *      hard-won accuracy on body-text patterns like
 *      `I, ____, authorize my credit card to be charged...`.
 *
 * Two-pass mode (v0.4.7+, default = "maximum"):
 *   When the user picks the "Maximum" accuracy preset, we run a second
 *   Gemini round-trip after Pass 1 finishes. Pass 2 sees the SAME PDF
 *   plus a structured dump of every field Pass 1 produced, and returns
 *   keep/drop/fix corrections per field. The corrections are applied
 *   deterministically and re-run through `mapToTemplateField` so the
 *   v0.4.5/v0.4.6 type-guard (CVV-as-checkbox → text) cannot be
 *   weakened by a Pass-2 mistake. ~12s typical end-to-end on Pro vs.
 *   ~6s for the single-pass Fast preset.
 *
 * Single-pass call typically completes in 5-10s on a 1-3 page production
 * form (Gemini 3.x Pro). Two-pass adds 4-6s. There is no Python
 * sandbox, no code-execution tool, no thinking-effort knob.
 *
 * Coordinate system contract with Gemini:
 *   - Gemini returns spatial coordinates in `[y_min, x_min, y_max, x_max]`
 *     as integers in the 0-1000 normalized range, per page.
 *   - We multiply (y/1000)*pageHeight and (x/1000)*pageWidth to get
 *     PDF user-space points. Y-first ordering is critical — reversing
 *     it produces fields rotated 90° from where they should be.
 *   - The `pageNumber` field is 1-based.
 */

import * as pdfjsLib from "pdfjs-dist";
import {
  detectFieldsWithGemini,
  GeminiNotConfiguredError,
  GeminiApiError,
  subscribeGeminiProgress,
  type GeminiProgress,
} from "@/services/geminiClient";
import { getAccuracyMode, getModelPreference } from "@/services/geminiSettings";
import {
  type CanonicalFieldId,
  type Project,
  type TemplateField,
  type TemplateFieldKind,
  type TemplateMappedProjectKey,
} from "@/types";
import { CANONICAL_FIELD_DEFINITIONS } from "@/utils/fieldCatalog";
import { normalizeCardType } from "@/utils/fill";

export {
  GeminiNotConfiguredError as ClaudeNotConfiguredError, // back-compat alias
  GeminiNotConfiguredError,
  GeminiApiError,
};

// ---------------------------------------------------------------------------
// Wire types — match the responseSchema 1:1.
// ---------------------------------------------------------------------------

interface PdfPageSize {
  pageNumber: number;
  width: number;
  height: number;
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

async function getPageSizes(pdfBytes: Uint8Array): Promise<PdfPageSize[]> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const pdf = await pdfjsLib.getDocument({ data: bytesCopy }).promise;
  const sizes: PdfPageSize[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    sizes.push({
      pageNumber,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
    });
  }
  pdf.destroy();
  return sizes;
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
 * The single system prompt. Designed to mirror Gemini's desktop-client
 * behaviour: ask for a clean structured-JSON response, not for the
 * model to "show its work" or run any tool. Native multimodal PDF
 * understanding does the heavy lifting on its own.
 */
function buildSystemPrompt(): string {
  return [
    "You are extracting fillable form fields from a PDF for a film-production assistant.",
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
    "  - `bbox` MUST be `[y_min, x_min, y_max, x_max]` integers in the normalized 0-1000 range, per page. Y-first ordering is mandatory.",
    "  - `page_number` is 1-based.",
    "  - `field_type` is `text` or `checkbox`.",
    "  - `field_kind` is one of: text, multiline, date, signature, checkbox-group, boolean-checkbox.",
    "  - `label` is a 2-5 word Title Case description of what belongs in the blank, derived from the surrounding sentence (NOT the literal text after the blank). Example: for `...charged an additional $______ plus a 3.3% fee for my booking...`, the label is `Additional Charge Amount`, not `plus a 3.3% fee`.",
    "  - `context_before` is up to 8 words IMMEDIATELY before the blank on the same row, AND it MUST include the printed label that precedes the writable area on the same scan line (e.g. for the `CVV2: ___ (3 digit number on back of Visa/MC, 4 digits on front of AMEX)` row, context_before MUST contain `CVV2`). If the row has no on-line label and the context comes from the surrounding sentence, include the closest preceding semantically meaningful tokens. NEVER return an empty string for context_before; if you cannot identify any preceding text, omit the field instead.",
    "  - `context_after` is up to 8 words IMMEDIATELY after the blank on the same row.",
    "  - `checkbox_value` is the literal label text next to the checkbox (e.g. `Visa`, `Mastercard`, `Yes`).",
    "",
    "## Canonical field ids",
    "Set `canonical_field_id` ONLY when the surrounding sentence unambiguously identifies the field. NULL is better than a wrong id. Available ids:",
    buildCatalogSummary(),
    "",
    "## Repeats",
    "If the same field type appears multiple times (e.g. cardholder name in two paragraphs), emit one entry per occurrence — each with its own bbox. The downstream system fills repeats with the same value.",
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
    "Concrete examples (numbers in PDF user-space points for clarity):",
    "  - Row `Billing Address ________________` where `Billing Address` ends at x≈250 and the line ends at x≈540: bbox starts at x≈260 (just past the label), NOT at x≈170 (start of the label).",
    "  - Row `Phone#________ Email________` (two fields on one row): two separate bboxes, each starting just past its own label, never overlapping the label text.",
    "  - Checkbox row `☐ Visa  ☐ MasterCard`: each bbox is a 10-15pt square aligned with the printed checkbox glyph itself, NOT including the word next to it.",
    "  - Inline `I, _________, authorize…`: bbox spans only the underscore region between the two commas.",
    "",
    "Vertical extent: match the local line height (typically 12-18 pt for body text, 18-30 pt for signatures/dates). NEVER include the row above or below.",
    "",
    "Tightness check before emitting each field: imagine cropping the page to your bbox. The crop should show empty space (or a drawn underline), nothing else. If you would see ANY printed letters in the crop, the bbox is too wide — shrink it.",
    "",
    "## Field-type rules (deterministic, do NOT deviate)",
    "  - If a field's surrounding text contains 'CVV', 'CVV2', 'CVC', 'security code', 'verification code', '3 digit', or '4 digit', the field is **always** `text` and `canonical_field_id: 'ccv'`. Do NOT classify it as a credit-card-type checkbox even if 'AMEX' or 'Visa' appears nearby — those words are part of the CVV instructional sentence.",
    "  - CVV / CVV2 / security code / `3 digit number` / `4 digits on front` → always `text`, NEVER `checkbox`. The blank may be drawn with a box outline, but the user types digits in it.",
    "  - Card number, expiration date, signature, name, address, phone, email → always `text`.",
    "  - Visa / MasterCard / Discover / AMEX selector boxes → `checkbox`.",
    "  - Any ☐ glyph or empty square the size of one letter → `checkbox`.",
    "",
    "If you cannot precisely locate the writable area, OMIT the field. We strongly prefer 10 correctly-placed fields to 20 fields where half are sitting on labels.",
  ].join("\n");
}

function buildUserPrompt(pageSizes: PdfPageSize[], filename: string): string {
  return [
    `Filename: ${filename}`,
    "Page sizes (PDF user-space points; you only need them for context — output bbox in normalized 0-1000):",
    pageSizes
      .map((p) => `  page ${p.pageNumber}: ${p.width} x ${p.height} pt`)
      .join("\n"),
    "",
    "Extract every fillable field per the system prompt's instructions and return the JSON object.",
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
          field_type: { type: "string", enum: ["text", "checkbox"] },
          field_kind: {
            type: "string",
            enum: [
              "text",
              "multiline",
              "date",
              "signature",
              "checkbox-group",
              "boolean-checkbox",
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
  fieldType: "text" | "checkbox"
): TemplateFieldKind {
  if (raw && VALID_FIELD_KINDS.has(raw as TemplateFieldKind)) {
    return raw as TemplateFieldKind;
  }
  return fieldType === "checkbox" ? "boolean-checkbox" : "text";
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
  fieldType: "text" | "checkbox"
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
  fieldType: "text" | "checkbox",
  checkboxValue: string | null | undefined
): CanonicalFieldId | undefined {
  const ctx = (context ?? "").toLowerCase();
  const aft = (after ?? "").toLowerCase();

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
    // cvvIndicators preflight at the top of this block. We still allow
    // anything else mistakenly tagged as a checkbox to fall through to
    // the text-alias matcher below; the type-guard in
    // `mapToTemplateField` will coerce a text-typed canonical id back
    // to a text field.
  }

  const haystack = `${ctx} ${aft}`.trim();
  if (!haystack) return undefined;
  for (const { alias, id } of ALIAS_INDEX) {
    if (alias.length < 3) continue;
    if (haystack.includes(alias)) return id;
  }
  return undefined;
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
 * into PDF user-space (x, y, w, h). Clamps to page bounds and enforces
 * a minimum dimension so single-character checkboxes are still
 * clickable.
 */
function bboxToPdfRect(
  bbox: number[] | undefined,
  pageSize: PdfPageSize,
  fieldType: "text" | "checkbox"
): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [yMin, xMin, yMax, xMax] = bbox.map((n) =>
    typeof n === "number" && Number.isFinite(n)
      ? clampNumber(n, 0, 1000)
      : NaN
  );
  if ([yMin, xMin, yMax, xMax].some((n) => Number.isNaN(n))) return null;

  const x = (xMin / 1000) * pageSize.width;
  const y = (yMin / 1000) * pageSize.height;
  const x2 = (xMax / 1000) * pageSize.width;
  const y2 = (yMax / 1000) * pageSize.height;

  const minDim = fieldType === "checkbox" ? 8 : 12;
  const width = Math.max(minDim, x2 - x);
  const height = Math.max(minDim, y2 - y);

  return {
    x: clampNumber(x, 0, Math.max(0, pageSize.width - 1)),
    y: clampNumber(y, 0, Math.max(0, pageSize.height - 1)),
    width: clampNumber(width, minDim, pageSize.width - x),
    height: clampNumber(height, minDim, pageSize.height - y),
  };
}

/**
 * Convert a PDF user-space rect back into Gemini's normalized
 * `[y_min, x_min, y_max, x_max]` (0-1000) coordinate system. Inverse of
 * {@link bboxToPdfRect}; used by the QC pass so Pass 2 sees the same
 * coordinate frame Pass 1 produced.
 */
function pdfRectToBbox(
  rect: { x: number; y: number; width: number; height: number },
  pageSize: PdfPageSize
): [number, number, number, number] {
  const norm = (v: number, max: number) =>
    Math.round(clampNumber((v / Math.max(1, max)) * 1000, 0, 1000));
  return [
    norm(rect.y, pageSize.height),
    norm(rect.x, pageSize.width),
    norm(rect.y + rect.height, pageSize.height),
    norm(rect.x + rect.width, pageSize.width),
  ];
}

function mapToTemplateField(
  raw: RawGeminiField,
  index: number,
  pageSizes: PdfPageSize[],
  /** Optional explicit id — used by the QC pass when re-mapping a fixed
   *  field so its id stays stable across passes. */
  explicitId?: string
): TemplateField | null {
  if (!raw || typeof raw !== "object") return null;

  const rawFieldType: "text" | "checkbox" =
    raw.field_type === "checkbox" ? "checkbox" : "text";

  const pageNumber =
    typeof raw.page_number === "number" && raw.page_number >= 1
      ? Math.floor(raw.page_number)
      : 1;
  const pageSize =
    pageSizes.find((p) => p.pageNumber === pageNumber) ?? pageSizes[0];
  if (!pageSize) return null;

  // Three-tier canonical-id resolution:
  //   1. Alias match — explicit-label rows hit a known alias.
  //   2. Pattern match — common body-text patterns alias matching can't see.
  //   3. Model semantic — Gemini's canonical_field_id, last resort.
  const aliasId = inferCanonicalId(
    raw.context_before,
    raw.context_after,
    rawFieldType,
    raw.checkbox_value
  );
  const patternId = inferByPattern(raw.context_before, raw.context_after, rawFieldType);
  const geminiId =
    raw.canonical_field_id && VALID_CANONICAL_IDS.has(raw.canonical_field_id)
      ? (raw.canonical_field_id as CanonicalFieldId)
      : undefined;
  const canonicalId: CanonicalFieldId | undefined =
    aliasId ?? patternId ?? geminiId;

  const canonicalDef = canonicalId
    ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
    : undefined;

  // Deterministic field-type guard. Every canonical id has a fixed
  // expected type (CVV is always text; visa/mastercard/etc. are always
  // checkboxes). When Gemini misclassifies — e.g. labelling CVV2 as a
  // checkbox because the form draws a small box around the underline
  // — this override fixes it without trusting the model. Only kicks
  // in when we're confident in the canonical id.
  const expectedType = canonicalDef
    ? canonicalDef.fieldKind === "checkbox-group" ||
      canonicalDef.fieldKind === "boolean-checkbox"
      ? "checkbox"
      : "text"
    : null;
  const fieldType: "text" | "checkbox" =
    expectedType && expectedType !== rawFieldType ? expectedType : rawFieldType;
  const fieldKind = normalizeFieldKind(raw.field_kind, fieldType);

  if (rawFieldType !== fieldType) {
    console.log(
      `[Typeset Gemini] Coerced ${canonicalId} from ${rawFieldType} → ${fieldType} based on canonical type.`
    );
  }

  const rect = bboxToPdfRect(raw.bbox, pageSize, fieldType);
  if (!rect) return null;

  const isCardCheckbox = canonicalId && CREDIT_CARD_CHECKBOX_IDS.has(canonicalId);
  const isBooleanCheckbox = fieldType === "checkbox" && !isCardCheckbox;

  const catalogKey = canonicalDef?.mappedProjectKey ?? "";
  // Label resolution priority:
  //   1. Canonical-mapped → use the catalog's label ("Cardholder Name", etc.).
  //   2. Unmapped → use Gemini's semantic label (generated from context).
  //   3. Fallback → derive from row context.
  const geminiLabel = (raw.label ?? "").trim();
  const fieldLabel =
    canonicalDef?.label ??
    (geminiLabel.length > 0
      ? geminiLabel
      : cleanLabel(raw.context_before, `Field ${index + 1}`));

  const isUnmappedText = !isBooleanCheckbox && !isCardCheckbox && !catalogKey;
  const mappedKey: TemplateMappedProjectKey =
    isBooleanCheckbox || isUnmappedText
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
    fieldKind: isBooleanCheckbox
      ? "boolean-checkbox"
      : (canonicalDef?.fieldKind ?? fieldKind),
    detectionSource: "gemini",
    checkboxValue,
    groupId: raw.group_id ?? canonicalDef?.groupId ?? undefined,
    promptLabel: isBooleanCheckbox || isUnmappedText ? fieldLabel : undefined,
    optional: raw.optional ?? undefined,
    estimatedFontSize,
    contextSnippet: buildContextSnippet(raw.context_before, raw.context_after),
  };
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
 * Which Gemini round-trip is currently in flight. Pass 1 is the
 * existing single-pass detection; Pass 2 is the QC audit. The phase
 * mapping is the same between the two — only the user-facing labels
 * and the progress-bar fraction band differ.
 */
type DetectionPhase = "pass1" | "qc";

function progressToStatus(
  progress: GeminiProgress,
  elapsedSec: number,
  phase: DetectionPhase
): string {
  const elapsed = elapsedSec > 0 ? ` (${elapsedSec}s)` : "";
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
 * Maps a phase to a 0-1 progress fraction within a band. The
 * DocumentList progress bar uses this as a hard floor and animates a
 * time-based curve up to it.
 *
 * In single-pass (Fast) mode Pass 1 occupies the full [0, 1] band.
 * In two-pass (Maximum) mode Pass 1 is squashed into [0, 0.55] and
 * Pass 2 occupies [0.55, 0.95] (with the final 0.05 reserved for the
 * deterministic correction-application step).
 */
function progressToFraction(
  progress: GeminiProgress,
  phase: DetectionPhase,
  twoPass: boolean
): number {
  // Inner [0, 1] mapping calibrated against measured timings on
  // Gemini 2.5/3.x Pro: inline-encode (1-3s) → request fire (1-2s) →
  // streaming (5-25s). Streaming is interpolated by token count
  // (typical field map / correction set 800-2000 output tokens).
  let inner = 0;
  switch (progress.phase) {
    case "uploading_file":
      inner = 0.05;
      break;
    case "file_uploaded":
      inner = 0.15;
      break;
    case "request_sent":
      inner = 0.3;
      break;
    case "streaming": {
      const tokens = progress.tokens ?? 0;
      const expected = 1500;
      const ratio = Math.min(1, tokens / expected);
      inner = 0.3 + ratio * 0.65;
      break;
    }
    case "done":
      inner = 1.0;
      break;
    case "error":
      inner = 1.0;
      break;
    default:
      inner = 0.0;
  }

  if (!twoPass) return inner;

  if (phase === "pass1") {
    // Squash Pass 1 into [0, 0.55].
    return inner * 0.55;
  }
  // Pass 2 occupies [0.55, 0.95]. The final 0.05 jump to 1.0 happens
  // when corrections are applied deterministically.
  return 0.55 + inner * 0.4;
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
 */
async function runGeminiRoundTrip(args: {
  pdfBytes: Uint8Array;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: Record<string, unknown>;
  maxOutputTokens: number;
  temperature: number;
  onStatus?: (status: string, progress?: number) => void;
  phase: DetectionPhase;
  twoPass: boolean;
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
      progressToFraction(lastProgress, args.phase, args.twoPass)
    );

  pushStatus();
  const heartbeat = window.setInterval(pushStatus, 1000);
  const unsubscribe = await subscribeGeminiProgress((progress) => {
    lastProgress = progress;
    pushStatus();
  });

  try {
    const result = await detectFieldsWithGemini(args.pdfBytes, {
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

async function runPass1(
  pdfBytes: Uint8Array,
  pageSizes: PdfPageSize[],
  filename: string,
  model: string,
  twoPass: boolean,
  onStatus?: (status: string, progress?: number) => void
): Promise<Pass1Result> {
  const result = await runGeminiRoundTrip({
    pdfBytes,
    model,
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(pageSizes, filename),
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
    twoPass,
  });

  console.log(
    `[Typeset Gemini] pass1 model=${model} stop=${result.finishReason} usage=${JSON.stringify(result.usage)}`
  );

  const parsed = parseStructuredResponse<RawGeminiResponse>(
    result.text,
    result.finishReason,
    "Pass 1"
  );

  const rawFields = parsed.fields ?? [];
  const mapped: TemplateField[] = [];
  const rawByFieldId = new Map<string, RawGeminiField>();
  for (let i = 0; i < rawFields.length; i += 1) {
    const raw = rawFields[i];
    const field = mapToTemplateField(raw, i, pageSizes);
    if (field) {
      mapped.push(field);
      rawByFieldId.set(field.id, raw);
    }
  }
  const deduped = dedupeFields(mapped);

  // Drop any raw entries whose mapped field got dedup'd away — the QC
  // pass should only audit fields we actually kept.
  const keptIds = new Set(deduped.map((f) => f.id));
  for (const id of rawByFieldId.keys()) {
    if (!keptIds.has(id)) rawByFieldId.delete(id);
  }

  return { fields: deduped, rawByFieldId };
}

async function detectFieldsImpl(
  pdfBytes: Uint8Array,
  onStatus?: (status: string, progress?: number) => void,
  options: DetectFieldsOptions = {}
): Promise<TemplateField[]> {
  const filename = options.filename ?? "document.pdf";
  onStatus?.("Reading PDF metadata…", 0.02);
  const pageSizes = await getPageSizes(pdfBytes);
  if (pageSizes.length === 0) {
    throw new GeminiApiError("PDF has no readable pages.");
  }

  const model = getModelPreference();
  const accuracyMode = getAccuracyMode();
  const twoPass = accuracyMode === "maximum";

  const pass1 = await runPass1(pdfBytes, pageSizes, filename, model, twoPass, onStatus);

  if (!twoPass) {
    onStatus?.(`Gemini detected ${pass1.fields.length} field(s).`, 1);
    return pass1.fields;
  }

  // ----- Pass 2: quality-control audit ------------------------------------
  onStatus?.(
    `Pass 1 detected ${pass1.fields.length} field(s); starting verification…`,
    0.55
  );

  let qcFields: TemplateField[];
  try {
    qcFields = await runQualityControlPass({
      pdfBytes,
      pageSizes,
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
    onStatus?.(
      `Verification failed; using Pass 1 results (${pass1.fields.length} field(s)).`,
      1
    );
    return pass1.fields;
  }

  onStatus?.(
    `Detection complete — ${qcFields.length} field(s) after verification.`,
    1
  );
  return qcFields;
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
    "You are auditing field detection on a PDF form. A previous Gemini pass produced a list of detected fields; for each one, decide whether it is correctly placed and typed given the actual PDF.",
    "",
    "Return ONLY a JSON object that conforms to the supplied responseSchema. No prose, no markdown fences.",
    "",
    "## Coordinate system",
    "Bounding boxes use the SAME native Gemini system as Pass 1: `[y_min, x_min, y_max, x_max]` integers in the normalized 0-1000 range, per page. Y-first ordering is mandatory.",
    "",
    "## Output shape",
    "For every input field, emit exactly one entry in `corrections` keyed by its `id`. Use:",
    "  - `action: \"keep\"` — the field is correct as-is. Set every `fixed_*` to null.",
    "  - `action: \"drop\"` — there is no writable area at this location, or the field is a duplicate of another. Set every `fixed_*` to null.",
    "  - `action: \"fix\"` — at least one of the field's properties is wrong. Set ONLY the `fixed_*` properties that need to change; leave the others null.",
    "",
    "Always include the original `id` exactly as provided. Never invent new fields and never re-key.",
    "",
    "## Audit rules — apply EVERY rule to EVERY field",
    "",
    "### 1. Bbox tightness",
    "The bbox must hug the writable blank only. If a horizontal scan line through your bbox would cross any printed letters of the label, the bbox is wrong — `action: \"fix\"` with a tighter `fixed_bbox` that starts just past the label and covers only empty space (or the drawn underline). If there is no writable area at the location at all, `action: \"drop\"`.",
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
    "### 4. Duplicates",
    "If two fields share the same `canonical_field_id` AND their bboxes overlap by more than 50% of their area, drop the lower-confidence one (`action: \"drop\"`). Different positions on the same form ARE allowed (e.g. two Cardholder Name lines, two date lines) — do NOT drop those.",
    "",
    "### 5. Default",
    "When in doubt and the field looks correct, return `action: \"keep\"` with all `fixed_*` null. Do not churn fields that are already right; you should only `fix` or `drop` when you are confident the input is wrong.",
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
  pageSizes: PdfPageSize[],
  filename: string,
  fields: AuditFieldDescriptor[]
): string {
  return [
    `Filename: ${filename}`,
    "Page sizes (PDF user-space points; bbox is normalized 0-1000):",
    pageSizes
      .map((p) => `  page ${p.pageNumber}: ${p.width} x ${p.height} pt`)
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
  pageSizes: PdfPageSize[]
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
  const remapped = mapToTemplateField(patched, index, pageSizes, field.id);
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
  pageSizes: PdfPageSize[]
): AuditFieldDescriptor[] {
  return pass1Fields.map((field) => {
    const raw = rawByFieldId.get(field.id);
    const pageSize =
      pageSizes.find((p) => p.pageNumber === field.pageNumber) ?? pageSizes[0];
    const bbox = pdfRectToBbox(
      { x: field.x, y: field.y, width: field.width, height: field.height },
      pageSize ?? { pageNumber: 1, width: 612, height: 792 }
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
  pdfBytes: Uint8Array;
  pageSizes: PdfPageSize[];
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
    args.pageSizes
  );

  const result = await runGeminiRoundTrip({
    pdfBytes: args.pdfBytes,
    model: args.model,
    systemPrompt: buildQualityControlSystemPrompt(),
    userPrompt: buildQualityControlUserPrompt(args.pageSizes, args.filename, descriptors),
    responseSchema: QC_RESPONSE_SCHEMA,
    // The audit response is much smaller than Pass 1 (one record per
    // input field, no bbox unless action=fix). 16k is comfortable for
    // ~150 fields and keeps us well below the model's 65k output cap.
    maxOutputTokens: 16384,
    temperature: 0.0,
    onStatus: args.onStatus,
    phase: "qc",
    twoPass: true,
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
      console.log(
        `[Typeset Gemini QC] Dropped ${field.id} (${field.canonicalFieldId ?? "—"}, ${field.label}): ${
          reason || "no reason given"
        }`
      );
      dropped += 1;
      continue;
    }

    if (action === "fix") {
      const next = applyCorrectionToField(field, raw, correction, i, args.pageSizes);
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
    `[Typeset Gemini QC] Summary: kept=${kept} fixed=${fixed} dropped=${dropped} dedup-dropped=${dedupedDropped} (input=${args.pass1Fields.length}, output=${deduped.length})`
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
