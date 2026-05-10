/**
 * v0.6.0 (Workstream C) — AcroForm-first ingestion pipeline.
 *
 * Many production forms (rental account agreements, CC auth forms,
 * studio contracts) are distributed as native AcroForm PDFs with
 * widgets already drawn at the right coordinates and labelled
 * cleanly. For those forms, deferring to Gemini's image-based
 * detection is wasteful AND error-prone: Gemini sometimes
 * misclassifies widget rects, hijacks Names into cardholder, or
 * skips small CCV/exp fields entirely. The native widget set is
 * ground truth for placement; we just need a thin adapter that
 * promotes each `PDFTextField` / `PDFCheckBox` / `PDFRadioGroup`
 * / `PDFSignature` / `PDFDropdown` to a `TemplateField`.
 *
 * Pipeline placement: called FIRST from the detection orchestrator
 * (App.tsx PDF drop handler). Three outcomes:
 *
 *   1. PDF has zero AcroForm fields → returns `null`. Caller falls
 *      through to the existing Gemini-only flow. No regression.
 *   2. PDF has AcroForm fields covering all pages → caller skips
 *      Gemini entirely. Field placement is deterministic, fast,
 *      and exact.
 *   3. PDF has AcroForm fields covering some pages → caller runs
 *      Gemini on the non-covered pages and merges the two sets
 *      ("hybrid" mode). The returned `pageNumbers` set tells the
 *      caller which pages already have AcroForm coverage.
 *
 * Coordinate translation: pdf-lib reports widget rects in PDF
 * user-space points with the PDF-native origin at the BOTTOM-LEFT
 * of the page (`getRectangle()` returns `{ x, y, width, height }`
 * with `y` = bottom edge from page bottom). The rest of this
 * codebase (`TemplateField.y`, the renderer in `pdfWriter.ts`,
 * `DraggableField`'s pixel layout) uses a TOP-DOWN convention
 * where `y` = distance from the top of the page to the field's
 * TOP edge. We flip in this module so the downstream pipeline
 * doesn't need to know AcroForm fields use a different origin.
 *
 * Canonical-id resolution: each widget's `getName()` (the PDF
 * field name, e.g. `"name.first"`, `"Text1"`, `"cc_number"`) is
 * lowercased and matched against every canonical's `aliases` list
 * by the same length-descending word-boundary algorithm
 * `inferByLabel` uses in `geminiFieldDetector.ts`. Widget names
 * that don't match any alias get `__prompt__` and a
 * Gemini-style cleanup of the raw name as their visible label —
 * conservative, never invents a canonical that isn't supported by
 * the catalog.
 */

import { PDFDocument } from "pdf-lib";
import type {
  CanonicalFieldId,
  FieldOption,
  TemplateField,
  TemplateFieldKind,
  TemplateMappedProjectKey,
} from "@/types";
import {
  CANONICAL_FIELD_DEFINITIONS,
  type CanonicalFieldDefinition,
} from "@/utils/fieldCatalog";

export interface AcroFormIngestResult {
  fields: TemplateField[];
  /** 1-based page numbers where at least one AcroForm widget was found. */
  pageNumbers: Set<number>;
  sourceCounts: { acroform: number };
}

/**
 * Multiline gate. AcroForm widgets with a rect height ≥ this many
 * points are treated as multiline text fields even when the
 * `multiLine` flag isn't set — matches the heuristic in
 * `mapToTemplateField` (`HEIGHT_MULTILINE_THRESHOLD_PT`) so the
 * downstream renderer + snap behave consistently across the two
 * detection paths.
 */
const HEIGHT_MULTILINE_THRESHOLD_PT = 30;

/**
 * Build the alias index (length-descending) for canonical resolution.
 * Mirrors the index `geminiFieldDetector.ts` uses internally;
 * computed once per call rather than at module load so the catalog
 * stays the single source of truth (catalog edits flow through
 * automatically without an extra rebuild step).
 */
