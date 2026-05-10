/**
 * v0.5.24 — Live tally of community-published templates owned by this
 * device.
 *
 * The "contribution count" is the number of distinct PDF fingerprints
 * the user has published to the registry. We dedupe by
 * `fingerprint_hash` because re-saving the same template from the
 * same device produces an UPDATE (see `publishTemplateAuto` in
 * `templateRegistry.ts`) — but if the user historically published
 * multiple rows against the same fingerprint we still count that as
 * one contribution.
 *
 * Persistence model:
 *   * Source of truth: the Supabase `template_submissions` table,
 *     keyed off `publisher_device_id` from `services/deviceId.ts`.
 *   * The device id lives in localStorage today and is derived from
 *     the same anonymous-id system used for registry RLS — so every
 *     query for stats matches the rows the user has actually
 *     published. Re-installing on the same machine preserves the id;
 *     re-installing on a different machine starts a fresh count, by
 *     design.
 *   * Local cache (`localStorage["typeset.contribution.stats"]`) is
 *     just a short-TTL optimisation. On a cold launch we read it
 *     synchronously to render the badge from the last-known value,
 *     then refetch in the background. Cache misses fall through to
 *     Supabase.
 *
 * Mutation model:
 *   * `bumpOptimistic` increments the in-memory + cached count by 1
 *     immediately after `handleSaveTemplate` succeeds publishing. We
 *     also invalidate the cache so the next `fetchContributionStats`
 *     reconciles against the server (which corrects an over-count if
 *     the publish was an UPDATE rather than an INSERT — see the
 *     `created` flag in `publishTemplateAuto`'s outcome).
 *   * Milestones fire from `checkAndFireMilestone(newCount)` so the
 *     caller (App.tsx) can pair the bump with a toast + confetti
 *     burst. The `[1, 5, 10, 25, 50, 100]` ladder is hard-coded and
 *     each milestone fires at most once per device, tracked in
 *     `localStorage["typeset.milestones.reached"]`.
 *
 * Failure model:
 *   * Network / RLS / RPC errors return the cached value if we have
 *     one, otherwise `{ count: 0, submissions: [] }`. We never throw
 *     — the badge is decorative, not load-bearing, and a transient
 *     failure must not surface as a toast.
 */

import { getRegistryClient } from "./templateRegistry";
import { getDeviceId } from "./deviceId";
import { getAuthClient } from "./authClient";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContributionSubmission {
  /** Server-side template_submissions.id (uuid). */
  id: string;
  /** Same fingerprint_hash used to dedupe by; useful for future
   *  "view this submission" affordances. */
  pdfFingerprint: string;
  /** Display name as stored in the registry. */
  templateName: string;
  /** ISO timestamp from the registry (`created_at`). Mapped to the
   *  spec's `submitted_at` name in the row contract. */
  submittedAt: string;
}

export interface ContributionStats {
  /** Distinct-by-fingerprint count of this device's submissions. */
  count: number;
  /** Submissions sorted newest-first. May be longer than `count` only
   *  if a fingerprint was duplicated server-side (in practice, never
   *  — the publish path UPDATEs same-fingerprint rows). */
  submissions: ContributionSubmission[];
}

// ---------------------------------------------------------------------------
// Storage / cache
// ---------------------------------------------------------------------------

const CACHE_KEY = "typeset.contribution.stats";
const MILESTONES_KEY = "typeset.milestones.reached";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEnvelope {
  count: number;
  submissions: ContributionSubmission[];
  fetchedAt: number;
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readCache(): CacheEnvelope | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope;
    if (
      typeof parsed?.count !== "number" ||
      !Array.isArray(parsed?.submissions) ||
      typeof parsed?.fetchedAt !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(envelope: CacheEnvelope): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
  } catch {
    /* quota / private mode — silently fall back to in-memory only */
  }
}

