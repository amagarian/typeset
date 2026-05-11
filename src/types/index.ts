/**
 * Typeset type definitions.
 * Local-only template architecture (Gemini detection + local fingerprint matching).
 */

export type CreditCardType = "visa" | "mastercard" | "discover" | "amex" | "";
export type TemplateMappedProjectKey = keyof Project | "__custom__" | "__prompt__" | "";
export type CanonicalFieldId =
  | "projectLabel"
  | "jobName"
  | "jobNumber"
  | "poNumber"
  | "authorizationDate"
  | "shootDate"
  | "productionCompany"
  | "billingAddress"
  | "billingCity"
  | "billingState"
  | "billingZipCode"
  | "producer"
  | "email"
  | "phone"
  | "creditCardTypeVisa"
  | "creditCardTypeMastercard"
  | "creditCardTypeDiscover"
  | "creditCardTypeAmex"
  | "cardType"
  | "creditCardHolder"
  | "cardholderSignature"
  | "creditCardNumber"
  | "expDate"
  | "ccv"
  // v0.6.0 — corpus-driven canonicals (32-form analysis). Each maps
  // to a new optional field on `Project` (see below). Aliases +
  // patterns live in `fieldCatalog.ts`. Adding ~22 canonicals lets
  // the detector resolve a much wider set of credit-application,
  // banking, vehicle, production-rate, and rental-period blanks
  // beyond the v0.5 CC-auth focus.
  | "federalTaxId"
  | "dunsNumber"
  | "dbaName"
  | "authorizedSignerName"
  | "authorizedSignerTitle"
  | "secondAuthorizedSignerName"
  | "secondAuthorizedSignerTitle"
  | "bankName"
  | "bankRoutingNumber"
  | "bankAccountNumber"
  | "fedExAccountNumber"
  | "upsAccountNumber"
  | "rentalStartDate"
  | "rentalEndDate"
  | "hourlyRateBuild"
  | "hourlyRateShoot"
  | "hoursBuild"
  | "hoursShoot"
  | "driverLicenseNumber"
  | "vehicleVin"
  | "vehiclePlate"
  | "insuranceCarrier"
  | "insurancePolicyNumber"
  | "invoiceNumber"
  | "dateBusinessStarted"
  | "dateIncorporated"
  | "parentCompany"
  | "streetAddress"
  | "deliveryAddress"
  | "accountingContactName"
  | "accountingEmail"
  | "clauseInitials"
  | "showName"
  | "seasonNumber"
  | "productionClassification"
  | "resaleTaxCertificate"
  | "yearsInBusiness";

export type TemplateFieldKind =
  | "text"
  | "multiline"
  | "date"
  | "signature"
  | "checkbox-group"
  | "boolean-checkbox"
  | "option-group";

/**
 * One option inside an `option-group` field (v0.5.25). Each option has
 * a label string and a tight bbox in PDF user-space points around just
 * that label's printed text. When the user picks a label, the form
 * filler draws a hand-drawn-style oval around the corresponding bbox
 * (industry-standard credit-card-form UX). The field's `value` is the
 * `label` of the chosen option, or `null`/empty when nothing is
 * selected.
 *
 * Why a per-option sub-bbox instead of a single parent bbox: the
 * options aren't anchored to drawn checkboxes/circles on the page —
 * the user typically circles or marks ONE label of a horizontal list
 * (e.g. `Visa  MasterCard  AMEX  Discover  Other`). To draw an oval
 * AROUND the chosen label at fill time, the renderer needs to know
 * exactly where that label's text sits, not just where the row sits.
 * Per-option bboxes give pdfWriter a tight target without forcing it
 * to re-OCR the page at fill time.
 */
