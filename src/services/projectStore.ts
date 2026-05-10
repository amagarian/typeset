/**
 * v0.5.28 — project persistence layer.
 *
 * Thin TypeScript wrapper over the Rust `read_projects` /
 * `write_projects` Tauri commands defined in
 * `src-tauri/src/projects.rs`. The Rust side handles AES-256-GCM
 * encryption + atomic file writes; this module is the cleaning /
 * shape-validation layer between the encrypted JSON blob on disk
 * and the in-memory `Project` shape that the rest of the app uses.
 *
 * ## On-disk shape (the JSON inside the encrypted blob)
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "projects": [<Project>, <Project>, ...]
 * }
 * ```
 *
 * `schemaVersion` is the v0.5.29 forward-compat hook. Bumping to 2
 * (when sync arrives) lets the next migration know it's looking at a
 * v0.5.28 blob and run any necessary in-place rewrites before the
 * UI sees the data.
 *
 * Legacy reads also accept a bare `Project[]` array — that's what
 * the corruption-recovery path in `read_projects` returns (`"[]"`),
 * and it's a courtesy for future tooling that may want to write a
 * raw array without the wrapper.
 *
 * ## Why no localStorage fallback
 *
 * The whole point of v0.5.28 is to get project data out of
 * unencrypted localStorage (where it never was — projects were
 * `useState`-only) and into an encrypted file. Adding a
 * localStorage fallback for non-Tauri contexts (web preview) would
 * defeat that. In a non-Tauri runtime `loadProjects` returns `[]`
 * and `saveProjects` is a no-op; the app behaves as a stateless
 * preview, which is what the dev workflow already assumed.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/types";

/**
 * Current persisted schema version. Bumped on any incompatible
 * change to the encrypted blob's shape. v0.5.29 (Supabase sync)
 * may bump to 2 to add user-keyed encryption metadata or a
 * `lastSyncedAt` field per project.
 */
export const PROJECT_STORE_SCHEMA_VERSION = 1 as const;

/**
 * Top-level shape inside the encrypted blob. Always wrapped — even
 * an empty list is `{ schemaVersion: 1, projects: [] }`.
 */
export interface ProjectStore {
  schemaVersion: typeof PROJECT_STORE_SCHEMA_VERSION;
  projects: Project[];
}

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

/**
 * Generate a stable UUID for a new project. Uses `crypto.randomUUID`
 * (available in the Tauri webview and modern browsers). Falls back
 * to a hex random in the unlikely event that the webview lacks it.
 *
 * Stable IDs at create time are a v0.5.29 forward-compat requirement:
 * cross-device sync needs to refer to a project by something other
 * than its (mutable, possibly empty) name.
 */
export function newProjectId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Coerce an unknown value into a Project. Defensive: anything we
 * can't read becomes a sensible default so a single corrupt entry
 * doesn't take the whole list down. Lazily assigns a UUID if the
 * stored project is missing one (covers any pre-UUID test fixtures
 * — beta testers start fresh, so this is belt-and-braces).
 */
function coerceProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (key: string): string => (typeof r[key] === "string" ? (r[key] as string) : "");
  /** v0.6.0 — optional string passthrough. Returns the trimmed value
   *  when it's a non-empty string, otherwise `undefined` so the field
   *  is omitted from the resulting Project (the new schema additions
   *  are all optional and we don't want to populate them with empty
   *  strings on every legacy project — the form-rendering paths
   *  treat `undefined` and `""` equivalently, but JSON serialisation
   *  is leaner with omissions). */
  const optStr = (key: string): string | undefined => {
    const v = r[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const id =
    typeof r.id === "string" && r.id.length > 0 ? (r.id as string) : newProjectId();
  const cardType = str("creditCardType");
  const allowedCardTypes = new Set(["visa", "mastercard", "discover", "amex", ""]);

  // v0.6.0 — coerce the optional uploaded signature image. Defensive
  // against partially-corrupt records: must be an object with a
  // string `dataUrl` and numeric `uploadedAt`. Anything else is
  // dropped (the field is optional and the renderer falls back to
  // the typed Caveat path).
  let signatureImage: Project["signatureImage"] | undefined;
  if (r.signatureImage && typeof r.signatureImage === "object") {
    const sig = r.signatureImage as Record<string, unknown>;
    if (typeof sig.dataUrl === "string" && sig.dataUrl.startsWith("data:")) {
      signatureImage = {
        dataUrl: sig.dataUrl,
        uploadedAt:
          typeof sig.uploadedAt === "number" ? sig.uploadedAt : Date.now(),
      };
    }
  }

  return {
    id,
    label: str("label"),
    jobName: str("jobName"),
    jobNumber: str("jobNumber"),
    poNumber: str("poNumber"),
    authorizationDate: str("authorizationDate"),
    // v0.5.31 — `shootDate` is optional on the type, but persisting
    // an empty string for unset values matches every other Project
    // field's shape and keeps `coerceProject`'s output total/well-typed
    // for downstream consumers.
    shootDate: str("shootDate"),
    productionCompany: str("productionCompany"),
    billingAddress: str("billingAddress"),
    billingCity: str("billingCity"),
    billingState: str("billingState"),
    billingZipCode: str("billingZipCode"),
    producer: str("producer"),
    email: str("email"),
    phone: str("phone"),
    creditCardType: (allowedCardTypes.has(cardType)
      ? cardType
      : "") as Project["creditCardType"],
    creditCardHolder: str("creditCardHolder"),
    cardholderSignature: str("cardholderSignature"),
    creditCardNumber: str("creditCardNumber"),
    expDate: str("expDate"),
    ccv: str("ccv"),
    createdAt: str("createdAt") || new Date().toISOString(),
    updatedAt: str("updatedAt") || new Date().toISOString(),
    modifiedAt:
      typeof r.modifiedAt === "number" ? (r.modifiedAt as number) : Date.now(),

    // v0.6.0 — corpus-driven optional fields. Stored straight onto the
    // encrypted project blob; legacy projects without these keys
    // deserialise as `undefined` and the form filler / UI treat that
    // identically to an empty string.
    federalTaxId: optStr("federalTaxId"),
    dunsNumber: optStr("dunsNumber"),
    dbaName: optStr("dbaName"),
    parentCompany: optStr("parentCompany"),
    yearsInBusiness: optStr("yearsInBusiness"),
    dateBusinessStarted: optStr("dateBusinessStarted"),
    dateIncorporated: optStr("dateIncorporated"),
    resaleTaxCertificate: optStr("resaleTaxCertificate"),
    authorizedSignerName: optStr("authorizedSignerName"),
    authorizedSignerTitle: optStr("authorizedSignerTitle"),
    secondAuthorizedSignerName: optStr("secondAuthorizedSignerName"),
    secondAuthorizedSignerTitle: optStr("secondAuthorizedSignerTitle"),
    bankName: optStr("bankName"),
    bankRoutingNumber: optStr("bankRoutingNumber"),
    bankAccountNumber: optStr("bankAccountNumber"),
    fedExAccountNumber: optStr("fedExAccountNumber"),
    upsAccountNumber: optStr("upsAccountNumber"),
    rentalStartDate: optStr("rentalStartDate"),
    rentalEndDate: optStr("rentalEndDate"),
    hourlyRateBuild: optStr("hourlyRateBuild"),
    hourlyRateShoot: optStr("hourlyRateShoot"),
    hoursBuild: optStr("hoursBuild"),
    hoursShoot: optStr("hoursShoot"),
    driverLicenseNumber: optStr("driverLicenseNumber"),
    vehicleVin: optStr("vehicleVin"),
    vehiclePlate: optStr("vehiclePlate"),
    insuranceCarrier: optStr("insuranceCarrier"),
    insurancePolicyNumber: optStr("insurancePolicyNumber"),
    invoiceNumber: optStr("invoiceNumber"),
    accountingContactName: optStr("accountingContactName"),
    accountingEmail: optStr("accountingEmail"),
    streetAddress: optStr("streetAddress"),
    deliveryAddress: optStr("deliveryAddress"),
    showName: optStr("showName"),
    seasonNumber: optStr("seasonNumber"),
    productionClassification: optStr("productionClassification"),
    initials: optStr("initials"),
    signatureImage,
  };
}

/**
 * Parse the JSON blob returned by the Rust `read_projects` command.
 * Accepts either the wrapped `{ schemaVersion, projects }` shape or
 * a bare `Project[]` (legacy / corruption-recovery default). Drops
 * any entry that fails coercion; never throws on malformed input.
 */
function parseStore(json: string): Project[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn("[Typeset] projects.enc payload is not valid JSON:", err);
    return [];
  }

  let raw: unknown[];
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (parsed && typeof parsed === "object") {
    const candidate = (parsed as Record<string, unknown>).projects;
    raw = Array.isArray(candidate) ? candidate : [];
  } else {
    raw = [];
  }

  return raw
    .map((entry) => coerceProject(entry))
    .filter((project): project is Project => project !== null);
}

/**
 * Read + decrypt the project store. Returns `[]` when:
 *   - The Tauri runtime is missing (web preview).
 *   - The on-disk file is missing (first launch).
 *   - The on-disk file was corrupt (Rust side renamed it to
 *     `projects.enc.broken-{epoch}` and returned `"[]"`).
 *
 * Throws only when the keychain refused access — the renderer will
 * surface that error string verbatim in a toast.
 */
export async function loadProjects(): Promise<Project[]> {
  if (!isTauriAvailable()) {
    return [];
  }
  const json = await invoke<string>("read_projects");
  return parseStore(json);
}

/**
 * Encrypt + write the entire project list. The Rust side serialises
 * concurrent writes via a mutex, so callers don't need to debounce
 * for correctness — but `useProjects` does debounce ~500ms anyway
 * to keep the I/O / encryption load proportional to the edit rate.
 *
 * No-op in a non-Tauri runtime.
 */
export async function saveProjects(projects: Project[]): Promise<void> {
  if (!isTauriAvailable()) {
    return;
  }
  const store: ProjectStore = {
    schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
    projects,
  };
  await invoke<void>("write_projects", { json: JSON.stringify(store) });
}
