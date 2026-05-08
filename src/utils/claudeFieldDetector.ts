import * as pdfjsLib from "pdfjs-dist";
import type {
  CanonicalFieldId,
  Project,
  TemplateField,
  TemplateFieldKind,
  TemplateMappedProjectKey,
} from "@/types";
import {
  analyzePdfAgentic,
  analyzePdfWithClaude,
  ClaudeApiError,
  ClaudeNotConfiguredError,
  subscribeAgenticProgress,
  type AgenticProgress,
  type ClaudeEffort,
} from "@/services/claudeClient";
import { getModelPreference } from "@/services/anthropicSettings";
import { CANONICAL_FIELD_DEFINITIONS } from "@/utils/fieldCatalog";
import { normalizeCardType } from "@/utils/fill";

export { ClaudeNotConfiguredError, ClaudeApiError };

/**
 * Translates a streaming agentic-progress event into a one-line status
 * suitable for the UI's "what is Claude doing" indicator. Phases come
 * straight from the Rust side (see anthropic.rs#AgenticProgress).
 */
function progressToStatus(progress: AgenticProgress, elapsedSec: number): string {
  const elapsed = elapsedSec > 0 ? ` (${elapsedSec}s)` : "";
  const idx = progress.toolIndex ?? 0;
  switch (progress.phase) {
    case "uploading_file":
      return `Uploading PDF to Claude${elapsed}…`;
    case "file_uploaded":
      return `PDF uploaded — starting Claude${elapsed}…`;
    case "request_sent":
      return `Claude is reading your form${elapsed}…`;
    case "thinking":
      return idx > 0
        ? `Claude is thinking after script ${idx}${elapsed}…`
        : `Claude is thinking${elapsed}…`;
    case "tool_start":
      return `Running Python script ${idx}${elapsed}…`;
    case "tool_executing":
      return `Script ${idx} executing in sandbox${elapsed}…`;
    case "tool_done":
      return `Script ${idx} complete — Claude is analyzing the result${elapsed}…`;
    case "writing":
      return `Claude is writing the field map${elapsed}…`;
    case "done":
      return `Done${elapsed}.`;
    case "error":
      return progress.detail
        ? `Claude error: ${progress.detail}`
        : `Claude failed.`;
    default:
      return `Claude${elapsed}…`;
  }
}

if (typeof window !== "undefined" && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}

interface PdfPageSize {
  pageNumber: number;
  width: number;
  height: number;
}

interface RawClaudeField {
  canonical_field_id?: string | null;
  label?: string;
  field_type?: string;
  field_kind?: string;
  page_number?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  checkbox_value?: string | null;
  group_id?: string | null;
  estimated_font_size?: number | null;
  optional?: boolean;
  /** All words to the LEFT of the blank on the same row, space-joined. Passed through from the script. */
  context?: string;
  /** Up to 8 words to the RIGHT of the blank on the same row, space-joined. Passed through from the script. */
  after?: string;
}

interface RawClaudeResponse {
  page_count?: number;
  form_type?: string;
  fields?: RawClaudeField[];
  /** Optional pass-through from the script: full text per page, used as a
   * fallback haystack for canonical-id alias matching when the row's
   * context/after strings are too short. */
  page_texts?: string[];
}

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

/**
 * The complete, deterministic Python script we ask Claude to execute
 * exactly once via `code_execution`. Prior prompt iterations let Claude
 * author its own extraction logic, which (with adaptive thinking on)
 * led to >20-script loops when the model wanted to "improve" its
 * approach. Shipping a fully-formed script collapses the agent to a
 * single tool use: run -> read JSON -> compose answer.
 */
