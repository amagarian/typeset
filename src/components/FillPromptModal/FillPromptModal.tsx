import { useMemo, useState, useCallback } from "react";
import type { Template, TemplateField } from "@/types";
import {
  getPromptFields,
  getTemplateFieldPromptLabel,
  type PromptFieldValues,
} from "@/utils/fill";
import { PdfPageCanvas } from "@/components/PdfPageCanvas/PdfPageCanvas";
import styles from "./FillPromptModal.module.css";

interface FillPromptModalProps {
  template: Template;
  pdfBytes?: Uint8Array | null;
  initialValues?: PromptFieldValues;
  mode: "preview" | "export";
  onClose: () => void;
  onSubmit: (values: PromptFieldValues) => void;
}

export function FillPromptModal({
  template,
  pdfBytes,
  initialValues = {},
  mode,
  onClose,
  onSubmit,
}: FillPromptModalProps) {
  const allPromptFields = useMemo(() => getPromptFields(template), [template]);
  const requiredFields = useMemo(() => allPromptFields.filter((f) => !f.optional), [allPromptFields]);
  const optionalFields = useMemo(() => allPromptFields.filter((f) => f.optional), [allPromptFields]);
  const promptFields = allPromptFields;
  const [values, setValues] = useState<PromptFieldValues>(() =>
    Object.fromEntries(promptFields.map((field) => [field.id, initialValues[field.id] ?? ""]))
  );
  const [activeFieldId, setActiveFieldId] = useState<string | null>(
    promptFields.length > 0 ? promptFields[0].id : null
  );
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [pageDims, setPageDims] = useState<{ width: number; height: number; scale: number } | null>(null);

  const handleDimensions = useCallback((dims: { width: number; height: number; scale: number }) => {
    setPageDims(dims);
  }, []);

  const toggleSkipped = useCallback((fieldId: string) => {
    setSkippedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fieldId)) {
        next.delete(fieldId);
      } else {
        next.add(fieldId);
        // Clear any partially-typed value so submit gets a clean empty string.
        setValues((v) => ({ ...v, [fieldId]: "" }));
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    // Skipped fields submit as empty string, which the fill logic already
    // treats as "leave blank in the PDF" (see getTemplateFieldValue).
    const submitted: PromptFieldValues = { ...values };
    for (const id of skippedIds) submitted[id] = "";
    onSubmit(submitted);
  }, [values, skippedIds, onSubmit]);

  const actionLabel = mode === "preview" ? "Continue to preview" : "Fill PDF";

  const activeField = promptFields.find((f) => f.id === activeFieldId) ?? null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="fill-prompt-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={`${styles.modal} ${pdfBytes ? styles.modalWide : ""}`}>
        <header className={styles.header}>
          <h2 id="fill-prompt-title" className={styles.title}>
            Fill required values
          </h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <div className={pdfBytes ? styles.bodyWithPreview : styles.body}>
          {pdfBytes && (
            <div className={styles.previewPane}>
              <div className={styles.pdfContainer}>
                <PdfPageCanvas
                  pdfBytes={pdfBytes}
                  pageNumber={1}
                  maxWidth={320}
                  maxHeight={440}
                  onDimensions={handleDimensions}
                />
                {pageDims && activeField && (
                  <div
                    className={styles.fieldHighlight}
                    style={{
                      left: activeField.x * pageDims.scale,
                      top: activeField.y * pageDims.scale,
                      width: activeField.width * pageDims.scale,
                      height: activeField.height * pageDims.scale,
                    }}
                  />
                )}
              </div>
            </div>
          )}

          <div className={styles.fieldsPane}>
            {requiredFields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                isOptional={false}
                isActive={field.id === activeFieldId}
                isSkipped={skippedIds.has(field.id)}
                value={values[field.id] ?? ""}
                onActivate={() => setActiveFieldId(field.id)}
                onChange={(value) => setValues((prev) => ({ ...prev, [field.id]: value }))}
                onToggleSkip={() => toggleSkipped(field.id)}
              />
            ))}

            {optionalFields.length > 0 && (
              <>
                <div className={styles.sectionDivider}>
                  <span className={styles.sectionLabel}>Optional — if applicable</span>
                </div>
                {optionalFields.map((field) => (
                  <FieldRow
                    key={field.id}
                    field={field}
                    isOptional
                    isActive={field.id === activeFieldId}
                    isSkipped={skippedIds.has(field.id)}
                    value={values[field.id] ?? ""}
                    onActivate={() => setActiveFieldId(field.id)}
                    onChange={(value) => setValues((prev) => ({ ...prev, [field.id]: value }))}
                    onToggleSkip={() => toggleSkipped(field.id)}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primaryBtn} onClick={handleSubmit}>
            {actionLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: TemplateField;
  isOptional: boolean;
  isActive: boolean;
  isSkipped: boolean;
  value: string;
  onActivate: () => void;
  onChange: (value: string) => void;
  onToggleSkip: () => void;
}

function FieldRow({
  field,
  isOptional,
  isActive,
  isSkipped,
  value,
  onActivate,
  onChange,
  onToggleSkip,
}: FieldRowProps) {
  const isCheckbox =
    field.fieldType === "checkbox" || field.fieldKind === "boolean-checkbox";
  const labelText = getTemplateFieldPromptLabel(field);
  const placeholder = isOptional ? `${field.label} (optional)` : field.label;

  const rowClass = [
    styles.row,
    isOptional ? styles.rowOptional : "",
    isActive && !isSkipped ? styles.rowActive : "",
    isSkipped ? styles.rowSkipped : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={rowClass} onClick={() => !isSkipped && onActivate()}>
      <span className={styles.label}>
        {labelText}
        {isOptional && <span className={styles.optionalTag}>Optional</span>}
      </span>

      {isSkipped ? (
        <div className={styles.skippedRow}>
          <span className={styles.skippedText}>Skipped — leave blank in PDF</span>
          <button
            type="button"
            className={styles.restoreBtn}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSkip();
            }}
          >
            Restore
          </button>
        </div>
      ) : isCheckbox ? (
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={value === "yes"}
            onFocus={onActivate}
            onChange={(e) => onChange(e.target.checked ? "yes" : "")}
          />
          <span className={styles.checkboxLabel}>
            {value === "yes" ? "Checked" : "Unchecked"}
          </span>
          <button
            type="button"
            className={styles.skipBtn}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSkip();
            }}
            title="Skip this field"
            aria-label={`Skip ${labelText}`}
          >
            ×
          </button>
        </div>
      ) : (
        <div className={styles.inputWrap}>
          <input
            type="text"
            className={styles.input}
            value={value}
            placeholder={placeholder}
            onFocus={onActivate}
            onChange={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            className={styles.skipBtn}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleSkip();
            }}
            title="Skip this field"
            aria-label={`Skip ${labelText}`}
          >
            ×
          </button>
        </div>
      )}
    </label>
  );
}
