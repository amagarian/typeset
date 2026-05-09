import { useState, useCallback, useEffect, useRef } from "react";
import type {
  PdfMatchResult,
  Project,
  ProjectDocument,
  Template,
  TemplateField,
} from "@/types";
import { mockProjects } from "@/data/mockProjects";
import { mockDraftTemplate } from "@/data/mockTemplates";
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
import { getPromptFields, type PromptFieldValues } from "@/utils/fill";
import { writeFilledPdfBytes } from "@/utils/pdfWriter";
import { exportPdfBytes, type PdfExportMode } from "@/utils/exportPdf";
import {
  detectFieldsWithClaude,
  extractProjectFromPdfWithClaude,
  ClaudeNotConfiguredError,
} from "@/utils/geminiFieldDetector";
import { hasApiKey } from "@/services/geminiClient";
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
  isRegistryEnabled,
  findRegistryMatches,
  publishTemplate,
  updatePublishedTemplate,
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

function createEmptyProject(): Project {
  const now = new Date().toISOString();
  return {
    id: `proj-${Date.now()}`,
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
    createdAt: now,
    updatedAt: now,
  };
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

function findMatchingLocalTemplate(
  templates: Template[],
  fingerprint: NonNullable<Template["fingerprint"]>
): { template: Template; confidence: number } | null {
  const ranked = templates
    .filter((template): template is Template & { fingerprint: NonNullable<Template["fingerprint"]> } =>
      Boolean(template.fingerprint)
    )
    .map((template) => ({
      template,
      confidence: scoreFingerprintMatch(fingerprint, template.fingerprint).total,
    }))
    .sort((left, right) => right.confidence - left.confidence);

  if (ranked[0] && ranked[0].confidence >= 0.92) {
    return { template: ranked[0].template, confidence: ranked[0].confidence };
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
  const [projects, setProjects] = useState<Project[]>(mockProjects);
  const [view, setView] = useState<View>("workspace");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    mockProjects[0]?.id ?? null
  );
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
  const [newProjectDraft, setNewProjectDraft] = useState<Partial<Project>>({});
  const [promptValuesByTemplate, setPromptValuesByTemplate] = useState<
    Record<string, PromptFieldValues>
  >({});
  const [projectDocuments, setProjectDocuments] = useState<Record<string, ProjectDocument[]>>({});
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [matchModal, setMatchModal] = useState<PdfMatchResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mirrors `isRegistryEnabled()` so React re-renders when the user
  // saves Supabase credentials in Settings. Updated by `initRegistry()`
  // on startup and by the Settings modal's `onSaved` callback.
  const [registryReady, setRegistryReady] = useState(false);

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

  // Boot the public template registry once, in the background. Failure
  // is non-fatal: the app remains fully usable in local-only mode and
  // every registry call gracefully no-ops when credentials are absent.
  useEffect(() => {
    void initRegistry().then((ok) => setRegistryReady(ok));
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

  const updateProject = useCallback((id: string, updates: Partial<Project>) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
    );
  }, []);

  const deleteProject = useCallback(
    (id: string) => {
      setProjects((prev) => prev.filter((p) => p.id !== id));
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
    [selectedProjectId]
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
      if (getPromptFields(template).length > 0) return;
      updateDocumentInProject(projectId, docId, {
        status: "filled",
        updatedAt: new Date().toISOString(),
      });
    },
    [updateDocumentInProject]
  );

  const ensureClaudeConfigured = useCallback(async (): Promise<boolean> => {
    const configured = await hasApiKey();
    if (!configured) {
      showToast(
        "Add your Gemini API key in Settings to enable detection.",
        "info"
      );
      setSettingsOpen(true);
    }
    return configured;
  }, [showToast]);

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
        const template = localMatch.template;
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

        if (options.autoFillVerified && getPromptFields(template).length === 0) {
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
      // sourced remotely. Below the threshold we *don't* auto-install;
      // a non-blocking toast lets the user browse candidates manually.
      if (isRegistryEnabled()) {
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

            const upvoteSummary =
              best.template.upvotes > 0
                ? ` (${best.template.upvotes} upvote${best.template.upvotes === 1 ? "" : "s"})`
                : "";
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
              lookupMessage: `Matched a community template${upvoteSummary}.`,
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
              showToast(
                `Matched a community template${upvoteSummary} — ready to fill.`,
                "success"
              );
            }
            return "verified-ready";
          }
          if (remoteMatches.length > 0 && !options.silentToasts) {
            // Below auto-install threshold but candidates exist — give
            // the user a soft hint so they can browse.
            showToast(
              `Found ${remoteMatches.length} community template${
                remoteMatches.length === 1 ? "" : "s"
              } that may match. Open Settings → Browse community templates.`,
              "info"
            );
          }
        } catch (err) {
          // Registry is best-effort. Any failure (network, RPC, RLS)
          // silently falls through to the Gemini detection path.
          console.warn("[Typeset] Registry lookup failed; falling back to Gemini:", err);
        }
      }

      // Step 2: nothing in cache or registry. Make sure Gemini is configured.
      const configured = await hasApiKey();
      if (!configured) {
        if (!options.silentToasts) {
          showToast(
            "Add your Gemini API key in Settings to detect fields.",
            "info"
          );
        }
        setSettingsOpen(true);
        updateDocumentInProject(effectiveProjectId, docId, { status: "pending" });
        return "no-key";
      }

      // Step 3: Gemini detection.
      const setDocProcessing = (msg: string, progress?: number) => {
        updateDocumentInProject(effectiveProjectId, docId, {
          status: "processing",
          processingMessage: msg,
          processingProgress: progress,
        });
      };

      let detectedFields: TemplateField[] = [];
      try {
        detectedFields = await detectFieldsWithClaude(bytes, 1, setDocProcessing, {
          projectHint: effectiveProject,
          filename: file.name,
        });
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
      projects,
      selectedProject,
      selectedProjectId,
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

  const handleAddField = useCallback(() => {
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
    const newField: TemplateField = {
      id: `new-${Date.now()}`,
      label: "New field",
      mappedProjectKey: "",
      pageNumber: 1,
      x: 100,
      y: 100,
      width: 150,
      height: inferredHeight,
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
  }, [recordTemplateUndoSnapshot, templateModal]);

  const handleAddCheckbox = useCallback(() => {
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

    const newField: TemplateField = {
      id: `checkbox-${Date.now()}`,
      label: "New checkbox",
      mappedProjectKey: "",
      pageNumber: 1,
      x: 100,
      y: 100,
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
  }, [recordTemplateUndoSnapshot, templateModal]);

  const handleSaveTemplate = useCallback(
    (template: Template, opts: { promote?: boolean } = {}) => {
      const now = new Date().toISOString();
      const savedTemplate: Template = {
        ...template,
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

      showToast("Saved template locally.", "success");
    },
    [activeDocumentId, selectedProjectId, showToast, updateDocumentInProject]
  );

  /**
   * Publish (or update) a template to the public Supabase registry.
   *
   * The fingerprint is rebuilt from the latest fields so any post-
   * detection edits (re-mapped labels, new manual fields) are reflected
   * in the public row. The registry service strips device-specific
   * data — `id`, `customValue`, `__custom__` mappings — before upload.
   *
   * After a successful first publish we stash the returned `registryId`
   * on the local copy so subsequent edits route through
   * `updatePublishedTemplate` (RLS scopes that to the original
   * publisher's device).
   */
  const handlePublishTemplate = useCallback(
    async (template: Template) => {
      if (!isRegistryEnabled()) {
        showToast(
          "Template registry isn't configured. Add Supabase credentials in Settings.",
          "info"
        );
        setSettingsOpen(true);
        return;
      }
      try {
        // Always recompute the fingerprint from the latest fields so the
        // anchor terms / canonical ids reflect any post-detection edits.
        const fingerprint = buildTemplateFingerprintFromTemplate(template);
        const ready: Template = { ...template, fingerprint };

        if (template.registryId) {
          await updatePublishedTemplate(template.registryId, ready);
          const updated: Template = {
            ...ready,
            updatedAt: new Date().toISOString(),
          };
          upsertLocalTemplate(updated);
          setEditedTemplates((prev) => ({ ...prev, [updated.id]: updated }));
          setDraftTemplate((prev) =>
            prev && prev.id === updated.id ? updated : prev
          );
          showToast("Updated your published template.", "success");
        } else {
          const { registryId } = await publishTemplate(ready);
          const updated: Template = {
            ...ready,
            registryId,
            source: "remote-registry",
            updatedAt: new Date().toISOString(),
          };
          upsertLocalTemplate(updated);
          setEditedTemplates((prev) => ({ ...prev, [updated.id]: updated }));
          setDraftTemplate((prev) =>
            prev && prev.id === updated.id ? updated : prev
          );
          showToast(
            "Published. Other users with the same form will see this template.",
            "success"
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Publish failed.";
        console.warn("[Typeset] Publish failed:", err);
        showToast(message, "error");
      }
    },
    [showToast]
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
      const promptFields = getPromptFields(template);
      if (promptFields.length === 0) {
        runFillAction(template, mode, project, sourceBytes, fileName, {}, options);
        return;
      }
      const savedValues = promptValuesByTemplate[template.id];
      const isCheckbox = (f: typeof promptFields[0]) =>
        f.fieldType === "checkbox" || f.fieldKind === "boolean-checkbox";
      const allFilled =
        savedValues &&
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

  const handleNewProject = useCallback(() => {
    setNewProjectDraft({});
    setView("new-project");
  }, []);

  const handleSaveNewProject = useCallback(() => {
    const project = { ...createEmptyProject(), ...newProjectDraft };
    if (project.label || project.jobName) {
      setProjects((prev) => [...prev, project]);
      setSelectedProjectId(project.id);
    }
    setNewProjectDraft({});
    setView("workspace");
  }, [newProjectDraft]);

  const handleCancelNewProject = useCallback(() => {
    setView("workspace");
    setNewProjectDraft({});
  }, []);

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
        if (view === "edit-project" && selectedProjectId) {
          updateProject(selectedProjectId, fields);
        } else {
          setNewProjectDraft((prev) => ({ ...prev, ...fields }));
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
      >
        {view === "new-project" || view === "edit-project" ? (
          <NewProjectView
            initialProject={view === "edit-project" && selectedProject ? selectedProject : newProjectDraft}
            isEditing={view === "edit-project"}
            onChange={(updates) => {
              if (view === "edit-project" && selectedProjectId) {
                updateProject(selectedProjectId, updates);
              } else {
                setNewProjectDraft((prev) => ({ ...prev, ...updates }));
              }
            }}
            onSave={view === "edit-project" ? () => setView("workspace") : handleSaveNewProject}
            onCancel={view === "edit-project" ? () => setView("workspace") : handleCancelNewProject}
            onImportPdf={importProjectFromPdf}
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
            handleSaveTemplate(template, { promote: true });
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
          onSaveLocal={(template) => handleSaveTemplate(template, { promote: true })}
          onPublish={registryReady ? handlePublishTemplate : undefined}
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
        onRegistryConfigChanged={(enabled) => setRegistryReady(enabled)}
        onInstallTemplate={(template) => {
          upsertLocalTemplate(template);
          setEditedTemplates((prev) => ({ ...prev, [template.id]: template }));
          showToast(`Installed “${template.name}” to your local templates.`, "success");
        }}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
