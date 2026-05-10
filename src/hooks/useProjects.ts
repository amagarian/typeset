/**
 * v0.5.28 — canonical project state hook.
 * v0.5.35 — sync layer added: when a user is signed in, every local
 *           autosave also pushes to Supabase via `services/projectSync.ts`,
 *           and a server-side change (realtime or focus poll) merges
 *           into `projects` via the same code path local edits use.
 *
 * Replaces the `useState<Project[]>(mockProjects)` that lived in
 * App.tsx through v0.5.27. Owns the in-memory project list, drives
 * the debounced autosave to the encrypted on-disk store, and
 * exposes the save status that the "Saved ✓" indicator subscribes
 * to.
 *
 * ## Mutation semantics
 *
 * `createProject` / `updateProject` / `deleteProject` are all
 * synchronous from the caller's POV — they update React state
 * immediately (optimistic) and schedule a debounced save. Read-back
 * happens through the `projects` array; there is no async API for
 * the renderer to await.
 *
 * ## Debounce
 *
 * Each mutation resets a 500ms timer. The save fires on the trailing
 * edge — i.e. 500ms after the last keystroke. Edits during an
 * in-flight save schedule a follow-up save once the current one
 * completes (the Rust mutex serialises overlapping calls anyway, so
 * this is purely about avoiding wasted work, not correctness).
 *
 * On mount, the hook does an initial `loadProjects()` and switches
 * `loadStatus` from `"loading"` to `"ready"`. While `loading`, the
 * `projects` array is empty — the UI shouldn't render its main
 * content until `loadStatus === "ready"`, but it can render the
 * shell (sidebar, header) without blocking.
 *
 * ## Save status state machine
 *
 *   idle  -- mutation -- (debounce 500ms) --> saving
 *   saving -- save resolves --> saved
 *   saved -- 1s hold --> idle
 *   saving -- save rejects --> error
 *
 * The 1-second `saved` hold drives the "Saved ✓" indicator's fade-out.
 *
 * ## Sync status state machine (v0.5.35)
 *
 * Independent of `saveStatus` — local persistence and remote sync
 * are different concerns and can fail independently:
 *
 *   idle    — signed out, or signed in and nothing in flight.
 *   syncing — at least one in-flight push/pull/full-reconcile.
 *   synced  — held for 1s after the last successful sync, then idle.
 *   error   — last attempt failed; we keep retrying on the next
 *             local mutation and on every focus poll.
 *   offline — placeholder for when navigator.onLine === false.
 *             Reverts to `idle` automatically when online again.
 *
 * Anonymous users (signed-out) only ever see `syncStatus === "idle"`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/types";
import {
  loadProjects as loadProjectsFromDisk,
  saveProjects as saveProjectsToDisk,
  newProjectId,
} from "@/services/projectStore";
import {
  fullReconcile,
  pullAll,
  pushDelete,
  pushProject,
  subscribeRealtime,
  unsubscribeRealtime,
} from "@/services/projectSync";
import { onAuthStateChange, getCurrentSession } from "@/services/authClient";
import { forgetSyncKey } from "@/services/syncKey";

/** Debounce window for autosave. Long enough to coalesce a full
 *  field's typing, short enough that the "Saved ✓" indicator feels
 *  responsive (~half a second after the user stops). */
const AUTOSAVE_DEBOUNCE_MS = 500;

/** How long to hold the `saved` state before reverting to `idle`. */
const SAVED_HOLD_MS = 1000;

export type LoadStatus = "loading" | "ready" | "error";
export type SaveStatus = "idle" | "saving" | "saved" | "error";
export type SyncStatus = "idle" | "syncing" | "synced" | "error" | "offline";

export interface UseProjectsResult {
  projects: Project[];
  /** Insert a fresh project with a stable UUID. Returns the inserted
   *  project (caller usually wants its `id` to navigate to). */
  createProject(initial?: Partial<Project>): Project;
  updateProject(id: string, patch: Partial<Project>): void;
  deleteProject(id: string): void;
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  syncStatus: SyncStatus;
  /** When `loadStatus === "error"` or `saveStatus === "error"`. */
  error: string | null;
  /** When sync is in `error` state, the last failure reason. */
  syncError: string | null;
  /**
   * Manually flush a pending debounced save. Useful for "before
   * window close" hooks (we don't currently use it, but it's cheap
   * to expose). Returns the save promise — resolves when the disk
   * write completes.
   */
  flushSave(): Promise<void>;
}

/**
 * Returns a fresh empty Project with a stable UUID. Centralised so
 * that any callers that allow their own initial values (e.g. a
 * "duplicate this project" flow later) can splat them on top of a
 * known-good base. The string `createdAt`/`updatedAt` are kept for
 * compatibility with the existing UI sort order; `modifiedAt` is
 * the v0.5.29-aligned numeric clock.
 */
