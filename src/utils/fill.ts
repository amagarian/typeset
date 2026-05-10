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

export function getPromptFields(
  template: Template,
  project?: Project,
  promptValues: PromptFieldValues = {}
): TemplateField[] {
  // v0.5.26 — option-group fields behave like `checkbox-group` and
  // other auto-fillable kinds: they only show up in the fill prompt
  // when the project (and any prior prompt entry / template default)
  // can't supply a value. The selection precedence inside
  // `getOptionGroupSelection` (prompt → field default → project value)
  // remains authoritative; this just reflects "do we still need to
  // ask the user?" in the prompt list.
  //
  // v0.5.25 had `option-group` always-included, which forced
  // `FillPromptModal` to surface the card-type picker on every fill
  // even when `project.creditCardType` already pinned a brand. That
  // regressed the auto-fill experience for the common single-card
  // workflow. Multi-card flows still work fine — the project value
  // can be overridden in the prompt modal whenever the user opens it
  // (which happens automatically as soon as any other field needs
  // their attention).
  return template.fields.filter((field) => {
    if (field.mappedProjectKey === "__prompt__") return true;
    if (isOptionGroupField(field)) {
      // Only prompt when there's no resolvable selection yet. If
      // `project` isn't passed (legacy callers), fall back to the
      // v0.5.25 always-prompt behaviour so we don't silently skip a
      // genuinely-required option-group.
      if (!project) return true;
      return getOptionGroupSelection(project, field, promptValues) === "";
    }
    return false;
  });
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

/**
 * v0.6.7 — when a `billingAddress` widget is the ONLY billing-related
 * widget on the form (no separate City/State/Zip widgets to fill in
 * their own targets), compose the project's city/state/zip onto the
 * SAME line as the street so the Arrow CC Authorization-style
 * "address block on two underlines" pattern renders the full address
 * on the first writable line instead of fighting baseline alignment
 * across stacked underlines. The merged bbox can absorb the extra
 * length and the writer top-aligns it onto the first underline.
 *
 * Output shape: `123 Main St, Los Angeles, CA 90026`. Empty pieces
 * are skipped — no trailing commas / orphaned ZIPs.
 */
function composeFullAddress(value: string, project: Project): string {
  const trimmed = value.trim();
  const cityState = [project.billingCity, project.billingState]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0)
    .join(", ");
  const zip = (project.billingZipCode ?? "").trim();
  const cityStateZip = [cityState, zip].filter((s) => s.length > 0).join(" ");
  if (!cityStateZip) return trimmed;
  if (!trimmed) return cityStateZip;
  return `${trimmed}, ${cityStateZip}`;
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

  // v0.5.31 — `shootDate` is stored on the Project as an ISO date
  // string (YYYY-MM-DD) — the native `<input type="date">` value
  // contract. Form filling expects the MM/DD/YY shape used elsewhere
  // (matches `authorizationDate`'s default formatting and what the
  // renderer expects for date-typed fields). Empty values fall through
  // to the empty string so unfilled shoot-date blanks behave like any
  // other unmapped-but-empty field.
  if (key === "shootDate") {
    const iso = (project.shootDate ?? "").trim();
    return iso ? formatIsoDateForFill(iso) : "";
  }

  // v0.6.0 — clause-initials boxes. `Project.initials` is optional;
  // when empty, derive from the most relevant person-name field
  // available (cardholder → authorised signer → producer). Returns
  // empty string when no name is available.
  if (key === "initials") {
    const explicit = (project.initials ?? "").trim();
    if (explicit) return explicit.toUpperCase().slice(0, 4);
    const sourceName = (
      project.creditCardHolder ||
      project.authorizedSignerName ||
      project.producer ||
      ""
    ).trim();
    if (!sourceName) return "";
    const parts = sourceName.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "";
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return `${first}${last}`.toUpperCase();
  }

  const value = project[key];
  if (typeof value !== "string") return "";

  if (key === "billingAddress") {
    const hasSiblings =
      siblingMappedKeys?.has("billingCity") ||
      siblingMappedKeys?.has("billingState") ||
      siblingMappedKeys?.has("billingZipCode");
    if (hasSiblings && siblingMappedKeys) {
      return stripAddressParts(value, project, siblingMappedKeys);
    }
    return composeFullAddress(value, project);
  }

  return value;
}

/**
 * Convert an ISO date string (YYYY-MM-DD, the native `<input
 * type="date">` value contract) into the MM/DD/YY format used by the
 * form filler. Returns the original string verbatim when the input is
 * not a recognisable ISO date so legacy projects that stored dates in
 * a different shape still render something sensible.
 */
function formatIsoDateForFill(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, yyyy, mm, dd] = match;
  return `${mm}/${dd}/${yyyy.slice(-2)}`;
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