const EXTRACTION_SCRIPT = `
import os, glob, json, sys, traceback
import pypdf
import pdfplumber

def find_pdf():
    for pattern in (
        "/mnt/user-data/uploads/*.pdf",
        "/mnt/user-data/*.pdf",
        "/tmp/*.pdf",
        "./*.pdf",
    ):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[0]
    raise SystemExit("PDF not found in sandbox")

PATH = find_pdf()

# --- AcroForm widgets (interactive PDFs) ---------------------------------
acroform = []
try:
    reader = pypdf.PdfReader(PATH)
    for page_idx, page in enumerate(reader.pages, 1):
        annots = page.get("/Annots") or []
        ph = float(page.mediabox.height)
        for annot in annots:
            obj = annot.get_object()
            if obj.get("/Subtype") != "/Widget":
                continue
            r = obj.get("/Rect")
            if not r or len(r) != 4:
                continue
            x0, y0, x1, y1 = float(r[0]), float(r[1]), float(r[2]), float(r[3])
            acroform.append({
                "page": page_idx,
                "x": round(x0, 2),
                "y": round(ph - y1, 2),
                "w": round(x1 - x0, 2),
                "h": round(y1 - y0, 2),
                "name": str(obj.get("/T") or "").strip(),
                "ft": str(obj.get("/FT") or "").strip(),
            })
    n_pages = len(reader.pages)
except Exception:
    traceback.print_exc(file=sys.stderr)
    n_pages = 0

# --- Structural fallback (printed forms with __ or drawn lines) ----------
candidates = []
try:
    with pdfplumber.open(PATH) as pdf:
        if not n_pages:
            n_pages = len(pdf.pages)
        for pi, page in enumerate(pdf.pages, 1):
            chars = sorted(page.chars, key=lambda c: (round(c["top"], 1), c["x0"]))

            # Underscore runs. Use the underscore characters' OWN top/bottom
            # so the box fits the actual cell — hardcoded heights produce a
            # ~one-line offset on fonts whose cell isn't exactly 16pt.
            run, last = [], None
            def flush():
                if len(run) < 3:
                    return
                x0 = min(r["x0"] for r in run)
                x1 = max(r["x1"] for r in run)
                top = min(r["top"] for r in run)
                bot = max(r["bottom"] for r in run)
                cell_h = max(12.0, bot - top)
                candidates.append({
                    "page": pi,
                    "kind": "u",
                    "x": round(x0, 2),
                    "y": round(top, 2),
                    "w": round(x1 - x0, 2),
                    "h": round(cell_h, 2),
                    "context": "",
                    "after": "",
                })
            for c in chars:
                is_u = c["text"] == "_"
                if is_u and last is not None and abs(c["top"] - last["top"]) < 1.0 and abs(c["x0"] - last["x1"]) < 2.0:
                    run.append(c)
                else:
                    flush()
                    run = [c] if is_u else []
                last = c if is_u else None
            flush()

            # Drawn horizontal lines. The line itself is the underline; the
            # fill text sits ABOVE it. Box height matches typical body font.
            for ln in page.lines:
                if ln.get("height", 99) < 1.5 and ln.get("width", 0) > 30:
                    cell_h = 13.0
                    candidates.append({
                        "page": pi,
                        "kind": "ln",
                        "x": round(ln["x0"], 2),
                        "y": round(ln["top"] - cell_h + 2, 2),
                        "w": round(ln["width"], 2),
                        "h": round(cell_h, 2),
                        "context": "",
                        "after": "",
                    })

            # Small squares (checkboxes).
            for rect in page.rects:
                w, h = rect.get("width", 0), rect.get("height", 0)
                if 7 < w < 18 and 7 < h < 18:
                    candidates.append({
                        "page": pi,
                        "kind": "rect",
                        "x": round(rect["x0"], 2),
                        "y": round(rect["top"], 2),
                        "w": round(w, 2),
                        "h": round(h, 2),
                        "context": "",
                        "after": "",
                    })

            # Row context: for each candidate, grab up to 6 words BEFORE
            # (left of) and 6 words AFTER (right of) it on the same row.
            # This is the single biggest input to correct labelling — for
            # body-text underscores ("I, ____, authorize my credit card to
            # be charged...") the surrounding sentence is the only signal
            # that distinguishes a cardholder-name blank from a date blank.
            try:
                words = page.extract_words(use_text_flow=False)
            except Exception:
                words = []
            for cand in [c for c in candidates if c["page"] == pi]:
                cy = cand["y"] + cand["h"] / 2
                cx_left = cand["x"]
                cx_right = cand["x"] + cand["w"]
                same_row = [
                    w for w in words
                    if abs((w["top"] + w["bottom"]) / 2 - cy) < 14
                ]
                same_row.sort(key=lambda w: w["x0"])
                prefix = [w["text"] for w in same_row if w["x1"] <= cx_left + 4]
                suffix = [w["text"] for w in same_row if w["x0"] >= cx_right - 4]
                # No left-cap. "Card Identification Number (last three
                # digits on back of card):" is ~10 words and the alias
                # is at the very front; truncating the prefix to 6
                # words drops the explicit label entirely.
                cand["context"] = " ".join(prefix)
                cand["after"] = " ".join(suffix[:8])
except Exception:
    traceback.print_exc(file=sys.stderr)

# Full body text per page — handed to Claude alongside the structural
# candidates so it can disambiguate body-text fields by reading the
# surrounding sentence.
page_texts = []
try:
    with pdfplumber.open(PATH) as pdf:
        for page in pdf.pages:
            try:
                page_texts.append(page.extract_text() or "")
            except Exception:
                page_texts.append("")
except Exception:
    pass

print(json.dumps({
    "path": PATH,
    "n_pages": n_pages,
    "acroform": acroform,
    "candidates": candidates,
    "page_texts": page_texts,
}))
`.trim();

