/**
 * Public template-registry client.
 *
 * Backed by Supabase. The whole module silently no-ops when credentials
 * are missing (or haven't been pasted into Settings yet) so the app
 * stays fully functional in local-only mode — see `isRegistryEnabled()`
 * for the gate every UI affordance should use.
 *
 * Server schema lives in `supabase/migrations/`. The table is named
 * `template_submissions`; RLS does the bulk of the policy work, and
 * this module just shapes payloads and adds the `x-device-id` header
 * used by RLS for ownership / vote-dedup.
 *
 * Credentials:
 *   * URL + anon (publishable) key live in the OS keychain via the
 *     `registry_*` Tauri commands (see `services/registrySettings.ts`).
 *     The user pastes them into Settings; no rebuild required.
 *   * `initRegistry()` (re)builds the Supabase client from the cached
 *     credentials. Call it on app startup and after Settings updates.
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
import {
  getRegistryCredentials,
  hasRegistryCredentials,
} from "./registrySettings";
import { scoreFingerprintMatch } from "@/utils/templateFingerprint";

// ---------------------------------------------------------------------------
// Singleton client (rebuilt whenever Settings updates the credentials).
// ---------------------------------------------------------------------------

const SUBMISSIONS_TABLE = "template_submissions";
const VOTES_TABLE = "template_submission_votes";
const FLAGS_TABLE = "template_submission_flags";
const MATCH_RPC = "match_template_submissions_by_fingerprint";

let cachedClient: SupabaseClient | null = null;
let cachedConfigured = false;

function buildClient(url: string, anonKey: string): SupabaseClient {
  // The `x-device-id` header is read by RLS policies (see migration)
  // to gate UPDATE / DELETE on template_submissions and ownership of
  // votes/flags. We set it once on the client and let supabase-js
  // attach it to every request automatically.
  return createClient(url, anonKey, {
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
 * Load credentials from the keychain and build (or rebuild) the
 * Supabase client. Idempotent. Call once on app startup, and again
 * whenever the user saves new credentials in Settings.
 *
 * Returns `true` if the registry is now usable, `false` otherwise.
 */
export async function initRegistry(): Promise<boolean> {
  try {
    const creds = await getRegistryCredentials();
    if (creds.url && creds.anonKey) {
      cachedClient = buildClient(creds.url, creds.anonKey);
      cachedConfigured = true;
    } else {
      cachedClient = null;
      cachedConfigured = false;
    }
  } catch (err) {
    console.warn("[Typeset registry] init failed:", err);
    cachedClient = null;
    cachedConfigured = false;
  }
  return cachedConfigured;
}

/** Force-reload after Settings updates the credentials. */
export async function reloadRegistry(): Promise<boolean> {
  cachedClient = null;
  cachedConfigured = false;
  return initRegistry();
}

/**
 * Sync gate for UI affordances. Reflects the cached state set by the
 * most recent `initRegistry()` / `reloadRegistry()` call. UI code
 * should call `initRegistry()` once at startup and treat this as
 * authoritative thereafter.
 */
export function isRegistryEnabled(): boolean {
  return cachedConfigured && cachedClient !== null;
}

/** Async escape hatch for callers that arrive before init has finished. */
export async function ensureRegistryReady(): Promise<SupabaseClient | null> {
  if (cachedClient) return cachedClient;
  await initRegistry();
  return cachedClient;
}

