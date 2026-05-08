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
  type ClaudeEffort,
} from "@/services/claudeClient";
import { getModelPreference } from "@/services/anthropicSettings";
import { CANONICAL_FIELD_DEFINITIONS } from "@/utils/fieldCatalog";
import { normalizeCardType } from "@/utils/fill";

export { ClaudeNotConfiguredError, ClaudeApiError };

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
 * Picks an adaptive-thinking effort level for a given model.
 *
 * - Opus 4.7 supports the new `xhigh` tier — strongest spatial reasoning.
 * - Opus 4.6 / Sonnet 4.6 cap out at `high`.
 * - Haiku doesn't support adaptive thinking at all → return undefined to
 *   omit the `thinking` / `output_config` parameters entirely.
 */
function effortForModel(model: string): ClaudeEffort | undefined {
  const lower = model.toLowerCase();
  if (lower.includes("haiku")) return undefined;
  if (lower.includes("opus-4-7") || lower.includes("opus_4_7")) return "xhigh";
  if (lower.includes("opus")) return "high";
  if (lower.includes("sonnet")) return "high";
  // Unknown / custom: be conservative.
  return "high";
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
    "You are an expert at analyzing film/production paperwork (vendor agreements, credit-card authorizations, insurance certificates, deal memos, W-9s, etc.) and locating every fillable field on the form with pixel-accurate coordinates.",
    "",
    "ENVIRONMENT",
    "- You have access to a hosted Python sandbox via the `code_execution` tool.",
    "- The user's PDF has been attached as a `container_upload` and is available in your sandbox filesystem. Discover its path with `os.listdir` (try `/mnt/user-data/uploads`, `/tmp`, and the working directory). The first .pdf you find IS the file to analyze.",
    "- Pre-installed libraries you should rely on: `pdfplumber`, `pypdf`, `pikepdf`, `Pillow`. Use `pip install` only if a needed library is missing.",
    "",
    "GOAL",
    "Emit a single JSON object describing every fillable input on the form, with bounding boxes precise enough to drop typed text directly onto the underline. Quality bar: a third party should be able to fill the form using ONLY your JSON output and have it look correct in the printed result.",
    "",
    "RECOMMENDED WORKFLOW (you may adapt it, but every step's job must get done)",
    "Step 1 — Inspect the PDF for AcroForm widgets:",
    "  Use `pypdf` or `pdfplumber.PDF.metadata` to check whether the PDF has interactive form fields. If it does, those widget rectangles are ground-truth bounding boxes; emit them directly (in PDF points, top-left origin) and skip ahead.",
    "Step 2 — If there are no AcroForm widgets, treat it as a flat-print form and extract structure with `pdfplumber`:",
    "  - For each page, iterate `page.chars` to get every glyph with its `x0, top, x1, bottom`. (`top`/`bottom` are already top-left origin in pdfplumber, do NOT use `y0`/`y1` which are bottom-up.)",
    "  - Find runs of underscore characters (`_`) → each contiguous run is one candidate text input.",
    "  - Iterate `page.lines` (drawn line graphics): a long thin horizontal line near a label is also a candidate input underline. Record its endpoints and stroke y.",
    "  - Iterate `page.rects`: small (≈8-18pt) square strokes near a label word like 'Visa'/'Mastercard'/'Discover'/'AMEX' or near checkbox-shaped Unicode glyphs (☐ ☑ ◯) are candidate checkboxes.",
    "  - Group every label-word with the nearest input candidate to its right or below (whichever is more plausible from the layout).",
    "  - **EXHAUSTIVE CHECKBOX SEQUENCES**: When you find a row of related checkboxes (e.g. `Visa __ Mastercard __ Amex __ Discover`), enumerate ALL of them — do NOT stop at three. Card-type rows always have FOUR options on standard US forms: Visa, Mastercard, Amex, Discover. Verify the count matches what's printed.",
    "Step 3 — VISUAL VERIFICATION (mandatory; do not skip):",
    "  a. Render each page at `resolution=200` with `page.to_image()`.",
    "  b. Use `PIL.ImageDraw` to draw EVERY candidate bounding box onto the rendered image, with the field's label as a small caption near the box.",
    "  c. Save the annotated PNG (e.g. `page1_boxes.png`) and IMMEDIATELY open it for inspection (`from IPython.display import Image; Image('page1_boxes.png')` or just print its dims and inspect via the tool result panel).",
    "  d. For EACH box, verify three things:",
    "       (i) The underline (the `_____` row OR the drawn line) sits at or just below the BOTTOM EDGE of the box — never the top, never the middle.",
    "       (ii) The horizontal extent matches the underline span — not narrower, not wider.",
    "       (iii) The label printed to the LEFT of the box is the correct label for that field.",
    "  e. If even one box is misaligned, recompute it and re-render. If MOST boxes share the same offset (a common bias), shift them all uniformly and re-verify. Iterate until correct.",
    "Step 4 — Compose the JSON answer.",
    "",
    "COORDINATE SYSTEM AND BOX-FROM-UNDERSCORE RULE (read carefully — this is where most detectors fail)",
    "- All output coordinates are in PDF points using a TOP-LEFT origin where y increases downward.",
    "- pdfplumber's `top`/`bottom` and `chars` already use top-down y. Use them directly.",
    "- pypdf and pdfplumber's `bbox` on annotations use bottom-up y. Convert with: `top_y = page_height - bottom_up_y_max`, `height = bottom_up_y_max - bottom_up_y_min`.",
    "- The bounding box must enclose the AREA WHERE INK WILL BE WRITTEN, NOT the printed label. For `Cardholder Name: ____________` only the underscores are the field, not the words.",
    "- Boxes must fit inside the page bounds.",
    "",
    "CRITICAL — UNDERSCORE GLYPH BBOX QUIRK:",
    "An underscore character's `top` value sits at the LINE'S ASCENDER (top of the row of text), NOT at the level of the actual underline stroke. The visible underline is at the underscore's `bottom`. If you copy `chars[i].top` straight into your output's `y` and use a small height, the box will float ~15-25pt ABOVE the underline. Do this instead:",
    "  let `underline_y = max(c.bottom for c in underscore_run_chars)`  # the actual underline level (top-down y)",
    "  let `font_size  = body_font_size_estimate`                       # often 11-13pt on production forms",
    "  let `bbox.height = round(font_size * 1.3)`                       # ≈ 15-18pt for a 12pt body font",
    "  let `bbox.y      = underline_y - bbox.height + 2`                # box BOTTOM lands ~2pt below underline",
    "  let `bbox.x      = min(c.x0 for c in run)`",
    "  let `bbox.width  = max(c.x1 for c in run) - bbox.x`",
    "When the underline is a drawn line (from `page.lines`) instead of underscores, use the line's y for `underline_y` directly.",
    "",
    "For checkboxes, use the glyph square's actual dimensions (≈10-16pt). The bbox is the square itself.",
    "",
    "FIELD CLASSIFICATION RULES",
    "- Body-text underscores inside running prose (e.g. 'I, ______, hereby authorize my card to be charged $______') ARE fillable; treat each underscore run as its own field, but bound the box tightly to the underline span only — never the whole sentence.",
    "- Skip static instructions ('please print clearly', '*** include a photo ***'), page numbers, headers/footers, dividers, and already-printed values (form title, company name).",
    "- Conditional sections (e.g. 'If paying by credit card…' or 'IF YOU WOULD LIKE TO PAY…') still count as fields; mark them with `optional: true`.",
    "- For Visa / MasterCard / Discover / AMEX checkboxes use `field_kind: 'checkbox-group'`, `group_id: 'creditCardType'`, and the matching `checkbox_value` ('visa' | 'mastercard' | 'discover' | 'amex').",
    "- For all other checkboxes use `field_kind: 'boolean-checkbox'` with `checkbox_value: 'yes'`.",
    "- Multi-line addresses (input area spans 2+ rows) → `field_kind: 'multiline'`.",
    "- Signature lines → `field_kind: 'signature'`.",
    "- Dates → `field_kind: 'date'`.",
    "- A canonical id may repeat only when the form legitimately has duplicates (e.g. signature at top AND bottom). Otherwise each id appears at most once.",
    "",
    "CANONICAL PROJECT FIELD CATALOG (only set `canonical_field_id` when you are confident; otherwise null):",
    buildSchemaSummary(),
    "",
    "FINAL RESPONSE FORMAT (very important)",
    "After all your tool calls, your FINAL assistant message must contain a single JSON object and nothing else — no prose outside the JSON, no markdown fences, no commentary. The shape:",
    "",
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
    "    x: number; y: number; width: number; height: number;  // PDF points, TOP-LEFT origin",
    "    checkbox_value?: string | null;",
    "    group_id?: string | null;",
    "    estimated_font_size?: number | null;",
    "    optional?: boolean;",
    "  }>",
    "}",
    "",
    "If you genuinely cannot find any fields, return `{ page_count, fields: [] }`.",
    "",
    "Take however long you need — the user prefers an extra minute of analysis over a fast wrong answer.",
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
    "Analyze the attached PDF using your code_execution sandbox and emit the JSON object described in the system prompt.",
    "",
    "Page sizes (PDF points, top-left origin):",
    pageBlock,
    "",
    "Walk through the recommended workflow: check for AcroForm widgets, otherwise extract structure with pdfplumber, render the page with your boxes drawn on it, and verify visually before finalizing the JSON.",
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

  onStatus?.("Uploading PDF to Claude…");

  const result = await analyzePdfAgentic(pdfBytes, {
    model,
    systemPrompt: buildAgenticSystemPrompt(),
    userPrompt: buildAgenticUserPrompt(pageSizes, options.projectHint ?? null),
    maxTokens: effort ? 32768 : 16384,
    effort,
    filename: options.filename,
  });

  // The renderer can't easily show progress while Claude is in its sandbox
  // loop — we only get the final response. Surface the count of tool calls
  // it made for transparency in the post-call status.
  const toolCallCount = result.toolCalls.length;
  onStatus?.(
    toolCallCount > 0
      ? `Claude ran ${toolCallCount} sandbox script(s); parsing answer…`
      : "Parsing Claude response…"
  );

  console.log(
    `[TYPESET Claude] model=${model} thinking=${result.thinkingMode} stop=${result.stopReason} tool_calls=${toolCallCount} file_id=${result.fileId} usage=${JSON.stringify(result.usage)}`
  );

  const parsed = parseClaudeJson(result.text);
  const rawFields = Array.isArray(parsed.fields) ? parsed.fields : [];
  if (rawFields.length === 0) {
    console.warn("[TYPESET Claude] No fields returned by Claude.");
    return [];
  }

  const templateFields = rawFields
    .map((raw, index) => mapToTemplateField(raw, index, pageSizes))
    .filter((field): field is TemplateField => field !== null);

  const deduped = dedupeFields(templateFields);
  console.log(
    `[TYPESET Claude] Produced ${deduped.length} field(s) from ${rawFields.length} raw entries (detected_via=${parsed.form_type ?? "unknown"}).`
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
