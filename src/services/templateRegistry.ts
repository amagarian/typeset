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
import { getAuthClient } from "./authClient";
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
  //
  // v0.5.35 — additional `Authorization: Bearer <access_token>`
  // header is attached at request time (not here) via a custom
  // fetch wrapper. We can't bake the access token in at construction
  // because (a) the auth client may not have hydrated yet and (b)
  // the token rotates on refresh. The wrapper reads
  // `getAuthClient().auth.getSession()` per-request — supabase-js
  // serves that out of memory after the first hydrate, so the
  // overhead is negligible (no network round-trip).
  return createClient(REGISTRY_URL, REGISTRY_KEY, {
    global: {
      headers: {
        "x-device-id": getDeviceId(),
      },
      fetch: registryFetch,
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Custom fetch wrapper: add `Authorization: Bearer <token>` when an
 * auth session exists, otherwise fall through to the publishable
 * key + device id auth surface (which is enough for anonymous read
 * + device-bound write under the existing RLS).
 *
 * Anonymous-friendly: if `getAuthClient().auth.getSession()`
 * resolves to null (signed-out user, or web preview) we just
 * return the original request unmodified.
 */
async function registryFetch(
  input: Request | URL | string,
  init?: RequestInit
): Promise<Response> {
  let session = null;
  try {
    const auth = getAuthClient();
    const { data } = await auth.auth.getSession();
    session = data.session;
  } catch {
    // If the auth client isn't available (test, web preview, etc.)
    // we proceed with the anonymous request — the registry has
    // always supported that and continues to in v0.5.35.
  }

  if (!session) {
    return fetch(input, init);
  }

  // Merge an Authorization header on top of whatever supabase-js
  // already wrote (which is `apikey: <publishable>` and our
  // `x-device-id`). Authorization wins server-side: when present,
  // RLS evaluates `auth.uid()` from the JWT instead of the
  // anonymous role. We keep `x-device-id` so legacy device-bound
  // policies (like `votes` / `flags` in the original schema) keep
  // working.
  const merged = new Headers(init?.headers);
  // Don't clobber a caller-supplied Authorization header — they
  // probably know better than we do (e.g. a service-role one-off).
  if (!merged.has("Authorization")) {
    merged.set("Authorization", `Bearer ${session.access_token}`);
  }
  return fetch(input, { ...init, headers: merged });
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

  // v0.6.29 — DO NOT stamp `user_id` on insert. The v0.5.35 RLS
  // policy added `(user_id is null or user_id = auth.uid())` to
  // the WITH CHECK clause, which means any insert that includes
  // `user_id` requires the server to resolve `auth.uid()` to the
  // SAME value — and that only works when the Authorization JWT
  // is valid AND the server's JWT secret matches the one used to
  // sign the token. Any drift (expired token, rotated key,
  // sign-in/sign-out race, server-side migration not applied,
  // supabase-js sending an apikey instead of a Bearer) silently
  // breaks the insert with a confusing RLS error and leaves the
  // user staring at "Saved locally" forever.
  //
  // The fix: always insert with `user_id IS NULL`. The
  // publisher_device_id column already provides ownership for
  // updates / deletes. Signed-in users can claim their rows
  // afterwards via `link_anonymous_device(p_device_id)` — that
  // RPC was designed for exactly this lifecycle (claim every row
  // whose device_id matches and whose user_id is null). The end
  // state is identical to v0.5.35 (rows stamped with both
  // device_id and user_id); we just take a deferred path that
  // doesn't depend on the auth flow being healthy at insert
  // time.
  //
  // If we ever want truly atomic device→user attribution, we can
  // call `link_anonymous_device` immediately after a successful
  // insert when a session is present.
  const insertPayload = {
    ...payload,
    publisher_device_id: deviceId,
  };
  console.log(
    `[Typeset registry] inserting submission — name="${insertPayload.name}" (${
      insertPayload.name.length
    } chars) fields=${insertPayload.fields.length} ` +
      `device_id=${deviceId.length} chars fingerprint_hash=${insertPayload.fingerprint_hash.slice(0, 12)}…`
  );
  const { data, error } = await client
    .from(SUBMISSIONS_TABLE)
    .insert(insertPayload)
    .select()
    .single<SubmissionRow>();
  if (error) {
    console.error(
      "[Typeset registry] Insert rejected — full error:",
      error,
      "payload shape:",
      {
        nameLen: insertPayload.name.length,
        fieldCount: insertPayload.fields.length,
        deviceIdLen: deviceId.length,
        anchorTermsLen: insertPayload.anchor_terms.length,
        pageCount: insertPayload.page_count,
      }
    );
    throw new Error(`Publish failed: ${error.message}`);
  }
  if (!data) throw new Error("Publish failed: empty response.");

  // v0.6.29 — best-effort attribution claim: when the user is
  // signed in at insert time, immediately link the freshly-
  // inserted row to their account via the RPC. Failures are
  // logged but don't fail the publish — the row is already in
  // the registry, the worst case is they have to call
  // `link_anonymous_device` next time they sign in to attach it.
  await claimRowAsUserIfSignedIn(client, deviceId);

  return { created: true, id: data.id, registryRow: rowToTemplate(data) };
}

/**
 * v0.6.29 — call `link_anonymous_device(p_device_id)` to stamp
 * `user_id = auth.uid()` on every row owned by this device. The
 * RPC is idempotent and rate-limit-friendly: it only touches rows
 * whose `user_id is null`. Errors are swallowed (logged) because
 * this runs as a follow-up to a successful insert and we don't
 * want a transient auth failure to surface as a publish failure.
 */
async function claimRowAsUserIfSignedIn(
  client: SupabaseClient,
  deviceId: string
): Promise<void> {
  let session = null;
  try {
    const { data } = await getAuthClient().auth.getSession();
    session = data.session;
  } catch {
    return;
  }
  if (!session) return;
  try {
    const { error } = await client.rpc("link_anonymous_device", {
      p_device_id: deviceId,
    });
    if (error) {
      console.warn(
        "[Typeset registry] link_anonymous_device failed (non-fatal):",
        error.message
      );
    }
  } catch (err) {
    console.warn(
      "[Typeset registry] link_anonymous_device threw (non-fatal):",
      err instanceof Error ? err.message : String(err)
    );
  }
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