function getClient(): SupabaseClient | null {
  return cachedClient;
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

export class RegistryDisabledError extends Error {
  constructor() {
    super("Public template registry is not configured.");
    this.name = "RegistryDisabledError";
  }
}

export interface PublishOptions {
  /** Override the displayed template name in the registry. */
  name?: string;
  /** Optional 1-2 sentence description shown on the browse panel. */
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
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
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
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
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
  const client = getClient();
  if (!client) return [];

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

/**
 * Returns the most recent / highest-scored submissions for a "Browse"
 * surface. No fingerprint required.
 */
export async function listFeaturedTemplates(
  limit: number = 50
): Promise<RegistryTemplate[]> {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client
    .from(SUBMISSIONS_TABLE)
    .select("*")
    .eq("is_hidden", false)
    .order("verification_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[Typeset registry] list failed:", error.message);
    return [];
  }
  return ((data as SubmissionRow[] | null) ?? []).map(rowToTemplate);
}

/**
 * Free-text search by submission name. Uses Postgres trigram similarity
 * (the migration creates a gin_trgm_ops index on `name`).
 */
export async function searchTemplates(
  query: string,
  limit: number = 30
): Promise<RegistryTemplate[]> {
  const client = getClient();
  if (!client) return [];
  const trimmed = query.trim();
  if (!trimmed) return listFeaturedTemplates(limit);
  const { data, error } = await client
    .from(SUBMISSIONS_TABLE)
    .select("*")
    .eq("is_hidden", false)
    .ilike("name", `%${trimmed}%`)
    .order("verification_score", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[Typeset registry] search failed:", error.message);
    return [];
  }
  return ((data as SubmissionRow[] | null) ?? []).map(rowToTemplate);
}

// ---------------------------------------------------------------------------
// Connection test (for the Settings "Test connection" button)
// ---------------------------------------------------------------------------

/**
 * Performs a trivial `head: true` count against `template_submissions`
 * so the user can verify their pasted credentials reach a project that
 * has the migration applied. Returns the row count on success; throws
 * with a human-readable message on failure.
 *
 * NOT cached — runs every time the button is clicked.
 */
export async function testRegistryConnection(): Promise<number> {
  if (!(await hasRegistryCredentials())) {
    throw new Error(
      "Paste your Supabase URL and publishable key first, then test the connection."
    );
  }
  // Force a fresh client from the latest stored credentials so testing
  // works even before `initRegistry()` has been re-run after a save.
  const creds = await getRegistryCredentials();
  if (!creds.url || !creds.anonKey) {
    throw new Error(
      "Supabase credentials missing. Paste both the project URL and publishable key."
    );
  }
  const probe = buildClient(creds.url, creds.anonKey);
  const { count, error } = await probe
    .from(SUBMISSIONS_TABLE)
    .select("*", { count: "exact", head: true });
  if (error) {
    const hint = /relation .* does not exist/i.test(error.message)
      ? " — has the SQL migration been applied? See supabase/README.md."
      : "";
    throw new Error(`${error.message}${hint}`);
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Votes & flags
// ---------------------------------------------------------------------------

export type VoteValue = -1 | 0 | 1;

/**
 * Set the current device's vote on a submission. Pass 0 to clear an
 * existing vote. Idempotent — safe to call repeatedly.
 */
export async function voteOnTemplate(
  registryId: string,
  vote: VoteValue
): Promise<void> {
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
  const deviceId = getDeviceId();
  if (vote === 0) {
    const { error } = await client
      .from(VOTES_TABLE)
      .delete()
      .eq("submission_id", registryId)
      .eq("voter_device_id", deviceId);
    if (error) throw new Error(`Vote clear failed: ${error.message}`);
    return;
  }
  const { error } = await client
    .from(VOTES_TABLE)
    .upsert(
      { submission_id: registryId, voter_device_id: deviceId, vote },
      { onConflict: "submission_id,voter_device_id" }
    );
  if (error) throw new Error(`Vote failed: ${error.message}`);
}

export type FlagReason = "spam" | "incorrect" | "pii" | "copyright" | "other";

/**
 * Flag a submission for review. Three flags from distinct devices auto-
 * hide it (handled server-side via trigger).
 */
export async function flagTemplate(
  registryId: string,
  reason: FlagReason,
  detail?: string
): Promise<void> {
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
  const { error } = await client
    .from(FLAGS_TABLE)
    .upsert(
      {
        submission_id: registryId,
        reporter_device_id: getDeviceId(),
        reason,
        detail: detail?.slice(0, 500) ?? null,
      },
      { onConflict: "submission_id,reporter_device_id" }
    );
  if (error) throw new Error(`Flag failed: ${error.message}`);
}
