/**
 * v0.5.28 — canonical project state hook.
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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@/types";
import {
  loadProjects as loadProjectsFromDisk,
  saveProjects as saveProjectsToDisk,
  newProjectId,
} from "@/services/projectStore";

/** Debounce window for autosave. Long enough to coalesce a full
 *  field's typing, short enough that the "Saved ✓" indicator feels
 *  responsive (~half a second after the user stops). */
const AUTOSAVE_DEBOUNCE_MS = 500;

/** How long to hold the `saved` state before reverting to `idle`. */
const SAVED_HOLD_MS = 1000;

export type LoadStatus = "loading" | "ready" | "error";
export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseProjectsResult {
  projects: Project[];
  /** Insert a fresh project with a stable UUID. Returns the inserted
   *  project (caller usually wants its `id` to navigate to). */
  createProject(initial?: Partial<Project>): Project;
  updateProject(id: string, patch: Partial<Project>): void;
  deleteProject(id: string): void;
  loadStatus: LoadStatus;
  saveStatus: SaveStatus;
  /** When `loadStatus === "error"` or `saveStatus === "error"`. */
  error: string | null;
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
  const [error, setError] = useState<string | null>(null);

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

  /** Schedule a debounced save. Each call resets the 500ms timer. */
  const scheduleSave = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void performSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [performSave]);

  const createProject = useCallback(
    (initial?: Partial<Project>): Project => {
      const project = freshProject(initial);
      setProjects((prev) => [...prev, project]);
      scheduleSave();
      return project;
    },
    [scheduleSave]
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
      scheduleSave();
    },
    [scheduleSave]
  );

  const deleteProject = useCallback(
    (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id));
      scheduleSave();
    },
    [scheduleSave]
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
    error,
    flushSave,
  };
}