function buildAliasIndex(): Array<{
  alias: string;
  id: CanonicalFieldId;
  def: CanonicalFieldDefinition;
}> {
  const index: Array<{
    alias: string;
    id: CanonicalFieldId;
    def: CanonicalFieldDefinition;
  }> = [];
  for (const def of CANONICAL_FIELD_DEFINITIONS) {
    for (const alias of def.aliases ?? []) {
      const trimmed = alias.trim().toLowerCase();
      if (!trimmed) continue;
      index.push({ alias: trimmed, id: def.id, def });
    }
  }
  index.sort((a, b) => b.alias.length - a.alias.length);
  return index;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a canonical id from a PDF widget's name. AcroForm
 * widget names are typically a) human-friendly (`first_name`,
 * `card.number`, `cardholder name`), b) generic (`Text1`,
 * `Check Box 4`), or c) opaque (`f1_2[0]`). For (a) we resolve via
 * the catalog alias index; for (b) and (c) we return undefined
 * and the caller falls back to `__prompt__`.
 *
 * Resolution rules (mirrors `inferByLabel`):
 *   - Lowercase + trim the widget name; replace `_`/`.`/`-` with
 *     spaces so multi-token names normalise to alias-comparable
 *     phrases.
 *   - Iterate aliases longest-first. Match if (i) the name equals
 *     the alias OR (ii) the alias appears bounded by word
 *     boundaries inside the name.
 *   - Skip aliases shorter than 3 chars (same gate as the Gemini
 *     resolver).
 *   - For canonicals scoped to a specific widget type (card-type
 *     checkbox aliases like `visa`/`mastercard`) require an exact
 *     name match OR a fieldType match before binding — same guard
 *     as `inferByLabel`'s `CREDIT_CARD_CHECKBOX_IDS` branch.
 */
