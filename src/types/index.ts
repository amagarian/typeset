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
  | "ccv";

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
   * For `option-group` fields (v0.5.25): the per-option sub-rectangles
   * within (or near) the parent bbox. Each option's bbox is in PDF
   * user-space points and tight around just that option label's text.
   * The form filler draws a hand-drawn-style oval around the chosen
   * option's bbox at fill time.
   */
  options?: FieldOption[];
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
