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
            run, last = [], None
            def flush():
                if len(run) < 3:
                    return
                x0 = min(r["x0"] for r in run)
                x1 = max(r["x1"] for r in run)
                bot = max(r["bottom"] for r in run)
                candidates.append({
                    "page": pi,
                    "kind": "u",
                    "x": round(x0, 2),
                    "y": round(bot - 16, 2),
                    "w": round(x1 - x0, 2),
                    "h": 16,
                    "context": "",
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

            for ln in page.lines:
                if ln.get("height", 99) < 1.5 and ln.get("width", 0) > 30:
                    candidates.append({
                        "page": pi,
                        "kind": "ln",
                        "x": round(ln["x0"], 2),
                        "y": round(ln["top"] - 14, 2),
                        "w": round(ln["width"], 2),
                        "h": 16,
                        "context": "",
                    })

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
                    })

            try:
                words = page.extract_words(use_text_flow=False)
            except Exception:
                words = []
            for cand in [c for c in candidates if c["page"] == pi and not c["context"]]:
                cy = cand["y"] + cand["h"] / 2
                cx = cand["x"]
                best, best_d = None, 9999
                for w in words:
                    wy = (w["top"] + w["bottom"]) / 2
                    if abs(wy - cy) > 14:
                        continue
                    if w["x1"] > cx + 6:
                        continue
                    d = cx - w["x1"]
                    if d < best_d:
                        best_d = d
                        best = w["text"]
                cand["context"] = best or ""
except Exception:
    traceback.print_exc(file=sys.stderr)

print(json.dumps({
    "path": PATH,
    "n_pages": n_pages,
    "acroform": acroform,
    "candidates": candidates,
}))
`.trim();

function buildAgenticSystemPrompt(): string {
  return [
    "You analyze production paperwork PDFs (vendor agreements, credit-card authorizations, deal memos, W-9s, COIs) and emit JSON describing every fillable field.",
    "",
    "## PROCESS — exactly one tool call",
    "1. Use `code_execution` to run the SCRIPT below VERBATIM. Do not edit it.",
    "2. Read its JSON output (`acroform` and `candidates` arrays).",
    "3. Compose your final assistant message: ONLY the answer JSON, no prose.",
    "Do NOT run a second script. Do NOT render verification images. Do NOT iterate. The script is correct; the only work left is mapping its output to canonical field ids.",
    "",
    "## SCRIPT",
    "```python",
    EXTRACTION_SCRIPT,
    "```",
    "",
    "## TURNING SCRIPT OUTPUT INTO FIELDS",
    "- If `acroform` is non-empty, those rectangles ARE the answer. The coordinates are already top-down PDF points. Use the widget's `name` to pick a canonical_field_id when obvious; otherwise null.",
    "- Otherwise use `candidates`:",
    "  - `kind: \"u\"` (underscore run) and `kind: \"ln\"` (drawn line) → `field_type: \"text\"`. Width/height/x/y are already final.",
    "  - `kind: \"rect\"` → `field_type: \"checkbox\"`. When 4 small squares appear in a row near label words containing Visa / Mastercard / Discover / Amex, emit them as a checkbox-group with `group_id: \"creditCardType\"` and `checkbox_value` of `visa | mastercard | discover | amex` respectively. Card rows ALWAYS have all four — never stop at three.",
    "  - The `context` string is the nearest label word to the left of the candidate. Use it to pick a canonical_field_id and a human label. If you cannot map confidently, set canonical_field_id to null.",
    "",
    "## RULES",
    "- Coordinates are PDF points, top-left origin (y grows downward). Do NOT recompute them.",
    "- Skip headers, footers, page numbers, instructions, and pre-printed values.",
    "- Repeat a canonical_field_id only when the form legitimately duplicates it (e.g. signature top AND bottom).",
    "- field_kind: text | multiline | date | signature | boolean-checkbox | checkbox-group.",
    "- Standalone checkboxes: `field_kind: \"boolean-checkbox\"`, `checkbox_value: \"yes\"`.",
    "",
    "## CANONICAL FIELD CATALOG (set `canonical_field_id` when confident, otherwise null):",
    buildSchemaSummary(),
    "",
    "## OUTPUT — your final assistant message must be ONLY this JSON object (no markdown fences, no prose):",
    "{",
    "  \"page_count\": number,",
    "  \"form_type\"?: string,",
    "  \"detected_via\"?: \"acroform\" | \"pdfplumber\" | \"mixed\",",
    "  \"fields\": Array<{",
    "    canonical_field_id: string | null,",
    "    label: string,",
    "    field_type: \"text\" | \"checkbox\",",
    "    field_kind: \"text\" | \"multiline\" | \"date\" | \"signature\" | \"boolean-checkbox\" | \"checkbox-group\",",
    "    page_number: number,",
    "    x: number, y: number, width: number, height: number,",
    "    checkbox_value?: string | null,",
    "    group_id?: string | null,",
    "    estimated_font_size?: number | null,",
    "    optional?: boolean",
    "  }>",
    "}",
    "",
    "If the script returns no acroform widgets and no candidates: `{ \"page_count\": N, \"fields\": [] }`.",
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
