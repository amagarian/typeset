/**
 * Public template-registry client.
 *
 * Backed by Supabase. Zero-config since v0.5.8: every install of
 * Typeset connects to the same shared registry on first run. The
 * project URL and publishable / anon key are baked in at compile
 * time below; RLS plus the device-bound anonymous id ship in
 * `services/deviceId.ts` are what actually gate writes.
 *
 * Server schema lives in `supabase/migrations/`. The table is named
 * `template_submissions`; RLS does the bulk of the policy work, and
 * this module just shapes payloads and adds the `x-device-id` header
 * used by RLS for ownership / vote-dedup.
 *
 * Matching:
 *   1. Client computes a `TemplateFingerprint` (already done locally).
 *   2. Calls `match_template_submissions_by_fingerprint` RPC — Postgres
 *      returns the top N candidates by anchor-term overlap +
 *      verification score. Cheap (gin index on text[]).
 *   3. Client re-scores candidates with the same `scoreFingerprintMatch`
 *      used for the local registry. Single source of truth → identical
 *      ranking semantics whether the template is local or remote.
 *
 * Publishing:
 *   * Sanitises the local Template (strips ids, custom values) before
 *     uploading. Submission rows only contain field schemas + coords —
 *     never user-entered values, never the source PDF.
 *   * Publisher device id ships in the row + the `x-device-id` header,
 *     enabling self-service updates / deletes.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Template, TemplateField, TemplateFingerprint } from "@/types";
import { getDeviceId } from "./deviceId";
import { scoreFingerprintMatch } from "@/utils/templateFingerprint";

// ---------------------------------------------------------------------------
// Baked-in registry credentials.
//
// Publishable / anon keys are designed to be embedded in clients —
// they only grant whatever the project's RLS policies allow, which
// for Typeset is "anonymous read of non-hidden rows + author-only
// updates keyed off the x-device-id header". See supabase/README.md.
//
// `import.meta.env.VITE_SUPABASE_*` lets dev builds point at a
// staging project without rebuilding the binary; production builds
// fall through to the constants below.
// ---------------------------------------------------------------------------

const REGISTRY_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  "https://sxtcmjahbgefqneauzpn.supabase.co";
const REGISTRY_KEY =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
  "sb_publishable_zVIlCZ9YSdPEEiQE3BGSYQ_mFtOLX1e";

// ---------------------------------------------------------------------------
// Singleton client.
// ---------------------------------------------------------------------------

const SUBMISSIONS_TABLE = "template_submissions";
const MATCH_RPC = "match_template_submissions_by_fingerprint";

let cachedClient: SupabaseClient | null = null;

function buildClient(): SupabaseClient {
  // The `x-device-id` header is read by RLS policies (see migration)
  // to gate UPDATE / DELETE on template_submissions and ownership of
  // votes/flags. We set it once on the client and let supabase-js
  // attach it to every request automatically.
  return createClient(REGISTRY_URL, REGISTRY_KEY, {
    global: {
      headers: {
        "x-device-id": getDeviceId(),
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Build the singleton Supabase client. Idempotent and synchronous —
 * since v0.5.8 there are no credentials to load from disk. Safe to
 * call from a `useEffect` on app mount.
 */
export function initRegistry(): void {
  if (cachedClient) return;
  cachedClient = buildClient();
}

/**
 * Returns the singleton client, lazily initialising on first call.
 * Every public API in this module routes through here so callers
 * never have to think about init order.
 */
export function getRegistryClient(): SupabaseClient {
  if (!cachedClient) initRegistry();
  return cachedClient!;
}

// ---------------------------------------------------------------------------
// Wire types — match the SQL schema 1:1.
// ---------------------------------------------------------------------------

