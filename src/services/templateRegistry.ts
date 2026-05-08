/**
 * Public template-registry client.
 *
 * Backed by Supabase. The whole module silently no-ops when env vars
 * are missing so the app stays fully functional in local-only mode —
 * see `isRegistryEnabled()` for the gate every UI affordance should
 * use.
 *
 * Server schema lives in `supabase/migrations/`. RLS does the bulk of
 * the policy work; this module just shapes payloads and adds the
 * `x-device-id` header used by RLS for ownership / vote-dedup.
 *
 * Matching:
 *   1. Client computes a `TemplateFingerprint` (already done locally).
 *   2. Calls `match_templates_by_fingerprint` RPC — Postgres returns
 *      the top N candidates by anchor-term overlap + verification
 *      score. Cheap (gin index on text[]).
 *   3. Client re-scores candidates with the same `scoreFingerprintMatch`
 *      used for the local registry. Single source of truth → identical
 *      ranking semantics whether the template is local or remote.
 *
 * Publishing:
 *   * Sanitises the local Template (strips ids, custom values) before
 *     uploading. Registry rows only contain field schemas + coords —
 *     never user-entered values, never the source PDF.
 *   * Publisher device id ships in the row + the `x-device-id` header,
 *     enabling self-service updates / deletes.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  Template,
  TemplateField,
  TemplateFingerprint,
} from "@/types";
import { getDeviceId } from "./deviceId";
import { scoreFingerprintMatch } from "@/utils/templateFingerprint";

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";

let cachedClient: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (cachedClient) return cachedClient;
  // The `x-device-id` header is read by RLS policies (see migration)
  // to gate UPDATE / DELETE on registry_templates and ownership of
  // votes/flags. We set it once on the client and let supabase-js
  // attach it to every request automatically.
  cachedClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
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
  return cachedClient;
}

/**
 * Returns true if the registry is configured. Every UI affordance that
 * touches the registry should gate on this — when it's false, the app
 * still works fully but nothing related to publishing / browsing is
 * exposed.
 */
export function isRegistryEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// ---------------------------------------------------------------------------
// Wire types — match the SQL schema 1:1.
// ---------------------------------------------------------------------------