/** Human-readable catalog summary for the prompt. Keep it compact —
 * Claude only needs id, label, and example aliases. */
function buildCatalogSummary(): string {
  return CANONICAL_FIELD_DEFINITIONS.map((d) => {
    const aliases = d.aliases.slice(0, 4).join(", ");
    return `  - ${d.id} (${d.label}): ${aliases}`;
  }).join("\n");
}

function buildAgenticSystemPrompt(): string {
  return [
    "You analyze production paperwork PDFs (vendor agreements, credit-card authorizations, deal memos, W-9s, COIs) and emit JSON describing every fillable field.",
    "",
    "## PROCESS — exactly one tool call",
    "1. Make ONE call to `code_execution`. Pass the SCRIPT below verbatim (copy-paste the whole thing into the `code` argument). Do not edit the script. Do not split it into smaller scripts. Do not run a probe/listing script first.",
    "2. Read the JSON the script printed (`acroform` and `candidates` arrays, plus `page_texts` for context).",
    "3. Compose your final assistant message: ONLY the answer JSON, no prose.",
    "ABSOLUTE CONSTRAINTS:",
    "- Total tool calls: exactly 1.",
    "- Do NOT run a second script for any reason — not to verify, not to debug, not to render images, not to look up where the file is, not to test alternative approaches.",
    "- The script's `find_pdf()` already locates the file. Trust it.",
    "- The script handles AcroForm widgets, underscore runs, drawn lines, and rectangles in one pass. Do NOT re-do that work in a follow-up script.",
    "- If the script raises an exception, still emit the best JSON you can from whatever it printed before the error. Do NOT retry.",
    "",
    "## SCRIPT",
    "```python",
    EXTRACTION_SCRIPT,
    "```",
    "",
    "## TURNING SCRIPT OUTPUT INTO FIELDS",
    "For each `acroform` widget and each `candidate`, emit one field entry. Preserve the script's coordinates and its `context`/`after` strings VERBATIM — those strings are the host's primary signal.",
    "",
    "Per-candidate translation:",
    "- `kind: \"u\"` (underscore run) and `kind: \"ln\"` (drawn line) → `field_type: \"text\"`. Pick `field_kind`:",
    "  - `date` when `context` or `after` mentions date / exp / MM/YY / expiration / authorization date / (date)",
    "  - `signature` when `context` or `after` mentions signature / sign / authorized",
    "  - `multiline` when the label is address-like AND the candidate is wider than ~250pt OR a similar candidate on the row directly below has the same x and width",
    "  - otherwise `text`",
    "- `kind: \"rect\"` → `field_type: \"checkbox\"`. When 4 small squares appear on a row near Visa / Mastercard / Discover / Amex, emit them as a checkbox-group with `group_id: \"creditCardType\"` and `checkbox_value` of `visa | mastercard | discover | amex` respectively. Card rows ALWAYS have all four — never stop at three. The card name is whichever of {visa, mastercard, amex, discover} appears in this box's `after` string.",
    "",
    "For each acroform widget: `field_type: \"text\"` (or `\"checkbox\"` if `ft == \"/Btn\"`), `field_kind: \"text\"`. Set `context` to the widget's `name` field; leave `after` empty.",
    "",
    "## CANONICAL FIELD ID — your semantic-reasoning job",
    "The host runs deterministic alias matching on `context`/`after` and will overwrite your `canonical_field_id` whenever an alias hits. Your job is to fill in `canonical_field_id` for the BODY-TEXT BLANKS that don't have an explicit label on their own row — the host can't see those, only you can read the surrounding sentence.",
    "",
    "Available canonical ids (id → label, with example aliases):",
    buildCatalogSummary(),
    "",
    "Rules for `canonical_field_id`:",
    "- ONLY set a canonical id when the surrounding sentence makes the role unambiguous. NULL IS BETTER THAN A WRONG ID. Wrong ids cause silent mis-fills downstream.",
    "- Common body-text patterns and their mappings:",
    "  - \"I, ____, authorize my credit card to be charged\" → `creditCardHolder` (the speaker IS the cardholder).",
    "  - \"...damages from my booking at <company> on ____ (date)\" → `authorizationDate` (charge/booking date).",
    "  - \"I authorize my credit card to be charged $____\" → leave NULL (this is the dollar amount, no canonical id for it).",
    "  - \"Signature: ____\" or signature line → `cardholderSignature`.",
    "  - \"____ /hour\" or \"plus a 3.3% processing fee\" → leave NULL (rate/fee fields without a canonical match).",
    "- Do NOT use the form's TITLE or surrounding paragraph to guess. The signal must come from the candidate's own row context+after.",
    "- Never guess `creditCardNumber` based on the form being a CC auth — that field has an explicit \"Credit Card Number:\" label row that the alias matcher will pick up.",
    "",
    "## RULES",
    "- Coordinates are PDF points, top-left origin. DO NOT recompute them. Pass `x`, `y`, `w`, `h` through verbatim from the script (rename `w`→`width`, `h`→`height`).",
    "- Pass `context` and `after` through VERBATIM. Do not paraphrase, do not clean them up, do not translate them.",
    "- `label`: the cleaned context string (strip trailing colons, drop leading prepositions like \"on\"/\"of\"/\"to\"). For body-text blanks where context is just \"I,\" or empty, use a short descriptive label like \"Body field 1\". The host re-derives this label, so it's mostly informational.",
    "- Repeat fields are kept: production paperwork routinely repeats the same blank across body text and signature blocks. Emit every occurrence; do not collapse.",
    "- Skip ONLY: headers, footers, page numbers, pre-printed values that obviously aren't fillable.",
    "- Pass `page_texts` through verbatim as a top-level field of the response.",
    "",
    "## OUTPUT — your final assistant message must be ONLY this JSON object (no markdown fences, no prose):",
    "{",
    "  \"page_count\": number,",
    "  \"form_type\"?: string,",
    "  \"detected_via\"?: \"acroform\" | \"pdfplumber\" | \"mixed\",",
    "  \"page_texts\": string[],",
    "  \"fields\": Array<{",
    "    canonical_field_id: string | null,",
    "    label: string,",
    "    field_type: \"text\" | \"checkbox\",",
    "    field_kind: \"text\" | \"multiline\" | \"date\" | \"signature\" | \"boolean-checkbox\" | \"checkbox-group\",",
    "    page_number: number,",
    "    x: number, y: number, width: number, height: number,",
    "    context: string,",
    "    after: string,",
    "    checkbox_value?: string | null,",
    "    group_id?: string | null",
    "  }>",
    "}",
    "",
    "If the script returns no acroform widgets and no candidates: `{ \"page_count\": N, \"page_texts\": [...], \"fields\": [] }`.",
  ].join("\n");
}

