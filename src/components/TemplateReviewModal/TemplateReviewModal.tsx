import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type {
  Template,
  TemplateField,
  Project,
  TemplateMappedProjectKey,
} from "@/types";
import { PdfPageCanvas } from "@/components/PdfPageCanvas/PdfPageCanvas";
import { DraggableField } from "@/components/DraggableField/DraggableField";
import { getTemplateFieldValue, normalizeCardType } from "@/utils/fill";
import styles from "./TemplateReviewModal.module.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface PageDims {
  width: number;
  height: number;
  scale: number;
}

// v0.6.27 — vertical gap between rendered PDF pages in the review
// canvas. Doubles as the natural-size carrier so the pinch sizing
// math (`pdfSizing` width/height) tracks the actual visible extent
// without overshoot.
const PAGE_GAP_PX = 16;

const PROJECT_KEY_LABELS: Record<string, string> = {
  jobName: "Job name",
  jobNumber: "Job number",
  poNumber: "PO / Order number",
  productionCompany: "Production company",
  billingAddress: "Billing address",
  billingCity: "City",
  billingState: "State",
  billingZipCode: "Zip code",
  creditCardHolder: "Name",
  email: "Email",
  phone: "Phone",
  creditCardType: "Credit card type",
  creditCardNumber: "Card number",
  expDate: "Exp date",
  ccv: "CCV",
  cardholderSignature: "Signature",
  authorizationDate: "Authorization date",
  shootDate: "Shoot date",
};

const CHECKBOX_VALUE_LABELS: Record<string, string> = {
  yes: "Yes / checked",
  visa: "VISA",
  mastercard: "MasterCard",
  discover: "Discover",
  amex: "AMEX",
};

function isCheckboxField(field: TemplateField): boolean {
  return (
    field.fieldType === "checkbox" ||
    field.fieldKind === "checkbox-group" ||
    field.fieldKind === "boolean-checkbox"
  );
}

function isOptionGroupField(field: TemplateField): boolean {
  return (
    field.fieldType === "option-group" || field.fieldKind === "option-group"
  );
}

// v0.5.3 — render-time zoom bounds. Field coords stay in PDF
// user-space on disk; zoom is purely cosmetic, applied via the
// PdfPageCanvas's `zoomFactor` prop (which also scales the reported
// `pageDims.scale`, so DraggableField overlays track the canvas
// without any extra math in this file).
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;

// v0.5.4 — settle delay after the last wheel event before we
// commit `liveZoom` into `zoomFactor` (which triggers the
// expensive PDF.js re-rasterization). 200ms feels instant on
// release but cleanly absorbs every frame of an active pinch.
const ZOOM_SETTLE_MS = 200;

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}



interface TemplateReviewModalProps {
  template: Template;
  project?: Project | null;
  pdfBytes?: Uint8Array | null;
  onClose: () => void;
  onConfirm: (template: Template) => void;
  /**
   * Save the template locally. As of v0.5.2 this also publishes to
   * the public registry when the registry is configured — the publish
   * is fire-and-forget at the App.tsx level. The modal stays unaware
   * of the registry; it just calls Save.
   */
  onSaveLocal: (template: Template) => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onBeginFieldEdit: () => void;
  onFieldChange: (fieldId: string, updates: Partial<TemplateField>) => void;
  onDeleteField: (fieldId: string) => void;
  /**
   * v0.6.21 — optional placement carries the PDF user-space coords
   * where the new field should be centered. The modal computes this
   * from the current scroll position + canvas geometry so the new
   * bbox appears in the middle of the visible viewport (instead of
   * always at the page's top-left). Callers may ignore `placement`
   * and fall back to a default position.
   */
  onAddField: (placement?: { x: number; y: number; pageNumber: number }) => void;
  onAddCheckbox: (placement?: { x: number; y: number; pageNumber: number }) => void;
  onProjectChange?: (updates: Partial<Project>) => void;
  onRedetect?: () => void;
}