interface RegistryRow {
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
 * What the UI sees. We rename a few snake_case columns into camelCase
 * for ergonomics, and tag each row with `isMine` so the browse UI can
 * surface "Edit" instead of "Install" on the user's own publishes.
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

function rowToTemplate(row: RegistryRow): RegistryTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    fingerprintHash: row.fingerprint_hash,
    fingerprint: row.fingerprint,
    pageCount: row.page_count,
    fieldCount: row.field_count ?? row.fields.length ?? 0,
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
 * coords, fieldKind, fieldType, detectionSource, anchorText,
 * checkboxValue, promptLabel, optional, contextSnippet,
 * estimatedFontSize, sectionId, groupId, confidence(Details).
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
 * Publish a local Template to the public registry. The template must
 * have a fingerprint — generate one with `buildPdfFingerprint` /
 * `buildTemplateFingerprintFromTemplate` before calling.
 */
export async function publishTemplate(
  template: Template,
  options: PublishOptions = {}
): Promise<PublishResult> {
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
  if (!template.fingerprint) {
    throw new Error("Template is missing a fingerprint; refusing to publish.");
  }
  if (template.fields.length === 0) {
    throw new Error("Template has no fields; refusing to publish.");
  }

  const fp = template.fingerprint;
  const sanitisedFields = template.fields.map(sanitiseField);
  const payload = {
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
    publisher_device_id: getDeviceId(),
  };

  const { data, error } = await client
    .from("registry_templates")
    .insert(payload)
    .select()
    .single<RegistryRow>();

  if (error) throw new Error(`Publish failed: ${error.message}`);
  if (!data) throw new Error("Publish failed: empty response.");

  return { registryId: data.id, registryRow: rowToTemplate(data) };
}

/**
 * Update a template that the current device originally published.
 * Fails (RLS) if `publisher_device_id` doesn't match.
 */
export async function updatePublishedTemplate(
  registryId: string,
  template: Template,
  options: PublishOptions = {}
): Promise<RegistryTemplate> {
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
  if (!template.fingerprint) {
    throw new Error("Template is missing a fingerprint; refusing to update.");
  }
  const fp = template.fingerprint;
  const sanitisedFields = template.fields.map(sanitiseField);
  const payload = {
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
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await client
    .from("registry_templates")
    .update(payload)
    .eq("id", registryId)
    .select()
    .single<RegistryRow>();
  if (error) throw new Error(`Update failed: ${error.message}`);
  if (!data) throw new Error("Update failed: empty response.");
  return rowToTemplate(data);
}

/**
 * Delete a template you own. RLS enforces ownership.
 */
export async function deletePublishedTemplate(registryId: string): Promise<void> {
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
  const { error } = await client
    .from("registry_templates")
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

  const { data, error } = await client.rpc("match_templates_by_fingerprint", {
    p_fingerprint_hash: fingerprint.fingerprintHash,
    p_page_count: fingerprint.pageCount,
    p_anchor_terms: fingerprint.anchorTerms,
    p_limit: Math.max(1, Math.min(limit * 2, 32)),
  });

  if (error) {
    console.warn("[Typeset registry] match RPC failed:", error.message);
    return [];
  }
  const rows = (data as RegistryRow[] | null) ?? [];

  // Re-score with the same matcher used for local templates so the
  // ranking is identical regardless of source.
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
 * Returns the most recent / highest-scored templates for a "Browse"
 * surface. No fingerprint required.
 */
export async function listFeaturedTemplates(limit: number = 50): Promise<RegistryTemplate[]> {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client
    .from("registry_templates")
    .select("*")
    .eq("is_hidden", false)
    .order("verification_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[Typeset registry] list failed:", error.message);
    return [];
  }
  return ((data as RegistryRow[] | null) ?? []).map(rowToTemplate);
}

/**
 * Free-text search by template name. Uses Postgres trigram similarity
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
    .from("registry_templates")
    .select("*")
    .eq("is_hidden", false)
    .ilike("name", `%${trimmed}%`)
    .order("verification_score", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[Typeset registry] search failed:", error.message);
    return [];
  }
  return ((data as RegistryRow[] | null) ?? []).map(rowToTemplate);
}

// ---------------------------------------------------------------------------
// Votes & flags
// ---------------------------------------------------------------------------

export type VoteValue = -1 | 0 | 1;

/**
 * Set the current device's vote on a template. Pass 0 to clear an
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
      .from("registry_votes")
      .delete()
      .eq("template_id", registryId)
      .eq("voter_device_id", deviceId);
    if (error) throw new Error(`Vote clear failed: ${error.message}`);
    return;
  }
  // upsert: works for both first-time and changing vote direction.
  const { error } = await client
    .from("registry_votes")
    .upsert(
      { template_id: registryId, voter_device_id: deviceId, vote },
      { onConflict: "template_id,voter_device_id" }
    );
  if (error) throw new Error(`Vote failed: ${error.message}`);
}

export type FlagReason = "spam" | "incorrect" | "pii" | "copyright" | "other";

/**
 * Flag a template for review. Three flags from distinct devices auto-
 * hide the template (handled server-side via trigger).
 */
export async function flagTemplate(
  registryId: string,
  reason: FlagReason,
  detail?: string
): Promise<void> {
  const client = getClient();
  if (!client) throw new RegistryDisabledError();
  const { error } = await client
    .from("registry_flags")
    .upsert(
      {
        template_id: registryId,
        reporter_device_id: getDeviceId(),
        reason,
        detail: detail?.slice(0, 500) ?? null,
      },
      { onConflict: "template_id,reporter_device_id" }
    );
  if (error) throw new Error(`Flag failed: ${error.message}`);
}
