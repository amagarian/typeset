import type { CanonicalFieldId, Project, TemplateFieldKind } from "@/types";

export interface CanonicalFieldDefinition {
  id: CanonicalFieldId;
  label: string;
  mappedProjectKey: keyof Project | "";
  fieldKind: TemplateFieldKind;
  aliases: string[];
  sectionHints: string[];
  checkboxValue?: string;
  groupId?: string;
  multiline?: boolean;
  allowDuplicates?: boolean;
  /**
   * For `option-group` canonicals (v0.5.25): the canonical option set
   * the renderer/UI defaults to. The actual per-option bboxes ship on
   * the detected `TemplateField` (see {@link TemplateField.options}),
   * but the canonical option set lets the alias-matcher recognise a
   * row of mutually-exclusive labels even when the model emits them
   * as separate fields and we need to stitch them back together.
   */
  optionSet?: string[];
  /**
   * v0.5.31 — context-level regex patterns used by the canonical
   * inference preflight when the field's printed label is too generic
   * to disambiguate (e.g. a bare `Date` blank embedded mid-sentence).
   * Aliases are matched against the field's label string, while
   * `patterns` are matched against the broader sentence haystack
   * (`context_before` + `context_after` + `label`). This is what lets
   * `shootDate` win over the generic-date fallback when a row reads
   * "for my booking at Beam Studios on _____ (date)" — the "for my
   * booking" pattern fires even though the inferred label is just
   * "Date". Patterns are case-insensitive by convention.
   */
  patterns?: RegExp[];
}

/**
 * Canonical option labels for `cardType` (v0.5.25). The first match
 * wins when normalising detected labels — e.g. `Mastercard`,
 * `MASTERCARD`, `master card`, and `MC` all collapse to `MasterCard`.
 * `Other` is a special "user-typed continuation" option; the form's
 * `Other:___` line is detected as a separate text field via the
 * existing pipeline.
 */
export const CARD_TYPE_OPTION_SET: ReadonlyArray<string> = [
  "Visa",
  "MasterCard",
  "AMEX",
  "Discover",
  "Other",
];

/**
 * Synonym set for card-type label matching (case-insensitive). Used by
 * both the option-group merge pass (Gemini sometimes splits the row
 * into separate text fields) and by `inferCanonicalId`'s preflight
 * check that promotes any option-group whose options match the
 * card-type pattern to canonical `cardType`.
 */
export const CARD_TYPE_LABEL_SYNONYMS: Record<string, string> = {
  visa: "Visa",
  mastercard: "MasterCard",
  "master card": "MasterCard",
  mc: "MasterCard",
  amex: "AMEX",
  "american express": "AMEX",
  americanexpress: "AMEX",
  discover: "Discover",
  "discover card": "Discover",
  other: "Other",
};

/**
 * Normalise a detected option label into its canonical form, or
 * `undefined` if it is not a recognised card-type label. Used by the
 * card-type detector to decide whether a row of horizontal labels
 * really IS a card-type selector vs an unrelated horizontal list.
 */
export function normalizeCardTypeLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase().replace(/[^a-z\s]/g, "");
  if (!key) return undefined;
  if (CARD_TYPE_LABEL_SYNONYMS[key]) return CARD_TYPE_LABEL_SYNONYMS[key];
  const collapsed = key.replace(/\s+/g, " ");
  if (CARD_TYPE_LABEL_SYNONYMS[collapsed]) return CARD_TYPE_LABEL_SYNONYMS[collapsed];
  const compact = key.replace(/\s+/g, "");
  if (CARD_TYPE_LABEL_SYNONYMS[compact]) return CARD_TYPE_LABEL_SYNONYMS[compact];
  return undefined;
}

