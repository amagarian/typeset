import { useState, useCallback, useEffect, useRef } from "react";
import type {
  PdfMatchResult,
  Project,
  ProjectDocument,
  Template,
  TemplateField,
} from "@/types";
import { mockDraftTemplate } from "@/data/mockTemplates";
import { useProjects } from "@/hooks/useProjects";
import { AppShell } from "@/components/AppShell/AppShell";
import { ProjectWorkspace } from "@/components/ProjectWorkspace/ProjectWorkspace";
import { NewProjectView } from "@/components/NewProjectView/NewProjectView";
import { TemplateReviewModal } from "@/components/TemplateReviewModal/TemplateReviewModal";
import { PreviewExportModal } from "@/components/PreviewExportModal/PreviewExportModal";
import { FillPromptModal } from "@/components/FillPromptModal/FillPromptModal";
import { MatchStatusModal } from "@/components/MatchStatusModal/MatchStatusModal";
import { SettingsModal } from "@/components/SettingsModal/SettingsModal";
import { Toast, type ToastState } from "@/components/Toast/Toast";
import { TrayDropZone } from "@/components/TrayDropZone/TrayDropZone";
import { UpdateBanner } from "@/components/UpdateBanner/UpdateBanner";
import { ContributionBadge } from "@/components/ContributionBadge/ContributionBadge";
import { ConfettiBurst } from "@/components/ConfettiBurst/ConfettiBurst";
import { useAutoUpdate } from "@/hooks/useAutoUpdate";
import {
  bumpOptimistic,
  checkAndFireMilestone,
  fetchContributionStats,
} from "@/services/contributionStats";
import { getPromptFields, type PromptFieldValues } from "@/utils/fill";
import { writeFilledPdfBytes } from "@/utils/pdfWriter";
import { exportPdfBytes, type PdfExportMode } from "@/utils/exportPdf";
import {
  detectFieldsWithClaude,
  extractProjectFromPdfWithClaude,
  ClaudeNotConfiguredError,
} from "@/utils/geminiFieldDetector";
import {
  buildPdfFingerprint,
  buildTemplateFingerprintFromTemplate,
  scoreFingerprintMatch,
} from "@/utils/templateFingerprint";
import {
  readLocalTemplates,
  upsertLocalTemplate,
} from "@/services/templateCache";
import {
  initRegistry,
  findRegistryMatches,
  publishTemplateAuto,
  type MatchedRegistryTemplate,
} from "@/services/templateRegistry";
import { initTray, updateTrayMenu } from "@/utils/trayManager";

function isDropZoneWindow(): boolean {
  try {
    const w = window as unknown as Record<string, unknown>;
    const internals = w.__TAURI_INTERNALS__ as
      | { metadata?: { currentWindow?: { label?: string } } }
      | undefined;
    return internals?.metadata?.currentWindow?.label === "dropzone";
  } catch {
    return false;
  }
}

type View = "workspace" | "new-project" | "edit-project";

/**
 * v0.5.28 — heuristic for "user opened New project then closed
 * without typing anything". The new-project flow now creates a real
 * Project up front (so all edits autosave through `useProjects`),
 * which means an immediate close would otherwise leave a blank row
 * in the sidebar forever. Treating an all-empty project as
 * disposable on close reverses that without an explicit Cancel
 * button. We deliberately scope this to the new-project view —
 * editing an existing project and blanking every field shouldn't
 * silently delete it.
 */
function isProjectEmpty(project: Project): boolean {
  return (
    [
      project.label,
      project.jobName,
      project.jobNumber,
      project.poNumber,
      project.authorizationDate,
      project.shootDate ?? "",
      project.productionCompany,
      project.billingAddress,
      project.billingCity,
      project.billingState,
      project.billingZipCode,
      project.producer,
      project.email,
      project.phone,
      project.creditCardType,
      project.creditCardHolder,
      project.cardholderSignature,
      project.creditCardNumber,
      project.expDate,
      project.ccv,
    ].every((value) => !value || value.trim() === "")
  );
}

