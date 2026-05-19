/**
 * v0.6.32 — document persistence layer.
 *
 * Thin TypeScript wrapper over the Rust `read_documents` /
 * `write_documents` / `read_document_pdf` / `write_document_pdf` /
 * `delete_document_pdf` Tauri commands defined in
 * `src-tauri/src/documents.rs`.
 *
 * Up through v0.6.31 the per-project document list (every imported
 * PDF, its template match, its fill status, its bytes) lived in a
 * single `useState<Record<string, ProjectDocument[]>>({})` and died
 * on every app quit — the user lost the full history of which
 * forms they'd processed in each project. v0.6.32 plumbs that map
 * through an encrypted on-disk store, with a deliberate split:
 *
 * - metadata (small, frequently changed) → `documents.enc` (one blob).
 * - PDF bytes (large, write-once)         → `documents/{id}.bin`.
 *
 * The split keeps the autosave path off the multi-MB PDF blobs;
 * status / template updates only re-encrypt the small metadata file.
 *
 * ## On-disk metadata shape
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "documents": [<ProjectDocument-without-pdfBytes>, ...]
 * }
 * ```
 *
 * The list is flat (not grouped by projectId) — the renderer groups
 * on read. That keeps the JSON shape stable as documents move between
 * projects (future-proof for a v0.6.x "reassign document" flow).
 *
 * ## No localStorage fallback
 *
 * Mirrors `projectStore.ts`: in a non-Tauri runtime (web preview)
 * loads return empty and writes are no-ops. The dev workflow already
 * assumes a stateless preview; we don't want to leak unencrypted
 * PDF metadata to localStorage.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectDocument,
  PdfMatchResult,
  TemplateMatch,
  TemplateRegistrySource,
  TemplateStatus,
} from "@/types";

export const DOCUMENT_STORE_SCHEMA_VERSION = 1 as const;

export interface DocumentStore {
  schemaVersion: typeof DOCUMENT_STORE_SCHEMA_VERSION;
  documents: ProjectDocument[];
}

/** ProjectDocument minus the heavy `pdfBytes` field — the shape we
 *  actually persist into the metadata blob. Bytes go through the
 *  per-document PDF file pair instead. */
export type StoredDocumentMeta = Omit<ProjectDocument, "pdfBytes">;

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function coerceVerifiedMatch(raw: unknown): TemplateMatch | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const vm = raw as Record<string, unknown>;
  if (typeof vm.templateId !== "string" || typeof vm.templateName !== "string") {
    return undefined;
  }
  return {
    templateId: vm.templateId,
    templateName: vm.templateName,
    status: (typeof vm.status === "string" ? vm.status : "verified") as TemplateStatus,
    confidence: typeof vm.confidence === "number" ? vm.confidence : 1,
    version: typeof vm.version === "string" ? vm.version : undefined,
    source:
      typeof vm.source === "string"
        ? (vm.source as TemplateRegistrySource)
        : undefined,
  };
}

function coerceMatchResult(raw: unknown): PdfMatchResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "verified" || r.kind === "none" ? r.kind : undefined;
  if (!kind) return undefined;
  const result: PdfMatchResult = { kind };
  if (typeof r.draftTemplateId === "string") result.draftTemplateId = r.draftTemplateId;
  if (typeof r.fileName === "string") result.fileName = r.fileName;
  if (typeof r.lookupMessage === "string") result.lookupMessage = r.lookupMessage;
  if (typeof r.matchSource === "string") {
    result.matchSource = r.matchSource as PdfMatchResult["matchSource"];
  }
  if (typeof r.syncState === "string") {
    result.syncState = r.syncState as PdfMatchResult["syncState"];
  }
  const vm = coerceVerifiedMatch(r.verifiedMatch);
  if (vm) result.verifiedMatch = vm;
  return result;
}

