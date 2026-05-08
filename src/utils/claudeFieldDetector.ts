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
import { effectiveEffort, getModelPreference } from "@/services/anthropicSettings";
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
}

interface RawClaudeResponse {
  page_count?: number;
  form_type?: string;
  fields?: RawClaudeField[];
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

/**
 * Picks an adaptive-thinking effort level for a given model, honoring
 * the user's `Detection effort` preference from Settings.
 *
 * - Haiku doesn't support adaptive thinking → undefined to omit the
 *   `thinking` / `output_config` parameters entirely.
 * - All other models: use the persisted preference, capped to model
 *   capabilities (xhigh → high on non-Opus-4.7).
 */
function effortForModel(model: string): ClaudeEffort | undefined {
  if (model.toLowerCase().includes("haiku")) return undefined;
  return effectiveEffort(model);
}

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

function buildSchemaSummary(): string {
  return CANONICAL_FIELD_DEFINITIONS.map((def) => {
    const aliases = def.aliases.length > 0 ? ` aliases: [${def.aliases.join(", ")}]` : "";
    const checkbox = def.checkboxValue ? ` checkboxValue: ${def.checkboxValue}` : "";
    const group = def.groupId ? ` group: ${def.groupId}` : "";
    return `- ${def.id} (${def.fieldKind}) — "${def.label}".${aliases}${checkbox}${group}`;
  }).join("\n");
}

function buildAgenticSystemPrompt(): string {
  return [
    "You analyze film/production paperwork (vendor agreements, credit-card authorizations, deal memos, W-9s, COIs, etc.) and locate every fillable field with pixel-accurate bounding boxes.",
    "",
    "ENVIRONMENT",
    "- A `code_execution` Python sandbox is available with pdfplumber, pypdf, pikepdf, Pillow pre-installed.",
    "- The user's PDF was attached via `container_upload`. Find it under `/mnt/user-data/uploads`, `/tmp`, or cwd; the first `.pdf` you see is the one.",
    "",
    "STRICT BUDGET",
    "Use AT MOST 2 sandbox scripts. Do NOT render annotated images for visual verification; the structural extraction below is accurate when followed correctly. Iterating with rendered debug pages is wasted time and dramatically increases latency without improving accuracy.",
    "",
    "WORKFLOW",
    "Script 1 (mandatory) — extract structure:",
    "  a. Open with `pypdf.PdfReader`. If `reader.get_form_text_fields()` (or `/AcroForm` widgets via `reader.trailer['/Root']['/AcroForm']`) returns interactive fields, those widget rectangles ARE the answer — convert from bottom-up to top-down y and emit. You're done.",
    "  b. Otherwise open the same PDF with `pdfplumber`. For each page collect:",
    "     - `page.chars` → contiguous runs of `_` characters → text-input candidates.",
    "     - `page.lines` → long horizontal strokes (height < 1.5pt, width > 30pt) near a label → text-input candidates.",
    "     - `page.rects` → small ≈8-18pt squares near label words like Visa/Mastercard/Amex/Discover or near ☐ ☑ ◯ glyphs → checkbox candidates.",
    "  c. Group label-words with the nearest input candidate to the right or below.",
    "  d. Print a compact summary (one line per candidate with x/y/w/h/label) so you can sanity-check before composing JSON.",
    "Script 2 (optional, ONLY if Script 1 found < 3 fields) — fallback to a denser pass: re-walk page.chars to find labels followed by colons + whitespace + drawn line graphics, OR run pytesseract on a 200dpi render to locate stray hand-drawn fields. Do not run more than this.",
    "Then compose JSON in your final assistant message. No third script.",
    "",
    "COORDINATES",
    "All output in PDF points, TOP-LEFT origin (y grows downward). pdfplumber's `top` and `bottom` are already top-down. pypdf widget rects are bottom-up — convert with `top_y = page_height - bottom_up_y_max`, `height = bottom_up_y_max - bottom_up_y_min`. Boxes must fit inside the page.",
    "",
    "UNDERSCORE BBOX RULE (the secret sauce — read carefully)",
    "An underscore character's `top` is the row's ascender, NOT the visible underline. The underline is at the underscore's `bottom`. So:",
    "  underline_y = max(c.bottom for c in underscore_run)",
    "  font_size   = body_font_size_estimate                # 11-13pt on most production forms",
    "  height      = round(font_size * 1.3)                 # ≈ 15-18pt",
    "  y           = underline_y - height + 2               # bottom of box ~2pt below underline",
    "  x           = min(c.x0 for c in run)",
    "  width       = max(c.x1 for c in run) - x",
    "For drawn lines from `page.lines`, use the line's y as `underline_y` directly. For checkboxes, the bbox IS the square.",
    "",
    "FIELD KINDS",
    "- `text` — single-line input",
    "- `multiline` — input spans 2+ rows (addresses, notes)",
    "- `date` — date field",
    "- `signature` — signature line",
    "- `boolean-checkbox` — standalone checkbox; `checkbox_value: 'yes'`",
    "- `checkbox-group` — card-type rows (Visa/Mastercard/Amex/Discover); `group_id: 'creditCardType'`, `checkbox_value: 'visa' | 'mastercard' | 'discover' | 'amex'`. Card rows ALWAYS have all four — don't stop at three.",
    "",
    "Body-text underscores inside running prose (`I, ______, authorize…`) are fillable; bound the box tightly to the underline only. Skip headers, footers, instructions, page numbers, and pre-printed values. Conditional sections still count — set `optional: true`. A canonical id repeats only when the form legitimately has duplicates (e.g. signature at top AND bottom).",
    "",
    "CANONICAL FIELD CATALOG (set `canonical_field_id` when confident, otherwise null):",
    buildSchemaSummary(),
    "",
    "OUTPUT — your FINAL assistant message must contain ONLY this JSON object, no prose, no markdown fences:",
    "interface Response {",
    "  page_count: number;",
    "  form_type?: string;        // e.g. 'credit card authorization'",
    "  detected_via?: 'acroform' | 'pdfplumber' | 'mixed';",
    "  fields: Array<{",
    "    canonical_field_id: string | null;",
    "    label: string;",
    "    field_type: 'text' | 'checkbox';",
    "    field_kind: 'text' | 'multiline' | 'date' | 'signature' | 'boolean-checkbox' | 'checkbox-group';",
    "    page_number: number;     // 1-indexed",
    "    x: number; y: number; width: number; height: number;",
    "    checkbox_value?: string | null;",
    "    group_id?: string | null;",
    "    estimated_font_size?: number | null;",
    "    optional?: boolean;",
    "  }>",
    "}",
    "",
    "If no fields found: `{ page_count, fields: [] }`.",
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
        "Sample project context (only a hint for picking canonical_field_id; do NOT inline these values into your response):",
        "```json",
        JSON.stringify(project, null, 2),
        "```",
      ].join("\n")
    : "";
  return [
    "Analyze the attached PDF using your code_execution sandbox and emit the JSON object from the system prompt.",
    "",
    "Page sizes (PDF points, top-left origin):",
    pageBlock,
    "",
    "Run AT MOST two sandbox scripts: one to extract structure (AcroForm widgets first, pdfplumber chars/lines/rects otherwise), an optional second only if the first found fewer than 3 candidates. Do NOT render annotated debug images. Then return the JSON.",
    projectBlock,
    "",
    "Your final assistant message must contain ONLY the JSON object — no commentary, no markdown fences.",
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

  const canonicalId =
    raw.canonical_field_id && VALID_CANONICAL_IDS.has(raw.canonical_field_id)
      ? (raw.canonical_field_id as CanonicalFieldId)
      : undefined;

  const canonicalDef = canonicalId
    ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
    : undefined;

  const isCardCheckbox = canonicalId && CREDIT_CARD_CHECKBOX_IDS.has(canonicalId);
  const isBooleanCheckbox = fieldType === "checkbox" && !isCardCheckbox;

  const catalogKey = canonicalDef?.mappedProjectKey ?? "";
  const fieldLabel = (raw.label && raw.label.trim()) || canonicalDef?.label || `Field ${index + 1}`;

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

function dedupeFields(fields: TemplateField[]): TemplateField[] {
  const result: TemplateField[] = [];
  const usedCanonicalIds = new Set<string>();

  for (const field of fields) {
    if (field.canonicalFieldId) {
      const def = CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === field.canonicalFieldId);
      if (!def?.allowDuplicates && usedCanonicalIds.has(field.canonicalFieldId)) {
        continue;
      }
    }

    const overlapping = result.find(
      (existing) =>
        existing.pageNumber === field.pageNumber &&
        Math.abs(existing.x - field.x) < 12 &&
        Math.abs(existing.y - field.y) < 12 &&
        existing.fieldType === field.fieldType
    );
    if (overlapping) continue;

    result.push(field);
    if (field.canonicalFieldId) {
      usedCanonicalIds.add(field.canonicalFieldId);
    }
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
  const effort: ClaudeEffort | undefined =
    options.effort === null
      ? undefined
      : (options.effort ?? effortForModel(model));

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
      maxTokens: effort ? 32768 : 16384,
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
