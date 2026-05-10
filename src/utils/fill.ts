import type { CreditCardType, Project, Template, TemplateField, TemplateMappedProjectKey } from "@/types";
import { CANONICAL_FIELD_DEFINITIONS } from "@/utils/fieldCatalog";

export type PromptFieldValues = Record<string, string>;

const CARD_TYPE_ALIASES: Record<string, CreditCardType> = {
  visa: "visa",
  mastercard: "mastercard",
  "master card": "mastercard",
  mc: "mastercard",
  discover: "discover",
  amex: "amex",
  "american express": "amex",
  americanexpress: "amex",
};

export function normalizeCardType(value: string): CreditCardType | "" {
  if (!value) return "";
  const key = value.trim().toLowerCase();
  return CARD_TYPE_ALIASES[key] ?? "";
}

export interface FilledField {
  fieldId: string;
  label: string;
  mappedProjectKey: TemplateMappedProjectKey;
  value: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export function getTemplateFieldPromptLabel(field: TemplateField): string {
  return field.promptLabel?.trim() || field.label || "Prompt value";
}

export function getPromptFields(template: Template): TemplateField[] {
  // v0.5.25 — option-group fields ALWAYS appear in the fill prompt
  // (regardless of their `mappedProjectKey`). Users want to pick the
  // card type per-fill rather than relying solely on the project's
  // stored `creditCardType`, especially on multi-card workflows where
  // the same project signs multiple authorisations on different
  // brands. The prompt UI seeds the picker from the project value
  // (via `getOptionGroupSelection`) so the typical case stays
  // single-click.
  return template.fields.filter(
    (field) =>
      field.mappedProjectKey === "__prompt__" || isOptionGroupField(field)
  );
}

/**
 * v0.5.25 — option-group field check shared between pdfWriter and the
 * UI. Branches on either `fieldType` or `fieldKind` so legacy
 * templates that only set one of the two still classify correctly.
 */
export function isOptionGroupField(field: TemplateField): boolean {
  return (
    field.fieldType === "option-group" || field.fieldKind === "option-group"
  );
}

/**
 * v0.5.25 — resolve the label of the currently-selected option for
 * an `option-group` field. Resolution order:
 *   1. Explicit prompt value submitted from `FillPromptModal` (the
 *      user just picked one).
 *   2. The field's own `selectedOption` (a default chosen at
 *      template-edit time, or persisted from a prior fill).
 *   3. For `cardType` canonicals: project's `creditCardType` value
 *      (collapsed via `normalizeCardType` to the canonical four
 *      brand keys), then mapped back to the matching option's label
 *      (case-insensitive synonym match).
 *   4. Empty string (no oval drawn).
 */
export function getOptionGroupSelection(
  project: Project,
  field: TemplateField,
  promptValues: PromptFieldValues = {}
): string {
  const fromPrompt = promptValues[field.id]?.trim();
  if (fromPrompt) return fromPrompt;
  const fromField = field.selectedOption?.trim();
  if (fromField) return fromField;
  if (field.canonicalFieldId === "cardType") {
    const normalised = normalizeCardType(project.creditCardType);
    if (!normalised) return "";
    if (normalised === "visa") return "Visa";
    if (normalised === "mastercard") return "MasterCard";
    if (normalised === "amex") return "AMEX";
    if (normalised === "discover") return "Discover";
  }
  return "";
}

/**
 * Repairs template fields whose mappedProjectKey is missing or empty by
 * looking up their canonicalFieldId in the field catalog. This ensures
 * templates saved before new catalog entries were added still fill correctly.
 * Also matches by label as a fallback for fields that were never assigned a
 * canonicalFieldId.
 */
export function repairTemplateMappings(template: Template): Template {
  let changed = false;
  const repairedFields = template.fields.map((f) => {
    if (f.mappedProjectKey) return f;

    let def = f.canonicalFieldId
      ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === f.canonicalFieldId)
      : undefined;

    if (!def && f.label) {
      const lbl = f.label.toLowerCase().trim();
      def = CANONICAL_FIELD_DEFINITIONS.find(
        (d) =>
          d.label.toLowerCase() === lbl ||
          d.aliases.some((a) => a.toLowerCase() === lbl)
      );
    }

    if (def?.mappedProjectKey) {
      changed = true;
      return {
        ...f,
        mappedProjectKey: def.mappedProjectKey as TemplateMappedProjectKey,
        canonicalFieldId: def.id,
      };
    }
    return f;
  });
  if (!changed) return template;
  return { ...template, fields: repairedFields };
}

/**
 * Strips city, state, and/or zip from a billing address string when the
 * template has separate fields for those values.
 */
function stripAddressParts(
  address: string,
  project: Project,
  siblingKeys: Set<string>
): string {
  let result = address;

  const parts: { key: string; value: string }[] = [
    { key: "billingZipCode", value: project.billingZipCode },
    { key: "billingState", value: project.billingState },
    { key: "billingCity", value: project.billingCity },
  ];

  for (const { key, value } of parts) {
    if (!siblingKeys.has(key) || !value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(",?\\s*" + escaped, "gi"), "");
  }

  return result.replace(/[,\s]+$/, "").trim();
}

export function getTemplateFieldValue(
  project: Project,
  field: TemplateField,
  promptValues: PromptFieldValues = {},
  siblingMappedKeys?: Set<string>
): string {
  const key = field.mappedProjectKey;
  if (key === "__custom__") {
    return field.customValue?.trim() ?? "";
  }
  if (key === "__prompt__") {
    return promptValues[field.id]?.trim() ?? "";
  }
  if (!key) {
    return "";
  }

  if (key === "authorizationDate") {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const yy = String(now.getFullYear()).slice(-2);
    return `${mm}/${dd}/${yy}`;
  }

  const value = project[key];
  if (typeof value !== "string") return "";

  if (key === "billingAddress" && siblingMappedKeys) {
    return stripAddressParts(value, project, siblingMappedKeys);
  }

  return value;
}

export function buildFilledFields(
  project: Project,
  template: Template,
  promptValues: PromptFieldValues = {}
): FilledField[] {
  const repaired = repairTemplateMappings(template);
  const siblingKeys = new Set(
    repaired.fields.map((f) => f.mappedProjectKey).filter(Boolean)
  );
  return repaired.fields.map((f) => {
    const value = getTemplateFieldValue(project, f, promptValues, siblingKeys);
    return {
      fieldId: f.id,
      label: f.label,
      mappedProjectKey: f.mappedProjectKey,
      value,
      pageNumber: f.pageNumber,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      confidence: f.confidence,
    };
  });
}