interface SubmissionRow {
  id: string;
  name: string;
  description: string | null;
  fingerprint_hash: string;
  fingerprint: TemplateFingerprint;
  page_count: number;
  anchor_terms: string[];
  checkbox_terms: string[];
  file_name_hints: string[];
  canonical_field_ids: string[];
  fields: TemplateField[];
  field_count: number;
  publisher_device_id: string;
  upvotes: number;
  downvotes: number;
  flag_count: number;
  is_hidden: boolean;
  verification_score: number;
  created_at: string;
  updated_at: string;
}

/**
 * What the UI sees. Renamed snake_case columns into camelCase, plus
 * `isMine` so the browser can show "Edit" instead of "Install" on the
 * user's own publishes.
 */
export interface RegistryTemplate {
  id: string;
  name: string;
  description?: string;
  fingerprintHash: string;
  fingerprint: TemplateFingerprint;
  pageCount: number;
  fieldCount: number;
  fields: TemplateField[];
  upvotes: number;
  downvotes: number;
  flagCount: number;
  verificationScore: number;
  publisherDeviceId: string;
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToTemplate(row: SubmissionRow): RegistryTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    fingerprintHash: row.fingerprint_hash,
    fingerprint: row.fingerprint,
    pageCount: row.page_count,
    fieldCount: row.field_count ?? row.fields?.length ?? 0,
    fields: row.fields,
    upvotes: row.upvotes ?? 0,
    downvotes: row.downvotes ?? 0,
    flagCount: row.flag_count ?? 0,
    verificationScore: row.verification_score ?? 0,
    publisherDeviceId: row.publisher_device_id,
    isMine: row.publisher_device_id === getDeviceId(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Sanitisation — what gets shipped to the registry.
// ---------------------------------------------------------------------------

/**
 * Strips everything from a `TemplateField` that is local-only or
 * potentially user-entered. The registry stores field *schemas*: where
 * a blank lives on the page and what kind of value belongs in it. It
 * never stores values.
 *
 * Specifically dropped:
 *   - `id`            — regenerated on install
 *   - `customValue`   — user-entered literal value
 *   - `mappedProjectKey` when set to `__custom__` (carries no
 *     semantic meaning across users; their local mapping will differ).
 *
 * Kept (all schema-level metadata): label, canonicalFieldId, page
 * coords, fieldKind, fieldType, anchorText, checkboxValue, promptLabel,
 * optional, contextSnippet, estimatedFontSize, sectionId, groupId,
 * confidence(Details). `detectionSource` is normalised to `"gemini"`
 * since v0.5.0 only ever publishes Gemini-detected fields.
 */
function sanitiseField(field: TemplateField): TemplateField {
  const { id: _id, customValue: _cv, ...rest } = field;
  void _id;
  void _cv;
  // mappedProjectKey: keep canonical mappings (so installs auto-map
  // to the user's Project shape), drop free-form custom keys.
  const mappedProjectKey =
    rest.mappedProjectKey === "__custom__" ? "" : rest.mappedProjectKey;
  return {
    ...rest,
    id: cryptoUuid(),
    mappedProjectKey,
    detectionSource: "gemini",
  };
}

function cryptoUuid(): string {
  const c = globalThis.crypto;
  return c?.randomUUID?.() ?? `tf-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** Override the displayed template name in the registry. */
  name?: string;
  /** Optional 1-2 sentence description stored alongside the row. */
  description?: string;
}

export interface PublishResult {
  registryId: string;
  registryRow: RegistryTemplate;
}

/**
 * Outcome of an auto-publish (the v0.5.2 single-button save+publish
 * action). Lets the caller toast a context-appropriate message:
 *
 *   - `created`: a brand-new submission row was inserted.
 *   - `updated`: an existing row owned by this device was updated
 *     because its `fields` payload differed from the local copy.
 *   - neither flag: no-op — the row exists and is byte-equal to the
 *     local template (deep-equal on the sanitised fields), so we
 *     skipped the network round-trip.
 *
 * The registry id is always returned so callers can stash it on the
 * local Template (so subsequent edits route through the update path).
 */
export type AutoPublishOutcome =
  | { created: true; updated?: never; id: string; registryRow: RegistryTemplate }
  | { updated: true; created?: never; id: string; registryRow: RegistryTemplate }
  | { created?: never; updated?: never; id: string; registryRow: RegistryTemplate };

function buildSubmissionPayload(
  template: Template,
  fp: NonNullable<Template["fingerprint"]>,
  options: PublishOptions
) {
  const sanitisedFields = template.fields.map(sanitiseField);
  return {
    name: (options.name ?? template.name).trim().slice(0, 120),
    description: options.description?.trim().slice(0, 500) || null,
    fingerprint_hash: fp.fingerprintHash,
    fingerprint: fp,
    page_count: fp.pageCount,
    anchor_terms: fp.anchorTerms,
    checkbox_terms: fp.checkboxTerms,
    file_name_hints: fp.fileNameHints,
    canonical_field_ids: fp.canonicalFieldIds,
    fields: sanitisedFields,
  };
}

/**
 * Strip volatile / device-local data from a TemplateField and return a
 * stable shape suitable for deep-equal comparison against a server
 * row. Mirrors `sanitiseField` but does NOT regenerate the id (so two
 * server rows with different per-write uuids still compare equal on
 * shape alone).
 */
function fieldShapeForCompare(field: TemplateField): Omit<TemplateField, "id"> {
  const { id: _id, customValue: _cv, ...rest } = field;
  void _id;
  void _cv;
  const mappedProjectKey =
    rest.mappedProjectKey === "__custom__" ? "" : rest.mappedProjectKey;
  return {
    ...rest,
    mappedProjectKey,
    detectionSource: "gemini",
  };
}

function fieldsEqualIgnoringIds(
  local: TemplateField[],
  remote: TemplateField[]
): boolean {
  if (local.length !== remote.length) return false;
  const a = local.map(fieldShapeForCompare);
  const b = remote.map(fieldShapeForCompare);
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Save-and-publish in a single round-trip. Looks up an existing row
 * for `(publisher_device_id, fingerprint_hash)`; INSERTs if none,
 * UPDATEs if the local fields differ from the server copy, and is a
 * no-op otherwise. The shape this returns drives the toast that
 * `App.tsx` shows after a Save click.
 *
 * Local save MUST happen first and MUST NOT depend on this call —
 * any failure here (network, RLS, schema) is caught and surfaced as a
 * non-blocking warning. See `handleSaveTemplate` in `App.tsx`.
 */
export async function publishTemplateAuto(
  template: Template,
  options: PublishOptions = {}
): Promise<AutoPublishOutcome> {
  const client = getRegistryClient();
  if (!template.fingerprint) {
    throw new Error("Template is missing a fingerprint; refusing to publish.");
  }
  if (template.fields.length === 0) {
    throw new Error("Template has no fields; refusing to publish.");
  }

  const fp = template.fingerprint;
  const deviceId = getDeviceId();
  const payload = buildSubmissionPayload(template, fp, options);

  // Lookup-then-insert/update. Two-step is clearer than upsert here:
  // the row's primary key is a uuid generated server-side, so we
  // can't drive the upsert by primary key from the client. The
  // (publisher_device_id, fingerprint_hash) pair is what gives a
  // template its identity from this device's perspective.
  const { data: existingRows, error: lookupError } = await client
    .from(SUBMISSIONS_TABLE)
    .select("*")
    .eq("publisher_device_id", deviceId)
    .eq("fingerprint_hash", fp.fingerprintHash)
    .limit(1);

  if (lookupError) {
    throw new Error(`Registry lookup failed: ${lookupError.message}`);
  }

  const existing = (existingRows as SubmissionRow[] | null)?.[0] ?? null;

  if (existing) {
    // Skip the network round-trip when nothing relevant changed.
    // We compare the field shapes (ignoring ids/customValue) and the
    // displayed name; description can drift without a reason to
    // re-publish if the user only renamed locally — but in practice
    // we treat any name change as worth pushing.
    const sameFields = fieldsEqualIgnoringIds(
      template.fields,
      existing.fields ?? []
    );
    const sameName = payload.name === existing.name;
    if (sameFields && sameName) {
      return { id: existing.id, registryRow: rowToTemplate(existing) };
    }

    const updatePayload = {
      ...payload,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await client
      .from(SUBMISSIONS_TABLE)
      .update(updatePayload)
      .eq("id", existing.id)
      .select()
      .single<SubmissionRow>();
    if (error) throw new Error(`Update failed: ${error.message}`);
    if (!data) throw new Error("Update failed: empty response.");
    return { updated: true, id: data.id, registryRow: rowToTemplate(data) };
  }

  const insertPayload = {
    ...payload,
    publisher_device_id: deviceId,
  };
  const { data, error } = await client
    .from(SUBMISSIONS_TABLE)
    .insert(insertPayload)
    .select()
    .single<SubmissionRow>();
  if (error) throw new Error(`Publish failed: ${error.message}`);
  if (!data) throw new Error("Publish failed: empty response.");
  return { created: true, id: data.id, registryRow: rowToTemplate(data) };
}

/** Delete a template you own. RLS enforces ownership. */
export async function deletePublishedTemplate(registryId: string): Promise<void> {
  const client = getRegistryClient();
  const { error } = await client
    .from(SUBMISSIONS_TABLE)
    .delete()
    .eq("id", registryId);
  if (error) throw new Error(`Delete failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Lookup / search
// ---------------------------------------------------------------------------

export interface MatchedRegistryTemplate {
  template: RegistryTemplate;
  /** Re-scored against the incoming fingerprint with the same
   *  `scoreFingerprintMatch` used for local templates. */
  matchScore: number;
}

/**
 * Find the best registry templates for an incoming PDF fingerprint.
 * Pipeline: server-side coarse filter (anchor-term overlap, page count
 * tolerance) → client-side full re-scoring with the local matcher.
 *
 * Returns at most `limit` results, sorted by descending matchScore.
 */
export async function findRegistryMatches(
  fingerprint: TemplateFingerprint,
  limit: number = 8
): Promise<MatchedRegistryTemplate[]> {
  const client = getRegistryClient();

  const { data, error } = await client.rpc(MATCH_RPC, {
    p_fingerprint_hash: fingerprint.fingerprintHash,
    p_page_count: fingerprint.pageCount,
    p_anchor_terms: fingerprint.anchorTerms,
    p_limit: Math.max(1, Math.min(limit * 2, 32)),
  });

  if (error) {
    console.warn("[Typeset registry] match RPC failed:", error.message);
    return [];
  }
  const rows = (data as SubmissionRow[] | null) ?? [];

  const matched: MatchedRegistryTemplate[] = rows.map((row) => {
    const template = rowToTemplate(row);
    const { total } = scoreFingerprintMatch(fingerprint, template.fingerprint);
    return { template, matchScore: total };
  });

  // De-dupe by registry id (the RPC uses UNION ALL which can repeat).
  const dedup = new Map<string, MatchedRegistryTemplate>();
  for (const entry of matched) {
    const existing = dedup.get(entry.template.id);
    if (!existing || entry.matchScore > existing.matchScore) {
      dedup.set(entry.template.id, entry);
    }
  }
  return [...dedup.values()]
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Votes / flags / browse / search were removed in v0.5.9.
//
// The registry is now a passive backend: the only client-driven entry
// points are `findRegistryMatches` (auto-fingerprint lookup on drop)
// and `publishTemplateAuto` (auto-publish on save). There is no UI
// surface for browsing, searching, voting on, or flagging community
// templates, so the corresponding wire endpoints were dead code on
// the client. The server-side tables (`template_submission_votes`,
// `template_submission_flags`) and supporting RLS policies still
// exist server-side and remain harmless — we just don't talk to them.
// ---------------------------------------------------------------------------