function invalidateCache(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// In-memory snapshot — survives across `fetch` calls in the same
// session and is what `bumpOptimistic` mutates synchronously so
// every subscriber sees the new count on the very next render.
let memorySnapshot: ContributionStats | null = null;

// Promise dedup: multiple consumers calling `fetchContributionStats`
// in the same tick (e.g. badge mount + popover open) collapse onto
// one network round-trip.
let inflight: Promise<ContributionStats> | null = null;

// ---------------------------------------------------------------------------
// Event bus — module-level EventTarget so all `useContributionStats`
// consumers re-render on bump / refetch without prop drilling.
// ---------------------------------------------------------------------------

const STATS_EVENT = "contribution-stats-changed";
export const contributionStatsBus: EventTarget = new EventTarget();

function emitChange(): void {
  contributionStatsBus.dispatchEvent(new Event(STATS_EVENT));
}

export function subscribeContributionStats(handler: () => void): () => void {
  contributionStatsBus.addEventListener(STATS_EVENT, handler);
  return () => contributionStatsBus.removeEventListener(STATS_EVENT, handler);
}

// ---------------------------------------------------------------------------
// Snapshot accessors (sync)
// ---------------------------------------------------------------------------

/**
 * Returns the best-effort current snapshot without touching the
 * network. Order of preference: in-memory → cache → empty.
 */
export function readSnapshot(): ContributionStats {
  if (memorySnapshot) return memorySnapshot;
  const cached = readCache();
  if (cached) {
    memorySnapshot = { count: cached.count, submissions: cached.submissions };
    return memorySnapshot;
  }
  return { count: 0, submissions: [] };
}

// ---------------------------------------------------------------------------
// Server fetch
// ---------------------------------------------------------------------------

interface SubmissionRow {
  id: string;
  name: string;
  fingerprint_hash: string;
  created_at: string;
}

async function fetchFromServer(): Promise<ContributionStats> {
  const client = getRegistryClient();
  const deviceId = getDeviceId();

  // v0.5.35 — when signed in, the user's contributions span both
  // (a) legacy rows still keyed only on `publisher_device_id` from
  // this or any other device they used pre-sign-in (the
  // `link_anonymous_device` RPC will have stamped them with their
  // user_id at sign-in time, but we OR on device_id too so a
  // pending sign-in or a missed RPC call doesn't drop the count to
  // zero), and (b) all rows where `user_id` matches their auth uid.
  //
  // For anonymous users (no session) we keep the device-only filter
  // — `or` on a missing field would 400 the request, so we branch
  // explicitly.
  let userId: string | null = null;
  try {
    const { data } = await getAuthClient().auth.getSession();
    userId = data.session?.user.id ?? null;
  } catch {
    /* no auth client available (web preview) */
  }

  let query = client
    .from("template_submissions")
    .select("id, name, fingerprint_hash, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (userId) {
    // PostgREST `.or()` syntax — comma-separated leaf filters,
    // wrapped in parens for grouping. We escape the device id /
    // user id as quoted strings to be safe even though both are
    // UUID-shaped today.
    query = query.or(
      `publisher_device_id.eq."${deviceId}",user_id.eq."${userId}"`
    );
  } else {
    query = query.eq("publisher_device_id", deviceId);
  }

  const { data, error } = await query;

  if (error) throw error;

  const rows = (data as SubmissionRow[] | null) ?? [];

  // Dedupe by fingerprint_hash, preserving the newest row per group.
  // Rows are already ordered desc by created_at so the first time we
  // see a fingerprint is the row we want to keep. (Same fingerprint
  // could legitimately appear twice when a row published anonymously
  // on this device and a row published from another device under the
  // user's account both match — we still only count the form once.)
  const seen = new Set<string>();
  const submissions: ContributionSubmission[] = [];
  for (const row of rows) {
    if (seen.has(row.fingerprint_hash)) continue;
    seen.add(row.fingerprint_hash);
    submissions.push({
      id: row.id,
      pdfFingerprint: row.fingerprint_hash,
      templateName: row.name,
      submittedAt: row.created_at,
    });
  }

  return { count: submissions.length, submissions };
}

/**
 * Public entry point. Honours the 5-minute TTL on the localStorage
 * cache and dedupes concurrent calls onto a single inflight promise.
 *
 * Pass `{ force: true }` (used by the optimistic-increment path) to
 * skip the cache and reconcile against the server immediately.
 */
export async function fetchContributionStats(
  options: { force?: boolean } = {}
): Promise<ContributionStats> {
  if (!options.force) {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const snapshot: ContributionStats = {
        count: cached.count,
        submissions: cached.submissions,
      };
      memorySnapshot = snapshot;
      return snapshot;
    }
  }

  if (inflight) return inflight;

  inflight = (async (): Promise<ContributionStats> => {
    try {
      const fresh = await fetchFromServer();
      memorySnapshot = fresh;
      writeCache({ ...fresh, fetchedAt: Date.now() });
      emitChange();
      return fresh;
    } catch (err) {
      console.warn("[ContributionStats] fetch failed", err);
      // Fall back to whatever we have — cache > empty.
      const fallback = readSnapshot();
      memorySnapshot = fallback;
      return fallback;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// ---------------------------------------------------------------------------
// Optimistic mutation
// ---------------------------------------------------------------------------

/**
 * Bumps the in-memory + cached count by 1 immediately. The caller
 * should follow up with `fetchContributionStats({ force: true })`
 * (typically scheduled a tick later) so the count reconciles back to
 * the server's view — the bump is provisional because a re-publish
 * of an existing template is an UPDATE, not an INSERT, and shouldn't
 * actually change the count.
 *
 * Returns the new optimistic count so milestone checks can hand it
 * straight to `checkAndFireMilestone`.
 */
export function bumpOptimistic(): number {
  const current = readSnapshot();
  const nextCount = current.count + 1;
  memorySnapshot = { count: nextCount, submissions: current.submissions };
  // Mark cache stale so the next non-forced fetch will refresh.
  invalidateCache();
  emitChange();
  return nextCount;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export const MILESTONES: readonly number[] = [1, 5, 10, 25, 50, 100];

const MILESTONE_COPY: Record<number, string> = {
  1: "First template shared!",
  5: "5 templates — you're a contributor",
  10: "10 templates — keeping the community fed",
  25: "25 templates — community veteran",
  50: "50 templates — community pillar",
  100: "100 templates — community legend",
};

export interface MilestoneEvent {
  milestone: number;
  message: string;
}

function readReachedMilestones(): number[] {
  if (!canUseStorage()) return [];
  try {
    const raw = window.localStorage.getItem(MILESTONES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number");
  } catch {
    return [];
  }
}

function writeReachedMilestones(reached: number[]): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(MILESTONES_KEY, JSON.stringify(reached));
  } catch {
    /* ignore */
  }
}

/**
 * If `newCount` matches an unreached milestone, returns the matching
 * MilestoneEvent and persists it as fired. Otherwise returns null.
 *
 * Once-only semantics rely entirely on the persisted set in
 * `localStorage["typeset.milestones.reached"]`, so a milestone that
 * fires after a count has been bumped above it (eg. user hits 5,
 * then deletes a template, then re-shares) won't fire again.
 */
export function checkAndFireMilestone(newCount: number): MilestoneEvent | null {
  if (!MILESTONES.includes(newCount)) return null;
  const reached = readReachedMilestones();
  if (reached.includes(newCount)) return null;
  const message = MILESTONE_COPY[newCount];
  if (!message) return null;
  writeReachedMilestones([...reached, newCount]);
  return { milestone: newCount, message };
}