function buildAgenticUserPrompt(
  pages: PdfPageSize[],
  project: Partial<Project> | null
): string {
  const pageBlock = pages
    .map((p) => `  page ${p.pageNumber}: ${p.width} x ${p.height} pt`)
    .join("\n");
  const projectBlock = project
    ? [
        "",
        "Project context (use only as a hint for picking canonical_field_id; do NOT inline these values):",
        "```json",
        JSON.stringify(project, null, 2),
        "```",
      ].join("\n")
    : "";
  return [
    "Run the extraction script in your system prompt EXACTLY ONCE via code_execution, then return the final JSON object.",
    "",
    "Page sizes (PDF points, top-left origin):",
    pageBlock,
    projectBlock,
    "",
    "Final assistant message: JSON only.",
  ]
    .filter(Boolean)
    .join("\n");
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  // Handle ```json ... ``` fences if Claude wrapped the JSON anyway.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  // Otherwise grab the outermost {...} block.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseClaudeJson(text: string): RawClaudeResponse {
  const candidate = extractJson(text);
  try {
    return JSON.parse(candidate) as RawClaudeResponse;
  } catch (err) {
    throw new ClaudeApiError(
      `Claude returned non-JSON content. First 400 chars: ${text.slice(0, 400)}\n(parse error: ${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
}

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
 * Pre-computed [aliasLowercase, canonicalId] pairs sorted by alias length
 * descending so we always match the most specific alias first
 * (e.g. "credit card number" wins over "number" / "card").
 */
const ALIAS_INDEX: ReadonlyArray<{ alias: string; id: CanonicalFieldId }> =
  CANONICAL_FIELD_DEFINITIONS.flatMap((def) =>
    def.aliases.map((alias) => ({
      alias: alias.toLowerCase().trim(),
      id: def.id,
    }))
  ).sort((a, b) => b.alias.length - a.alias.length);

/**
 * Deterministic canonical_field_id matching from the script-provided
 * context/after strings. We do this on the TS side instead of trusting
 * Claude's `canonical_field_id` output because Claude (especially Sonnet)
 * tends to force-fit candidates onto canonical ids that don't actually
 * appear in the form — e.g. assigning `billingCity`/`billingState` to
 * the Credit Card Number / Expiration Date rows of a CC auth form that
 * has no separate city/state fields. Alias-based matching against the
 * actual context strings is far more reliable.
 *
 * IMPORTANT: only matches against the candidate's OWN row (context +
 * after). Earlier versions also fell back to the full page text, but
 * that's actively hostile on forms whose subject matter overlaps with
 * an alias — e.g. on a Credit Card Authorization form the page text
 * contains "credit card" / "card number" everywhere, so every
 * unlabelled candidate would match `creditCardNumber`.
 *
 * Returns `undefined` if no alias matches the row; the caller leaves
 * the field unmapped for the user to assign manually.
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
    // Card-type label sits to the RIGHT of the box on standard layouts
    // ("Credit Card Type: [_]Visa  [_]Mastercard  [_]Amex  [_]Discover").
    // CRITICAL: do not fall back to `context` for the Visa check —
    // every box from Mastercard onwards has "Visa" in its left
    // context, so context-based visa matching always wins for the
    // first card listed. Use Claude's `checkbox_value` as a strong
    // secondary signal (Claude reads the whole row and tags each box).
    const cv = (checkboxValue ?? "").toLowerCase().trim();
    if (cv === "visa" || /\bvisa\b/.test(aft)) return "creditCardTypeVisa";
    if (cv === "mastercard" || /\bmaster\s?card\b/.test(aft) || /\bmc\b/.test(aft))
      return "creditCardTypeMastercard";
    if (cv === "amex" || cv === "american express" || /\bamex\b|\bamerican\s?express\b/.test(aft))
      return "creditCardTypeAmex";
    if (cv === "discover" || /\bdiscover\b/.test(aft))
      return "creditCardTypeDiscover";
    // No `after` and no `checkbox_value` — try context as a last
    // resort (rare layouts where the label is to the LEFT of the box).
    if (!aft.trim() && !cv) {
      if (/\bvisa\b/.test(ctx)) return "creditCardTypeVisa";
      if (/\bmaster\s?card\b|\bmc\b/.test(ctx)) return "creditCardTypeMastercard";
      if (/\bamex\b|\bamerican\s?express\b/.test(ctx)) return "creditCardTypeAmex";
      if (/\bdiscover\b/.test(ctx)) return "creditCardTypeDiscover";
    }
    return undefined;
  }

  // Text fields: only this row's context+after. Body-text blanks where
  // the surrounding sentence doesn't contain a known label stay
  // unmapped here; Claude's semantic canonical_field_id (when emitted)
  // becomes the fallback in `mapToTemplateField`.
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
 * Cleans up a raw context string into a presentable label.
 * - Strips trailing punctuation
 * - Drops leading and trailing prepositions ("my booking at Beam Studios on" → "my booking at Beam Studios")
 * - Caps at 60 chars, truncating at a word boundary
 */
function cleanLabel(context: string | undefined, fallback: string): string {
  const raw = (context ?? "").trim();
  if (!raw) return fallback;
  let cleaned = raw.replace(/[:.,;]+\s*$/g, "").trim();
  cleaned = cleaned.replace(LEADING_PREP_RE, "");
  // Trailing prep: "my booking at Beam Studios on" → "my booking at Beam Studios"
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

function mapToTemplateField(
  raw: RawClaudeField,
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

  const minDim = fieldType === "checkbox" ? 8 : 12;
  const x = clampNumber(raw.x ?? 0, 0, Math.max(0, pageSize.width - 1));
  const y = clampNumber(raw.y ?? 0, 0, Math.max(0, pageSize.height - 1));
  const rawWidth = clampNumber(raw.width ?? minDim, minDim, pageSize.width - x);
  const rawHeight = clampNumber(raw.height ?? minDim, minDim, pageSize.height - y);

  // Deterministic canonical-id matching from the row context wins over
  // Claude's reasoning for explicit-label rows ("Credit Card Number:"
  // etc.) because Claude tends to force-fit candidates onto canonical
  // ids that don't actually appear in the form. For body-text blanks
  // where alias matching can't see a label, Claude's semantic
  // canonical_field_id becomes the fallback — which is how we recover
  // mapping for sentences like "I, ___, authorize my credit card".
  const inferredId = inferCanonicalId(
    raw.context,
    raw.after,
    fieldType,
    raw.checkbox_value
  );
  const claudeId =
    raw.canonical_field_id && VALID_CANONICAL_IDS.has(raw.canonical_field_id)
      ? (raw.canonical_field_id as CanonicalFieldId)
      : undefined;
  const canonicalId: CanonicalFieldId | undefined = inferredId ?? claudeId;

  const canonicalDef = canonicalId
    ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
    : undefined;

  const isCardCheckbox = canonicalId && CREDIT_CARD_CHECKBOX_IDS.has(canonicalId);
  const isBooleanCheckbox = fieldType === "checkbox" && !isCardCheckbox;

  const catalogKey = canonicalDef?.mappedProjectKey ?? "";
  const fieldLabel =
    canonicalDef?.label ??
    cleanLabel(raw.context, (raw.label && raw.label.trim()) || `Field ${index + 1}`);

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
    id: `claude-field-${index}-${Date.now().toString(36)}`,
    label: fieldLabel,
    mappedProjectKey: mappedKey,
    canonicalFieldId: canonicalId,
    pageNumber,
    x,
    y,
    width: rawWidth,
    height: rawHeight,
    confidence: 0.9,
    fieldType,
    fieldKind: isBooleanCheckbox
      ? "boolean-checkbox"
      : (canonicalDef?.fieldKind ?? fieldKind),
    detectionSource: "claude",
    checkboxValue,
    groupId: raw.group_id ?? canonicalDef?.groupId ?? undefined,
    promptLabel: isBooleanCheckbox || isUnmappedText ? fieldLabel : undefined,
    optional: raw.optional ?? undefined,
    estimatedFontSize,
  };
}

/**
 * De-duplicate detections by spatial overlap only. Production paperwork
 * routinely repeats the same canonical field across the document — e.g.
 * the cardholder's name appears in body text AND in the signature
 * block, dates appear at top and bottom, signatures appear top and
 * bottom — and every instance needs to be filled with the same project
 * value. Earlier versions kept a `usedCanonicalIds` set that dropped
 * legitimate repeats; we now keep every instance unless two detections
 * sit on top of each other (within 12pt on the same page, same field
 * type), which only happens when the model double-tags one location.
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

export interface DetectFieldsOptions {
  /** Hint about the project being filled (helps Claude pick the right canonical IDs). */
  projectHint?: Partial<Project> | null;
  /** Override the persisted model preference for this single call. */
  model?: string;
  /**
   * Override the adaptive-thinking effort. Pass `null` to disable thinking
   * entirely (omits the `thinking` and `output_config` params).
   * Defaults to a model-aware value (`xhigh` for Opus 4.7, `high` for
   * Opus 4.6 / Sonnet 4.6, none for Haiku).
   */
  effort?: ClaudeEffort | null;
  /** Optional original filename, used as the multipart filename for the upload. */
  filename?: string;
}

/**
 * High-fidelity field detector. Uploads the PDF to Anthropic's Files API
 * and asks Claude (with adaptive thinking + the hosted code_execution tool)
 * to extract field coordinates structurally using `pdfplumber` / `pypdf` /
 * `Pillow` inside the Anthropic sandbox — the same architecture Claude.ai
 * uses internally. This is dramatically more accurate than vision-based
 * coordinate guessing and is the only path that matches Claude.ai quality.
 *
 * First-time detection runs 60-180 seconds depending on form complexity
 * and effort level. Subsequent fills hit the local template cache and skip
 * Claude entirely.
 *
 * Throws `ClaudeNotConfiguredError` when the API key/desktop runtime is
 * missing; throws `ClaudeApiError` for any other Anthropic failure.
 */
export async function detectFieldsWithClaude(
  pdfBytes: Uint8Array,
  _pageNumber: number = 1,
  onStatus?: (status: string) => void,
  options: DetectFieldsOptions = {}
): Promise<TemplateField[]> {
  const model = options.model ?? getModelPreference();
  // Adaptive thinking is intentionally off for the agentic flow. The
  // extraction script in `buildAgenticSystemPrompt` is fully deterministic;
  // Claude's only remaining job is mapping the script's `candidates` /
  // `acroform` arrays onto canonical field ids — no reasoning loop needed.
  // Leaving thinking on with code_execution caused the model to second-guess
  // the script and run dozens of "verification" passes (the v0.3.7 endless
  // loop). The Settings "Detection effort" preference still applies to the
  // vision-only single-shot path used by `extractProjectFromPdfWithClaude`.
  const effort: ClaudeEffort | undefined =
    options.effort && options.effort !== null
      ? options.effort
      : undefined;

  onStatus?.("Reading PDF metadata…");
  const pageSizes = await getPageSizes(pdfBytes);

  // Live progress feed: Rust streams Anthropic's SSE events and emits
  // `anthropic-progress` Tauri events; we translate them into onStatus
  // strings. A heartbeat re-renders the same status with the elapsed
  // wall-clock time every second so the UI doesn't look frozen during
  // long sandbox calls.
  const startedAt = Date.now();
  let lastProgress: AgenticProgress = {
    phase: "uploading_file",
    detail: options.filename ?? null,
    toolIndex: null,
    toolCount: null,
  };
  const elapsedSec = () => Math.round((Date.now() - startedAt) / 1000);
  const pushStatus = () =>
    onStatus?.(progressToStatus(lastProgress, elapsedSec()));

  pushStatus();
  const heartbeat = window.setInterval(pushStatus, 1000);
  const unsubscribe = await subscribeAgenticProgress((progress) => {
    lastProgress = progress;
    pushStatus();
  });

  let result;
  try {
    result = await analyzePdfAgentic(pdfBytes, {
      model,
      systemPrompt: buildAgenticSystemPrompt(),
      userPrompt: buildAgenticUserPrompt(
        pageSizes,
        options.projectHint ?? null
      ),
      // 12k is plenty: a 30-field form serialises to ~4k tokens. A tight cap
      // is the second line of defence against a runaway loop — even if
      // Claude ignored the "one script" directive, it would hit max_tokens
      // long before burning 5+ minutes on script writing.
      maxTokens: 12288,
      effort,
      filename: options.filename,
    });
  } finally {
    window.clearInterval(heartbeat);
    unsubscribe();
  }

  const toolCallCount = result.toolCalls.length;
  onStatus?.(
    toolCallCount > 0
      ? `Claude ran ${toolCallCount} sandbox script(s); parsing answer…`
      : "Parsing Claude response…"
  );

  console.log(
    `[Typeset Claude] model=${model} thinking=${result.thinkingMode} stop=${result.stopReason} tool_calls=${toolCallCount} file_id=${result.fileId} usage=${JSON.stringify(result.usage)}`
  );

  const parsed = parseClaudeJson(result.text);
  const rawFields = Array.isArray(parsed.fields) ? parsed.fields : [];
  if (rawFields.length === 0) {
    console.warn("[Typeset Claude] No fields returned by Claude.");
    return [];
  }

  const templateFields = rawFields
    .map((raw, index) => mapToTemplateField(raw, index, pageSizes))
    .filter((field): field is TemplateField => field !== null);

  const deduped = dedupeFields(templateFields);
  console.log(
    `[Typeset Claude] Produced ${deduped.length} field(s) from ${rawFields.length} raw entries (detected_via=${parsed.form_type ?? "unknown"}).`
  );
  return deduped;
}

/**
 * Pulls field VALUES out of an already-filled PDF and maps them onto a
 * Partial<Project>. Used by the New Project view's "import from PDF".
 */
export async function extractProjectFromPdfWithClaude(
  pdfBytes: Uint8Array,
  options: { model?: string } = {}
): Promise<{ fields: Partial<Project>; fieldCount: number }> {
  const pageSizes = await getPageSizes(pdfBytes);
  const model = options.model ?? getModelPreference();

  const systemPrompt = [
    "You are reading a filled-in production paperwork PDF and extracting any project metadata that has already been written into the form.",
    "",
    "Map extracted values to this fixed schema (omit any keys you cannot confidently fill):",
    "{",
    '  "label": string,             // overall project / show label',
    '  "jobName": string,',
    '  "jobNumber": string,',
    '  "poNumber": string,',
    '  "authorizationDate": string, // MM/DD/YY or MM/DD/YYYY',
    '  "productionCompany": string,',
    '  "billingAddress": string,',
    '  "billingCity": string,',
    '  "billingState": string,',
    '  "billingZipCode": string,',
    '  "producer": string,',
    '  "email": string,',
    '  "phone": string,',
    '  "creditCardType": "visa" | "mastercard" | "discover" | "amex",',
    '  "creditCardHolder": string,',
    '  "creditCardNumber": string,',
    '  "expDate": string,',
    '  "ccv": string',
    "}",
    "",
    "Respond with a single JSON object only. No prose. No markdown fences.",
  ].join("\n");

  const userPrompt = [
    "Extract any pre-filled values from this PDF and return them as the JSON object described in the system prompt.",
    "Page sizes:",
    pageSizes.map((p) => `  page ${p.pageNumber}: ${p.width} x ${p.height} pt`).join("\n"),
  ].join("\n");

  const result = await analyzePdfWithClaude(pdfBytes, {
    model,
    systemPrompt,
    userPrompt,
    maxTokens: 2048,
  });

  const json = extractJson(result.text);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new ClaudeApiError(
      `Claude returned non-JSON content while extracting project fields. (parse error: ${
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
