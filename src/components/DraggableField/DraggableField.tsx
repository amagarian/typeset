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

      const handleMouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();
        const dx = (moveEvent.clientX - startPos.current.x) / scale;
        const dy = (moveEvent.clientY - startPos.current.y) / scale;
        const { fieldX, fieldY, fieldW, fieldH } = startPos.current;

        if (mode === "move") {
          onChange({
            x: Math.max(0, fieldX + dx),
            y: Math.max(0, fieldY + dy),
          });
        } else if (mode === "resize-e") {
          onChange({ width: Math.max(20, fieldW + dx) });
        } else if (mode === "resize-w") {
          const newWidth = Math.max(20, fieldW - dx);
          onChange({
            x: Math.max(0, fieldX + (fieldW - newWidth)),
            width: newWidth,
          });
        } else if (mode === "resize-n") {
          const newHeight = Math.max(10, fieldH - dy);
          onChange({
            y: Math.max(0, fieldY + (fieldH - newHeight)),
            height: newHeight,
          });
        } else if (mode === "resize-s") {
          onChange({ height: Math.max(10, fieldH + dy) });
        } else if (mode === "resize-nw") {
          const newWidth = Math.max(20, fieldW - dx);
          const newHeight = Math.max(10, fieldH - dy);
          onChange({
            x: Math.max(0, fieldX + (fieldW - newWidth)),
            y: Math.max(0, fieldY + (fieldH - newHeight)),
            width: newWidth,
            height: newHeight,
          });
        } else if (mode === "resize-ne") {
          const newHeight = Math.max(10, fieldH - dy);
          onChange({
            y: Math.max(0, fieldY + (fieldH - newHeight)),
            width: Math.max(20, fieldW + dx),
            height: newHeight,
          });
        } else if (mode === "resize-sw") {
          const newWidth = Math.max(20, fieldW - dx);
          onChange({
            x: Math.max(0, fieldX + (fieldW - newWidth)),
            width: newWidth,
            height: Math.max(10, fieldH + dy),
          });
        } else if (mode === "resize-se") {
          onChange({
            width: Math.max(20, fieldW + dx),
            height: Math.max(10, fieldH + dy),
          });
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