export interface FieldOption {
  /** The option's display text, e.g. `"Visa"`, `"MasterCard"`. */
  label: string;
  /** Tight bbox around the label's printed text, PDF user-space pt. */
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /**
   * v0.5.36 — true when this option has a writable blank (typically
   * a short underscore or drawn underline) immediately to the LEFT
   * of the printed label, e.g. `___ Visa  ___ Mastercard  ___ Amex`.
   * Detected per-option from the raster of the page during the
   * detection pipeline (see `optionBlankDetector.ts`). When true,
   * the form filler draws an X glyph centred on `blankRect` instead
   * of the v0.5.25 hand-drawn-style oval around the label —
   * matching how a human marks an underline-selector form.
   *
   * Per-option (NOT per-field) because malformed groups can mix
   * styles: some options may have detectable blanks and some may
   * not. The renderer falls back to circle-around-label for any
   * option where this is false / undefined, preserving the v0.5.25
   * inline-checkbox/button-style behaviour.
   */
  hasUnderlineBlank?: boolean;
  /**
   * v0.5.36 — when {@link hasUnderlineBlank} is true, the rectangle
   * (PDF user-space pt) where the X glyph should be drawn. Sized so
   * the X sits centred over the detected underline stroke, with the
   * rect's BOTTOM edge resting on the stroke (text-baseline
   * geometry — same convention as `TemplateField.y` storage and the
   * `bbox_bottom == strokeRow` snap target in `underlineSnap.ts`).
   * Width matches the stroke's actual horizontal extent; height is
   * set to the option label's local row height so the X arms have
   * room to render visibly.
   *
   * Only meaningful when `hasUnderlineBlank` is true. Drag/resize
   * scaling in `DraggableField.tsx` translates this rect in lockstep
   * with both the parent field rect and the option's `bbox`.
   */
  blankRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type TemplateFieldSource =
  | "text-inline"
  | "text-line"
  | "geometry-line"
  | "geometry-box"
  | "glyph-checkbox"
  | "acroform"
  | "manual"
  | "gemini"
  // Legacy discriminator preserved so templates serialised by older
  // (Claude-backed) versions still deserialise without migration. New
  // detections emit "gemini".
  | "claude";

export interface ConfidenceDetails {
  total: number;
  label?: number;
  geometry?: number;
  section?: number;
  source?: number;
  reason?: string;
}

/** Project/job as used across the app */
export interface Project {
  id: string;
  label: string;
  jobName: string;
  jobNumber: string;
  poNumber: string;
  authorizationDate: string;
  /**
   * v0.5.31 — ISO date (YYYY-MM-DD) of the future event the project is
   * for: the shoot, booking, rental period, or service date. Distinct
   * from `authorizationDate`, which represents the date the
   * cardholder signs the form (typically today). Forms that carry
   * both contexts (e.g. an inline "for my booking on _____ (date)"
   * blank AND a standalone "Date:" line by the signature) auto-fill
   * each blank from the right canonical instead of conflating both
   * onto today's date.
   *
   * Optional so projects created prior to v0.5.31 deserialise without
   * a migration step — `coerceProject` and the form filler treat
   * missing/empty values the same as no shoot date and fall through
   * to a Fill-prompt entry.
   */
  shootDate?: string;
  productionCompany: string;
  billingAddress: string;
  billingCity: string;
  billingState: string;
  billingZipCode: string;
  producer: string;
  email: string;
  phone: string;
  creditCardType: CreditCardType;
  creditCardHolder: string;
  cardholderSignature: string;
  creditCardNumber: string;
  expDate: string;
  ccv: string;
  createdAt: string;
  updatedAt: string;
  /**
   * v0.5.28 — last-modified timestamp in **ms epoch**.
   *
   * Distinct from `updatedAt` (which is an ISO string used for
   * display + UI sort) because v0.5.29 cross-device sync needs a
   * monotonic numeric clock for last-write-wins conflict resolution.
   * Bumped on every autosave through `useProjects`. Optional only so
   * older serialised state (or test fixtures) deserialise without a
   * migration step; the persistence layer normalises missing values
   * to `Date.now()` on load.
   */
  modifiedAt?: number;

