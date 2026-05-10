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

function isCheckboxField(field: TemplateField): boolean {
  return (
    field.fieldType === "checkbox" ||
    field.fieldKind === "checkbox-group" ||
    field.fieldKind === "boolean-checkbox"
  );
}

function isSignatureField(field: TemplateField): boolean {
  return (
    field.mappedProjectKey === "cardholderSignature" ||
    field.fieldKind === "signature"
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
    if (!rawValue) continue;

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
    } else {
      let fontSize = defaultFontSize;
      if (field.estimatedFontSize) {
        fontSize = Math.max(7, Math.min(16, Math.round(field.estimatedFontSize * 1.5)));
      } else if (field.height > 0) {
        fontSize = Math.max(7, Math.min(12, Math.floor(field.height * 0.75)));
      }

      const value = fitTextToWidth(rawValue, field.width, font, fontSize);

      page.drawText(value, {
        x: x + 3,
        y: yPdfBottom + Math.max(4, (field.height - fontSize) / 2) + 2,
        size: fontSize,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }

  const bytes = await pdfDoc.save();
  return bytes;
}
