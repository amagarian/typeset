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
  | "boolean-checkbox";

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
  /** Field type: text input or checkbox */
  fieldType?: "text" | "checkbox";
  /** Richer field semantics used by the writer. */
  fieldKind?: TemplateFieldKind;
  detectionSource?: TemplateFieldSource;
  sectionId?: string;
  groupId?: string;
  anchorText?: string;
  confidenceDetails?: ConfidenceDetails;
  /** For checkbox fields: which value triggers this checkbox to be checked */
  checkboxValue?: string;
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