export const CANONICAL_FIELD_DEFINITIONS: CanonicalFieldDefinition[] = [
  {
    id: "projectLabel",
    label: "Project label",
    mappedProjectKey: "label",
    fieldKind: "text",
    aliases: ["project label", "show title", "show label"],
    sectionHints: ["header", "job"],
  },
  {
    id: "jobName",
    label: "Job Name",
    mappedProjectKey: "jobName",
    fieldKind: "text",
    aliases: ["job name", "project name", "show name"],
    sectionHints: ["job", "header"],
  },
  {
    id: "jobNumber",
    label: "Job No.",
    mappedProjectKey: "jobNumber",
    fieldKind: "text",
    aliases: ["job no", "job number", "job #"],
    sectionHints: ["job", "header"],
  },
  {
    id: "poNumber",
    label: "PO No.",
    mappedProjectKey: "poNumber",
    fieldKind: "text",
    aliases: ["po no", "po number", "po #", "purchase order", "order #", "order no", "order number", "order#"],
    sectionHints: ["job", "billing"],
  },
  {
    id: "authorizationDate",
    label: "Date",
    mappedProjectKey: "authorizationDate",
    fieldKind: "date",
    aliases: ["authorization date", "auth date"],
    sectionHints: ["authorization", "signature", "footer"],
  },
  // v0.5.31 — shoot/booking date canonical. Distinct from
  // `authorizationDate` (which is "the date the user signs the form",
  // typically today) — `shootDate` represents the future event the
  // form is being executed FOR (booking, shoot, rental period, etc.).
  // Forms in this corpus frequently carry both contexts (e.g. the
  // Beam Studios CC AUTH_Deposit and Rental form has an inline
  // "for my booking at Beam Studios on _____ (date)" sentence AND a
  // standalone "Date:" line by the cardholder signature). Without
  // this canonical, the post-processor would conflate both dates onto
  // `authorizationDate` and the form would auto-fill "today" into the
  // booking blank too — wrong.
  //
  // `aliases` are matched against the field's label string; `patterns`
  // run against the broader sentence haystack and are how we recover
  // shootDate from inline-sentence blanks where Gemini sees only a
  // bare "Date" caption next to the underline. The Pass-1 prompt
  // (v0.5.31 date-disambiguation rule) instructs Gemini to emit
  // booking-context labels like "Shoot Date" / "Booking Date" /
  // "Rental Date" directly, but the patterns are the safety net.
  {
    id: "shootDate",
    label: "Shoot Date",
    mappedProjectKey: "shootDate",
    fieldKind: "date",
    aliases: [
      "shoot date",
      "booking date",
      "event date",
      "session date",
      "rental date",
      "production date",
      "wrap date",
      "shoot day",
      "service date",
    ],
    sectionHints: ["booking", "rental", "shoot", "header"],
    patterns: [
      // Possessive / definite-article phrasings — covers the most
      // common inline-sentence shapes the corpus throws at us:
      //   "for my booking at Beam Studios", "from my booking at",
      //   "during the rental", "before the shoot", "after our event".
      // The leading-prep variant is bundled into the same class so
      // phrasings like "for my booking ..." and "from my booking ..."
      // both fire even though only the latter happens to appear in
      // the v0.5.31 reference form.
      /\b(?:my|our|the)\s+(?:booking|shoot|rental|event|session|production|service|wrap)\b/i,
      /\bfor\s+(?:my|our|the)\s+(?:booking|shoot|rental|event|session|production|service|wrap)\b/i,
      /\brental\s+period\b/i,
      /\b(?:shoot|booking|event|rental|session|production|service|wrap)\s+(?:date|day)\b/i,
      /\bdate\s+of\s+(?:shoot|booking|event|rental|session|production|service|the\s+(?:shoot|booking|event|rental|session|production|service))\b/i,
    ],
  },
  {
    id: "productionCompany",
    label: "Production Company",
    mappedProjectKey: "productionCompany",
    fieldKind: "text",
    aliases: [
      "production company",
      "company / contact",
      "name of company",
      "business",
      "company name",
      "production co",
      "prod co",
    ],
    sectionHints: ["billing", "contact", "header"],
  },
  {
    id: "billingAddress",
    label: "Billing Address",
    mappedProjectKey: "billingAddress",
    fieldKind: "multiline",
    aliases: [
      "billing address",
      "billing address of card holder",
      "company address",
      "credit card billing address",
      "mailing address",
      "remit to",
      "address",
    ],
    sectionHints: ["billing", "payment", "contact"],
    multiline: true,
  },
  {
    id: "billingCity",
    label: "City",
    mappedProjectKey: "billingCity",
    fieldKind: "text",
    aliases: ["city", "billing city"],
    sectionHints: ["billing", "payment", "contact"],
  },
  {
    id: "billingState",
    label: "State",
    mappedProjectKey: "billingState",
    fieldKind: "text",
    aliases: ["state", "billing state", "st"],
    sectionHints: ["billing", "payment", "contact"],
  },
  {
    id: "billingZipCode",
    label: "Zip Code",
    mappedProjectKey: "billingZipCode",
    fieldKind: "text",
    aliases: ["zip", "zip code", "postal code", "billing zip", "billing postal code"],
    sectionHints: ["billing", "payment", "contact"],
  },
  {
    id: "producer",
    label: "Producer",
    mappedProjectKey: "producer",
    fieldKind: "text",
    aliases: ["producer", "production coordinator", "upm", "authorized by", "contact name"],
    sectionHints: ["contact", "authorization"],
  },
  {
    id: "email",
    label: "Email",
    mappedProjectKey: "email",
    fieldKind: "text",
    aliases: ["email", "email address", "e-mail"],
    sectionHints: ["contact", "billing"],
  },
  {
    id: "phone",
    label: "Phone",
    mappedProjectKey: "phone",
    fieldKind: "text",
    aliases: ["phone", "phone #", "phone number", "phone numbers", "telephone", "telephone #", "mobile", "cell"],
    sectionHints: ["contact", "billing"],
  },
  {
    id: "creditCardHolder",
    label: "Cardholder Name",
    mappedProjectKey: "creditCardHolder",
    fieldKind: "text",
    aliases: [
      "card holder",
      "name of cardholder",
      "cardholder name",
      "cardholder name as shown on card",
      "name on card",
      "customer name",
    ],
    sectionHints: ["payment", "authorization"],
  },
  {
    id: "cardholderSignature",
    label: "Signature",
    mappedProjectKey: "cardholderSignature",
    fieldKind: "signature",
    aliases: [
      "signature of cardholder",
      "cardholder signature",
      "customer signature",
      "authorized signature",
      "signature",
    ],
    sectionHints: ["signature", "authorization", "footer"],
    allowDuplicates: true,
  },
  {
    id: "creditCardNumber",
    label: "Credit Card Number",
    mappedProjectKey: "creditCardNumber",
    fieldKind: "text",
    aliases: [
      "credit card number",
      "credit card #",
      "card number",
      "cc number",
      "cc #",
      "cc#",
      "account number",
    ],
    sectionHints: ["payment", "billing"],
  },
  {
    id: "expDate",
    label: "Expiration Date",
    mappedProjectKey: "expDate",
    fieldKind: "date",
    aliases: [
      "expiration date",
      "exp date",
      "exp.",
      "expiry",
      "expiration",
      "mm/yy",
      "mm yy",
    ],
    sectionHints: ["payment", "billing"],
  },
  {
    id: "ccv",
    label: "Security Code",
    mappedProjectKey: "ccv",
    fieldKind: "text",
    aliases: [
      "security code",
      "verification code",
      "card identification number",
      "card identification",
      "cvv2",
      "cvv",
      "cvc2",
      "cvc",
      "cid",
      "ccv",
      "3 digit",
      "3-digit",
      "three digit",
      "4 digits on front",
      "card verification",
    ],
    sectionHints: ["payment", "billing"],
  },
  {
    id: "creditCardTypeVisa",
    label: "VISA",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["visa"],
    checkboxValue: "visa",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
  {
    id: "creditCardTypeMastercard",
    label: "MasterCard",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["mastercard", "master card", "mc"],
    checkboxValue: "mastercard",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
  {
    id: "creditCardTypeDiscover",
    label: "Discover",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["discover"],
    checkboxValue: "discover",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
  {
    id: "creditCardTypeAmex",
    label: "AMEX",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["amex", "american express"],
    checkboxValue: "amex",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
  // v0.5.25 — option-group form of the card-type selector. Used on
  // forms that render the selector as a horizontal list of labels
  // with NO drawn checkboxes/circles (industry-standard credit-card
  // UX where the user circles the chosen option). The Arrow CC
  // Authorization form is the canonical example: a single row reads
  // `Card Type: Visa  MasterCard  AMEX  Discover  Other:___`. The
  // Other:___ portion is a separate text field; the rest is one
  // option-group field.
  //
  // Coexists with the four `creditCardType*` checkbox canonicals
  // above for backward compat with forms that DO draw checkboxes
  // beside each label. The detector picks the right shape based on
  // visual evidence: if drawn checkboxes are present, Gemini emits
  // four `creditCardType*` checkbox-group fields; if no checkboxes
  // are drawn, Gemini emits a single `option-group` field with an
  // `options` array, which `inferCanonicalId`'s preflight promotes
  // to this canonical.
  {
    id: "cardType",
    label: "Card Type",
    mappedProjectKey: "creditCardType",
    fieldKind: "option-group",
    aliases: [
      "card type",
      "type of card",
      "credit card type",
      "card brand",
      "payment method",
    ],
    sectionHints: ["payment", "card-type"],
    optionSet: [...CARD_TYPE_OPTION_SET],
  },
];

export const CANONICAL_FIELD_BY_ID: Record<CanonicalFieldId, CanonicalFieldDefinition> =
  Object.fromEntries(CANONICAL_FIELD_DEFINITIONS.map((field) => [field.id, field])) as Record<
    CanonicalFieldId,
    CanonicalFieldDefinition
  >;

export function getCanonicalFieldDefinition(
  id: CanonicalFieldId
): CanonicalFieldDefinition | undefined {
  return CANONICAL_FIELD_BY_ID[id];
}
