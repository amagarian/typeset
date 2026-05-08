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
 * The whole call typically completes in 20-30s on a 1-3 page production
 * form (Gemini 2.5 Pro), or 10-15s on Flash. There is no Python
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
import { getModelPreference } from "@/services/geminiSettings";
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
    "  - `context_before` is up to 8 words IMMEDIATELY before the blank on the same row.",
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
    "## Be tight",
    "Bounding boxes should hug the writable area, not include the printed label. For underscore lines, the box covers the underscore characters only.",
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

function mapToTemplateField(
  raw: RawGeminiField,
  index: number,
  pageSizes: PdfPageSize[]
): TemplateField | null {
  if (!raw || typeof raw !== "object") return null;

  const fieldType: "text" | "checkbox" =
    raw.field_type === "checkbox" ? "checkbox" : "text";
  const fieldKind = normalizeFieldKind(raw.field_kind, fieldType);

  const pageNumber =
    typeof raw.page_number === "number" && raw.page_number >= 1
      ? Math.floor(raw.page_number)
      : 1;
  const pageSize =
    pageSizes.find((p) => p.pageNumber === pageNumber) ?? pageSizes[0];
  if (!pageSize) return null;

  const rect = bboxToPdfRect(raw.bbox, pageSize, fieldType);
  if (!rect) return null;

  // Three-tier canonical-id resolution:
  //   1. Alias match — explicit-label rows hit a known alias.
  //   2. Pattern match — common body-text patterns alias matching can't see.
  //   3. Model semantic — Gemini's canonical_field_id, last resort.
  const aliasId = inferCanonicalId(
    raw.context_before,
    raw.context_after,
    fieldType,
    raw.checkbox_value
  );
  const patternId = inferByPattern(raw.context_before, raw.context_after, fieldType);
  const geminiId =
    raw.canonical_field_id && VALID_CANONICAL_IDS.has(raw.canonical_field_id)
      ? (raw.canonical_field_id as CanonicalFieldId)
      : undefined;
  const canonicalId: CanonicalFieldId | undefined =
    aliasId ?? patternId ?? geminiId;

  const canonicalDef = canonicalId
    ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
    : undefined;

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
    id: `gemini-field-${index}-${Date.now().toString(36)}`,
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

function progressToStatus(progress: GeminiProgress, elapsedSec: number): string {
  const elapsed = elapsedSec > 0 ? ` (${elapsedSec}s)` : "";
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
 * Maps a phase to a 0-1 progress fraction. The DocumentList progress
 * bar uses this as a hard floor and animates a time-based curve up to
 * it. Calibrated against measured timings on Gemini 2.5 Pro:
 *
 *   inline-encode (1-3s) → request fire (1-2s) → streaming (15-25s).
 *
 * The streaming phase is interpolated between 0.30 and 0.95 by token
 * count: a typical field map is 800-2000 output tokens.
 */
function progressToFraction(progress: GeminiProgress): number {
  switch (progress.phase) {
    case "uploading_file":
      return 0.05;
    case "file_uploaded":
      return 0.15;
    case "request_sent":
      return 0.30;
    case "streaming": {
      const tokens = progress.tokens ?? 0;
      const expected = 1500;
      const ratio = Math.min(1, tokens / expected);
      return 0.30 + ratio * 0.65;
    }
    case "done":
      return 1.0;
    case "error":
      return 1.0;
    default:
      return 0.0;
  }
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
  const startedAt = Date.now();
  let lastProgress: GeminiProgress = {
    phase: "uploading_file",
    detail: null,
    tokens: null,
  };
  const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000);
  const pushStatus = () =>
    onStatus?.(
      progressToStatus(lastProgress, elapsedSec()),
      progressToFraction(lastProgress)
    );

  pushStatus();
  const heartbeat = window.setInterval(pushStatus, 1000);
  const unsubscribe = await subscribeGeminiProgress((progress) => {
    lastProgress = progress;
    pushStatus();
  });

  let result;
  try {
    result = await detectFieldsWithGemini(pdfBytes, {
      model,
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(pageSizes, filename),
      responseSchema: RESPONSE_SCHEMA,
      // 1500 tokens is plenty for a typical 20-field form; double it as
      // headroom for very dense multi-page documents.
      maxOutputTokens: 4096,
      temperature: 0.0,
    });
  } finally {
    window.clearInterval(heartbeat);
    unsubscribe();
  }

  onStatus?.("Parsing Gemini response…", 0.97);

  console.log(
    `[Typeset Gemini] model=${model} stop=${result.finishReason} usage=${JSON.stringify(result.usage)}`
  );

  let parsed: RawGeminiResponse;
  try {
    parsed = JSON.parse(result.text) as RawGeminiResponse;
  } catch (err) {
    throw new GeminiApiError(
      `Gemini returned non-JSON content. (parse error: ${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }

  const rawFields = parsed.fields ?? [];
  const mapped: TemplateField[] = [];
  for (let i = 0; i < rawFields.length; i += 1) {
    const field = mapToTemplateField(rawFields[i], i, pageSizes);
    if (field) mapped.push(field);
  }
  const deduped = dedupeFields(mapped);
  onStatus?.(`Gemini detected ${deduped.length} field(s).`, 1);
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
