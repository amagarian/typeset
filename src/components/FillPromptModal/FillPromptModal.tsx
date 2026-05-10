import { useMemo, useState, useCallback } from "react";
import type { Project, Template, TemplateField } from "@/types";
import {
  getOptionGroupSelection,
  getPromptFields,
  getTemplateFieldPromptLabel,
  isOptionGroupField,
  type PromptFieldValues,
} from "@/utils/fill";
import { PdfPageCanvas } from "@/components/PdfPageCanvas/PdfPageCanvas";
import styles from "./FillPromptModal.module.css";

interface FillPromptModalProps {
  template: Template;
  pdfBytes?: Uint8Array | null;
  initialValues?: PromptFieldValues;
  /**
   * v0.5.25 — used to seed an option-group field's default selection
   * from the project's stored value (e.g. card type) so the typical
   * "no-change" case is a single confirmation click.
   */
  project?: Project | null;
  mode: "preview" | "export";
  onClose: () => void;
  onSubmit: (values: PromptFieldValues) => void;
}

export function FillPromptModal({
  template,
  pdfBytes,
  initialValues = {},
  project,
  mode,
  onClose,
  onSubmit,
}: FillPromptModalProps) {
  // v0.5.26 — `getPromptFields` now considers project + initial values
  // so an option-group field whose selection is already resolvable
  // (project default or saved prompt value) is hidden from the
  // modal entirely. Mirrors the behaviour of `checkbox-group` and
  // every other auto-fillable kind.
  const allPromptFields = useMemo(
    () => getPromptFields(template, project ?? undefined, initialValues),
    [template, project, initialValues]
  );
  const requiredFields = useMemo(() => allPromptFields.filter((f) => !f.optional), [allPromptFields]);
  const optionalFields = useMemo(() => allPromptFields.filter((f) => f.optional), [allPromptFields]);
  const promptFields = allPromptFields;
  const [values, setValues] = useState<PromptFieldValues>(() =>
    Object.fromEntries(
      promptFields.map((field) => {
        const seeded = initialValues[field.id];
        if (seeded !== undefined && seeded !== "") return [field.id, seeded];
        if (isOptionGroupField(field) && project) {
          return [field.id, getOptionGroupSelection(project, field, {})];
        }
        return [field.id, seeded ?? ""];
      })
    )
  );
  const [activeFieldId, setActiveFieldId] = useState<string | null>(
    promptFields.length > 0 ? promptFields[0].id : null
  );
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [pageDims, setPageDims] = useState<{ width: number; height: number; scale: number } | null>(null);

  const handleDimensions = useCallback((dims: { width: number; height: number; scale: number; renderedZoom: number }) => {
    setPageDims({ width: dims.width, height: dims.height, scale: dims.scale });
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
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close" title="Close">
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
  const isOptionGroup = isOptionGroupField(field);
  const labelText = getTemplateFieldPromptLabel(field);
  const placeholder = isOptional ? `${field.label} (optional)` : field.label;

  const rowClass = [
    styles.row,
    isOptional ? styles.rowOptional : "",
    isActive && !isSkipped ? styles.rowActive : "",
    isSkipped ? styles.rowSkipped : "",
    field.contextSnippet ? styles.rowWithSnippet : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={rowClass} onClick={() => !isSkipped && onActivate()}>
      {field.contextSnippet && (
        <span className={styles.contextSnippet}>{field.contextSnippet}</span>
      )}
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
      ) : isOptionGroup ? (
        <div className={styles.inputWrap}>
          <select
            className={styles.input}
            value={value}
            onFocus={onActivate}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">— Select an option —</option>
            {(field.options ?? []).map((opt) => (
              <option key={opt.label} value={opt.label}>
                {opt.label}
              </option>
            ))}
          </select>
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