function createEmptyDraftTemplate(fileName: string): Template {
  const now = new Date().toISOString();
  return {
    id: `tpl-draft-${Date.now()}`,
    name: `${fileName.replace(/\.pdf$/i, "")} — draft`,
    status: "local-draft",
    source: "local-draft",
    fields: [],
    pageCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function templatesToMap(templates: Template[]): Record<string, Template> {
  return Object.fromEntries(templates.map((template) => [template.id, template]));
}

/**
 * v0.5.12 — heuristic for spotting legacy "field-based" fingerprints
 * that were saved before the save-site fix. Pre-fix saves overwrote
 * the PDF-derived fingerprint (typ. 24-48 anchor terms) with one
 * derived only from field labels (typ. 5-15). Use a conservative
 * threshold of <16 — well below the PDF-side `.slice(0, 48)` floor
 * and above what a tiny PDF would produce.
 */
function isLikelyLegacyFieldFingerprint(
  fingerprint: NonNullable<Template["fingerprint"]>
): boolean {
  return fingerprint.anchorTerms.length < 16;
}

/**
 * v0.5.12 — for legacy templates whose stored fingerprint is
 * field-based (and so won't anchor-overlap with a freshly-computed
 * PDF fingerprint), check whether their `fileNameHints` and
 * `pageCount` line up with the incoming PDF. If both agree, treat
 * the template as a "shape match" so the caller can upgrade the
 * stored fingerprint in place. Strict on both signals to avoid
 * cross-template aliasing on similar filenames.
 */
function isShapeMatchForLegacyUpgrade(
  incoming: NonNullable<Template["fingerprint"]>,
  candidate: NonNullable<Template["fingerprint"]>
): boolean {
  if (incoming.pageCount !== candidate.pageCount) return false;
  if (candidate.fileNameHints.length === 0) return false;
  const incomingHints = new Set(incoming.fileNameHints);
  const overlap = candidate.fileNameHints.filter((hint) => incomingHints.has(hint)).length;
  // Require majority overlap on the candidate's hints — a single
  // shared token isn't enough to safely overwrite a fingerprint.
  return overlap / candidate.fileNameHints.length >= 0.5;
}

function findMatchingLocalTemplate(
  templates: Template[],
  fingerprint: NonNullable<Template["fingerprint"]>
): { template: Template; confidence: number; upgradedFingerprint?: NonNullable<Template["fingerprint"]> } | null {
  const candidates = templates.filter(
    (template): template is Template & { fingerprint: NonNullable<Template["fingerprint"]> } =>
      Boolean(template.fingerprint)
  );

  const ranked = candidates
    .map((template) => ({
      template,
      confidence: scoreFingerprintMatch(fingerprint, template.fingerprint).total,
    }))
    .sort((left, right) => right.confidence - left.confidence);

  if (ranked[0] && ranked[0].confidence >= 0.92) {
    return { template: ranked[0].template, confidence: ranked[0].confidence };
  }

  // v0.5.12 — fallback for legacy templates saved before the
  // save-site fix landed. Their fingerprints are field-derived,
  // so the anchor-term Jaccard collapses against a fresh PDF
  // fingerprint and the score never crosses 0.92. If shape
  // (page count + filename hints) agrees, treat it as a match
  // and hand back a freshly-stitched fingerprint so the caller
  // can persist it. One-time per legacy template.
  const legacyMatch = candidates.find(
    (template) =>
      isLikelyLegacyFieldFingerprint(template.fingerprint) &&
      isShapeMatchForLegacyUpgrade(fingerprint, template.fingerprint)
  );
  if (legacyMatch) {
    const upgradedFingerprint: NonNullable<Template["fingerprint"]> = {
      ...fingerprint,
      // Preserve the legacy fingerprint's canonicalFieldIds so
      // downstream consumers that key off canonical ids stay stable.
      canonicalFieldIds:
        legacyMatch.fingerprint.canonicalFieldIds.length > 0
          ? legacyMatch.fingerprint.canonicalFieldIds
          : fingerprint.canonicalFieldIds,
    };
    return { template: legacyMatch, confidence: 0.92, upgradedFingerprint };
  }

  return null;
}

/**
 * Convert a community-published registry submission into a local
 * Template suitable for installation. We give it a fresh local id and
 * tag it as `remote-registry` so future flows can show "Synced from
 * registry" affordances without mistaking it for a draft.
 */
function buildTemplateFromRegistry(remote: MatchedRegistryTemplate): Template {
  const now = new Date().toISOString();
  return {
    id: `tpl-registry-${remote.template.id}`,
    name: remote.template.name,
    status: "local-verified",
    source: "remote-registry",
    registryId: remote.template.id,
    fields: remote.template.fields,
    fingerprint: remote.template.fingerprint,
    pageCount: remote.template.pageCount,
    createdAt: now,
    updatedAt: now,
  };
}

function cloneTemplate(template: Template): Template {
  return JSON.parse(JSON.stringify(template)) as Template;
}

function buildTemplateFromDetectedFields(
  fields: TemplateField[],
  fileName: string,
  fingerprint: ReturnType<typeof buildPdfFingerprint> extends Promise<infer T> ? T : never
): Template {
  const now = new Date().toISOString();
  const baseName = fileName.replace(/\.pdf$/i, "");
  const pageCount = Math.max(
    fingerprint?.pageCount ?? 1,
    ...fields.map((field) => field.pageNumber)
  );
  return {
    id: `tpl-gemini-${Date.now()}`,
    name: `${baseName} — draft`,
    status: "local-draft",
    source: "local-draft",
    fields,
    fingerprint,
    pageCount,
    createdAt: now,
    updatedAt: now,
  };
}

export default function App() {
  if (isDropZoneWindow()) {
    return <TrayDropZone />;
  }

  return <MainApp />;
}

function MainApp() {
  // v0.5.28 — project state moved into `useProjects`, which owns the
  // canonical list, autosaves to the encrypted on-disk store with a
  // 500ms debounce, and exposes `saveStatus` for the "Saved ✓"
  // indicator in the project edit view. Replaces the
  // `useState<Project[]>(mockProjects)` that lived here through
  // v0.5.27 — projects no longer dissolve on quit.
  const {
    projects,
    createProject,
    updateProject: updateProjectInStore,
    deleteProject: deleteProjectInStore,
    saveStatus,
    syncStatus,
    error: projectsError,
    flushSave,
  } = useProjects();
  const [view, setView] = useState<View>("workspace");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [templateModal, setTemplateModal] = useState<{ template: Template } | null>(null);
  const [templateUndoStack, setTemplateUndoStack] = useState<Template[]>([]);
  const [templateRedoStack, setTemplateRedoStack] = useState<Template[]>([]);
  const [draftTemplate, setDraftTemplate] = useState<Template | null>(null);
  const [editedTemplates, setEditedTemplates] = useState<Record<string, Template>>({});
  const [previewModal, setPreviewModal] = useState<{
    template: Template;
    fileName?: string;
    promptValues: PromptFieldValues;
    sourceBytes: Uint8Array;
  } | null>(null);
  const [fillPromptModal, setFillPromptModal] = useState<{
    template: Template;
    mode: "preview" | "export";
    sourceBytes: Uint8Array;
    fileName: string;
  } | null>(null);
  const [pdfSource, setPdfSource] = useState<{
    fileName: string;
    bytes: Uint8Array;
  } | null>(null);
  const [promptValuesByTemplate, setPromptValuesByTemplate] = useState<
    Record<string, PromptFieldValues>
  >({});
  const [projectDocuments, setProjectDocuments] = useState<Record<string, ProjectDocument[]>>({});
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [matchModal, setMatchModal] = useState<PdfMatchResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // v0.5.24 — bumping `confettiTrigger` re-fires the inline confetti
  // burst portal. Sentinel value 0 means "do nothing yet"; we set
  // `Date.now()` on each milestone so back-to-back milestones still
  // re-trigger the animation rather than no-oping on a stale ref.
  const [confettiTrigger, setConfettiTrigger] = useState(0);

  // v0.5.23 — drives the auto-update banner. Hook also schedules the
  // launch-time check and the focus-triggered (debounced) re-check. Mounted
  // exactly once here; the dropzone webview renders <TrayDropZone /> from
  // <App /> above and never reaches this component.
  const { banner: updateBanner, dismissBanner: dismissUpdateBanner } = useAutoUpdate();

  // v0.5.24 — kick off the contribution stats fetch on launch so the
  // header badge picks up the user's count from the server before
  // their first interaction. Cache short-circuits the network on
  // warm starts; the helper handles all error swallowing.
  useEffect(() => {
    void fetchContributionStats();
  }, []);

  // v0.5.28 — auto-select the most recent project once the on-disk
  // store finishes loading. The hook starts at `projects = []`
  // (loading state), so without this the workspace would render
  // "Select or create a project" for one frame even when the user
  // has saved projects. We only fire the auto-select on the
  // transition out of empty selection, so deleting the last
  // project (or arriving at an empty store on first launch)
  // doesn't auto-jump back into a different project mid-session.
  const didAutoSelectRef = useRef(false);
  useEffect(() => {
    if (didAutoSelectRef.current) return;
    if (projects.length === 0) return;
    didAutoSelectRef.current = true;
    setSelectedProjectId((current) => current ?? projects[0].id);
  }, [projects]);

  // v0.5.28 — surface persistence errors (keychain denied, disk
  // failure) as a toast. The hook keeps the in-memory list usable
  // even when the disk write fails, so the user isn't blocked —
  // but we want them to know something is wrong before they trust
  // the app with more data. Dependency on `projectsError` re-fires
  // only when the message itself changes.
  useEffect(() => {
    if (projectsError) {
      setToast({ message: projectsError, type: "error" });
    }
  }, [projectsError]);

  // v0.5.27 — bridge for the native macOS menu bar's "Settings…"
  // item (⌘,). The Rust setup hook in `src-tauri/src/lib.rs`
  // emits `menu:open-settings` on activation; we mirror it into a
  // local state flip here. `setSettingsOpen(true)` is idempotent,
  // so a stale fire while the modal is already open is a no-op
  // (no double-open / focus thrash). The async import keeps the
  // Tauri event API out of any non-Tauri (browser preview) build.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<unknown>("menu:open-settings", () => {
          setSettingsOpen(true);
        });
        if (cancelled) {
          off();
        } else {
          unlisten = off;
        }
      } catch (err) {
        console.warn("[Typeset] Menu listener attach failed:", err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleRelaunch = useCallback(async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      console.warn("[AutoUpdate] relaunch failed", err);
    }
  }, []);

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  const currentDocuments = selectedProjectId
    ? projectDocuments[selectedProjectId] ?? []
    : [];

  useEffect(() => {
    const localTemplates = readLocalTemplates();
    if (localTemplates.length > 0) {
      setEditedTemplates(templatesToMap(localTemplates));
    }
  }, []);

  // Boot the public template registry. Since v0.5.8 credentials are
  // baked in, so this is unconditional and synchronous — no
  // keychain round-trip, no "is configured?" gate. Subsequent calls
  // through `getRegistryClient()` reuse the singleton.
  useEffect(() => {
    initRegistry();
  }, []);

  const trayInitialized = useRef(false);
  useEffect(() => {
    if (trayInitialized.current) return;
    trayInitialized.current = true;
    const projectList = projects.map((p) => ({
      id: p.id,
      label: p.label || p.jobName || "Untitled",
    }));
    void initTray(projectList).catch((err) =>
      console.warn("[Typeset] Tray init failed (expected in browser):", err)
    );
  }, []);

  useEffect(() => {
    const projectList = projects.map((p) => ({
      id: p.id,
      label: p.label || p.jobName || "Untitled",
    }));
    void updateTrayMenu(projectList).catch(() => {});
  }, [projects]);

  // v0.5.28 — every project mutation now flows through the
  // `useProjects` store, which handles the optimistic in-memory
  // update + the debounced encrypted-disk write. We keep this
  // local indirection so the rest of the file's call sites stay
  // identical to the v0.5.27 wiring (a `(id, patch)` shape).
  const updateProject = useCallback(
    (id: string, updates: Partial<Project>) => {
      updateProjectInStore(id, updates);
    },
    [updateProjectInStore]
  );

  const deleteProject = useCallback(
    (id: string) => {
      deleteProjectInStore(id);
      setProjectDocuments((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (selectedProjectId === id) {
        setSelectedProjectId(null);
        setView("workspace");
      }
    },
    [deleteProjectInStore, selectedProjectId]
  );

  const addDocumentToProject = useCallback((projectId: string, doc: ProjectDocument) => {
    setProjectDocuments((prev) => ({
      ...prev,
      [projectId]: [...(prev[projectId] ?? []), doc],
    }));
  }, []);

  const updateDocumentInProject = useCallback(
    (projectId: string, docId: string, updates: Partial<ProjectDocument>) => {
      setProjectDocuments((prev) => ({
        ...prev,
        [projectId]: (prev[projectId] ?? []).map((d) =>
          d.id === docId
            ? { ...d, ...updates, updatedAt: new Date().toISOString() }
            : d
        ),
      }));
    },
    []
  );

  const removeDocumentFromProject = useCallback(
    (projectId: string, docId: string) => {
      setProjectDocuments((prev) => ({
        ...prev,
        [projectId]: (prev[projectId] ?? []).filter((d) => d.id !== docId),
      }));
    },
    []
  );

  const showToast = useCallback(
    (message: string, type: "success" | "error" | "info" = "success") => {
      setToast({ message, type });
    },
    []
  );

  const autoFillDocument = useCallback(
    (template: Template, docId: string, projectId: string) => {
      const project = projects.find((p) => p.id === projectId);
      if (getPromptFields(template, project).length > 0) return;
      updateDocumentInProject(projectId, docId, {
        status: "filled",
        updatedAt: new Date().toISOString(),
      });
    },
    [updateDocumentInProject, projects]
  );

  const ensureClaudeConfigured = useCallback(async (): Promise<boolean> => {
    const { hasApiKey } = await import("@/services/geminiClient");
    return await hasApiKey();
  }, []);

  const processDroppedPdf = useCallback(
    async (
      file: File,
      options: {
        showMatchModal?: boolean;
        autoFillVerified?: boolean;
        silentToasts?: boolean;
        overrideProjectId?: string;
      } = {}
    ): Promise<"verified-filled" | "verified-ready" | "draft" | "no-key"> => {
      const effectiveProjectId = options.overrideProjectId ?? selectedProjectId;
      const effectiveProject = effectiveProjectId
        ? projects.find((p) => p.id === effectiveProjectId) ?? selectedProject
        : selectedProject;
      if (!effectiveProjectId || !effectiveProject) {
        return "draft";
      }

      const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const newDoc: ProjectDocument = {
        id: docId,
        projectId: effectiveProjectId,
        fileName: file.name,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      addDocumentToProject(effectiveProjectId, newDoc);

      const bytes = new Uint8Array(await file.arrayBuffer());
      updateDocumentInProject(effectiveProjectId, docId, { pdfBytes: bytes });

      if (options.showMatchModal !== false) {
        setActiveDocumentId(docId);
        setPdfSource({ fileName: file.name, bytes });
      }

      const fingerprint = await buildPdfFingerprint(bytes, file.name);

      // Step 1: try the local template cache first.
      const localMatch = findMatchingLocalTemplate(readLocalTemplates(), fingerprint);
      if (localMatch) {
        // v0.5.12 — when the matcher fell back to the legacy
        // shape-match path, persist the freshly-computed PDF
        // fingerprint so subsequent drops hit the fast (≥0.92)
        // path without needing the legacy heuristic again.
        const template = localMatch.upgradedFingerprint
          ? {
              ...localMatch.template,
              fingerprint: localMatch.upgradedFingerprint,
              updatedAt: new Date().toISOString(),
            }
          : localMatch.template;
        if (localMatch.upgradedFingerprint) {
          upsertLocalTemplate(template);
        }
        setEditedTemplates((prev) => ({ ...prev, [template.id]: template }));
        setDraftTemplate(template);
        const result: PdfMatchResult = {
          kind: "verified",
          verifiedMatch: {
            templateId: template.id,
            templateName: template.name,
            status: template.status,
            confidence: localMatch.confidence,
            source: template.source ?? "local-draft",
          },
          fileName: file.name,
          lookupMessage: "Auto-filled with your saved local template.",
          matchSource: template.source ?? "local-draft",
          syncState: "matched",
        };

        updateDocumentInProject(effectiveProjectId, docId, {
          status: "matched",
          matchResult: result,
          templateId: template.id,
        });

        if (options.showMatchModal !== false) {
          setMatchModal(result);
        }

        if (options.autoFillVerified && getPromptFields(template, effectiveProject).length === 0) {
          try {
            const filledBytes = await writeFilledPdfBytes(bytes, template, effectiveProject, {
              defaultFontSize: 10,
            });
            const baseName = file.name.replace(/\.pdf$/i, "");
            const suggested = `${baseName} - FILLED.pdf`;
            const res = await exportPdfBytes(filledBytes, suggested, "downloads");
            if (!res.canceled) {
              updateDocumentInProject(effectiveProjectId, docId, {
                status: "filled",
                updatedAt: new Date().toISOString(),
              });
              return "verified-filled";
            }
          } catch (err) {
            console.error("Batch fill/export failed:", err);
            showToast(
              `Batch export failed for ${file.name}: ${
                err instanceof Error ? err.message : "unknown error"
              }`,
              "error"
            );
          }
          return "verified-ready";
        }

        autoFillDocument(template, docId, effectiveProjectId);
        if (!options.silentToasts) {
          showToast("Matched a saved template — ready to fill.", "success");
        }
        return "verified-ready";
      }

      // Step 1.5: nothing in the LOCAL cache — try the public registry
      // before paying for a Gemini detection. Hits here are gold: zero
      // detection cost, ~200ms round-trip, and the user gets a
      // community-verified field map. We use the same 0.92 confidence
      // threshold as the local matcher so behaviour is symmetric — a
      // registry hit is semantically equivalent to a local hit, just
      // sourced remotely.
      //
      // Since v0.5.9 the registry is invisible to the user. The only
      // user-visible signal is a single discreet toast when an
      // auto-match installs. Below-threshold candidates fall through
      // silently to Gemini — there is no manual browse UI to direct
      // the user to. Any registry failure (offline / RLS / RPC) is
      // caught and falls through silently as well.
      try {
        const remoteMatches = await findRegistryMatches(fingerprint, 4);
        const best = remoteMatches[0];
        if (best && best.matchScore >= 0.92) {
          const installed = buildTemplateFromRegistry(best);
          // Cache locally so the next drop of the same form is instant
          // and works offline.
          upsertLocalTemplate(installed);
          setEditedTemplates((prev) => ({ ...prev, [installed.id]: installed }));
          setDraftTemplate(installed);

          const result: PdfMatchResult = {
            kind: "verified",
            verifiedMatch: {
              templateId: installed.id,
              templateName: installed.name,
              status: installed.status,
              confidence: best.matchScore,
              source: "remote-registry",
            },
            fileName: file.name,
            lookupMessage: `Matched “${installed.name}” from the community library.`,
            matchSource: "remote-registry",
            syncState: "matched",
          };

          updateDocumentInProject(effectiveProjectId, docId, {
            status: "matched",
            matchResult: result,
            templateId: installed.id,
          });

          if (options.showMatchModal !== false) {
            setMatchModal(result);
          }

          autoFillDocument(installed, docId, effectiveProjectId);
          if (!options.silentToasts) {
            // The single user-visible registry signal in the app.
            // Concise, non-dismissable, surfaces which template was
            // applied so the user knows the registry contributed.
            showToast(
              `Matched template “${installed.name}” from community library`,
              "success"
            );
          }
          return "verified-ready";
        }
        // Below the auto-install threshold: silent fall-through to
        // Gemini detection. No toast — the registry has no manual
        // browse UI to direct the user to in v0.5.9.
      } catch (err) {
        console.warn("[Typeset] Registry lookup failed; falling back to Gemini:", err);
      }

      // Step 2: nothing in cache or registry — Gemini detection (unless
      // AcroForm already satisfied the doc). Requires a key in Settings.

      // Step 3: Gemini detection.
      const setDocProcessing = (msg: string, progress?: number) => {
        updateDocumentInProject(effectiveProjectId, docId, {
          status: "processing",
          processingMessage: msg,
          processingProgress: progress,
        });
      };

      // v0.6.0 (Workstream C) — AcroForm-first ingestion. Many
      // production rental/account/CC-auth PDFs ship with native
      // form widgets at the right coordinates. We try the cheap,
      // deterministic AcroForm extractor BEFORE the Gemini call:
      //   - Zero AcroForm fields → returns null, fall through to
      //     Gemini-only (existing behaviour, no regression).
      //   - All pages covered by AcroForm widgets → skip Gemini
      //     entirely; field placement is exact and the API call
      //     is saved.
      //   - Some pages covered → hybrid mode (NOT YET wired —
      //     v0.6.0 ships AcroForm-only-or-Gemini-only). The
      //     hybrid merge is queued for a v0.6.x follow-up because
      //     the pages-without-AcroForm case is dominated by
      //     standalone CC-auth scans (no AcroForm, full Gemini)
      //     and full-AcroForm packets (no Gemini needed); the
      //     "hybrid same-document" case (some pages have form
      //     widgets, others don't) is rare in the corpus.
      let detectedFields: TemplateField[] = [];
      let acroformDetectionUsed = false;
      try {
        const { tryAcroFormIngest } = await import("@/utils/acroFormIngest");
        const acroformResult = await tryAcroFormIngest(bytes);
        if (acroformResult && acroformResult.fields.length > 0) {
          setDocProcessing(
            `Detected ${acroformResult.fields.length} native form field${acroformResult.fields.length === 1 ? "" : "s"}…`,
            0.95
          );
          detectedFields = acroformResult.fields;
          acroformDetectionUsed = true;
          console.log(
            `[Typeset] AcroForm path: ${acroformResult.fields.length} field(s) extracted across ${acroformResult.pageNumbers.size} page(s); skipping Gemini.`
          );
        }
      } catch (acroErr) {
        console.warn("[Typeset] AcroForm ingest threw — falling through to Gemini:", acroErr);
      }

      try {
        if (!acroformDetectionUsed) {
          const configured = await ensureClaudeConfigured();
          if (!configured) {
            if (!options.silentToasts) {
              showToast("Add a Gemini API key in Settings (⌘,) to detect fields.", "info");
            }
            setSettingsOpen(true);
            updateDocumentInProject(effectiveProjectId, docId, { status: "pending" });
            return "no-key";
          }
          detectedFields = await detectFieldsWithClaude(bytes, 1, setDocProcessing, {
            projectHint: effectiveProject,
            filename: file.name,
          });
        }
      } catch (err) {
        console.warn("[Typeset] Gemini detection failed:", err);
        if (err instanceof ClaudeNotConfiguredError) {
          if (!options.silentToasts) {
            showToast(err.message, "info");
          }
          setSettingsOpen(true);
          updateDocumentInProject(effectiveProjectId, docId, { status: "pending" });
          return "no-key";
        }
        if (!options.silentToasts) {
          showToast(
            `Gemini detection failed: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
            "error"
          );
        }
      }

      const draft: Template =
        detectedFields.length > 0
          ? buildTemplateFromDetectedFields(detectedFields, file.name, fingerprint)
          : {
              ...createEmptyDraftTemplate(file.name),
              fingerprint,
            };

      setDraftTemplate(draft);
      setEditedTemplates((prev) => ({ ...prev, [draft.id]: draft }));

      const result: PdfMatchResult = {
        kind: "none",
        draftTemplateId: draft.id,
        fileName: file.name,
        lookupMessage:
          detectedFields.length > 0
            ? `Gemini detected ${detectedFields.length} field(s). Review and save to reuse on future drops of this form.`
            : "Gemini could not identify fields automatically. Open the editor to add them.",
        matchSource: "detector",
        syncState: "matched",
      };
      if (options.showMatchModal !== false) {
        setMatchModal(result);
      }
      updateDocumentInProject(effectiveProjectId, docId, {
        status: "matched",
        matchResult: result,
        templateId: draft.id,
      });
      autoFillDocument(draft, docId, effectiveProjectId);
      if (!options.silentToasts && detectedFields.length > 0) {
        showToast(
          `Gemini detected ${detectedFields.length} field(s). Use Edit Template to refine.`,
          "info"
        );
      }
      return "draft";
    },
    [
      addDocumentToProject,
      autoFillDocument,
      ensureClaudeConfigured,
      projects,
      selectedProject,
      selectedProjectId,
      setSettingsOpen,
      showToast,
      updateDocumentInProject,
    ]
  );

  const processDroppedPdfRef = useRef(processDroppedPdf);
  processDroppedPdfRef.current = processDroppedPdf;

  useEffect(() => {
    let cancelled = false;
    const setupListener = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<{
        projectId: string;
        fileName: string;
        bytesBase64: string;
      }>("tray-pdf-dropped", (event) => {
        if (cancelled) return;
        const { projectId, fileName, bytesBase64 } = event.payload;

        const binary = atob(bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }

        setSelectedProjectId(projectId);

        const blob = new Blob([bytes], { type: "application/pdf" });
        const file = new File([blob], fileName, { type: "application/pdf" });
        void processDroppedPdfRef.current(file, {
          showMatchModal: false,
          autoFillVerified: true,
          silentToasts: true,
          overrideProjectId: projectId,
        });
      });
    };

    let unlisten: (() => void) | undefined;
    setupListener()
      .then((fn) => {
        if (!cancelled) unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handlePdfDrop = useCallback(
    (files: File[] | null) => {
      if (!files || files.length === 0 || !selectedProjectId || !selectedProject) return;

      if (files.length === 1) {
        void processDroppedPdf(files[0], { showMatchModal: true });
        return;
      }

      const promises = files.map((file) =>
        processDroppedPdf(file, {
          showMatchModal: false,
          autoFillVerified: true,
          silentToasts: true,
        })
      );

      void Promise.all(promises).then((outcomes) => {
        let verifiedFilled = 0;
        let verifiedReady = 0;
        let manualReview = 0;
        let noKey = 0;

        for (const outcome of outcomes) {
          if (outcome === "verified-filled") verifiedFilled += 1;
          else if (outcome === "verified-ready") verifiedReady += 1;
          else if (outcome === "no-key") noKey += 1;
          else manualReview += 1;
        }

        const parts = [
          verifiedFilled > 0 ? `${verifiedFilled} filled and saved to Downloads` : "",
          verifiedReady > 0
            ? `${verifiedReady} ready for manual fill`
            : "",
          manualReview > 0 ? `${manualReview} need template review` : "",
          noKey > 0 ? `${noKey} skipped (API key not set)` : "",
        ].filter(Boolean);

        showToast(
          parts.length > 0
            ? `Batch complete: ${parts.join(", ")}.`
            : "Batch complete.",
          verifiedFilled > 0 ? "success" : "info"
        );
      });
    },
    [processDroppedPdf, selectedProject, selectedProjectId, showToast]
  );

  const getTemplateById = useCallback(
    (templateId: string): Template | null => {
      if (editedTemplates[templateId]) return editedTemplates[templateId];
      if (draftTemplate?.id === templateId) return draftTemplate;
      return null;
    },
    [draftTemplate, editedTemplates]
  );

  const handleOpenTemplateReview = useCallback(
    (templateId: string) => {
      const template =
        getTemplateById(templateId) ??
        ({
          ...mockDraftTemplate,
          id: templateId,
          source: "local-draft",
        } as Template);
      if (template.status !== "local-verified") {
        setDraftTemplate(template);
      }
      setTemplateUndoStack([]);
      setTemplateRedoStack([]);
      setTemplateModal({ template });
    },
    [getTemplateById]
  );

  const recordTemplateUndoSnapshot = useCallback(() => {
    setTemplateUndoStack((prev) => {
      if (!templateModal) {
        return prev;
      }
      const snapshot = cloneTemplate(templateModal.template);
      const lastSnapshot = prev[prev.length - 1];
      if (lastSnapshot && JSON.stringify(lastSnapshot) === JSON.stringify(snapshot)) {
        return prev;
      }
      return [...prev.slice(-49), snapshot];
    });
    setTemplateRedoStack([]);
  }, [templateModal]);

  const handleUndoTemplateEdit = useCallback(() => {
    setTemplateUndoStack((prev) => {
      const snapshot = prev[prev.length - 1];
      if (!snapshot) {
        return prev;
      }
      setTemplateRedoStack((redoPrev) => {
        if (!templateModal) {
          return redoPrev;
        }
        return [...redoPrev.slice(-49), cloneTemplate(templateModal.template)];
      });
      setTemplateModal({ template: cloneTemplate(snapshot) });
      setDraftTemplate((current) => {
        if (!current || current.id !== snapshot.id) {
          return current;
        }
        return cloneTemplate(snapshot);
      });
      return prev.slice(0, -1);
    });
  }, [templateModal]);

  const handleRedoTemplateEdit = useCallback(() => {
    setTemplateRedoStack((prev) => {
      const snapshot = prev[prev.length - 1];
      if (!snapshot) {
        return prev;
      }
      setTemplateUndoStack((undoPrev) => {
        if (!templateModal) {
          return undoPrev;
        }
        return [...undoPrev.slice(-49), cloneTemplate(templateModal.template)];
      });
      setTemplateModal({ template: cloneTemplate(snapshot) });
      setDraftTemplate((current) => {
        if (!current || current.id !== snapshot.id) {
          return current;
        }
        return cloneTemplate(snapshot);
      });
      return prev.slice(0, -1);
    });
  }, [templateModal]);

  const handleTemplateFieldChange = useCallback(
    (fieldId: string, updates: Partial<TemplateField>) => {
      if (!templateModal) return;
      setTemplateModal({
        template: {
          ...templateModal.template,
          fields: templateModal.template.fields.map((f) =>
            f.id === fieldId ? { ...f, ...updates } : f
          ),
        },
      });
      setDraftTemplate((prev) =>
        prev
          ? {
              ...prev,
              fields: prev.fields.map((f) =>
                f.id === fieldId ? { ...f, ...updates } : f
              ),
            }
          : null
      );
    },
    [templateModal]
  );

  const handleDeleteField = useCallback(
    (fieldId: string) => {
      if (!templateModal) return;
      const nextFields = templateModal.template.fields.filter((f) => f.id !== fieldId);
      const next = { ...templateModal.template, fields: nextFields };
      setTemplateModal({ template: next });
      setDraftTemplate((prev) =>
        prev ? { ...prev, fields: prev.fields.filter((f) => f.id !== fieldId) } : null
      );
    },
    [templateModal]
  );

  const handleAddField = useCallback(
    (placement?: { x: number; y: number; pageNumber: number }) => {
      if (!templateModal) return;
      recordTemplateUndoSnapshot();
      const referenceFields = templateModal.template.fields.filter(
        (field) => field.fieldType !== "checkbox" && field.height > 0
      );
      const heightSamples = (referenceFields.length > 0 ? referenceFields : templateModal.template.fields)
        .map((field) => Math.round(field.height))
        .filter((height) => height > 0)
        .sort((left, right) => left - right);
      const inferredHeight =
        heightSamples.length > 0
          ? heightSamples[Math.floor(heightSamples.length / 2)]
          : 22;
      const width = 150;
      const height = inferredHeight;
      // v0.6.21 — center the new field on `placement` (the visible
      // viewport center from the modal). Clamp to non-negative
      // coords so a partially-scrolled-off viewport still places
      // the bbox on-page. Fall back to (100, 100) when the modal
      // couldn't compute a placement (e.g. canvas not yet rendered).
      const cx = placement?.x ?? 100 + width / 2;
      const cy = placement?.y ?? 100 + height / 2;
      const x = Math.max(0, cx - width / 2);
      const y = Math.max(0, cy - height / 2);
      const newField: TemplateField = {
        id: `new-${Date.now()}`,
        label: "New field",
        mappedProjectKey: "",
        pageNumber: placement?.pageNumber ?? 1,
        x,
        y,
        width,
        height,
        confidence: 0.5,
        fieldType: "text",
        fieldKind: "text",
        detectionSource: "manual",
      };
      const next = {
        ...templateModal.template,
        fields: [...templateModal.template.fields, newField],
      };
      setTemplateModal({ template: next });
      setDraftTemplate((prev) =>
        prev ? { ...prev, fields: [...prev.fields, newField] } : null
      );
    },
    [recordTemplateUndoSnapshot, templateModal]
  );

  const handleAddCheckbox = useCallback(
    (placement?: { x: number; y: number; pageNumber: number }) => {
      if (!templateModal) return;
      recordTemplateUndoSnapshot();
      const checkboxSamples = templateModal.template.fields
        .filter((field) => field.fieldType === "checkbox")
        .flatMap((field) => [Math.round(field.width), Math.round(field.height)])
        .filter((size) => size > 0)
        .sort((left, right) => left - right);
      const inferredCheckboxSize =
        checkboxSamples.length > 0
          ? checkboxSamples[Math.floor(checkboxSamples.length / 2)]
          : 16;

      // v0.6.21 — center on viewport (same logic as handleAddField).
      const cx = placement?.x ?? 100 + inferredCheckboxSize / 2;
      const cy = placement?.y ?? 100 + inferredCheckboxSize / 2;
      const x = Math.max(0, cx - inferredCheckboxSize / 2);
      const y = Math.max(0, cy - inferredCheckboxSize / 2);
      const newField: TemplateField = {
        id: `checkbox-${Date.now()}`,
        label: "New checkbox",
        mappedProjectKey: "",
        pageNumber: placement?.pageNumber ?? 1,
        x,
        y,
        width: inferredCheckboxSize,
        height: inferredCheckboxSize,
        confidence: 0.5,
        fieldType: "checkbox",
        fieldKind: "boolean-checkbox",
        detectionSource: "manual",
        checkboxValue: "yes",
      };
      const next = {
        ...templateModal.template,
        fields: [...templateModal.template.fields, newField],
      };
      setTemplateModal({ template: next });
      setDraftTemplate((prev) =>
        prev ? { ...prev, fields: [...prev.fields, newField] } : null
      );
    },
    [recordTemplateUndoSnapshot, templateModal]
  );

  /**
   * Save a template locally and, if the public registry is configured,
   * publish (or update) it in the same action. Local save NEVER
   * blocks on the registry: a network failure, RLS rejection, or
   * missing credentials results in a non-blocking toast — the local
   * save still succeeds. See `publishTemplateAuto` for the
   * created/updated/no-op semantics.
   *
   * Fingerprint is recomputed from the current fields so any post-
   * detection edits (re-labelled fields, new manual fields, deletions)
   * are reflected in the row's anchor terms / canonical ids before
   * upload.
   */
  const handleSaveTemplate = useCallback(
    async (template: Template, opts: { promote?: boolean } = {}) => {
      const now = new Date().toISOString();
      // v0.5.12 — preserve the PDF-derived fingerprint that was
      // attached when the template was first detected. The
      // field-derived fingerprint produced by
      // `buildTemplateFingerprintFromTemplate` only tokenizes field
      // labels (~5-15 anchor terms), which doesn't overlap enough
      // with the body-copy-derived fingerprint that
      // `buildPdfFingerprint` produces on re-drop (~30-50 anchor
      // terms). The Jaccard collapses, the score lands ~0.55, and
      // neither the local cache nor the registry auto-installs.
      // Refresh `canonicalFieldIds` only — that's the one
      // fingerprint dimension that field edits legitimately affect.
      const fingerprint = template.fingerprint
        ? {
            ...template.fingerprint,
            canonicalFieldIds: Array.from(
              new Set(
                template.fields
                  .map((f) => f.canonicalFieldId)
                  .filter((id): id is NonNullable<typeof id> => Boolean(id))
              )
            ),
          }
        : template.fields.length > 0
        ? buildTemplateFingerprintFromTemplate(template)
        : undefined;
      const savedTemplate: Template = {
        ...template,
        fingerprint,
        status: opts.promote ? "local-verified" : template.status,
        source:
          opts.promote && template.source === "local-draft"
            ? "local-verified"
            : template.source ?? "local-draft",
        updatedAt: now,
      };
      upsertLocalTemplate(savedTemplate);
      setEditedTemplates((prev) => ({ ...prev, [template.id]: savedTemplate }));
      setDraftTemplate(savedTemplate);
      setTemplateUndoStack([]);
      setTemplateRedoStack([]);
      setTemplateModal(null);

      if (activeDocumentId && selectedProjectId) {
        updateDocumentInProject(selectedProjectId, activeDocumentId, {
          matchResult: {
            kind: "verified",
            verifiedMatch: {
              templateId: savedTemplate.id,
              templateName: savedTemplate.name,
              status: savedTemplate.status,
              confidence: 1,
              source: savedTemplate.source,
            },
            syncState: "matched",
          },
          templateId: savedTemplate.id,
        });
      }

      // Local save is done. Now (best-effort) push to the registry.
      // Since v0.5.8 the registry is always configured, so the only
      // reasons to skip are local-only: empty field list (nothing
      // useful to share) or no fingerprint computed. Network / RLS
      // failures fall through to the catch below as a non-blocking
      // toast — local save has already succeeded.
      const canAttemptPublish =
        savedTemplate.fields.length > 0 && Boolean(fingerprint);

      if (!canAttemptPublish) {
        showToast("Saved template locally.", "success");
        return;
      }

      try {
        const result = await publishTemplateAuto(savedTemplate);
        const publishedAt = new Date().toISOString();
        const withRegistryId: Template = {
          ...savedTemplate,
          registryId: result.id,
          source:
            savedTemplate.source === "local-draft"
              ? "remote-registry"
              : savedTemplate.source ?? "remote-registry",
          updatedAt: publishedAt,
        };
        upsertLocalTemplate(withRegistryId);
        setEditedTemplates((prev) => ({ ...prev, [withRegistryId.id]: withRegistryId }));
        setDraftTemplate((prev) =>
          prev && prev.id === withRegistryId.id ? withRegistryId : prev
        );

        if (result.created) {
          // v0.5.24 — only INSERTs (not UPDATEs) bump the contribution
          // tally. UPDATE = re-publishing an already-shared template
          // for this device, which doesn't change the distinct
          // fingerprint count. The bump is provisional and gets
          // reconciled on the next fetch (which always happens
          // because `bumpOptimistic` invalidates the cache TTL).
          const newCount = bumpOptimistic();
          const milestone = checkAndFireMilestone(newCount);
          if (milestone) {
            showToast(milestone.message, "success");
            setConfettiTrigger(Date.now());
          } else {
            showToast(
              "Saved & published to the community registry.",
              "success"
            );
          }
          // Reconcile against the server in the background so any
          // optimistic over-count (eg. server-side dedup) corrects
          // itself before the next user-facing read.
          void fetchContributionStats({ force: true });
        } else if (result.updated) {
          showToast(
            "Saved & updated your community registry entry.",
            "success"
          );
        } else {
          showToast(
            "Saved locally. Already up to date in the registry.",
            "info"
          );
        }
      } catch (err) {
        // v0.6.23 — local save already succeeded and the registry
        // publish is a background, additive nice-to-have. The old
        // toast ("Couldn't reach the community registry — try again
        // later.") was misleading because the user can't actually
        // do anything about it.
        //
        // v0.6.25 — bump the diagnostic from `console.warn` to
        // `console.error` and stringify the underlying cause so it
        // surfaces clearly in devtools. This lets us actually
        // figure out *why* the publish keeps failing (RLS policy,
        // schema drift, network, auth state) when a user reports
        // "still only saving locally".
        const errMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[Typeset] Registry publish failed — local save succeeded; ` +
            `community sync rejected with: ${errMessage}`,
          err
        );
        showToast("Saved template locally.", "success");
      }
    },
    [activeDocumentId, selectedProjectId, showToast, updateDocumentInProject]
  );

  const exportFilledPdf = useCallback(
    async (
      template: Template,
      project: Project,
      sourceBytes: Uint8Array,
      sourceFileName: string,
      options: {
        promptValues?: PromptFieldValues;
        targetDocumentId?: string;
        exportMode?: PdfExportMode;
        silentSuccess?: boolean;
      } = {}
    ) => {
      try {
        const promptValues = options.promptValues ?? {};
        const filledBytes = await writeFilledPdfBytes(sourceBytes, template, project, {
          defaultFontSize: 10,
          promptValues,
        });
        const baseName = sourceFileName.replace(/\.pdf$/i, "");
        const suggested = `${baseName} - FILLED.pdf`;
        const res = await exportPdfBytes(
          filledBytes,
          suggested,
          options.exportMode ?? "prompt"
        );
        if (res.canceled) return;

        const targetDocumentId = options.targetDocumentId ?? activeDocumentId;
        if (targetDocumentId && selectedProjectId) {
          updateDocumentInProject(selectedProjectId, targetDocumentId, {
            status: "filled",
            updatedAt: new Date().toISOString(),
          });
        }

        if (!options.silentSuccess) {
          showToast(
            options.exportMode === "downloads"
              ? `Saved ${suggested} to Downloads.`
              : res.method === "tauri"
                ? "Saved filled PDF."
                : "Downloaded filled PDF.",
            "success"
          );
        }
      } catch (err) {
        console.error("Fill/export failed:", err);
        showToast(`Export failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
      }
    },
    [showToast, activeDocumentId, selectedProjectId, updateDocumentInProject]
  );

  const runFillAction = useCallback(
    (
      template: Template,
      mode: "preview" | "export",
      project: Project,
      sourceBytes: Uint8Array,
      fileName: string,
      promptValues: PromptFieldValues = {},
      options: {
        targetDocumentId?: string;
        exportMode?: PdfExportMode;
        silentSuccess?: boolean;
      } = {}
    ) => {
      if (mode === "preview") {
        setPreviewModal({
          template,
          fileName,
          promptValues,
          sourceBytes,
        });
        return;
      }
      void exportFilledPdf(template, project, sourceBytes, fileName, {
        promptValues,
        targetDocumentId: options.targetDocumentId,
        exportMode: options.exportMode,
        silentSuccess: options.silentSuccess,
      });
    },
    [exportFilledPdf]
  );

  const beginFillAction = useCallback(
    (
      template: Template,
      mode: "preview" | "export",
      project: Project,
      sourceBytes: Uint8Array,
      fileName: string,
      options: {
        targetDocumentId?: string;
        exportMode?: PdfExportMode;
        silentSuccess?: boolean;
      } = {}
    ) => {
      const savedValues = promptValuesByTemplate[template.id] ?? {};
      // v0.5.26 — pass `project` + `savedValues` so option-group
      // fields drop out of the prompt list whenever
      // `getOptionGroupSelection` can already resolve a label
      // (project default OR a previously-saved prompt entry).
      const promptFields = getPromptFields(template, project, savedValues);
      if (promptFields.length === 0) {
        runFillAction(template, mode, project, sourceBytes, fileName, {}, options);
        return;
      }
      const isCheckbox = (f: typeof promptFields[0]) =>
        f.fieldType === "checkbox" || f.fieldKind === "boolean-checkbox";
      const allFilled =
        Object.keys(savedValues).length > 0 &&
        promptFields.every((f) => isCheckbox(f) || (savedValues[f.id] ?? "").trim());
      if (allFilled) {
        runFillAction(template, mode, project, sourceBytes, fileName, savedValues, options);
        return;
      }
      setFillPromptModal({ template, mode, sourceBytes, fileName });
    },
    [runFillAction, promptValuesByTemplate]
  );

  const handlePreviewBeforeExport = useCallback(
    (templateId: string, overrideBytes?: Uint8Array, overrideFileName?: string) => {
      if (!selectedProject) {
        showToast("Select a project first.");
        return;
      }
      const bytes = overrideBytes ?? pdfSource?.bytes;
      const fileName = overrideFileName ?? pdfSource?.fileName ?? "document.pdf";
      if (!bytes) {
        showToast("Drop a PDF first.");
        return;
      }
      const template = getTemplateById(templateId);
      if (!template) {
        showToast("Template not found.");
        return;
      }
      beginFillAction(template, "preview", selectedProject, bytes, fileName);
    },
    [beginFillAction, getTemplateById, pdfSource, selectedProject, showToast]
  );

  const handleFillNow = useCallback(
    (
      templateId: string,
      options: {
        overrideBytes?: Uint8Array;
        overrideFileName?: string;
        targetDocumentId?: string;
        exportMode?: PdfExportMode;
        silentSuccess?: boolean;
      } = {}
    ) => {
      if (!selectedProject) {
        showToast("Select a project first.");
        return;
      }
      const bytes = options.overrideBytes ?? pdfSource?.bytes;
      const fileName = options.overrideFileName ?? pdfSource?.fileName ?? "document.pdf";
      if (!bytes) {
        showToast("Drop a PDF first.");
        return;
      }
      const template = getTemplateById(templateId);
      if (!template) {
        showToast("Template not found.");
        return;
      }
      beginFillAction(template, "export", selectedProject, bytes, fileName, {
        targetDocumentId: options.targetDocumentId,
        exportMode: options.exportMode,
        silentSuccess: options.silentSuccess,
      });
    },
    [beginFillAction, getTemplateById, pdfSource?.bytes, selectedProject, showToast]
  );

  // v0.5.28 — "+ New project" now creates a real Project up front
  // (with a stable UUID via `useProjects.createProject`) and drops
  // straight into the autosave loop. The old flow accumulated edits
  // in a transient `newProjectDraft` and committed via a "Create
  // project" button at the bottom of the form — that button is
  // gone, so we need an inserted-on-entry record for autosave to
  // target. The "discard if empty on close" path lives in
  // `handleCloseNewProject` so a misclick on "+ New project"
  // doesn't permanently litter the sidebar.
  const handleNewProject = useCallback(() => {
    const project = createProject();
    setSelectedProjectId(project.id);
    setView("new-project");
  }, [createProject]);

  const handleCloseNewProject = useCallback(() => {
    if (selectedProjectId) {
      const current = projects.find((p) => p.id === selectedProjectId);
      if (current && isProjectEmpty(current)) {
        deleteProjectInStore(selectedProjectId);
        setSelectedProjectId(null);
      }
    }
    setView("workspace");
  }, [deleteProjectInStore, projects, selectedProjectId]);

  // v0.6.0 — explicit Save handler for the job edit page. Flushes
  // any pending debounced autosave to disk synchronously, then
  // navigates back to the workspace empty state with the sidebar
  // selection cleared. Differs from `handleCloseNewProject` in
  // two ways:
  //   1. We force-flush before navigating so a user mid-typing a
  //      sentence still gets their last keystroke persisted before
  //      the view tears down (the 500ms autosave debounce would
  //      otherwise drop the in-flight edit when the timer's
  //      `useEffect` cleanup runs on unmount).
  //   2. We do NOT delete an empty project — Save is an explicit
  //      "I want this saved" intent, even if the user only typed
  //      a label and decided that was enough.
  const handleSaveProject = useCallback(async () => {
    try {
      await flushSave();
    } catch (err) {
      console.warn("[App] flushSave failed during explicit Save:", err);
    }
    setSelectedProjectId(null);
    setView("workspace");
  }, [flushSave]);

  const handleEditProject = useCallback(() => {
    setView("edit-project");
  }, []);

  const handleSelectProject = useCallback((id: string) => {
    setSelectedProjectId(id);
    setView("workspace");
  }, []);

  const importProjectFromPdf = useCallback(
    async (file: File) => {
      const configured = await ensureClaudeConfigured();
      if (!configured) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        showToast("Reading project info from PDF…", "info");
        const { fields, fieldCount } = await extractProjectFromPdfWithClaude(bytes);
        if (fieldCount === 0) {
          showToast("No recognizable fields found in this PDF.", "info");
          return;
        }
        // v0.5.28 — both views now mutate a real project through
        // the autosave store. The new-project view inserts an empty
        // Project on entry, so PDF import here just patches it the
        // same way an explicit edit would.
        if ((view === "edit-project" || view === "new-project") && selectedProjectId) {
          updateProject(selectedProjectId, fields);
        }
        showToast(
          `Imported ${fieldCount} field${fieldCount === 1 ? "" : "s"} from PDF.`,
          "success"
        );
      } catch (err) {
        console.error("PDF import failed:", err);
        if (err instanceof ClaudeNotConfiguredError) {
          showToast(err.message, "info");
          setSettingsOpen(true);
        } else {
          showToast(
            `Failed to extract fields: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
            "error"
          );
        }
      }
    },
    [ensureClaudeConfigured, selectedProjectId, showToast, updateProject, view]
  );

  const displayTemplate = templateModal?.template ?? draftTemplate;

  return (
    <>
      <AppShell
        projects={projects.map((p) => ({ id: p.id, label: p.label || p.jobName || "Untitled" }))}
        selectedProjectId={view === "workspace" ? selectedProjectId : null}
        onSelectProject={handleSelectProject}
        onNewProject={handleNewProject}
        onOpenSettings={() => setSettingsOpen(true)}
        headerRight={<ContributionBadge />}
      >
        {(view === "new-project" || view === "edit-project") && selectedProject ? (
          <NewProjectView
            initialProject={selectedProject}
            isEditing={view === "edit-project"}
            saveStatus={saveStatus}
            syncStatus={syncStatus}
            onChange={(updates) => {
              if (selectedProjectId) {
                updateProject(selectedProjectId, updates);
              }
            }}
            onClose={
              view === "new-project"
                ? handleCloseNewProject
                : () => setView("workspace")
            }
            onImportPdf={importProjectFromPdf}
            onSave={handleSaveProject}
            onError={(message) => showToast(message, "error")}
          />
        ) : (
          <ProjectWorkspace
            project={selectedProject}
            documents={currentDocuments}
            onPdfDrop={handlePdfDrop}
            onEditProject={handleEditProject}
            onDeleteProject={() => {
              if (selectedProjectId) deleteProject(selectedProjectId);
            }}
            onOpenDocument={(doc) => {
              setActiveDocumentId(doc.id);
              if (doc.pdfBytes) {
                setPdfSource({ fileName: doc.fileName, bytes: doc.pdfBytes });
              }
              if (doc.templateId) {
                const tpl = getTemplateById(doc.templateId);
                if (tpl) setDraftTemplate(tpl);
              }
              if (doc.matchResult) {
                setMatchModal(doc.matchResult);
              }
            }}
            onDownloadDocument={(doc) => {
              if (!doc.templateId) {
                showToast("No template assigned to this document.", "error");
                return;
              }
              const bytes = doc.pdfBytes ?? pdfSource?.bytes;
              if (!bytes) {
                showToast("PDF data not available. Try clicking the document name first.", "error");
                return;
              }
              setActiveDocumentId(doc.id);
              setPdfSource({ fileName: doc.fileName, bytes });
              handleFillNow(doc.templateId, {
                overrideBytes: bytes,
                overrideFileName: doc.fileName,
                targetDocumentId: doc.id,
              });
            }}
            onEditTemplateDocument={(doc) => {
              setActiveDocumentId(doc.id);
              if (doc.pdfBytes) {
                setPdfSource({ fileName: doc.fileName, bytes: doc.pdfBytes });
              }
              if (doc.templateId) {
                handleOpenTemplateReview(doc.templateId);
              } else {
                showToast("No template assigned to this document.", "error");
              }
            }}
            onPreviewDocument={(doc) => {
              if (!doc.templateId) {
                showToast("No template assigned to this document.", "error");
                return;
              }
              const bytes = doc.pdfBytes ?? pdfSource?.bytes;
              if (!bytes) {
                showToast("PDF data not available. Try clicking the document name first, then Preview.", "error");
                return;
              }
              setActiveDocumentId(doc.id);
              setPdfSource({ fileName: doc.fileName, bytes });
              handlePreviewBeforeExport(doc.templateId, bytes, doc.fileName);
            }}
            onRemoveDocument={(docId) => {
              if (selectedProjectId) {
                removeDocumentFromProject(selectedProjectId, docId);
              }
            }}
          />
        )}
      </AppShell>

      {matchModal && (
        <MatchStatusModal
          result={matchModal}
          onClose={() => setMatchModal(null)}
          onOpenTemplateReview={(templateId) => {
            setMatchModal(null);
            handleOpenTemplateReview(templateId);
          }}
          onFillNow={(templateId) => {
            setMatchModal(null);
            handleFillNow(templateId);
          }}
          onPreviewBeforeExport={(templateId) => {
            setMatchModal(null);
            handlePreviewBeforeExport(templateId);
          }}
          onCreateNewTemplate={() => {
            const draft = {
              ...createEmptyDraftTemplate(pdfSource?.fileName ?? "Untitled.pdf"),
              ...mockDraftTemplate,
              id: `tpl-draft-${Date.now()}`,
              source: "local-draft",
            } as Template;
            setDraftTemplate(draft);
            setTemplateUndoStack([]);
            setTemplateRedoStack([]);
            setMatchModal(null);
            setTemplateModal({ template: draft });
          }}
          onEditTemplate={(templateId) => {
            const template = getTemplateById(templateId);
            if (template) {
              setTemplateUndoStack([]);
              setTemplateRedoStack([]);
              setMatchModal(null);
              setTemplateModal({ template });
            }
          }}
        />
      )}

      {displayTemplate && templateModal && (
        <TemplateReviewModal
          template={templateModal.template}
          project={selectedProject}
          pdfBytes={pdfSource?.bytes ?? null}
          onClose={() => {
            setTemplateUndoStack([]);
            setTemplateRedoStack([]);
            setTemplateModal(null);
          }}
          onConfirm={(template) => {
            void handleSaveTemplate(template, { promote: true });
            if (activeDocumentId && selectedProjectId) {
              updateDocumentInProject(selectedProjectId, activeDocumentId, {
                status: "filled",
                updatedAt: new Date().toISOString(),
              });
            }
            if (selectedProject && pdfSource?.bytes && template.id) {
              handleFillNow(template.id, {
                targetDocumentId: activeDocumentId ?? undefined,
              });
            }
          }}
          onSaveLocal={(template) => {
            void handleSaveTemplate(template, { promote: true });
          }}
          onUndo={handleUndoTemplateEdit}
          canUndo={templateUndoStack.length > 0}
          onRedo={handleRedoTemplateEdit}
          canRedo={templateRedoStack.length > 0}
          onBeginFieldEdit={recordTemplateUndoSnapshot}
          onFieldChange={handleTemplateFieldChange}
          onDeleteField={handleDeleteField}
          onAddField={handleAddField}
          onAddCheckbox={handleAddCheckbox}
          onProjectChange={
            selectedProjectId
              ? (updates) => updateProject(selectedProjectId, updates)
              : undefined
          }
          onRedetect={
            pdfSource?.bytes
              ? async () => {
                  const bytes = pdfSource.bytes;
                  setTemplateModal(null);

                  const setRedetectStatus = (msg: string, progress?: number) => {
                    if (activeDocumentId && selectedProjectId) {
                      updateDocumentInProject(selectedProjectId, activeDocumentId, {
                        status: "processing",
                        processingMessage: msg,
                        processingProgress: progress,
                      });
                    }
                  };

                  let detectedFields: TemplateField[] = [];
                  try {
                    detectedFields = await detectFieldsWithClaude(
                      bytes,
                      1,
                      setRedetectStatus,
                      {
                        projectHint: selectedProject ?? undefined,
                        filename: pdfSource.fileName,
                      }
                    );
                  } catch (err) {
                    console.warn("[Typeset] Gemini re-detection failed:", err);
                    if (err instanceof ClaudeNotConfiguredError) {
                      showToast(err.message, "info");
                      setSettingsOpen(true);
                      return;
                    }
                    showToast(
                      `Re-detect failed: ${
                        err instanceof Error ? err.message : "unknown error"
                      }`,
                      "error"
                    );
                    return;
                  }

                  if (detectedFields.length === 0) {
                    showToast("Gemini found no fields.", "info");
                    return;
                  }

                  const fingerprint = await buildPdfFingerprint(bytes, pdfSource.fileName);
                  const newTemplate = buildTemplateFromDetectedFields(
                    detectedFields,
                    pdfSource.fileName,
                    fingerprint
                  );

                  setDraftTemplate(newTemplate);
                  setEditedTemplates((prev) => ({ ...prev, [newTemplate.id]: newTemplate }));
                  if (activeDocumentId && selectedProjectId) {
                    updateDocumentInProject(selectedProjectId, activeDocumentId, {
                      templateId: newTemplate.id,
                      status: "matched",
                    });
                    autoFillDocument(newTemplate, activeDocumentId, selectedProjectId);
                  }
                  setTemplateUndoStack([]);
                  setTemplateRedoStack([]);
                  setTemplateModal({ template: newTemplate });
                  showToast(`Re-detected ${detectedFields.length} field(s).`, "success");
                }
              : undefined
          }
        />
      )}

      {previewModal && selectedProject && (
        <PreviewExportModal
          template={previewModal.template}
          project={selectedProject}
          sourceBytes={previewModal.sourceBytes}
          promptValues={previewModal.promptValues}
          fileName={previewModal.fileName}
          onClose={() => setPreviewModal(null)}
          onExport={() => {
            void exportFilledPdf(
              previewModal.template,
              selectedProject,
              previewModal.sourceBytes,
              previewModal.fileName ?? "document.pdf",
              { promptValues: previewModal.promptValues }
            );
          }}
          exportLabel="Export filled PDF"
        />
      )}

      {fillPromptModal && selectedProject && (
        <FillPromptModal
          template={fillPromptModal.template}
          pdfBytes={fillPromptModal.sourceBytes}
          project={selectedProject}
          mode={fillPromptModal.mode}
          initialValues={promptValuesByTemplate[fillPromptModal.template.id] ?? {}}
          onClose={() => setFillPromptModal(null)}
          onSubmit={(values) => {
            setPromptValuesByTemplate((prev) => ({
              ...prev,
              [fillPromptModal.template.id]: values,
            }));
            setFillPromptModal(null);
            runFillAction(
              fillPromptModal.template,
              fillPromptModal.mode,
              selectedProject,
              fillPromptModal.sourceBytes,
              fillPromptModal.fileName,
              values
            );
          }}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {updateBanner && (
        <UpdateBanner
          version={updateBanner.version}
          onRelaunch={handleRelaunch}
          onDismiss={dismissUpdateBanner}
        />
      )}

      {/*
        v0.5.24 — milestone celebration. Always mounted (cheap), only
        animates when `confettiTrigger` is non-zero. Portals to body
        so it's above modals / banners / popovers.
      */}
      <ConfettiBurst triggerKey={confettiTrigger} />
    </>
  );
}
