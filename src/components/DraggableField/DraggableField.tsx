import { useRef, useCallback, useState } from "react";
import type { TemplateField } from "@/types";
import { normalizeCardType } from "@/utils/fill";
import styles from "./DraggableField.module.css";

interface DraggableFieldProps {
  field: TemplateField;
  scale: number;
  selected: boolean;
  onSelect: () => void;
  onChangeStart?: () => void;
  onChange: (updates: Partial<TemplateField>) => void;
  /** For checkbox fields: current project value to compare against */
  projectValue?: string;
  /** For checkbox fields: callback when checkbox is clicked */
  onCheckboxClick?: (checkboxValue: string) => void;
}

type DragMode = 
  | "move" 
  | "resize-n" | "resize-s" | "resize-e" | "resize-w"
  | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se" 
  | null;

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let current = el?.parentElement ?? null;
  while (current) {
    const style = getComputedStyle(current);
    if (
      ["auto", "scroll"].includes(style.overflow) ||
      ["auto", "scroll"].includes(style.overflowX) ||
      ["auto", "scroll"].includes(style.overflowY)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export function DraggableField({
  field,
  scale,
  selected,
  onSelect,
  onChangeStart,
  onChange,
  projectValue,
  onCheckboxClick,
}: DraggableFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const startPos = useRef({ x: 0, y: 0, fieldX: 0, fieldY: 0, fieldW: 0, fieldH: 0 });

  const startDrag = useCallback(
    (e: React.MouseEvent, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      onChangeStart?.();
      onSelect();
      setDragMode(mode);
      startPos.current = {
        x: e.clientX,
        y: e.clientY,
        fieldX: field.x,
        fieldY: field.y,
        fieldW: field.width,
        fieldH: field.height,
      };

      const scrollParent = findScrollParent(containerRef.current);
      const savedOverflow = scrollParent?.style.overflow ?? "";
      if (scrollParent) {
        scrollParent.style.overflow = "hidden";
      }

      // v0.5.25 — capture option bboxes at drag start so we can
      // translate/scale them in lockstep with the parent rect. For
      // option-group fields the per-option bboxes live in absolute
      // PDF user-space, so a parent move must shift each option by
      // the same dx/dy and a parent resize scales each option's
      // offset within the parent proportionally.
      //
      // v0.5.36 — also clone `blankRect` (when present) so the
      // X-on-blank renderer's target rect tracks the parent move/
      // resize identically to the option's label bbox. The blank
      // rect is in the same PDF user-space and lives or dies with
      // the option, so we apply the same proportional scaling
      // (sx/sy) and translation (nextX - fieldX) to it.
      const startOptions = field.options
        ? field.options.map((o) => ({
            ...o,
            bbox: { ...o.bbox },
            blankRect: o.blankRect ? { ...o.blankRect } : undefined,
          }))
        : null;

      const computeOptions = (
        nextX: number,
        nextY: number,
        nextW: number,
        nextH: number
      ): TemplateField["options"] | undefined => {
        if (!startOptions) return undefined;
        const { fieldX, fieldY, fieldW, fieldH } = startPos.current;
        const sx = fieldW > 0 ? nextW / fieldW : 1;
        const sy = fieldH > 0 ? nextH / fieldH : 1;
        return startOptions.map((opt) => {
          const localDx = opt.bbox.x - fieldX;
          const localDy = opt.bbox.y - fieldY;
          const next: NonNullable<TemplateField["options"]>[number] = {
            label: opt.label,
            bbox: {
              x: nextX + localDx * sx,
              y: nextY + localDy * sy,
              width: opt.bbox.width * sx,
              height: opt.bbox.height * sy,
            },
          };
          if (opt.hasUnderlineBlank) next.hasUnderlineBlank = true;
          if (opt.blankRect) {
            const blankDx = opt.blankRect.x - fieldX;
            const blankDy = opt.blankRect.y - fieldY;
            next.blankRect = {
              x: nextX + blankDx * sx,
              y: nextY + blankDy * sy,
              width: opt.blankRect.width * sx,
              height: opt.blankRect.height * sy,
            };
          }
          return next;
        });
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();
        const dx = (moveEvent.clientX - startPos.current.x) / scale;
        const dy = (moveEvent.clientY - startPos.current.y) / scale;
        const { fieldX, fieldY, fieldW, fieldH } = startPos.current;

        if (mode === "move") {
          const nextX = Math.max(0, fieldX + dx);
          const nextY = Math.max(0, fieldY + dy);
          const updates: Partial<TemplateField> = { x: nextX, y: nextY };
          const nextOpts = computeOptions(nextX, nextY, fieldW, fieldH);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-e") {
          const nextW = Math.max(20, fieldW + dx);
          const updates: Partial<TemplateField> = { width: nextW };
          const nextOpts = computeOptions(fieldX, fieldY, nextW, fieldH);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-w") {
          const newWidth = Math.max(20, fieldW - dx);
          const nextX = Math.max(0, fieldX + (fieldW - newWidth));
          const updates: Partial<TemplateField> = {
            x: nextX,
            width: newWidth,
          };
          const nextOpts = computeOptions(nextX, fieldY, newWidth, fieldH);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-n") {
          const newHeight = Math.max(10, fieldH - dy);
          const nextY = Math.max(0, fieldY + (fieldH - newHeight));
          const updates: Partial<TemplateField> = {
            y: nextY,
            height: newHeight,
          };
          const nextOpts = computeOptions(fieldX, nextY, fieldW, newHeight);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-s") {
          const newHeight = Math.max(10, fieldH + dy);
          const updates: Partial<TemplateField> = { height: newHeight };
          const nextOpts = computeOptions(fieldX, fieldY, fieldW, newHeight);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-nw") {
          const newWidth = Math.max(20, fieldW - dx);
          const newHeight = Math.max(10, fieldH - dy);
          const nextX = Math.max(0, fieldX + (fieldW - newWidth));
          const nextY = Math.max(0, fieldY + (fieldH - newHeight));
          const updates: Partial<TemplateField> = {
            x: nextX,
            y: nextY,
            width: newWidth,
            height: newHeight,
          };
          const nextOpts = computeOptions(nextX, nextY, newWidth, newHeight);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-ne") {
          const newHeight = Math.max(10, fieldH - dy);
          const nextY = Math.max(0, fieldY + (fieldH - newHeight));
          const newWidth = Math.max(20, fieldW + dx);
          const updates: Partial<TemplateField> = {
            y: nextY,
            width: newWidth,
            height: newHeight,
          };
          const nextOpts = computeOptions(fieldX, nextY, newWidth, newHeight);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-sw") {
          const newWidth = Math.max(20, fieldW - dx);
          const nextX = Math.max(0, fieldX + (fieldW - newWidth));
          const newHeight = Math.max(10, fieldH + dy);
          const updates: Partial<TemplateField> = {
            x: nextX,
            width: newWidth,
            height: newHeight,
          };
          const nextOpts = computeOptions(nextX, fieldY, newWidth, newHeight);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        } else if (mode === "resize-se") {
          const newWidth = Math.max(20, fieldW + dx);
          const newHeight = Math.max(10, fieldH + dy);
          const updates: Partial<TemplateField> = {
            width: newWidth,
            height: newHeight,
          };
          const nextOpts = computeOptions(fieldX, fieldY, newWidth, newHeight);
          if (nextOpts) updates.options = nextOpts;
          onChange(updates);
        }
      };

      const handleMouseUp = () => {
        setDragMode(null);
        if (scrollParent) {
          scrollParent.style.overflow = savedOverflow;
        }
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [field, onChange, onChangeStart, onSelect, scale]
  );

  const handleFieldMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only start move if clicking directly on the field, not on handles
      const target = e.target as HTMLElement;
      if (target.dataset.handle) {
        return;
      }
      startDrag(e, "move");
    },
    [startDrag]
  );

  const scaledStyle = {
    left: field.x * scale,
    top: field.y * scale,
    width: field.width * scale,
    height: field.height * scale,
  };

  const isCheckbox =
    field.fieldType === "checkbox" ||
    field.fieldKind === "checkbox-group" ||
    field.fieldKind === "boolean-checkbox";
  const isCreditCardCheckbox = isCheckbox && field.canonicalFieldId?.startsWith("creditCardType");
  const isChecked = isCheckbox && (
    isCreditCardCheckbox
      ? normalizeCardType(projectValue ?? "") === normalizeCardType(field.checkboxValue ?? "")
      : projectValue === field.checkboxValue
  );

  // v0.5.25 — option-group field (e.g. card-type horizontal label
  // list with no drawn checkboxes). Renders the parent rect for
  // drag/resize plus a small circle outline around each option's
  // bbox to telegraph the selector pattern in the review canvas.
  const isOptionGroup =
    field.fieldType === "option-group" || field.fieldKind === "option-group";

  if (isOptionGroup) {
    const selectedLabel = (field.selectedOption ?? "").toLowerCase();
    return (
      <div
        ref={containerRef}
        data-draggable-field
        className={`${styles.field} ${styles.optionGroup ?? ""} ${selected ? styles.selected : ""} ${dragMode ? styles.dragging : ""}`}
        style={scaledStyle}
        onMouseDown={handleFieldMouseDown}
        title={`${field.label} — drag to move (option group)`}
      >
        <span className={styles.label}>{field.label}</span>

        {(field.options ?? []).map((opt, idx) => {
          const isSel = opt.label.toLowerCase() === selectedLabel;
          // v0.5.36 — branch per-option (NOT per-field) on the
          // detected per-option blank. Two render paths:
          //
          //   1. `hasUnderlineBlank` + `blankRect` present
          //      (`___ Visa`-style row): the option's writable
          //      area IS the blank, not the label. Draw a faint
          //      outline around the blank rect ALWAYS (so the
          //      user can see where the X target sits, even when
          //      nothing is picked yet) and overlay an X centred
          //      on the rect when this option is the selection.
          //      The label rect is left bare — circling a label
          //      that has its own blank to the left would be
          //      visually redundant and would compete with the X
          //      mark for the user's attention.
          //
          //   2. No detected blank (inline-checkbox / button-style
          //      row): keep the v0.5.25 circle-around-label
          //      rendering — the label IS the selector target,
          //      and the circle communicates that.
          if (opt.hasUnderlineBlank && opt.blankRect) {
            const blankLeft = (opt.blankRect.x - field.x) * scale;
            const blankTop = (opt.blankRect.y - field.y) * scale;
            const blankWidth = Math.max(4, opt.blankRect.width * scale);
            const blankHeight = Math.max(4, opt.blankRect.height * scale);
            // X drawn at 80% of the rect's height, centred on the
            // rect (so the arms cross above the underline stroke
            // — same text-baseline geometry the rect itself
            // encodes). Two SVG <line>s; stroke currentColor so a
            // future theme override can restyle without touching
            // this component. Stroke width tracks the
            // selected/unselected affordance the way the circle
            // marker's border width does (2px / 1px).
            const xSize = blankHeight * 0.8;
            const cx = blankWidth / 2;
            const cy = blankHeight / 2;
            const half = xSize / 2;
            const strokeWidth = selected ? 2 : 1.5;
            return (
              <div
                key={`${opt.label}-${idx}`}
                style={{
                  position: "absolute",
                  left: blankLeft,
                  top: blankTop,
                  width: blankWidth,
                  height: blankHeight,
                  pointerEvents: "none",
                  boxSizing: "border-box",
                  // Faint dashed outline around the blank target —
                  // visible even when nothing is selected, so the
                  // canvas review communicates "this is the X
                  // target" without competing with the selected
                  // X glyph itself.
                  border: isSel
                    ? "none"
                    : `1px dashed ${selected ? "rgba(40, 70, 200, 0.55)" : "rgba(40, 70, 200, 0.35)"}`,
                  borderRadius: 2,
                }}
              >
                {isSel && (
                  <svg
                    width={blankWidth}
                    height={blankHeight}
                    viewBox={`0 0 ${blankWidth} ${blankHeight}`}
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      overflow: "visible",
                      color: "#0a7c2c",
                    }}
                  >
                    <line
                      x1={cx - half}
                      y1={cy - half}
                      x2={cx + half}
                      y2={cy + half}
                      stroke="currentColor"
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                    />
                    <line
                      x1={cx - half}
                      y1={cy + half}
                      x2={cx + half}
                      y2={cy - half}
                      stroke="currentColor"
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </div>
            );
          }

          const ovalLeft = (opt.bbox.x - field.x) * scale;
          const ovalTop = (opt.bbox.y - field.y) * scale;
          const ovalWidth = opt.bbox.width * scale;
          const ovalHeight = opt.bbox.height * scale;
          const padPx = 3 * scale;
          return (
            <div
              key={`${opt.label}-${idx}`}
              className={`${styles.optionMarker ?? ""} ${isSel ? styles.optionMarkerSelected ?? "" : ""}`}
              style={{
                position: "absolute",
                left: ovalLeft - padPx,
                top: ovalTop - padPx,
                width: Math.max(8, ovalWidth + padPx * 2),
                height: Math.max(8, ovalHeight + padPx * 2),
                borderRadius: "50%",
                border: `${selected ? 2 : 1}px solid ${isSel ? "#0a7c2c" : "rgba(40, 70, 200, 0.55)"}`,
                pointerEvents: "none",
                boxSizing: "border-box",
              }}
            />
          );
        })}

        <div
          data-handle="nw"
          className={`${styles.handle} ${styles.handleNW}`}
          onMouseDown={(e) => startDrag(e, "resize-nw")}
          title="Drag to resize"
        />
        <div
          data-handle="ne"
          className={`${styles.handle} ${styles.handleNE}`}
          onMouseDown={(e) => startDrag(e, "resize-ne")}
          title="Drag to resize"
        />
        <div
          data-handle="sw"
          className={`${styles.handle} ${styles.handleSW}`}
          onMouseDown={(e) => startDrag(e, "resize-sw")}
          title="Drag to resize"
        />
        <div
          data-handle="se"
          className={`${styles.handle} ${styles.handleSE}`}
          onMouseDown={(e) => startDrag(e, "resize-se")}
          title="Drag to resize"
        />
      </div>
    );
  }

  // Checkbox fields render as click targets, but can also be dragged when selected
  if (isCheckbox) {
    return (
      <div
        ref={containerRef}
        data-draggable-field
        className={`${styles.checkboxField} ${isChecked ? styles.checked : ""} ${selected ? styles.selected : ""} ${dragMode ? styles.dragging : ""}`}
        style={{
          left: field.x * scale,
          top: field.y * scale,
          width: Math.max(12, field.width * scale),
          height: Math.max(12, field.height * scale),
        }}
        onMouseDown={(e) => {
          if (selected) {
            // If already selected, allow dragging
            startDrag(e, "move");
          } else {
            // First click selects and toggles
            e.stopPropagation();
            if (onCheckboxClick && field.checkboxValue) {
              onCheckboxClick(isChecked ? "" : field.checkboxValue);
            }
            onSelect();
          }
        }}
        onClick={(e) => {
          // Keep checkbox selection from being cleared by the preview container click handler.
          e.stopPropagation();
        }}
        title={selected 
          ? `Drag to reposition ${field.checkboxValue}` 
          : `Click to select ${field.checkboxValue}${isChecked ? " (currently selected)" : ""}`
        }
      >
        {isChecked && <span className={styles.checkmark}>✓</span>}
      </div>
    );
  }

  // Text fields render with drag/resize handles
  return (
    <div
      ref={containerRef}
      data-draggable-field
      className={`${styles.field} ${selected ? styles.selected : ""} ${dragMode ? styles.dragging : ""}`}
      style={scaledStyle}
      onMouseDown={handleFieldMouseDown}
      title={`${field.label} — drag to move`}
    >
      <span className={styles.label}>{field.label}</span>
      
      {/* Corner handles */}
      <div
        data-handle="nw"
        className={`${styles.handle} ${styles.handleNW}`}
        onMouseDown={(e) => startDrag(e, "resize-nw")}
        title="Drag to resize"
      />
      <div
        data-handle="ne"
        className={`${styles.handle} ${styles.handleNE}`}
        onMouseDown={(e) => startDrag(e, "resize-ne")}
        title="Drag to resize"
      />
      <div
        data-handle="sw"
        className={`${styles.handle} ${styles.handleSW}`}
        onMouseDown={(e) => startDrag(e, "resize-sw")}
        title="Drag to resize"
      />
      <div
        data-handle="se"
        className={`${styles.handle} ${styles.handleSE}`}
        onMouseDown={(e) => startDrag(e, "resize-se")}
        title="Drag to resize"
      />
      {/* Edge handles */}
      <div
        data-handle="n"
        className={`${styles.handle} ${styles.handleN}`}
        onMouseDown={(e) => startDrag(e, "resize-n")}
        title="Drag to resize height"
      />
      <div
        data-handle="s"
        className={`${styles.handle} ${styles.handleS}`}
        onMouseDown={(e) => startDrag(e, "resize-s")}
        title="Drag to resize height"
      />
      <div
        data-handle="w"
        className={`${styles.handle} ${styles.handleW}`}
        onMouseDown={(e) => startDrag(e, "resize-w")}
        title="Drag to resize width"
      />
      <div
        data-handle="e"
        className={`${styles.handle} ${styles.handleE}`}
        onMouseDown={(e) => startDrag(e, "resize-e")}
        title="Drag to resize width"
      />
    </div>
  );
}