function freshProject(initial: Partial<Project> = {}): Project {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  return {
    id: newProjectId(),
    label: "",
    jobName: "",
    jobNumber: "",
    poNumber: "",
    authorizationDate: "",
    shootDate: "",
    productionCompany: "",
    billingAddress: "",
    billingCity: "",
    billingState: "",
    billingZipCode: "",
    producer: "",
    email: "",
    phone: "",
    creditCardType: "",
    creditCardHolder: "",
    cardholderSignature: "",
    creditCardNumber: "",
    expDate: "",
    ccv: "",
    createdAt: nowIso,
    updatedAt: nowIso,
    modifiedAt: nowMs,
    ...initial,
  };
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Always-current view of the project list, for the debounce
  // closure to read at fire time. Avoids stale closures when the
  // user types into multiple fields between debounce ticks.
  const projectsRef = useRef<Project[]>(projects);
  projectsRef.current = projects;

  const debounceTimerRef = useRef<number | null>(null);
  const savedHoldTimerRef = useRef<number | null>(null);
  // Tracks the in-flight save Promise so we can chain a follow-up
  // save when an edit lands during a write. Without this, fast-typed
  // edits could land between "save fires" and "save resolves", and
  // the post-resolve `saved` state would clobber the new "saving".
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const pendingFollowupRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(true);
  const syncedHoldTimerRef = useRef<number | null>(null);

  // Last-known signed-in user id. We watch the auth state and run
  // the full-reconcile pipeline whenever this transitions from
  // null → user-id (initial sign-in) or between two different
  // user-ids (account switch on the same machine).
  const signedInUserRef = useRef<string | null>(null);

  // Set of remote-driven IDs that arrived via realtime/poll within
  // the last few hundred ms. We use this to suppress "echo" pushes
  // — if we naively push every mutation that lands via setProjects,
  // we'd push the just-decrypted realtime payload right back to the
  // server in an infinite loop. The set is cleared automatically as
  // each id ages out (~2s).
  const remoteEchoRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      if (savedHoldTimerRef.current !== null) {
        window.clearTimeout(savedHoldTimerRef.current);
      }
      if (syncedHoldTimerRef.current !== null) {
        window.clearTimeout(syncedHoldTimerRef.current);
      }
    };
  }, []);

  // Initial load. Runs once on mount; failures keep the app
  // usable (empty list) but surface through `error` so the App
  // shell can show a toast / Settings affordance.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initial = await loadProjectsFromDisk();
        if (cancelled) return;
        setProjects(initial);
        setLoadStatus("ready");
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[Typeset] loadProjects failed:", err);
        setError(message);
        setLoadStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ------------------------------------------------------------------
  // Sync status helpers
  // ------------------------------------------------------------------

  const markSyncing = useCallback(() => {
    if (syncedHoldTimerRef.current !== null) {
      window.clearTimeout(syncedHoldTimerRef.current);
      syncedHoldTimerRef.current = null;
    }
    setSyncStatus("syncing");
    setSyncError(null);
  }, []);

  const markSynced = useCallback(() => {
    setSyncStatus("synced");
    setSyncError(null);
    if (syncedHoldTimerRef.current !== null) {
      window.clearTimeout(syncedHoldTimerRef.current);
    }
    syncedHoldTimerRef.current = window.setTimeout(() => {
      syncedHoldTimerRef.current = null;
      if (mountedRef.current) setSyncStatus("idle");
    }, SAVED_HOLD_MS);
  }, []);

  const markSyncError = useCallback((message: string) => {
    setSyncStatus("error");
    setSyncError(message);
  }, []);

  // ------------------------------------------------------------------
  // Remote echo tracking — suppress "I just got this from the server,
  // don't push it right back" round-trips.
  // ------------------------------------------------------------------

  const noteRemoteEcho = useCallback((id: string) => {
    remoteEchoRef.current.set(id, Date.now());
  }, []);

  const consumeRemoteEcho = useCallback((id: string): boolean => {
    const ts = remoteEchoRef.current.get(id);
    if (ts === undefined) return false;
    if (Date.now() - ts > 2000) {
      remoteEchoRef.current.delete(id);
      return false;
    }
    remoteEchoRef.current.delete(id);
    return true;
  }, []);

  const mergeProjectFromRemote = useCallback(
    (project: Project) => {
      noteRemoteEcho(project.id);
      setProjects((prev) => {
        const idx = prev.findIndex((p) => p.id === project.id);
        if (idx === -1) {
          return [...prev, project];
        }
        const existing = prev[idx];
        const existingTs = existing.modifiedAt ?? 0;
        const incomingTs = project.modifiedAt ?? 0;
        if (incomingTs <= existingTs) {
          // Local copy is newer or equal — keep it. The remote will
          // catch up on the next push.
          return prev;
        }
        const next = [...prev];
        next[idx] = project;
        return next;
      });
    },
    [noteRemoteEcho]
  );

  const removeProjectFromRemote = useCallback(
    (id: string) => {
      noteRemoteEcho(id);
      setProjects((prev) => {
        const idx = prev.findIndex((p) => p.id === id);
        if (idx === -1) return prev;
        const next = [...prev];
        next.splice(idx, 1);
        return next;
      });
    },
    [noteRemoteEcho]
  );

  // ------------------------------------------------------------------
  // Auth-driven sync lifecycle.
  //
  // On sign-in: full reconcile + realtime subscribe.
  // On sign-out: drop realtime, reset sync status, forget cached
  //              sync key (the next sign-in will re-fetch).
  // ------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let realtimeUnsubscribe: (() => void) | null = null;

    const startSync = async (userId: string) => {
      try {
        markSyncing();
        const result = await fullReconcile(projectsRef.current);
        if (cancelled) return;
        if (
          result.pulled.length > 0 ||
          result.replacedLocal.length > 0
        ) {
          setProjects((prev) => {
            const byId = new Map<string, Project>();
            for (const project of prev) byId.set(project.id, project);
            for (const project of result.replacedLocal) {
              byId.set(project.id, project);
              noteRemoteEcho(project.id);
            }
            for (const project of result.pulled) {
              byId.set(project.id, project);
              noteRemoteEcho(project.id);
            }
            return [...byId.values()];
          });
        }
        markSynced();

        // Subscribe to realtime AFTER the initial reconcile so we
        // don't double-process server state we just pulled.
        realtimeUnsubscribe = await subscribeRealtime({
          onUpsert: (project) => {
            if (cancelled) return;
            mergeProjectFromRemote(project);
          },
          onDelete: (id) => {
            if (cancelled) return;
            removeProjectFromRemote(id);
          },
        });
        signedInUserRef.current = userId;
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[useProjects] full reconcile failed:", err);
        markSyncError(message);
      }
    };

    const stopSync = () => {
      void unsubscribeRealtime();
      forgetSyncKey();
      signedInUserRef.current = null;
      setSyncStatus("idle");
      setSyncError(null);
    };

    void (async () => {
      const session = await getCurrentSession();
      if (cancelled) return;
      if (session) {
        await startSync(session.user.id);
      }
    })();

    const unsubscribeAuth = onAuthStateChange((session) => {
      if (cancelled) return;
      const nextUserId = session?.user.id ?? null;
      const previousUserId = signedInUserRef.current;
      if (nextUserId === previousUserId) return;

      // Sign-out (or account swap) — drop realtime and clear status.
      if (realtimeUnsubscribe) {
        realtimeUnsubscribe();
        realtimeUnsubscribe = null;
      }
      stopSync();

      if (nextUserId) {
        void startSync(nextUserId);
      }
    });

    return () => {
      cancelled = true;
      if (realtimeUnsubscribe) realtimeUnsubscribe();
      void unsubscribeRealtime();
      unsubscribeAuth();
    };
    // markSyncing / markSynced / markSyncError are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------
  // Focus-driven polling fallback. Runs only when signed in.
  // ------------------------------------------------------------------

  useEffect(() => {
    const handler = () => {
      if (!signedInUserRef.current) return;
      void (async () => {
        try {
          const items = await pullAll();
          if (!mountedRef.current) return;
          for (const item of items) {
            if (item.kind === "upsert" && item.project) {
              mergeProjectFromRemote(item.project);
            }
          }
        } catch (err) {
          console.warn("[useProjects] focus poll failed:", err);
        }
      })();
    };
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [mergeProjectFromRemote]);

  // ------------------------------------------------------------------
  // Local + remote save coordination.
  // ------------------------------------------------------------------

  /**
   * Push a single project remotely (no-op when signed out). Failures
   * are logged + reported via syncStatus, but never thrown — local
   * persistence has already happened, and the next focus poll will
   * retry.
   */
  const pushProjectToRemote = useCallback(
    async (project: Project) => {
      if (!signedInUserRef.current) return;
      if (consumeRemoteEcho(project.id)) return;
      try {
        markSyncing();
        await pushProject(project);
        if (!mountedRef.current) return;
        markSynced();
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[useProjects] sync push failed:", err);
        markSyncError(message);
      }
    },
    [consumeRemoteEcho, markSyncing, markSynced, markSyncError]
  );

  const pushDeleteToRemote = useCallback(
    async (id: string) => {
      if (!signedInUserRef.current) return;
      if (consumeRemoteEcho(id)) return;
      try {
        markSyncing();
        await pushDelete(id);
        if (!mountedRef.current) return;
        markSynced();
      } catch (err) {
        if (!mountedRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[useProjects] sync delete failed:", err);
        markSyncError(message);
      }
    },
    [consumeRemoteEcho, markSyncing, markSynced, markSyncError]
  );

  /**
   * Run the actual disk write. Sets `saveStatus` to `"saving"` for
   * the duration, transitions to `"saved"` for `SAVED_HOLD_MS`
   * (which the indicator hooks into), then back to `"idle"`. If
   * an edit lands during the write, queues exactly one follow-up
   * save once the current one resolves.
   */
  const performSave = useCallback(async (): Promise<void> => {
    if (inFlightSaveRef.current) {
      // Save already running — flag a follow-up. The current save's
      // post-resolve handler will pick this up.
      pendingFollowupRef.current = true;
      return inFlightSaveRef.current;
    }
    if (savedHoldTimerRef.current !== null) {
      window.clearTimeout(savedHoldTimerRef.current);
      savedHoldTimerRef.current = null;
    }
    setSaveStatus("saving");

    const run = (async () => {
      try {
        await saveProjectsToDisk(projectsRef.current);
        if (!mountedRef.current) return;
        setError(null);
        setSaveStatus("saved");
        savedHoldTimerRef.current = window.setTimeout(() => {
          savedHoldTimerRef.current = null;
          if (mountedRef.current) setSaveStatus("idle");
        }, SAVED_HOLD_MS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[Typeset] saveProjects failed:", err);
        if (!mountedRef.current) return;
        setError(message);
        setSaveStatus("error");
      }
    })();
    inFlightSaveRef.current = run;

    try {
      await run;
    } finally {
      inFlightSaveRef.current = null;
    }

    if (pendingFollowupRef.current) {
      pendingFollowupRef.current = false;
      // Tail call: re-enter via performSave so the `saving → saved`
      // transition fires for the follow-up too. Saved indicator then
      // reflects the most recent successful write.
      void performSave();
    }
  }, []);

  /** Schedule a debounced save. Each call resets the 500ms timer.
   *  Captures the set of project ids whose `modifiedAt` changed
   *  since the last save so we know what to push remotely. */
  const dirtyIdsRef = useRef<Set<string>>(new Set());
  const dirtyDeletesRef = useRef<Set<string>>(new Set());

  const scheduleSave = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void (async () => {
        await performSave();
        // Local save done — kick off remote pushes.
        if (signedInUserRef.current) {
          const ids = [...dirtyIdsRef.current];
          dirtyIdsRef.current = new Set();
          for (const id of ids) {
            const project = projectsRef.current.find((p) => p.id === id);
            if (project) {
              void pushProjectToRemote(project);
            }
          }
          const deletedIds = [...dirtyDeletesRef.current];
          dirtyDeletesRef.current = new Set();
          for (const id of deletedIds) {
            void pushDeleteToRemote(id);
          }
        } else {
          // Reset queues even if signed out so that re-signing in
          // doesn't push stale deltas (full-reconcile takes care
          // of catching up).
          dirtyIdsRef.current = new Set();
          dirtyDeletesRef.current = new Set();
        }
      })();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [performSave, pushProjectToRemote, pushDeleteToRemote]);

  const markDirty = useCallback((id: string) => {
    dirtyIdsRef.current.add(id);
    dirtyDeletesRef.current.delete(id);
  }, []);

  const markDeleted = useCallback((id: string) => {
    dirtyDeletesRef.current.add(id);
    dirtyIdsRef.current.delete(id);
  }, []);

  const createProject = useCallback(
    (initial?: Partial<Project>): Project => {
      const project = freshProject(initial);
      setProjects((prev) => [...prev, project]);
      markDirty(project.id);
      scheduleSave();
      return project;
    },
    [markDirty, scheduleSave]
  );

  const updateProject = useCallback(
    (id: string, patch: Partial<Project>) => {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                ...patch,
                updatedAt: new Date().toISOString(),
                modifiedAt: Date.now(),
              }
            : p
        )
      );
      markDirty(id);
      scheduleSave();
    },
    [markDirty, scheduleSave]
  );

  const deleteProject = useCallback(
    (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      markDeleted(id);
      scheduleSave();
    },
    [markDeleted, scheduleSave]
  );

  const flushSave = useCallback(async (): Promise<void> => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    await performSave();
  }, [performSave]);

  return {
    projects,
    createProject,
    updateProject,
    deleteProject,
    loadStatus,
    saveStatus,
    syncStatus,
    error,
    syncError,
    flushSave,
  };
}