function coerceDocument(raw: unknown): StoredDocumentMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.projectId !== "string") return null;
  if (typeof r.fileName !== "string") return null;
  const allowedStatus = new Set([
    "pending",
    "processing",
    "matched",
    "filled",
  ]);
  const status = typeof r.status === "string" && allowedStatus.has(r.status)
    ? (r.status as ProjectDocument["status"])
    : "pending";
  const doc: StoredDocumentMeta = {
    id: r.id,
    projectId: r.projectId,
    fileName: r.fileName,
    status,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : new Date().toISOString(),
  };
  if (typeof r.templateId === "string") doc.templateId = r.templateId;
  if (typeof r.processingMessage === "string") doc.processingMessage = r.processingMessage;
  if (typeof r.processingProgress === "number") doc.processingProgress = r.processingProgress;
  const match = coerceMatchResult(r.matchResult);
  if (match) doc.matchResult = match;
  return doc;
}

function parseDocumentsStore(json: string): StoredDocumentMeta[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn("[Typeset] documents.enc payload is not valid JSON:", err);
    return [];
  }
  let raw: unknown[];
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (parsed && typeof parsed === "object") {
    const candidate = (parsed as Record<string, unknown>).documents;
    raw = Array.isArray(candidate) ? candidate : [];
  } else {
    raw = [];
  }
  return raw
    .map((entry) => coerceDocument(entry))
    .filter((doc): doc is StoredDocumentMeta => doc !== null);
}

/**
 * Read + decrypt the document metadata store. Returns `[]` when:
 *   - The Tauri runtime is missing (web preview).
 *   - The on-disk file is missing (first launch).
 *   - The on-disk file was corrupt (Rust side backed it up and
 *     returned `"{}"`).
 *
 * Throws only when the keychain refused access — `App.tsx` surfaces
 * the error string verbatim through a toast.
 */
export async function loadDocuments(): Promise<StoredDocumentMeta[]> {
  if (!isTauriAvailable()) return [];
  const json = await invoke<string>("read_documents");
  return parseDocumentsStore(json);
}

/**
 * Encrypt + write the full document metadata list. Strips any
 * `pdfBytes` field defensively — bytes belong in the per-document
 * file, never in this blob.
 *
 * No-op in a non-Tauri runtime.
 */
export async function saveDocuments(
  documents: ReadonlyArray<ProjectDocument>
): Promise<void> {
  if (!isTauriAvailable()) return;
  const cleaned: StoredDocumentMeta[] = documents.map((doc) => {
    // Strip pdfBytes; everything else is JSON-safe.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pdfBytes: _omit, ...meta } = doc;
    return meta;
  });
  const store: DocumentStore = {
    schemaVersion: DOCUMENT_STORE_SCHEMA_VERSION,
    documents: cleaned,
  };
  await invoke<void>("write_documents", { json: JSON.stringify(store) });
}

// ---------------------------------------------------------------------------
// Per-document PDF bytes
// ---------------------------------------------------------------------------

/**
 * Load the encrypted PDF bytes for a single document. Returns `null`
 * when the file is missing (deleted on disk, or never persisted —
 * e.g. an older project from before v0.6.32).
 */
export async function loadDocumentPdf(docId: string): Promise<Uint8Array | null> {
  if (!isTauriAvailable()) return null;
  // Rust returns `Option<Vec<u8>>` → JS `number[] | null`.
  const bytes = await invoke<number[] | null>("read_document_pdf", { docId });
  if (!bytes) return null;
  return new Uint8Array(bytes);
}

/**
 * Persist the PDF bytes for a single document. Called exactly once
 * per import (subsequent metadata updates don't churn the file).
 */
export async function saveDocumentPdf(
  docId: string,
  bytes: Uint8Array
): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke<void>("write_document_pdf", {
    docId,
    bytes: Array.from(bytes),
  });
}

/**
 * Best-effort delete of the on-disk PDF file. Missing file is a
 * no-op — metadata is the source of truth for "does this doc exist".
 */
export async function deleteDocumentPdf(docId: string): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke<void>("delete_document_pdf", { docId });
}
