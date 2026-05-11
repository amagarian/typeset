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
      // v0.6.17 — bare "Company:" cell label (e.g. the Keslow CC Auth
      // header grid's row 2 left cell). Without this alias, Gemini
      // either resolved the cell to no canonical OR (worse) labelled
      // it with the neighbor cell's printed text ("Invoice #") and
      // we had no way to recover the mapping.
      "company",
    ],
    sectionHints: ["billing", "contact", "header"],
  },
  {
    // v0.6.3 — dropped the bare `"address"` alias. It was matching as a
    // word-boundary substring inside labels like `Address Line 2`,
    // `Address (City, State, Zip)`, etc., which collapsed multiple
    // distinct widgets onto `billingAddress`. Every one of them then
    // rendered `project.billingAddress` (just the street), producing
    // the "first line of address repeated on every line" symptom on
    // the Arrow CC Authorization form. Real billing-address labels
    // almost always carry a qualifier (`Billing`, `Mailing`, `Company`,
    // `Remit To`); the rare bare-`Address` case can be re-mapped from
    // the template editor.
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
    // NOTE: v0.6.0 added a label-only `Tel` / `Tel.` / `Tel:`
    // preflight in `geminiFieldDetector.ts:inferByLabel` — those
    // tokens are NOT in the alias array because the global alias
    // index is also consulted by `inferCanonicalId` against the
    // surrounding-context haystack, where a 3-char `tel`
    // substring would hijack words like "hotel" / "intel". The
    // preflight matches the EXACT bare-`Tel` captions found on
    // 204 New Account, FNJ-GEO, and similar credit-app forms.
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

  // -----------------------------------------------------------------
  // v0.6.0 — corpus-driven canonicals. Grouped roughly by section
  // (business, signers, banking/shipping, rental, vehicle/insurance,
  // production, accounting, address, initials).
  //
  // Aliases are kept short and unambiguous to keep the substring
  // matcher in `inferCanonicalId` from hijacking unrelated context.
  // Where a label is genuinely short (`DBA`, `EIN`, `VIN`), the
  // 3-char minimum gate in `inferByLabel` / `inferCanonicalId` still
  // applies — `dba` and `ein` clear it, `dl` (driver licence) does
  // not and lives only as a longer alias (`dl #`, `driver license`).
  // -----------------------------------------------------------------

  {
    id: "federalTaxId",
    label: "Federal Tax ID",
    mappedProjectKey: "federalTaxId",
    fieldKind: "text",
    aliases: ["federal tax id", "federal id", "tax id", "ein", "fein", "tin", "federal id #", "federal employer id"],
    sectionHints: ["business", "header"],
  },
  {
    id: "dunsNumber",
    label: "DUNS Number",
    mappedProjectKey: "dunsNumber",
    fieldKind: "text",
    aliases: ["duns", "duns number", "duns #", "d-u-n-s", "d.u.n.s."],
    sectionHints: ["business"],
  },
  {
    id: "dbaName",
    label: "DBA Name",
    mappedProjectKey: "dbaName",
    fieldKind: "text",
    aliases: ["dba", "d/b/a", "doing business as", "dba name"],
    sectionHints: ["business"],
  },
  {
    id: "parentCompany",
    label: "Parent Company",
    mappedProjectKey: "parentCompany",
    fieldKind: "text",
    aliases: ["parent company", "parent corporation"],
    sectionHints: ["business"],
  },
  {
    id: "yearsInBusiness",
    label: "Years in Business",
    mappedProjectKey: "yearsInBusiness",
    fieldKind: "text",
    aliases: ["years in business", "years business"],
    sectionHints: ["business"],
  },
  {
    id: "dateBusinessStarted",
    label: "Date Business Started",
    mappedProjectKey: "dateBusinessStarted",
    fieldKind: "date",
    aliases: ["date business started", "business start date", "date started"],
    sectionHints: ["business"],
  },
  {
    id: "dateIncorporated",
    label: "Date Incorporated",
    mappedProjectKey: "dateIncorporated",
    fieldKind: "date",
    aliases: ["date incorporated", "date of incorporation", "incorporation date"],
    sectionHints: ["business"],
  },
  {
    id: "resaleTaxCertificate",
    label: "Resale Tax Certificate",
    mappedProjectKey: "resaleTaxCertificate",
    fieldKind: "text",
    aliases: ["resale tax certificate", "resale cert", "resale certificate", "resale #", "resale number"],
    sectionHints: ["business"],
  },

  // Authorized signers (officer-level, distinct from cardholders)
  {
    id: "authorizedSignerName",
    label: "Authorized Signer",
    mappedProjectKey: "authorizedSignerName",
    fieldKind: "text",
    aliases: [
      "authorized signer",
      "authorized signer name",
      "authorized signature name",
      "officer name",
      "company officer",
      "officer's name",
      "print name (officer)",
    ],
    sectionHints: ["signature", "authorization", "signer"],
  },
  {
    id: "authorizedSignerTitle",
    label: "Signer Title",
    mappedProjectKey: "authorizedSignerTitle",
    fieldKind: "text",
    aliases: [
      "authorized signer title",
      "officer title",
      "signer title",
      "title (officer)",
      "title of signer",
      "company officer title",
    ],
    sectionHints: ["signature", "authorization", "signer"],
  },
  {
    id: "secondAuthorizedSignerName",
    label: "Second Authorized Signer",
    mappedProjectKey: "secondAuthorizedSignerName",
    fieldKind: "text",
    aliases: [
      "second authorized signer",
      "second signer",
      "co-signer name",
      "co-signer",
      "secondary signer",
    ],
    sectionHints: ["signature", "authorization", "signer"],
    allowDuplicates: true,
  },
  {
    id: "secondAuthorizedSignerTitle",
    label: "Second Signer Title",
    mappedProjectKey: "secondAuthorizedSignerTitle",
    fieldKind: "text",
    aliases: ["second signer title", "co-signer title", "secondary signer title"],
    sectionHints: ["signature", "authorization", "signer"],
    allowDuplicates: true,
  },

  // Banking + shipping account numbers
  {
    id: "bankName",
    label: "Bank Name",
    mappedProjectKey: "bankName",
    fieldKind: "text",
    aliases: ["bank name", "name of bank", "bank"],
    sectionHints: ["banking", "credit"],
  },
  {
    id: "bankRoutingNumber",
    label: "Bank Routing #",
    mappedProjectKey: "bankRoutingNumber",
    fieldKind: "text",
    aliases: ["routing", "routing number", "routing #", "aba", "aba routing", "aba number"],
    sectionHints: ["banking", "credit"],
  },
  {
    id: "bankAccountNumber",
    label: "Bank Account #",
    mappedProjectKey: "bankAccountNumber",
    fieldKind: "text",
    // NOTE: deliberately NOT aliasing bare `account number` / `account #` —
    // those collide with `creditCardNumber` aliases. The matcher
    // resolves "bank account number" via substring, but standalone
    // "account number" stays with `creditCardNumber` to preserve
    // v0.5.x CC-form behaviour. Banking rows that read "Bank Acct #" /
    // "Bank Account No." are caught by the explicit aliases below.
    aliases: ["bank account", "bank account number", "bank account no", "bank account #", "bank acct", "bank acct #", "bank acct number"],
    sectionHints: ["banking", "credit"],
  },
  {
    id: "fedExAccountNumber",
    label: "FedEx Account #",
    mappedProjectKey: "fedExAccountNumber",
    fieldKind: "text",
    aliases: ["fedex account", "fedex account number", "fedex #", "fedex account #", "federal express account"],
    sectionHints: ["shipping"],
  },
  {
    id: "upsAccountNumber",
    label: "UPS Account #",
    mappedProjectKey: "upsAccountNumber",
    fieldKind: "text",
    aliases: ["ups account", "ups account number", "ups #", "ups account #"],
    sectionHints: ["shipping"],
  },

  // Rental period
  {
    id: "rentalStartDate",
    label: "Rental Start Date",
    mappedProjectKey: "rentalStartDate",
    fieldKind: "date",
    aliases: ["start date", "rental start", "pickup date", "pick-up date", "begin date", "rental begin"],
    sectionHints: ["rental", "schedule"],
    patterns: [/\brental\s+(?:start|period\s+begin)\b/i, /\bpick(?:[-\s]?up)\s+date\b/i],
  },
  {
    id: "rentalEndDate",
    label: "Rental End Date",
    mappedProjectKey: "rentalEndDate",
    fieldKind: "date",
    aliases: ["end date", "rental end", "return date", "drop off date", "drop-off date", "rental return"],
    sectionHints: ["rental", "schedule"],
    patterns: [/\brental\s+(?:end|period\s+end|return)\b/i, /\bdrop[-\s]?off\s+date\b/i],
  },

  // Studio Contract — rate + hours
  {
    id: "hourlyRateBuild",
    label: "Build Rate",
    mappedProjectKey: "hourlyRateBuild",
    fieldKind: "text",
    aliases: ["build rate", "build hourly rate", "shop rate", "build rate/hr", "build $/hr"],
    sectionHints: ["rate", "schedule"],
  },
  {
    id: "hourlyRateShoot",
    label: "Shoot Rate",
    mappedProjectKey: "hourlyRateShoot",
    fieldKind: "text",
    aliases: ["shoot rate", "shoot hourly rate", "shoot rate/hr", "shoot $/hr"],
    sectionHints: ["rate", "schedule"],
  },
  {
    id: "hoursBuild",
    label: "Build Hours",
    mappedProjectKey: "hoursBuild",
    fieldKind: "text",
    aliases: ["build hours", "build hr", "build hrs"],
    sectionHints: ["schedule"],
  },
  {
    id: "hoursShoot",
    label: "Shoot Hours",
    mappedProjectKey: "hoursShoot",
    fieldKind: "text",
    aliases: ["shoot hours", "shoot hr", "shoot hrs"],
    sectionHints: ["schedule"],
  },

  // Vehicle / DL fields
  {
    id: "driverLicenseNumber",
    label: "Driver Licence #",
    mappedProjectKey: "driverLicenseNumber",
    fieldKind: "text",
    aliases: ["driver license", "driver license number", "driver license #", "driver's license", "driver's license number", "dl #", "dl number", "drivers license"],
    sectionHints: ["vehicle", "credit"],
  },
  {
    id: "vehicleVin",
    label: "Vehicle VIN",
    mappedProjectKey: "vehicleVin",
    fieldKind: "text",
    aliases: ["vin", "vin #", "vehicle identification number", "vehicle vin"],
    sectionHints: ["vehicle"],
  },
  {
    id: "vehiclePlate",
    label: "Vehicle Plate",
    mappedProjectKey: "vehiclePlate",
    fieldKind: "text",
    aliases: ["plate", "plate #", "license plate", "license plate #", "tag #", "tag number"],
    sectionHints: ["vehicle"],
  },
  {
    id: "insuranceCarrier",
    label: "Insurance Carrier",
    mappedProjectKey: "insuranceCarrier",
    fieldKind: "text",
    aliases: ["insurance carrier", "insurance company", "insurer"],
    sectionHints: ["vehicle", "insurance"],
  },
  {
    id: "insurancePolicyNumber",
    label: "Insurance Policy #",
    mappedProjectKey: "insurancePolicyNumber",
    fieldKind: "text",
    aliases: ["policy number", "policy #", "insurance policy", "insurance policy number", "insurance policy #"],
    sectionHints: ["vehicle", "insurance"],
  },

  // Other accounting / invoicing
  {
    id: "invoiceNumber",
    label: "Invoice #",
    mappedProjectKey: "invoiceNumber",
    fieldKind: "text",
    aliases: ["invoice", "invoice number", "invoice #", "inv #", "inv number"],
    sectionHints: ["billing", "header"],
  },
  {
    id: "accountingContactName",
    label: "Accounting Contact",
    mappedProjectKey: "accountingContactName",
    fieldKind: "text",
    aliases: ["accounting contact", "accounting contact name", "accounts payable contact", "ap contact"],
    sectionHints: ["billing", "contact"],
  },
  {
    id: "accountingEmail",
    label: "Accounting Email",
    mappedProjectKey: "accountingEmail",
    fieldKind: "text",
    aliases: ["accounting email", "ap email", "accounts payable email"],
    sectionHints: ["billing", "contact"],
  },

  // Address variants — distinct from `billingAddress`
  {
    id: "streetAddress",
    label: "Street Address",
    mappedProjectKey: "streetAddress",
    fieldKind: "text",
    aliases: ["street address", "street", "physical address"],
    sectionHints: ["contact", "billing"],
  },
  {
    id: "deliveryAddress",
    label: "Delivery Address",
    mappedProjectKey: "deliveryAddress",
    fieldKind: "multiline",
    aliases: ["delivery address", "ship to", "ship-to address", "shipping address", "deliver to"],
    sectionHints: ["shipping"],
    multiline: true,
  },

  // Production metadata (ISS Acro)
  {
    id: "showName",
    label: "Show Name",
    mappedProjectKey: "showName",
    fieldKind: "text",
    aliases: ["show name", "show title", "series name", "series title", "production title"],
    sectionHints: ["job", "header"],
  },
  {
    id: "seasonNumber",
    label: "Season #",
    mappedProjectKey: "seasonNumber",
    fieldKind: "text",
    aliases: ["season", "season number", "season #"],
    sectionHints: ["job"],
  },
  {
    id: "productionClassification",
    label: "Production Type",
    mappedProjectKey: "productionClassification",
    fieldKind: "text",
    aliases: [
      "production classification",
      "classification of show",
      "classification of production",
      "type of production",
      "production type",
    ],
    sectionHints: ["job"],
  },

  // Per-clause initial boxes (Studio Contract, long rentals).
  // `mappedProjectKey: "initials"` — the form filler reads
  // `Project.initials` (or auto-derives from name when empty).
  // Multiple boxes per page are legitimate, so allow duplicates.
  {
    id: "clauseInitials",
    label: "Initials",
    mappedProjectKey: "initials",
    fieldKind: "text",
    aliases: ["initials", "initial", "renter initials", "client initials", "204 initials"],
    sectionHints: ["initials", "clause"],
    allowDuplicates: true,
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
