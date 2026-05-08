import { useMemo, useState, useCallback } from "react";
import type { Template } from "@/types";
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
  const [pageDims, setPageDims] = useState<{ width: number; height: number; scale: number } | null>(null);

  const handleDimensions = useCallback((dims: { width: number; height: number; scale: number }) => {
    setPageDims(dims);
  }, []);

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
            {requiredFields.map((field) => {
              const isCheckbox =
                field.fieldType === "checkbox" ||
                field.fieldKind === "boolean-checkbox";

              return (
                <label
                  key={field.id}
                  className={`${styles.row} ${field.id === activeFieldId ? styles.rowActive : ""}`}
                  onClick={() => setActiveFieldId(field.id)}
                >
                  <span className={styles.label}>{getTemplateFieldPromptLabel(field)}</span>
                  {isCheckbox ? (
                    <div className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        className={styles.checkbox}
                        checked={values[field.id] === "yes"}
                        onFocus={() => setActiveFieldId(field.id)}
                        onChange={(e) =>
                          setValues((prev) => ({
                            ...prev,
                            [field.id]: e.target.checked ? "yes" : "",
                          }))
                        }
                      />
                      <span className={styles.checkboxLabel}>
                        {values[field.id] === "yes" ? "Checked" : "Unchecked"}
                      </span>
                    </div>
                  ) : (
                    <input
                      type="text"
                      className={styles.input}
                      value={values[field.id] ?? ""}
                      placeholder={field.label}
                      onFocus={() => setActiveFieldId(field.id)}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [field.id]: e.target.value,
                        }))
                      }
                    />
                  )}
                </label>
              );
            })}

            {optionalFields.length > 0 && (
              <>
                <div className={styles.sectionDivider}>
                  <span className={styles.sectionLabel}>Optional — if applicable</span>
                </div>
                {optionalFields.map((field) => {
                  const isCheckbox =
                    field.fieldType === "checkbox" ||
                    field.fieldKind === "boolean-checkbox";

                  return (
                    <label
                      key={field.id}
                      className={`${styles.row} ${styles.rowOptional} ${field.id === activeFieldId ? styles.rowActive : ""}`}
                      onClick={() => setActiveFieldId(field.id)}
                    >
                      <span className={styles.label}>
                        {getTemplateFieldPromptLabel(field)}
                        <span className={styles.optionalTag}>Optional</span>
                      </span>
                      {isCheckbox ? (
                        <div className={styles.checkboxRow}>
                          <input
                            type="checkbox"
                            className={styles.checkbox}
                            checked={values[field.id] === "yes"}
                            onFocus={() => setActiveFieldId(field.id)}
                            onChange={(e) =>
                              setValues((prev) => ({
                                ...prev,
                                [field.id]: e.target.checked ? "yes" : "",
                              }))
                            }
                          />
                          <span className={styles.checkboxLabel}>
                            {values[field.id] === "yes" ? "Checked" : "Unchecked"}
                          </span>
                        </div>
                      ) : (
                        <input
                          type="text"
                          className={styles.input}
                          value={values[field.id] ?? ""}
                          placeholder={`${field.label} (optional)`}
                          onFocus={() => setActiveFieldId(field.id)}
                          onChange={(e) =>
                            setValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                        />
                      )}
                    </label>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primaryBtn} onClick={() => onSubmit(values)}>
            {actionLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