  // -----------------------------------------------------------------
  // v0.6.0 — corpus-driven Project schema additions.
  //
  // All fields below are optional so projects created prior to v0.6.0
  // deserialise without a migration step (`coerceProject` defaults
  // anything missing to "" or `undefined`). Sensitive PII (bank
  // routing/account numbers, driver licence, etc.) is NOT given a
  // separate Rust crypto layer — the entire `Project` blob is
  // already encrypted at-rest in `projects.enc` (AES-256-GCM with
  // the key in the OS keychain) and the same envelope ships over
  // the v0.5.35 sync pipe encrypted with the per-account sync key.
  // See `services/projectStore.ts` and `src-tauri/src/projects.rs`.
  // -----------------------------------------------------------------

  // Business identifiers + lineage
  federalTaxId?: string;
  dunsNumber?: string;
  dbaName?: string;
  parentCompany?: string;
  yearsInBusiness?: string;
  dateBusinessStarted?: string;
  dateIncorporated?: string;
  resaleTaxCertificate?: string;

  // Authorized signer(s) — distinct from `creditCardHolder` (which
  // is a payment-method field). Officer-level signers commonly
  // appear in pairs on credit applications (President + Secretary,
  // etc.) — hence the `second*` slot for ISS/Camtec-style forms
  // that explicitly require a counter-signature.
  authorizedSignerName?: string;
  authorizedSignerTitle?: string;
  secondAuthorizedSignerName?: string;
  secondAuthorizedSignerTitle?: string;

  // Banking + shipping account numbers
  bankName?: string;
  bankRoutingNumber?: string;
  bankAccountNumber?: string;
  fedExAccountNumber?: string;
  upsAccountNumber?: string;

  // Rental period + Studio-style rate/hour fields
  rentalStartDate?: string;
  rentalEndDate?: string;
  hourlyRateBuild?: string;
  hourlyRateShoot?: string;
  hoursBuild?: string;
  hoursShoot?: string;

  // Vehicle / DL fields (Omega, FNJ, PSIS DOT)
  driverLicenseNumber?: string;
  vehicleVin?: string;
  vehiclePlate?: string;
  insuranceCarrier?: string;
  insurancePolicyNumber?: string;

  // Other accounting / invoicing
  invoiceNumber?: string;
  accountingContactName?: string;
  accountingEmail?: string;

  // Address variants — separate from billingAddress for forms
  // (ISS, Camtec) that distinguish billing vs ship-to.
  streetAddress?: string;
  deliveryAddress?: string;

  // Production metadata (ISS Acro)
  showName?: string;
  seasonNumber?: string;
  productionClassification?: string;

  // Initials value used to fill `clauseInitials` boxes (Studio
  // Contract, long rental agreements). When empty, the form filler
  // derives a default from the user's first/last name; users can
  // override here.
  initials?: string;

