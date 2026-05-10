/**
 * v0.5.35 — End-to-end encrypted project sync engine.
 *
 * When a user is signed in, this module:
 *
 *   - On sign-in, performs a full reconcile: fetch every server
 *     project for the user, decrypt with the per-account sync key
 *     (services/syncKey.ts), merge into the local store using
 *     `modifiedAt` last-write-wins, and push any locally-only
 *     projects up.
 *   - On every local autosave (via `pushProject`), encrypts the
 *     project and upserts its row server-side.
 *   - On every local delete (via `pushDelete`), removes the row
 *     server-side.
 *   - Subscribes to Postgres realtime changes for the user's
 *     `public.projects` rows so multi-device updates flow in
 *     within a few hundred ms. As a fallback (Wifi flap, realtime
 *     disconnect), `refreshOnFocus()` polls "everything since X"
 *     each time the window regains focus.
 *
 * Anonymous users see exactly the same `useProjects` behaviour as
 * pre-v0.5.35: the autosave goes to local Keychain-encrypted
 * storage and this module's exports are no-ops. The wiring in
 * `useProjects` only enters the sync path when `getCurrentSession()`
 * resolves to a non-null session.
 *
 * ## Encryption envelope
 *
 *   {
 *     id:               <uuid, mirrored to row PK>,
 *     ciphertext:       AES-256-GCM(plaintext, sync_key, nonce),
 *     nonce:            12 bytes random,
 *     modified_at:      iso-string from Project.modifiedAt,
 *     schema_version:   1
 *   }
 *
 * Plaintext is the JSON-encoded `Project` object. We include the
 * full Project (not Project minus id) to keep decrypt simple.
 *
 * ## Conflict resolution
 *
 * Per-row last-write-wins on `modifiedAt`. Realtime + the focus
 * fallback both go through the same merge path, so a row that
 * arrives via realtime AND via the focus poll resolves to the same
 * answer either way. There is no merging within a row's payload —
 * a write to the same field on two devices that haven't synced
 * resolves to "the device whose autosave fires later wins".
 *
 * ## Why TS-side WebCrypto, not Rust
 *
 * The renderer is online for sync, has the key in memory, and
 * WebCrypto is hardware-accelerated. Routing through Tauri would
 * add an IPC hop per row (~0.5ms) for no security gain — the key
 * is already in renderer memory once `services/syncKey.ts` has
 * imported it. We keep encrypt/decrypt in `projectSync.ts` for
 * iteration speed.
 */

import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import type { Project } from "@/types";
import { getAuthClient } from "./authClient";
import { getOrCreateSyncKey } from "./syncKey";

const PROJECTS_TABLE = "projects";
const SCHEMA_VERSION = 1;
const NONCE_BYTES = 12;

// ---------------------------------------------------------------------------
// Wire shape — matches the SQL columns 1:1.
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  user_id: string;
  ciphertext: string; // bytea sent over JSON as `\x...` hex
  nonce: string;
  modified_at: string;
  server_updated_at: string;
  schema_version: number;
}

// ---------------------------------------------------------------------------
// bytea helpers — Supabase serialises `bytea` as the Postgres `\x...`
// hex format on read. On write, we send raw bytes via base64 in
// Uint8Array form — the JS client converts to bytea automatically
// when the column is typed bytea.
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("\\x") ? hex.slice(2) : hex;
  const len = Math.floor(stripped.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHexLiteral(bytes: Uint8Array): string {
  // Postgres bytea hex literal — works as the on-the-wire form
  // when supabase-js sends a string into a bytea column.
  let out = "\\x";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

interface EncryptedPayload {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

async function encryptProject(project: Project): Promise<EncryptedPayload> {
  const key = await getOrCreateSyncKey();
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(project));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext)
  );
  return { ciphertext, nonce };
}

