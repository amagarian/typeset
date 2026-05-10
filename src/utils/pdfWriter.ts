import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Project, Template, TemplateField } from "@/types";
import {
  getOptionGroupSelection,
  getTemplateFieldValue,
  normalizeCardType,
  repairTemplateMappings,
  type PromptFieldValues,
} from "@/utils/fill";
import { normalizeCardTypeLabel } from "@/utils/fieldCatalog";

import { trimSignatureDataUrl } from "@/utils/signatureImageTrim";

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
const LABEL_PREFIX_CANONICAL_IDS = new Set([
  "creditCardHolder",
  "billingAddress",
  "ccv",
  "cardholderSignature",
  "creditCardNumber",
  "phone",
  "email",
  "authorizationDate",
  "cardType",
]);

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
  const canonicalMatch =
    typeof field.canonicalFieldId === "string" &&
    LABEL_PREFIX_CANONICAL_IDS.has(field.canonicalFieldId);

  // PATH A requires width ≥ 100pt; PATH B requires width ≥ 150pt
  // (canonical-only paths are riskier, so we demand a wider bbox to
  // reduce the chance of shifting a genuinely post-colon writable
  // area). If neither gate is satisfied, no shift.
  const widthOk =
    (endsWithColon && field.width >= 100) ||
    (canonicalMatch && field.width >= 150);
  if (!widthOk) return 0;

  const ctx = (field.contextBefore ?? "").trim().toLowerCase();
  if (ctx.length > 0) {
    const stem = printed
      .toLowerCase()
      .replace(/[:：]\s*$/, "")
      .trim();
    if (stem.length >= 4) {
      const probe = stem.slice(0, Math.min(stem.length, 16));
      if (ctx.includes(probe)) return 0;
    }
  }

  const measureLabel = endsWithColon ? printed : `${printed}:`;
  const labelWidth = font.widthOfTextAtSize(measureLabel, fontSize);
  const shift = labelWidth + 4;
  const ceiling = field.width * 0.6;
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
  const maxWidth = Math.max(0, width - 6);
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

export async function writeFilledPdfBytes(
  sourcePdfBytes: Uint8Array,
  template: Template,
  project: Project,
  options: WritePdfOptions = {}
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourcePdfBytes);

  // Flatten existing AcroForm fields so they don't cover our drawn text.
  // Interactive widgets render on top of page content in PDF viewers,
  // so we must remove them before writing.
  try {
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    if (fields.length > 0) {
      console.log(`[pdfWriter] Flattening ${fields.length} existing AcroForm fields`);
      form.flatten();
    }
  } catch {
    // No form or form access failed — safe to continue
  }

  const pages = pdfDoc.getPages();
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

      const prefixShift = computePrefixLabelShiftX(field, font, probeFontSize);
      const insetX = Math.max(baseInsetX, prefixShift > 0 ? prefixShift : 0);

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
        const usableWidth = Math.max(8, field.width - insetX - 3);

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

      const usableWidth = Math.max(8, field.width - insetX - 3);
      const { text: value, fontSize: actualFontSize } = fitWithShrink(
        rawValue,
        usableWidth,
        font,
        baseFontSize
      );

      page.drawText(value, {
        x: x + insetX,
        y: yPdfBottom + Math.max(4, (field.height - actualFontSize) / 2) + 2,
        size: actualFontSize,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }

  const bytes = await pdfDoc.save();
  return bytes;
}