  /**
   * v0.6.0 — uploaded signature image. When present, the form
   * filler embeds this image into signature-typed bboxes via
   * `pdf-lib`'s `embedPng` / `embedJpg`, scaled to fit while
   * preserving aspect ratio. When absent, the renderer falls
   * back to the v0.5.x typed/Caveat-font signature draw path.
   *
   * `dataUrl` is a base64-encoded PNG/JPEG — `data:image/png;base64,...`
   * Stored inline on the encrypted project blob (see schema notes
   * above). 2MB upload cap is enforced in the upload UI; well
   * within the encryption layer's comfort zone.
   *
   * Optional + backwards compatible: existing projects without a
   * signature image continue to render their typed Caveat
   * signature unchanged.
   */
  signatureImage?: { dataUrl: string; uploadedAt: number };
}

/** A single field definition on a template (position + mapping) */
export interface TemplateField {
  id: string;
  label: string;
  /** Key in Project that supplies the value */
  mappedProjectKey: TemplateMappedProjectKey;
  canonicalFieldId?: CanonicalFieldId;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0–1, from auto-detection or manual */
  confidence: number;
  /** Field type: text input, checkbox, or option-group selector. */
  fieldType?: "text" | "checkbox" | "option-group";
  /** Richer field semantics used by the writer. */
  fieldKind?: TemplateFieldKind;
  detectionSource?: TemplateFieldSource;
  sectionId?: string;
  groupId?: string;
  anchorText?: string;
  confidenceDetails?: ConfidenceDetails;
  /** For checkbox fields: which value triggers this checkbox to be checked */
  checkboxValue?: string;
  /**
   * v0.6.0 — section label this field belongs to, derived from the
   * deterministic `detectSections` walk in `geminiFieldDetector.ts`.
   * Headers like `BASIC INFORMATION`, `CREDIT CARD INFORMATION`,
   * `SECTION 1` get harvested from ALL-CAPS text rows and each
   * field's bbox falls into one of the resulting bands. Used for
   * cross-page dedup (the same canonical id can appear on different
   * sections legitimately) and for B2's name-disambiguation guard
   * (a `Name` blank in a `CREDIT CARD` section maps to
   * `creditCardHolder`; one in `SECTION 1` falls through to the
   * officer/signer canonical).
   */
  section?: string;
  /**
   * For `option-group` fields (v0.5.25): the per-option sub-rectangles
   * within (or near) the parent bbox. Each option's bbox is in PDF
   * user-space points and tight around just that option label's text.
   * The form filler draws a hand-drawn-style oval around the chosen
   * option's bbox at fill time.
   */
  options?: FieldOption[];
  /**
   * v0.6.0 — single-shared-stroke option-group flag. Set to `true`
   * by the v0.6.0 `optionBlankDetector.ts` extension when a row
   * like `Type: ____ Visa  Mastercard  Amex  Discover` is rendered
   * with ONE continuous underline spanning every label rather than
   * per-option blanks. When `true`, `sharedUnderlineRect` carries
   * the stroke's bounding rect and the renderer draws an X at the
   * horizontal center of the SELECTED option's label projected onto
   * the shared stroke (rather than per-option Xs). Replaces the
   * v0.5.36 punt that left these rows un-marked.
   */
  sharedUnderline?: boolean;
  /**
   * v0.6.0 — bounding rect of the shared underline stroke (PDF
   * user-space points, top-down origin matching `TemplateField.y`).
   * Only meaningful when `sharedUnderline === true`.
   */
  sharedUnderlineRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /**
   * For `option-group` fields (v0.5.25): the `label` of the currently
   * selected option, or `null`/`undefined` when nothing is selected.
   * Set at fill time (FillPromptModal) when the user picks an option;
   * also editable in the TemplateReviewModal sidebar to pin a default
   * choice on the template.
   */
  selectedOption?: string | null;
  /** Literal value for manual one-off fields not bound to Project. */
  customValue?: string;
  /** Prompt label shown when this field is collected at fill time. */
  promptLabel?: string;
  /** True if field is in an optional/conditional section (e.g. "if applicable"). */
  optional?: boolean;
  /** Estimated font size (pt) of the nearby label text. */
  estimatedFontSize?: number;
  /**
   * Short snippet of the surrounding sentence with `___` standing in for the
   * blank — e.g. "…charged an additional $ ___ plus a 3.3% fee…". Shown above
   * the input in the Fill Required Values modal so the user can see the
   * context they're filling into. Generated at detection time from the
   * script's row context.
   */
  contextSnippet?: string;
  /**
   * v0.6.11 — the form's PRINTED prefix label as Gemini reported it
   * (`raw.label`), distinct from {@link label} which becomes the
   * canonical's display label after a successful catalog match.
   * Populated even when canonical resolution succeeds, so the renderer
   * can detect label-prefix-inside-boxed-cell layouts (e.g. Keslow's
   * `Cardholder's Name: ___` cells where the printed colon sits INSIDE
   * the bbox) and shift the rendered value rightward past the printed
   * label instead of writing on top of it. Optional because not every
   * detection carries a meaningful label string.
   */
  printedLabel?: string;
  /**
   * v0.6.11 — the text immediately preceding the bbox (`raw.context_before`),
   * lightly normalised. The renderer reads this together with
   * {@link printedLabel} to gate the boxed-cell shift heuristic: when
   * `contextBefore` is empty/whitespace AND `printedLabel` ends with a
   * colon, the printed label most likely sits INSIDE the bbox (Layout
   * A1). Optional and best-effort.
   */
  contextBefore?: string;
  /**
   * v0.6.28 — auto-detected party this field is intended for.
   *   - `signer` = the user / their production company (the side
   *     Wrapkit is filling out on their behalf).
   *   - `vendor` = the counterparty / supplier (the side that signs
   *     off on the form from their end, e.g. JEM F/X on a rental
   *     contract).
   * Undefined when the detector can't make a confident call. The
   * value is purely advisory — visualised on the canvas + sidebar
   * to help the user spot which fields are theirs at a glance —
   * and never blocks fill. Computed in `annotateFieldsWithParty`
   * from same-row printed text and the field's section context.
   */
  party?: "signer" | "vendor";
}

/**
 * Where a saved template originated. `local-*` values come from the
 * user's own machine; `remote-registry` is a template that was
 * installed from (or has been published to) the public Supabase
 * registry. Remote-sourced templates carry a `registryId` on the
 * parent {@link Template} so the UI can re-fetch the row, surface
 * upvote counts, and route republishes through the same primary key.
 */
export type TemplateRegistrySource =
  | "local-draft"
  | "local-override"
  | "local-verified"
  | "remote-registry";

export type TemplateStatus = "local-draft" | "local-verified";

export interface PageFingerprint {
  pageNumber: number;
  width: number;
  height: number;
  anchorTerms: string[];
  textDigest: string;
}

export interface TemplateFingerprint {
  version: number;
  pageCount: number;
  pageFingerprints: PageFingerprint[];
  anchorTerms: string[];
  checkboxTerms: string[];
  canonicalFieldIds: CanonicalFieldId[];
  fileNameHints: string[];
  fingerprintHash: string;
}

/** A saved template (local store; may have been installed from the registry) */
export interface Template {
  id: string;
  name: string;
  status: TemplateStatus;
  version?: string;
  source?: TemplateRegistrySource;
  fingerprint?: TemplateFingerprint;
  fields: TemplateField[];
  pageCount?: number;
  /**
   * Registry primary key, set when this template was installed from the
   * public registry (or after the user published a local template).
   * Lets the UI re-fetch the row to update vote counts, surface a
   * "Re-publish" affordance for the original publisher, and dedupe
   * browse results against templates the user already has locally.
   */
  registryId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectDocumentStatus = "pending" | "processing" | "matched" | "filled";

export interface ProjectDocument {
  id: string;
  projectId: string;
  fileName: string;
  templateId?: string;
  matchResult?: PdfMatchResult;
  pdfBytes?: Uint8Array;
  status: ProjectDocumentStatus;
  processingMessage?: string;
  /**
   * Live progress fraction (0-1) supplied by the detector. Maps to
   * Gemini SSE phases (upload → request_sent → streaming
   * → done). The DocumentList progress bar uses this as a hard floor
   * and animates a time-based curve up to it.
   */
  processingProgress?: number;
  createdAt: string;
  updatedAt: string;
}

export type MatchResultKind = "verified" | "none";

export interface TemplateMatch {
  templateId: string;
  templateName: string;
  status: TemplateStatus;
  confidence: number;
  version?: string;
  source?: TemplateRegistrySource;
}

/** UI state after PDF intake */
export interface PdfMatchResult {
  kind: MatchResultKind;
  /** When kind === 'verified', single match */
  verifiedMatch?: TemplateMatch;
  /** When kind === 'none', we may still create a draft template with detected fields */
  draftTemplateId?: string;
  fileName?: string;
  lookupMessage?: string;
  matchSource?: TemplateRegistrySource | "detector";
  syncState?: "idle" | "matching" | "matched" | "error";
}