function resolveCanonicalByName(
  rawName: string,
  fieldType: "text" | "checkbox" | "option-group" | "signature",
  aliasIndex: ReturnType<typeof buildAliasIndex>
): CanonicalFieldId | undefined {
  const cleaned = rawName
    .toLowerCase()
    .replace(/[._\-/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  for (const { alias, id, def } of aliasIndex) {
    if (alias.length < 3) continue;
    const isExact = cleaned === alias;
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`);
    if (!isExact && !re.test(cleaned)) continue;

    // Type-scoped canonicals (Visa/MC/Amex/Discover checkbox
    // aliases) only resolve when the widget itself is a checkbox
    // — otherwise a `visa_number` text field would hijack into
    // `creditCardTypeVisa`.
    if (def.fieldKind === "checkbox-group" || def.fieldKind === "boolean-checkbox") {
      if (fieldType !== "checkbox" && !isExact) continue;
    }
    if (def.fieldKind === "signature" && fieldType !== "signature" && !isExact) {
      continue;
    }
    return id;
  }
  return undefined;
}

/**
 * Look up the 1-based page number for a widget by walking the
 * document's page list and matching the widget's `/P` reference.
 *
 * pdf-lib exposes `PDFPage.ref` (a public readonly `PDFRef`) and
 * `PDFWidgetAnnotation.P()` (returns the parent page's ref or
 * undefined). Comparing by `objectNumber` + `generationNumber`
 * is robust to ref-object re-creation across the document load.
 *
 * Returns `undefined` for orphaned widgets (no `/P`); the caller
 * skips orphans because there's no sensible page-number to assign
 * and the bbox is meaningless without a page context.
 */
function findPageNumberForWidget(
  pdfDoc: PDFDocument,
  widgetParentRef: { objectNumber: number; generationNumber: number } | undefined
): number | undefined {
  if (!widgetParentRef) return undefined;
  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i += 1) {
    const ref = pages[i].ref;
    if (
      ref.objectNumber === widgetParentRef.objectNumber &&
      ref.generationNumber === widgetParentRef.generationNumber
    ) {
      return i + 1;
    }
  }
  return undefined;
}

/**
 * Convert a PDF widget rect (origin at page BOTTOM-LEFT) to a
 * `TemplateField` rect (origin at page TOP-LEFT, y = distance
 * from page top to the field's TOP edge). The width/height carry
 * across unchanged.
 *
 * Edge cases: pdf-lib reports negative-width or negative-height
 * rects on some malformed PDFs (the `/Rect` array can be in
 * `[urx, ury, llx, lly]` order rather than the spec's
 * `[llx, lly, urx, ury]`). We normalise by taking absolutes and
 * recomputing the corner — better to ship a positive-extent rect
 * the user can drag than to silently drop a real widget.
 */
function widgetRectToTemplate(
  rect: { x: number; y: number; width: number; height: number },
  pageHeight: number
): { x: number; y: number; width: number; height: number } {
  const w = Math.abs(rect.width);
  const h = Math.abs(rect.height);
  const x = Math.min(rect.x, rect.x + rect.width);
  const yBottom = Math.min(rect.y, rect.y + rect.height);
  const yTopDown = pageHeight - (yBottom + h);
  return { x, y: yTopDown, width: w, height: h };
}

/**
 * Clean a raw PDF field name into something a human can read in
 * the field-review sidebar. Strips trailing `[0]` array indexing
 * (common in XFA-converted PDFs), replaces `_`/`.`/`-` with spaces,
 * collapses multi-spaces, title-cases only the first letter so the
 * label reads like the original PDF without inventing capitalisation
 * for words that the form designer left lowercase.
 */
function humaniseWidgetName(rawName: string): string {
  const stripped = rawName
    .replace(/\[\d+\]\s*$/g, "")
    .replace(/[._\-/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return rawName;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Attempt to extract the AcroForm field set from a PDF. Returns
 * `null` when the document either has no form OR has zero fields
 * — both signals that the caller should fall through to the
 * Gemini-only path.
 *
 * Never throws on broken AcroForm trees: pdf-lib will sometimes
 * fail to parse a malformed widget annotation (missing `/Rect`,
 * dangling `/Kids`). We swallow per-widget errors and continue —
 * the asymmetric cost analysis is the same as Gemini's: a
 * dropped widget is a "user has to manually add this field"
 * regression, but a thrown exception aborts the entire detection
 * and forces the user into Gemini-only mode for the whole
 * document. Logging the per-widget failure on the way out so
 * future debugging sessions have evidence.
 */
export async function tryAcroFormIngest(
  pdfBytes: Uint8Array
): Promise<AcroFormIngestResult | null> {
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (err) {
    console.warn("[acroFormIngest] PDFDocument.load failed:", err);
    return null;
  }

  let form: ReturnType<PDFDocument["getForm"]>;
  try {
    form = pdfDoc.getForm();
  } catch (err) {
    console.warn("[acroFormIngest] getForm() failed:", err);
    return null;
  }

  const acroFields = form.getFields();
  if (acroFields.length === 0) {
    console.log("[acroFormIngest] PDF has zero AcroForm fields — falling through to Gemini.");
    return null;
  }

  const pages = pdfDoc.getPages();
  const aliasIndex = buildAliasIndex();
  const out: TemplateField[] = [];
  const pageNumbers = new Set<number>();
  let acroformCount = 0;

  for (let i = 0; i < acroFields.length; i += 1) {
    const field = acroFields[i];
    let rawName = "";
    try {
      rawName = field.getName();
    } catch (err) {
      console.warn(`[acroFormIngest] field ${i}: getName() failed:`, err);
      continue;
    }
    if (!rawName) continue;

    // Resolve the widget type by class name. Reading the
    // constructor name (`PDFTextField`, `PDFCheckBox`,
    // `PDFRadioGroup`, `PDFSignature`, `PDFDropdown`) avoids the
    // need to import all five classes and `instanceof`-check each
    // one — the runtime class names are stable across pdf-lib
    // versions (the names are in the public d.ts files) and a
    // stringly comparison is more forgiving when pdf-lib bundles
    // its own copies of the classes (e.g. dual ESM/CJS load).
    const widgetCtorName = field.constructor?.name ?? "";

    type WidgetKind = "text" | "checkbox" | "option-group" | "signature";
    let widgetKind: WidgetKind | undefined;
    if (widgetCtorName === "PDFTextField") widgetKind = "text";
    else if (widgetCtorName === "PDFCheckBox") widgetKind = "checkbox";
    else if (widgetCtorName === "PDFRadioGroup") widgetKind = "option-group";
    else if (widgetCtorName === "PDFDropdown") widgetKind = "option-group";
    else if (widgetCtorName === "PDFSignature") widgetKind = "signature";

    if (!widgetKind) {
      // PDFOptionList (multi-select) or PDFButton (push button)
      // are out-of-scope for v0.6.0. Log + skip; the user can
      // hand-add them in the review canvas if needed.
      console.log(
        `[acroFormIngest] field ${i} (${rawName}): unsupported widget type ${widgetCtorName}, skipping.`
      );
      continue;
    }

    let widgets: ReturnType<typeof field.acroField.getWidgets>;
    try {
      widgets = field.acroField.getWidgets();
    } catch (err) {
      console.warn(
        `[acroFormIngest] field ${i} (${rawName}): getWidgets() failed:`,
        err
      );
      continue;
    }

    if (widgets.length === 0) {
      console.log(`[acroFormIngest] field ${i} (${rawName}): no widgets, skipping.`);
      continue;
    }

    // For RADIO groups, each widget is one button — we collapse
    // into a single TemplateField with one option per button. For
    // every other type, each widget is rendered as its own
    // TemplateField (some fields legitimately render at multiple
    // page locations, e.g. signature on both p1 and p2).
    if (widgetKind === "option-group" && widgetCtorName === "PDFRadioGroup") {
      // Use the FIRST widget's page + bounding union of all radio
      // rects as the parent field rect. Per-option bboxes are the
      // individual radio rects (top-down).
      let pageNumber: number | undefined;
      const optionRects: Array<{
        rect: { x: number; y: number; width: number; height: number };
        label: string;
      }> = [];

      // Need the radio button option labels in the order pdf-lib
      // returns them (matches widget order on most PDFs).
      let radioOptions: string[] = [];
      try {
        // Cast to PDFRadioGroup to access getOptions(); we
        // already constructor-name-checked above so this is safe.
        radioOptions = (field as unknown as { getOptions(): string[] }).getOptions();
      } catch (err) {
        console.warn(
          `[acroFormIngest] field ${i} (${rawName}): getOptions() failed:`,
          err
        );
        continue;
      }

      for (let w = 0; w < widgets.length; w += 1) {
        const widget = widgets[w];
        const parentRef = widget.P();
        const widgetPage = findPageNumberForWidget(pdfDoc, parentRef);
        if (widgetPage === undefined) continue;
        pageNumber = pageNumber ?? widgetPage;
        const page = pages[widgetPage - 1];
        if (!page) continue;
        let widgetRect: ReturnType<typeof widget.getRectangle>;
        try {
          widgetRect = widget.getRectangle();
        } catch {
          continue;
        }
        const optRect = widgetRectToTemplate(widgetRect, page.getHeight());
        const optLabel = radioOptions[w] ?? `Option ${w + 1}`;
        optionRects.push({ rect: optRect, label: optLabel });
      }

      if (optionRects.length === 0 || pageNumber === undefined) {
        console.log(
          `[acroFormIngest] field ${i} (${rawName}): no resolvable radio widgets, skipping.`
        );
        continue;
      }

      // Parent rect = union of all option rects.
      let minX = Infinity;
      let minY = Infinity;
      let maxRight = -Infinity;
      let maxBot = -Infinity;
      for (const { rect } of optionRects) {
        if (rect.x < minX) minX = rect.x;
        if (rect.y < minY) minY = rect.y;
        if (rect.x + rect.width > maxRight) maxRight = rect.x + rect.width;
        if (rect.y + rect.height > maxBot) maxBot = rect.y + rect.height;
      }
      const parentRect = {
        x: minX,
        y: minY,
        width: maxRight - minX,
        height: maxBot - minY,
      };

      const canonicalId = resolveCanonicalByName(rawName, "option-group", aliasIndex);
      const def = canonicalId
        ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
        : undefined;
      const mappedKey: TemplateMappedProjectKey = def?.mappedProjectKey
        ? (def.mappedProjectKey as TemplateMappedProjectKey)
        : "__prompt__";

      const options: FieldOption[] = optionRects.map(({ rect, label }) => ({
        label,
        bbox: { ...rect },
      }));

      const label = def?.label ?? humaniseWidgetName(rawName);

      out.push({
        id: `acroform-${i}-${Date.now().toString(36)}`,
        label,
        mappedProjectKey: mappedKey,
        canonicalFieldId: canonicalId,
        pageNumber,
        x: parentRect.x,
        y: parentRect.y,
        width: parentRect.width,
        height: parentRect.height,
        confidence: 1.0, // AcroForm widgets are ground truth — no fuzzy detection.
        fieldType: "option-group",
        fieldKind: "option-group",
        detectionSource: "acroform",
        options,
        selectedOption: null,
        promptLabel: !def ? label : undefined,
      });
      pageNumbers.add(pageNumber);
      acroformCount += 1;
      continue;
    }

    // Non-radio path: each widget produces its own TemplateField.
    for (let w = 0; w < widgets.length; w += 1) {
      const widget = widgets[w];
      const parentRef = widget.P();
      const pageNumber = findPageNumberForWidget(pdfDoc, parentRef);
      if (pageNumber === undefined) {
        console.log(
          `[acroFormIngest] field ${i} (${rawName}) widget ${w}: no page reference, skipping.`
        );
        continue;
      }
      const page = pages[pageNumber - 1];
      if (!page) continue;

      let widgetRect: ReturnType<typeof widget.getRectangle>;
      try {
        widgetRect = widget.getRectangle();
      } catch (err) {
        console.warn(
          `[acroFormIngest] field ${i} (${rawName}) widget ${w}: getRectangle() failed:`,
          err
        );
        continue;
      }
      const rect = widgetRectToTemplate(widgetRect, page.getHeight());
      if (rect.width <= 0 || rect.height <= 0) {
        console.log(
          `[acroFormIngest] field ${i} (${rawName}) widget ${w}: degenerate rect ${JSON.stringify(rect)}, skipping.`
        );
        continue;
      }

      const canonicalId = resolveCanonicalByName(rawName, widgetKind, aliasIndex);
      const def = canonicalId
        ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
        : undefined;

      // Field kind resolution:
      //   - signature widget always → `signature` (regardless of
      //     canonical, so even an unmatched widget name keeps the
      //     signature renderer);
      //   - checkbox widget → `boolean-checkbox` unless the
      //     canonical says otherwise (card-type aliases would
      //     bind to `checkbox-group`);
      //   - dropdown widget → `option-group` (already covered by
      //     widgetKind);
      //   - text widget → multiline if the field's `multiLine`
      //     flag is set OR the rect is taller than the multiline
      //     threshold; else fall back to canonical `fieldKind`
      //     (e.g. `date` for canonical `shootDate`) or `text`.
      let fieldKind: TemplateFieldKind;
      let fieldType: "text" | "checkbox" | "option-group" = "text";
      if (widgetKind === "signature") {
        fieldKind = "signature";
        fieldType = "text";
      } else if (widgetKind === "checkbox") {
        fieldType = "checkbox";
        fieldKind =
          def?.fieldKind === "checkbox-group" ? "checkbox-group" : "boolean-checkbox";
      } else if (widgetKind === "option-group") {
        // Dropdown — get the dropdown's options.
        fieldType = "option-group";
        fieldKind = "option-group";
      } else {
        fieldType = "text";
        // Multiline detection: pdf-lib exposes `isMultiline()` on
        // PDFTextField; we narrow + try-catch so a misclassified
        // widget doesn't throw.
        let isMultiline = false;
        try {
          isMultiline = !!(
            field as unknown as { isMultiline?: () => boolean }
          ).isMultiline?.();
        } catch {
          // ignore — fall through to height heuristic.
        }
        if (isMultiline || rect.height >= HEIGHT_MULTILINE_THRESHOLD_PT) {
          fieldKind = "multiline";
        } else if (def?.fieldKind && def.fieldKind !== "checkbox-group" &&
                   def.fieldKind !== "boolean-checkbox" &&
                   def.fieldKind !== "option-group" &&
                   def.fieldKind !== "signature") {
          fieldKind = def.fieldKind;
        } else {
          fieldKind = "text";
        }
      }

      const mappedKey: TemplateMappedProjectKey = def?.mappedProjectKey
        ? (def.mappedProjectKey as TemplateMappedProjectKey)
        : "__prompt__";

      let options: FieldOption[] | undefined;
      if (widgetKind === "option-group" && widgetCtorName === "PDFDropdown") {
        // Dropdown options become the option-group labels with
        // a single shared bbox (the dropdown widget's rect) — we
        // don't have per-option geometry for a dropdown; the
        // parent rect IS the visible widget.
        try {
          const opts = (field as unknown as { getOptions(): string[] }).getOptions();
          options = opts.map((label) => ({
            label,
            bbox: { ...rect },
          }));
        } catch (err) {
          console.warn(
            `[acroFormIngest] field ${i} (${rawName}): dropdown getOptions() failed:`,
            err
          );
          continue;
        }
      }

      const label = def?.label ?? humaniseWidgetName(rawName);

      out.push({
        id: `acroform-${i}-${w}-${Date.now().toString(36)}`,
        label,
        mappedProjectKey: mappedKey,
        canonicalFieldId: canonicalId,
        pageNumber,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        confidence: 1.0,
        fieldType,
        fieldKind,
        detectionSource: "acroform",
        options,
        selectedOption: widgetKind === "option-group" ? null : undefined,
        promptLabel: mappedKey === "__prompt__" ? label : undefined,
        // For checkbox widgets: the on-value lets the renderer
        // know what to compare project value against. Pull it from
        // the widget if available; falls back to the canonical's
        // checkboxValue (Visa → "visa", etc.).
        checkboxValue:
          widgetKind === "checkbox"
            ? (() => {
                try {
                  const onName = widget.getOnValue();
                  if (onName) return onName.toString().replace(/^\//, "");
                } catch {
                  // ignore
                }
                return def?.checkboxValue;
              })()
            : undefined,
      });
      pageNumbers.add(pageNumber);
      acroformCount += 1;
    }
  }

  if (out.length === 0) {
    console.log("[acroFormIngest] All AcroForm fields skipped during mapping — falling through to Gemini.");
    return null;
  }

  console.log(
    `[acroFormIngest] Extracted ${out.length} TemplateField(s) from ${acroFields.length} AcroForm field(s) across ${pageNumbers.size} page(s).`
  );

  return {
    fields: out,
    pageNumbers,
    sourceCounts: { acroform: acroformCount },
  };
}