export function TemplateReviewModal({
  template,
  project,
  pdfBytes,
  onClose,
  onConfirm,
  onSaveLocal,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  onBeginFieldEdit,
  onFieldChange,
  onDeleteField,
  onAddField,
  onAddCheckbox,
  onProjectChange,
  onRedetect,
}: TemplateReviewModalProps) {
  // v0.6.27 — multi-page review canvas. Track per-page dimensions
  // so each page's DraggableField overlays use that page's own
  // rendered scale (pages with different sizes get their own
  // viewports, e.g. landscape pages mixed into a portrait packet).
  const [pageDimsByPage, setPageDimsByPage] = useState<Map<number, PageDims>>(
    () => new Map()
  );
  const [numPages, setNumPages] = useState<number>(1);
  const pageWrapsRef = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const setPageWrapRef = useCallback((page: number) =>
    (el: HTMLDivElement | null) => {
      const map = pageWrapsRef.current;
      if (el) map.set(page, el);
      else map.delete(page);
    },
  []);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  // v0.5.4 — three zoom values:
  //   • liveZoom: transient gesture intent. Updates every wheel
  //     tick. Drives a cheap CSS transform.
  //   • zoomFactor: committed render target. Only changes on
  //     settle or via discrete buttons/keyboard. This is what
  //     PdfPageCanvas re-rasterizes at.
  //   • lastRenderedZoom: what the canvas has actually finished
  //     rendering. Updates when onDimensions fires. Divisor for
  //     the transient transform so the visual scale matches
  //     intent regardless of where the raster pipeline is.
  const [zoomFactor, setZoomFactor] = useState(1);
  const [liveZoom, setLiveZoom] = useState(1);
  const [lastRenderedZoom, setLastRenderedZoom] = useState(1);
  const fieldListRef = useRef<HTMLUListElement>(null);
  const previewAreaRef = useRef<HTMLDivElement>(null);
  // v0.6.21 — ref to the inner pdfContainer (the positioning context
  // for absolute-positioned DraggableField overlays). Used by the
  // "Add field" handler to compute the visible viewport's center in
  // PDF user-space so the new bbox lands where the user is looking.
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  // v0.5.6 — closure-stable mirror of `lastRenderedZoom` so the
  // wheel handler (set up once in a useEffect) reads the latest value
  // when computing the cursor anchor's document-space coords.
  const lastRenderedZoomRef = useRef(1);
  // v0.6.27 — per-page dimensions. Each PdfPageCanvas reports its
  // own viewport; we key by `pageNumber` so a packet with mixed page
  // sizes still tracks each one correctly. `lastRenderedZoom` is the
  // zoomFactor passed in, which is identical across pages, so we
  // only need one copy of it.
  const handleDimensionsForPage = useCallback(
    (pageNumber: number) =>
      (dims: { width: number; height: number; scale: number; renderedZoom: number }) => {
        setPageDimsByPage((prev) => {
          const existing = prev.get(pageNumber);
          if (
            existing &&
            existing.width === dims.width &&
            existing.height === dims.height &&
            existing.scale === dims.scale
          ) {
            return prev;
          }
          const next = new Map(prev);
          next.set(pageNumber, {
            width: dims.width,
            height: dims.height,
            scale: dims.scale,
          });
          return next;
        });
        setLastRenderedZoom(dims.renderedZoom);
        lastRenderedZoomRef.current = dims.renderedZoom;
      },
    [],
  );

  // v0.6.27 — probe the PDF for its page count so we know how many
  // `PdfPageCanvas` instances to render. Falls back to 1 on error so
  // the user still sees something even if pdfjs barfs on a damaged
  // file (the same rasterize-and-overlay path covers fill-time).
  useEffect(() => {
    if (!pdfBytes) {
      setNumPages(1);
      setPageDimsByPage(new Map());
      pageWrapsRef.current.clear();
      return;
    }
    let cancelled = false;
    const bytesCopy = new Uint8Array(pdfBytes);
    const task = pdfjsLib.getDocument({ data: bytesCopy });
    task.promise
      .then((pdf) => {
        if (cancelled) return;
        setNumPages(pdf.numPages);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn(
          "[TemplateReviewModal] could not probe PDF page count; falling back to 1.",
          err
        );
        setNumPages(1);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfBytes]);

  // v0.6.27 — derived "primary" dims used by the transient pinch
  // sizing math and by callers that pre-date multi-page support.
  // Width is the max page width (the column is centered, the widest
  // page sets the rail width); height is the sum of all known page
  // heights + inter-page gaps. Unknown pages contribute 0 (their
  // canvases will fill in once they finish rendering, growing the
  // sizing wrapper to match).
  const pageDimsList = useMemo<Array<{ pageNumber: number; dims: PageDims | null }>>(() => {
    const list: Array<{ pageNumber: number; dims: PageDims | null }> = [];
    for (let p = 1; p <= numPages; p += 1) {
      list.push({ pageNumber: p, dims: pageDimsByPage.get(p) ?? null });
    }
    return list;
  }, [numPages, pageDimsByPage]);

  const totalDims = useMemo<{ width: number; height: number } | null>(() => {
    let width = 0;
    let height = 0;
    let gotAny = false;
    for (const entry of pageDimsList) {
      if (!entry.dims) continue;
      gotAny = true;
      width = Math.max(width, entry.dims.width);
      height += entry.dims.height;
    }
    if (!gotAny) return null;
    height += Math.max(0, pageDimsList.length - 1) * PAGE_GAP_PX;
    return { width, height };
  }, [pageDimsList]);


  // v0.5.6 — cursor anchor for zoom-around-cursor behavior. Captured
  // before each liveZoom mutation: pinch wheel events store the actual
  // cursor position; discrete +/-/0 zoom stores the viewport center.
  // A useLayoutEffect on liveZoom reads this anchor and rewrites
  // previewArea scroll so the recorded document point ends up back
  // under the cursor after the new transform applies. The anchor is
  // single-use — cleared after each application — so a stale anchor
  // can never trigger a phantom scroll on an unrelated re-render
  // (e.g. when lastRenderedZoom snaps after a re-raster completes).
  const lastCursorAnchorRef = useRef<{
    docX: number;
    docY: number;
    cursorLocalX: number;
    cursorLocalY: number;
  } | null>(null);

  // v0.5.4 — discrete zoom commits both the live (visual) and the
  // committed (raster target) zoom synchronously, so a button click
  // or keyboard shortcut produces a crisp re-rasterized result with
  // no transient blur. Smooth wheel/pinch zoom takes a different
  // path that defers the raster commit (see effect below).
  const liveZoomRef = useRef(1);
  const commitZoom = useCallback((next: number) => {
    const clamped = clampZoom(next);
    liveZoomRef.current = clamped;
    setLiveZoom(clamped);
    setZoomFactor(clamped);
  }, []);
  // v0.5.6 — discrete zoom (buttons + Cmd+=/Cmd+-/Cmd+0) anchors to
  // the viewport center: there's no cursor location for a keyboard
  // shortcut and "center" is the most predictable visual anchor for
  // a button click.
  const captureViewportCenterAnchor = useCallback(() => {
    const previewArea = previewAreaRef.current;
    if (!previewArea) return;
    const rect = previewArea.getBoundingClientRect();
    const oldDisplayScale = liveZoomRef.current / lastRenderedZoomRef.current;
    if (!Number.isFinite(oldDisplayScale) || oldDisplayScale <= 0) return;
    lastCursorAnchorRef.current = {
      docX: (rect.width / 2 + previewArea.scrollLeft) / oldDisplayScale,
      docY: (rect.height / 2 + previewArea.scrollTop) / oldDisplayScale,
      cursorLocalX: rect.width / 2,
      cursorLocalY: rect.height / 2,
    };
  }, []);
  const zoomIn = useCallback(() => {
    captureViewportCenterAnchor();
    commitZoom(liveZoomRef.current * ZOOM_STEP);
  }, [commitZoom, captureViewportCenterAnchor]);
  const zoomOut = useCallback(() => {
    captureViewportCenterAnchor();
    commitZoom(liveZoomRef.current / ZOOM_STEP);
  }, [commitZoom, captureViewportCenterAnchor]);
  const zoomReset = useCallback(() => {
    captureViewportCenterAnchor();
    commitZoom(1);
  }, [commitZoom, captureViewportCenterAnchor]);

  // v0.5.4 — pinch/wheel zoom is decoupled from the PDF re-raster.
  // Every wheel tick accumulates a delta in a ref; we apply it once
  // per animation frame to `liveZoom` (which drives a CSS transform
  // — GPU-accelerated, instant) and (re)schedule a settle timer
  // that commits `zoomFactor` 200ms after the last event. Without
  // this, every wheel tick was triggering PdfPageCanvas's render
  // effect, which cancels in-flight rasters and queues fresh ones
  // at 60Hz — i.e. nothing useful was completing during the
  // gesture.
  //
  // macOS trackpad pinch arrives as `wheel` events with
  // `ctrlKey: true`. We need a non-passive listener to call
  // preventDefault() and stop the browser's page-zoom; attaching
  // via addEventListener (not React's onWheel) is the only way to
  // pass `{ passive: false }`.
  useEffect(() => {
    const node = previewAreaRef.current;
    if (!node) return;

    let pendingDelta = 0;
    let rafId: number | null = null;
    let settleId: number | null = null;

    const flush = () => {
      rafId = null;
      const d = pendingDelta;
      pendingDelta = 0;
      if (d === 0) return;
      // Composing exp() per-tick is mathematically equivalent to a
      // single exp() over the summed delta, so accumulating the
      // raw deltaY is correct.
      const next = clampZoom(liveZoomRef.current * Math.exp(-d * 0.01));
      liveZoomRef.current = next;
      setLiveZoom(next);
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // v0.5.6 — capture the cursor anchor BEFORE we accumulate
      // the delta. The doc-space coords are computed against the
      // CURRENT (pre-update) liveZoom/lastRenderedZoom, so the
      // useLayoutEffect that runs after this rAF tick can place
      // the same document point back under the cursor at the new
      // zoom. Multiple wheel events in a single frame just
      // overwrite the anchor with the latest cursor position —
      // that's the position we want to anchor to.
      const rect = node.getBoundingClientRect();
      const cursorLocalX = e.clientX - rect.left;
      const cursorLocalY = e.clientY - rect.top;
      const oldDisplayScale =
        liveZoomRef.current / lastRenderedZoomRef.current;
      if (Number.isFinite(oldDisplayScale) && oldDisplayScale > 0) {
        lastCursorAnchorRef.current = {
          docX: (cursorLocalX + node.scrollLeft) / oldDisplayScale,
          docY: (cursorLocalY + node.scrollTop) / oldDisplayScale,
          cursorLocalX,
          cursorLocalY,
        };
      }
      pendingDelta += e.deltaY;
      if (rafId == null) {
        rafId = requestAnimationFrame(flush);
      }
      if (settleId != null) {
        window.clearTimeout(settleId);
      }
      settleId = window.setTimeout(() => {
        settleId = null;
        // Flush any unapplied delta first so the committed value
        // matches what the user is seeing on screen.
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          flush();
        }
        setZoomFactor(liveZoomRef.current);
      }, ZOOM_SETTLE_MS);
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      if (rafId != null) cancelAnimationFrame(rafId);
      if (settleId != null) window.clearTimeout(settleId);
    };
  }, []);

  // v0.5.6 — cursor-anchored zoom. Runs synchronously after React
  // mutates the DOM (so .pdfSizing's new width/height is in place
  // and previewArea's scrollable extent is up-to-date) but before
  // the browser paints. Re-anchors the recorded document point so
  // the visual position under the cursor stays put across a zoom
  // change. transform-origin remains 0 0 — this is mathematically
  // simpler than a cursor-positioned origin because the visual
  // extent of .pdfContainer aligns exactly with .pdfSizing's
  // layout box, so scroll-content coords == pdfSizing coords ==
  // pdfContainer-natural coords * displayScale.
  //
  // The anchor is single-use: cleared after each application so a
  // re-render that wasn't preceded by a fresh anchor capture
  // (e.g. lastRenderedZoom snapping after an async re-raster
  // completes) is a no-op. Without that clear, a stale anchor in
  // the OLD natural coord space would compute a bogus scroll
  // position when lastRenderedZoom changes the natural coord
  // basis underneath us.
  useLayoutEffect(() => {
    const anchor = lastCursorAnchorRef.current;
    if (!anchor) return;
    const previewArea = previewAreaRef.current;
    if (!previewArea) return;
    const newDisplayScale = liveZoom / lastRenderedZoom;
    if (!Number.isFinite(newDisplayScale) || newDisplayScale <= 0) return;
    // After scaling, the doc point sits at
    // (docX * newDisplayScale, docY * newDisplayScale) in
    // pdfSizing's coord space (== previewArea's scroll content).
    // To render it at (cursorLocalX, cursorLocalY) inside the
    // viewport, scrollLeft must be docPoint - cursorLocal.
    const targetScrollLeft = anchor.docX * newDisplayScale - anchor.cursorLocalX;
    const targetScrollTop = anchor.docY * newDisplayScale - anchor.cursorLocalY;
    previewArea.scrollLeft = Math.max(0, targetScrollLeft);
    previewArea.scrollTop = Math.max(0, targetScrollTop);
    lastCursorAnchorRef.current = null;
  }, [liveZoom, lastRenderedZoom]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        Boolean(target?.isContentEditable);

      if (
        selectedFieldId &&
        !isEditable &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const field = template.fields.find((f) => f.id === selectedFieldId);
        if (!field) return;
        const updates: Partial<TemplateField> = {};
        if (event.key === "ArrowLeft") updates.x = Math.max(0, field.x - step);
        if (event.key === "ArrowRight") updates.x = field.x + step;
        if (event.key === "ArrowUp") updates.y = Math.max(0, field.y - step);
        if (event.key === "ArrowDown") updates.y = field.y + step;
        onBeginFieldEdit();
        onFieldChange(selectedFieldId, updates);
        return;
      }

      // v0.6.20 — Delete / Backspace removes the selected field.
      // We gate on `!isEditable` so the shortcut doesn't fire while
      // the user is mid-edit in the prompt-label / custom-value
      // inputs in the sidebar. Records an undo snapshot first so
      // the deletion is reversible via Cmd+Z (same flow as the
      // sidebar's `×` button).
      if (
        selectedFieldId &&
        !isEditable &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        onBeginFieldEdit();
        onDeleteField(selectedFieldId);
        setSelectedFieldId(null);
        return;
      }

      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier) return;

      // v0.5.3 — Cmd+= / Cmd+- / Cmd+0 zoom shortcuts. `event.key`
      // for Cmd+= is "=" (US layout) and Cmd+- is "-". Some browsers
      // report "+" when Shift is also held; accept either.
      if (!isEditable) {
        if (event.key === "=" || event.key === "+") {
          event.preventDefault();
          zoomIn();
          return;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          zoomOut();
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          zoomReset();
          return;
        }
      }

      if (event.key.toLowerCase() !== "z") return;
      if (isEditable) return;
      if (event.shiftKey) {
        if (!canRedo) return;
        event.preventDefault();
        onRedo();
        return;
      }
      if (!canUndo) return;
      event.preventDefault();
      onUndo();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canRedo, canUndo, onRedo, onUndo, selectedFieldId, template.fields, onFieldChange, onBeginFieldEdit, onDeleteField, zoomIn, zoomOut, zoomReset]);

  useEffect(() => {
    if (!selectedFieldId || !fieldListRef.current) return;
    const el = fieldListRef.current.querySelector(`[data-field-id="${selectedFieldId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selectedFieldId]);

  /**
   * v0.6.21 — return the visible viewport's center in PDF
   * user-space coords, suitable for placing a freshly-added field
   * so it appears where the user is looking instead of always at
   * (100, 100). Uses `getBoundingClientRect` on the previewArea
   * (scroll viewport) and the inner pdfContainer (DraggableField
   * positioning context), so the math survives:
   *   - scroll position (we read what's actually visible),
   *   - zoom factor (pageDims.scale already encodes it),
   *   - the previewArea's centering padding (the container's
   *     position relative to the scroll content is non-trivial),
   *   - mid-pinch transforms (getBoundingClientRect respects them).
   *
   * Returns `null` when the canvas hasn't rendered yet — callers
   * fall back to a default position (App.tsx defaults to 100, 100).
   */
  const getViewportCenterPlacement = useCallback(():
    | { x: number; y: number; pageNumber: number }
    | null => {
    const preview = previewAreaRef.current;
    if (!preview) return null;
    const previewRect = preview.getBoundingClientRect();
    const cssCx = previewRect.left + previewRect.width / 2;
    const cssCy = previewRect.top + previewRect.height / 2;
    // v0.6.27 — walk each page wrap and find the one whose rect
    // contains the viewport center. If none contain it (e.g. user
    // scrolled into the gap between pages, or above/below the
    // stack), pick the page whose vertical midpoint is closest to
    // the viewport center. This gives a stable answer even when the
    // user adds a field while looking at an inter-page gap.
    let bestPage = -1;
    let bestDist = Infinity;
    let bestRect: DOMRect | null = null;
    let bestDims: PageDims | null = null;
    for (const [pageNumber, el] of pageWrapsRef.current.entries()) {
      if (!el) continue;
      const dims = pageDimsByPage.get(pageNumber);
      if (!dims || dims.scale <= 0) continue;
      const rect = el.getBoundingClientRect();
      if (cssCy >= rect.top && cssCy <= rect.bottom) {
        bestPage = pageNumber;
        bestRect = rect;
        bestDims = dims;
        break;
      }
      const midY = rect.top + rect.height / 2;
      const dist = Math.abs(cssCy - midY);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = pageNumber;
        bestRect = rect;
        bestDims = dims;
      }
    }
    if (!bestRect || !bestDims || bestPage < 0) return null;
    const localX = cssCx - bestRect.left;
    const localY = cssCy - bestRect.top;
    const pdfX = localX / bestDims.scale;
    const pdfY = localY / bestDims.scale;
    return { x: pdfX, y: pdfY, pageNumber: bestPage };
  }, [pageDimsByPage]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="template-modal-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <h2 id="template-modal-title" className={styles.title}>
            Template review — {template.name}
          </h2>
          <span className={styles.hint}>Click a field to select, drag to move, use handles to resize</span>
          <div className={styles.zoomToolbar} role="group" aria-label="Zoom">
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={zoomOut}
              disabled={liveZoom <= ZOOM_MIN + 1e-3}
              title="Zoom out (⌘−)"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className={styles.zoomLevel}
              onClick={zoomReset}
              title="Reset zoom (⌘0)"
              aria-label={`Current zoom ${Math.round(liveZoom * 100)}%, click to reset`}
            >
              {Math.round(liveZoom * 100)}%
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={zoomIn}
              disabled={liveZoom >= ZOOM_MAX - 1e-3}
              title="Zoom in (⌘+)"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <div
            ref={previewAreaRef}
            className={styles.previewArea}
            onClickCapture={(e) => {
              const target = e.target as HTMLElement;
              if (target.closest("[data-draggable-field]")) return;
              setSelectedFieldId(null);
            }}
          >
            {pdfBytes ? (
              // v0.5.4 — transient transform during pinch. While
              // `liveZoom != lastRenderedZoom`, displayScale != 1
              // and we apply transform: scale(displayScale) to the
              // PDF container so it visually tracks the gesture
              // without forcing a re-raster on every wheel tick.
              // The outer sizing div gives the parent's
              // overflow:auto a real layout box (transform doesn't
              // affect layout-box dimensions) so scrollbars stay
              // accurate during the gesture.
              //
              // Steady state: liveZoom == zoomFactor == lastRenderedZoom
              //   → displayScale = 1, no transform, no sizing override.
              // Mid-pinch (or commit-pending): displayScale = liveZoom/lastRenderedZoom.
              // After re-raster fires onDimensions: lastRenderedZoom updates
              //   → displayScale snaps back to 1 and the transform falls away.
              //
              // Trade-off: a field-drag during an active pinch
              // would compute against pageDims.scale (the rendered
              // scale) while the canvas is visually transformed,
              // so the cursor and field would diverge slightly.
              // Pinching while dragging isn't a real workflow — we
              // accept this in exchange for smooth gesture
              // performance.
              (() => {
                const displayScale =
                  lastRenderedZoom > 0 ? liveZoom / lastRenderedZoom : 1;
                const isTransformed = Math.abs(displayScale - 1) > 1e-3;
                const sizingStyle =
                  isTransformed && totalDims
                    ? {
                        width: totalDims.width * displayScale,
                        height: totalDims.height * displayScale,
                      }
                    : undefined;
                const containerStyle = isTransformed
                  ? {
                      transform: `scale(${displayScale})`,
                      transformOrigin: "0 0" as const,
                    }
                  : undefined;
                return (
                  <div className={styles.pdfSizing} style={sizingStyle}>
                    <div
                      ref={pdfContainerRef}
                      className={styles.pdfContainer}
                      style={containerStyle}
                    >
                      {pageDimsList.map(({ pageNumber: p, dims }) => (
                        <div
                          key={p}
                          ref={setPageWrapRef(p)}
                          className={styles.pageWrap}
                          style={
                            p > 1 ? { marginTop: PAGE_GAP_PX } : undefined
                          }
                        >
                          <PdfPageCanvas
                            pdfBytes={pdfBytes}
                            pageNumber={p}
                            maxWidth={580}
                            maxHeight={720}
                            zoomFactor={zoomFactor}
                            onDimensions={handleDimensionsForPage(p)}
                          />
                          {dims &&
                            template.fields
                              .filter((f) => f.pageNumber === p)
                              .map((f) => (
                                <DraggableField
                                  key={f.id}
                                  field={f}
                                  scale={dims.scale}
                                  selected={f.id === selectedFieldId}
                                  onSelect={() => setSelectedFieldId(f.id)}
                                  onChangeStart={onBeginFieldEdit}
                                  onChange={(updates) => onFieldChange(f.id, updates)}
                                  projectValue={
                                    project ? getTemplateFieldValue(project, f) : undefined
                                  }
                                  onCheckboxClick={
                                    f.fieldType === "checkbox" && onProjectChange
                                      ? (value) => {
                                          if (f.mappedProjectKey === "creditCardType") {
                                            const normalized =
                                              normalizeCardType(value) || value;
                                            onProjectChange({
                                              creditCardType:
                                                normalized as Project["creditCardType"],
                                            });
                                          }
                                        }
                                      : undefined
                                  }
                                  onDelete={() => {
                                    onBeginFieldEdit();
                                    onDeleteField(f.id);
                                    if (selectedFieldId === f.id) {
                                      setSelectedFieldId(null);
                                    }
                                  }}
                                />
                              ))}
                          {numPages > 1 && (
                            <div className={styles.pageBadge}>
                              Page {p} / {numPages}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className={styles.pdfPlaceholder}>
                No PDF loaded. Drop a PDF first to see preview.
              </div>
            )}
          </div>

          <aside className={styles.sidebar}>
            <h3 className={styles.sidebarTitle}>Fields ({template.fields.length})</h3>
            <ul className={styles.fieldList} ref={fieldListRef}>
              {template.fields.map((f) => (
                <li
                  key={f.id}
                  data-field-id={f.id}
                  className={`${styles.fieldItem} ${f.id === selectedFieldId ? styles.fieldItemSelected : ""} ${f.party === "vendor" ? styles.fieldItemVendor : ""}`}
                  onClick={() => setSelectedFieldId(f.id)}
                >
                  <div className={styles.fieldItemRow}>
                    <span className={styles.fieldItemLabel}>{f.label}</span>
                    {f.party === "vendor" && (
                      <span
                        className={`${styles.fieldItemParty} ${styles.fieldItemPartyVendor}`}
                        title="Auto-detected as a vendor field (the other party fills this in)"
                      >
                        vendor
                      </span>
                    )}
                    {f.party === "signer" && (
                      <span
                        className={`${styles.fieldItemParty} ${styles.fieldItemPartySigner}`}
                        title="Auto-detected as your field (Wrapkit auto-fills)"
                      >
                        you
                      </span>
                    )}
                    {numPages > 1 && (
                      <span
                        className={styles.fieldItemPage}
                        title={`Page ${f.pageNumber}`}
                      >
                        p{f.pageNumber}
                      </span>
                    )}
                    <button
                      type="button"
                      className={styles.deleteBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onBeginFieldEdit();
                        onDeleteField(f.id);
                      }}
                      title="Delete field"
                    >
                      ×
                    </button>
                  </div>
                  <select
                    className={styles.select}
                    value={f.mappedProjectKey || ""}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      onBeginFieldEdit();
                      onFieldChange(f.id, {
                        mappedProjectKey: (e.target.value || "") as TemplateMappedProjectKey,
                        ...(isCheckboxField(f)
                          ? {
                              fieldKind:
                                e.target.value === "creditCardType"
                                  ? ("checkbox-group" as const)
                                  : ("boolean-checkbox" as const),
                              checkboxValue:
                                e.target.value === "creditCardType"
                                  ? f.checkboxValue && f.checkboxValue !== "yes"
                                    ? f.checkboxValue
                                    : "visa"
                                  : "yes",
                            }
                          : {}),
                      });
                    }}
                  >
                    <option value="">— Not mapped —</option>
                    {(Object.keys(PROJECT_KEY_LABELS) as (keyof Project)[]).map((key) => (
                      <option key={key} value={key}>
                        {PROJECT_KEY_LABELS[key]}
                      </option>
                    ))}
                    {!isCheckboxField(f) && !isOptionGroupField(f) && (
                      <option value="__custom__">Custom value</option>
                    )}
                    {!isCheckboxField(f) && !isOptionGroupField(f) && (
                      <option value="__prompt__">Prompt at fill time</option>
                    )}
                  </select>
                  {isOptionGroupField(f) && (
                    <select
                      className={styles.select}
                      value={f.selectedOption ?? ""}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        onBeginFieldEdit();
                        onFieldChange(f.id, {
                          selectedOption: e.target.value || null,
                        });
                      }}
                      title="Default selection (overridden at fill time)"
                    >
                      <option value="">— No default selection —</option>
                      {(f.options ?? []).map((opt) => (
                        <option key={opt.label} value={opt.label}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {!isCheckboxField(f) && !isOptionGroupField(f) && f.mappedProjectKey === "__custom__" && (
                    <input
                      type="text"
                      className={styles.input}
                      value={f.customValue ?? ""}
                      placeholder="Enter custom field value"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        onBeginFieldEdit();
                        onFieldChange(f.id, { customValue: e.target.value });
                      }}
                    />
                  )}
                  {!isCheckboxField(f) && !isOptionGroupField(f) && f.mappedProjectKey === "__prompt__" && (
                    <input
                      type="text"
                      className={styles.input}
                      value={f.promptLabel ?? ""}
                      placeholder="Prompt label, e.g. Charge authorization amount"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        onBeginFieldEdit();
                        onFieldChange(f.id, { promptLabel: e.target.value });
                      }}
                    />
                  )}
                  {isCheckboxField(f) && (
                    <select
                      className={styles.select}
                      value={f.checkboxValue || "yes"}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        onBeginFieldEdit();
                        onFieldChange(f.id, {
                          checkboxValue: e.target.value,
                          fieldKind:
                            e.target.value === "visa" ||
                            e.target.value === "mastercard" ||
                            e.target.value === "discover" ||
                            e.target.value === "amex"
                              ? "checkbox-group"
                              : "boolean-checkbox",
                        });
                      }}
                    >
                      {Object.entries(CHECKBOX_VALUE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          Check when value is {label}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
            <div className={styles.addActions}>
              <button
                type="button"
                className={styles.addFieldBtn}
                onClick={() => onAddField(getViewportCenterPlacement() ?? undefined)}
              >
                + Add field
              </button>
              <button
                type="button"
                className={styles.addFieldBtn}
                onClick={() => onAddCheckbox(getViewportCenterPlacement() ?? undefined)}
              >
                + Add checkbox
              </button>
            </div>

          </aside>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          {onRedetect && (
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={onRedetect}
              title="Run fresh AI detection on this document"
            >
              Re-detect fields
            </button>
          )}
          <button
            type="button"
            className={styles.saveBtn}
            onClick={() => onSaveLocal(template)}
          >
            Save template
          </button>
          <button
            type="button"
            className={styles.confirmBtn}
            onClick={() => onConfirm(template)}
          >
            Fill
          </button>
        </footer>
      </div>
    </div>
  );
}