async function decryptRow(row: ProjectRow): Promise<Project | null> {
  try {
    const key = await getOrCreateSyncKey();
    const ciphertext = hexToBytes(row.ciphertext);
    const nonce = hexToBytes(row.nonce);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext
    );
    const json = new TextDecoder().decode(plaintext);
    const parsed = JSON.parse(json) as Project;
    // Don't trust the embedded id over the row PK — they should
    // match, but if there's drift the row PK is the canonical
    // identity (it's what RLS and realtime key on).
    parsed.id = row.id;
    return parsed;
  } catch (err) {
    console.warn(
      "[projectSync] decrypt failed for row",
      row.id,
      "—",
      "skipping. (Wrong sync key? Different account?)",
      err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public sync result types
// ---------------------------------------------------------------------------

export interface ProjectSyncResult {
  /** Server projects that were missing locally (decrypt + insert). */
  pulled: Project[];
  /** Local projects pushed up (newly created or stale-on-server). */
  pushed: number;
  /**
   * Local projects whose `modifiedAt` was older than the server copy
   * — the merger replaced them in place. Caller (useProjects) must
   * splat these back into local state.
   */
  replacedLocal: Project[];
}

export interface PullDeltaItem {
  kind: "upsert" | "delete";
  id: string;
  project?: Project;
}

// ---------------------------------------------------------------------------
// Initial sync — full reconcile.
//
// Cheaper than it sounds: at the cardinalities we expect (single-
// digit hundreds of projects max per user), one request fetches
// every row in a single response. Decrypt happens in parallel via
// Promise.all. The merge is O(n + m) on a Map keyed by id.
// ---------------------------------------------------------------------------

export async function fullReconcile(
  localProjects: Project[]
): Promise<ProjectSyncResult> {
  const client = getAuthClient();
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) {
    return { pulled: [], pushed: 0, replacedLocal: [] };
  }

  const { data, error } = await client
    .from(PROJECTS_TABLE)
    .select("*")
    .order("modified_at", { ascending: false });

  if (error) {
    throw new Error(`Sync fetch failed: ${error.message}`);
  }

  const rows = (data as ProjectRow[] | null) ?? [];
  const decrypted = (
    await Promise.all(rows.map((row) => decryptRow(row)))
  ).filter((p): p is Project => p !== null);

  const remoteById = new Map<string, Project>();
  for (const project of decrypted) remoteById.set(project.id, project);

  const localById = new Map<string, Project>();
  for (const project of localProjects) localById.set(project.id, project);

  const pulled: Project[] = [];
  const replacedLocal: Project[] = [];
  const pushQueue: Project[] = [];

  // Pass 1: every server project that the local doesn't have →
  // pull. Every server project where the local copy is older →
  // replace locally. Every server project where the local copy
  // is newer → queue for push.
  for (const remote of decrypted) {
    const local = localById.get(remote.id);
    if (!local) {
      pulled.push(remote);
      continue;
    }
    const localTs = local.modifiedAt ?? 0;
    const remoteTs = remote.modifiedAt ?? 0;
    if (remoteTs > localTs) {
      replacedLocal.push(remote);
    } else if (localTs > remoteTs) {
      pushQueue.push(local);
    }
    // Equal timestamps → assume same revision, skip.
  }

  // Pass 2: every local project the server doesn't have → push.
  for (const local of localProjects) {
    if (!remoteById.has(local.id)) pushQueue.push(local);
  }

  await Promise.all(pushQueue.map((project) => pushProject(project)));

  return { pulled, pushed: pushQueue.length, replacedLocal };
}

// ---------------------------------------------------------------------------
// Push a single project (upsert).
//
// Called by `useProjects` on autosave. Resolves once the row is
// committed server-side; if Supabase is unreachable, the local
// save has already happened and the next focus-poll will catch up.
// ---------------------------------------------------------------------------

export async function pushProject(project: Project): Promise<void> {
  const client = getAuthClient();
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) return;

  const { ciphertext, nonce } = await encryptProject(project);

  const row = {
    id: project.id,
    user_id: sessionData.session.user.id,
    ciphertext: bytesToHexLiteral(ciphertext),
    nonce: bytesToHexLiteral(nonce),
    modified_at: new Date(project.modifiedAt ?? Date.now()).toISOString(),
    schema_version: SCHEMA_VERSION,
  };

  const { error } = await client
    .from(PROJECTS_TABLE)
    .upsert(row, { onConflict: "id" });
  if (error) {
    throw new Error(`Sync push failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Push a delete.
// ---------------------------------------------------------------------------

export async function pushDelete(id: string): Promise<void> {
  const client = getAuthClient();
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) return;

  const { error } = await client.from(PROJECTS_TABLE).delete().eq("id", id);
  if (error) {
    throw new Error(`Sync delete failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Realtime subscription
// ---------------------------------------------------------------------------

let activeChannel: RealtimeChannel | null = null;

export interface RealtimeSubscriberHandlers {
  onUpsert(project: Project): void;
  onDelete(id: string): void;
}

/**
 * Subscribe to `postgres_changes` on `public.projects` for the
 * current user's rows. Idempotent — calling twice replaces the
 * previous channel. Returns a `() => void` unsubscribe.
 *
 * The realtime payload includes only the row's bytea columns in
 * hex form (Postgres replicates them that way). We re-decrypt
 * each upsert here instead of forwarding the encrypted blob to
 * the caller — the renderer never sees ciphertext.
 */
export async function subscribeRealtime(
  handlers: RealtimeSubscriberHandlers
): Promise<() => void> {
  const client = getAuthClient();
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) return () => {};

  await unsubscribeRealtime();

  const userId = sessionData.session.user.id;
  const channel = client.channel(`typeset-projects-${userId}`);
  channel.on(
    "postgres_changes" as never,
    {
      event: "*",
      schema: "public",
      table: PROJECTS_TABLE,
      filter: `user_id=eq.${userId}`,
    },
    (payload: RealtimePostgresChangesPayload<ProjectRow>) => {
      void handleRealtimePayload(payload, handlers);
    }
  );
  await channel.subscribe();
  activeChannel = channel;

  return () => {
    void unsubscribeRealtime();
  };
}

async function handleRealtimePayload(
  payload: RealtimePostgresChangesPayload<ProjectRow>,
  handlers: RealtimeSubscriberHandlers
): Promise<void> {
  if (payload.eventType === "DELETE") {
    const oldId =
      (payload.old as Partial<ProjectRow> | null | undefined)?.id ?? null;
    if (oldId) handlers.onDelete(oldId);
    return;
  }
  const row = payload.new as ProjectRow | null;
  if (!row) return;
  const project = await decryptRow(row);
  if (project) handlers.onUpsert(project);
}

export async function unsubscribeRealtime(): Promise<void> {
  if (!activeChannel) return;
  try {
    await getAuthClient().removeChannel(activeChannel);
  } catch (err) {
    console.warn("[projectSync] realtime unsubscribe failed:", err);
  }
  activeChannel = null;
}

// ---------------------------------------------------------------------------
// Polling fallback (focus-driven)
//
// In case realtime drops, we re-pull "everything since X" on every
// window focus. The window between two focuses is small enough
// that fetching everything (rather than tracking server_updated_at
// cursors per session) is fine at v0.5.35 cardinalities.
// ---------------------------------------------------------------------------

export async function pullAll(): Promise<PullDeltaItem[]> {
  const client = getAuthClient();
  const { data: sessionData } = await client.auth.getSession();
  if (!sessionData.session) return [];

  const { data, error } = await client.from(PROJECTS_TABLE).select("*");
  if (error) {
    throw new Error(`Sync poll failed: ${error.message}`);
  }
  const rows = (data as ProjectRow[] | null) ?? [];
  const decrypted = (
    await Promise.all(rows.map((row) => decryptRow(row)))
  ).filter((p): p is Project => p !== null);
  return decrypted.map(
    (project): PullDeltaItem => ({
      kind: "upsert",
      id: project.id,
      project,
    })
  );
}
