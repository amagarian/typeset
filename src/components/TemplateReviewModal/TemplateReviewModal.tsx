import { useState, useCallback, useEffect, useRef } from "react";
import type { Template, TemplateField, Project, TemplateMappedProjectKey } from "@/types";
import { PdfPageCanvas } from "@/components/PdfPageCanvas/PdfPageCanvas";
import { DraggableField } from "@/components/DraggableField/DraggableField";
import { getTemplateFieldValue, normalizeCardType } from "@/utils/fill";
import styles from "./TemplateReviewModal.module.css";

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



interface TemplateReviewModalProps {
  template: Template;
  project?: Project | null;
  pdfBytes?: Uint8Array | null;
  onClose: () => void;
  onConfirm: (template: Template) => void;
  onSaveLocal: (template: Template) => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onBeginFieldEdit: () => void;
  onFieldChange: (fieldId: string, updates: Partial<TemplateField>) => void;
  onDeleteField: (fieldId: string) => void;
  onAddField: () => void;
  onAddCheckbox: () => void;
  onProjectChange?: (updates: Partial<Project>) => void;
  onRedetect?: () => void;
  /**
   * Optional publish-to-public-registry handler. When provided (i.e.
   * the registry has been configured in Settings), the modal exposes a
   * "Publish to registry" / "Update published" button next to "Save
   * template". App-level code is responsible for handling errors and
   * surfacing toasts.
   */
  onPublish?: (template: Template) => Promise<void>;
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
  onPublish,
}: TemplateReviewModalProps) {
  const [pageDims, setPageDims] = useState<{ width: number; height: number; scale: number } | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<"idle" | "publishing">("idle");
  const fieldListRef = useRef<HTMLUListElement>(null);

  const handleDimensions = useCallback((dims: { width: number; height: number; scale: number }) => {
    setPageDims(dims);
  }, []);

  const handlePublishClick = useCallback(async () => {
    if (!onPublish) return;
    setPublishState("publishing");
    try {
      await onPublish(template);
    } finally {
      setPublishState("idle");
    }
  }, [onPublish, template]);

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

      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
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
  }, [canRedo, canUndo, onRedo, onUndo, selectedFieldId, template.fields, onFieldChange, onBeginFieldEdit]);

  useEffect(() => {
    if (!selectedFieldId || !fieldListRef.current) return;
    const el = fieldListRef.current.querySelector(`[data-field-id="${selectedFieldId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [selectedFieldId]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="template-modal-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <h2 id="template-modal-title" className={styles.title}>
            Template review — {template.name}
          </h2>
          <span className={styles.hint}>Click a field to select, drag to move, use handles to resize</span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.previewArea} onClickCapture={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-draggable-field]")) return;
            setSelectedFieldId(null);
          }}>
            {pdfBytes ? (
              <div className={styles.pdfContainer}>
                <PdfPageCanvas
                  pdfBytes={pdfBytes}
                  pageNumber={1}
                  maxWidth={580}
                  maxHeight={720}
                  onDimensions={handleDimensions}
                />
                {pageDims && template.fields.filter((f) => f.pageNumber === 1).map((f) => (
                  <DraggableField
                    key={f.id}
                    field={f}
                    scale={pageDims.scale}
                    selected={f.id === selectedFieldId}
                    onSelect={() => setSelectedFieldId(f.id)}
                    onChangeStart={onBeginFieldEdit}
                    onChange={(updates) => onFieldChange(f.id, updates)}
                    projectValue={project ? getTemplateFieldValue(project, f) : undefined}
                    onCheckboxClick={
                      f.fieldType === "checkbox" && onProjectChange
                        ? (value) => {
                            if (f.mappedProjectKey === "creditCardType") {
                              const normalized = normalizeCardType(value) || value;
                              onProjectChange({ creditCardType: normalized as Project["creditCardType"] });
                            }
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
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
                  className={`${styles.fieldItem} ${f.id === selectedFieldId ? styles.fieldItemSelected : ""}`}
                  onClick={() => setSelectedFieldId(f.id)}
                >
                  <div className={styles.fieldItemRow}>
                    <span className={styles.fieldItemLabel}>{f.label}</span>
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
                    {!isCheckboxField(f) && <option value="__custom__">Custom value</option>}
                    {!isCheckboxField(f) && <option value="__prompt__">Prompt at fill time</option>}
                  </select>
                  {!isCheckboxField(f) && f.mappedProjectKey === "__custom__" && (
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
                  {!isCheckboxField(f) && f.mappedProjectKey === "__prompt__" && (
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
              <button type="button" className={styles.addFieldBtn} onClick={onAddField}>
                + Add field
              </button>
              <button type="button" className={styles.addFieldBtn} onClick={onAddCheckbox}>
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
          {onPublish && (
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={handlePublishClick}
              disabled={publishState === "publishing" || template.fields.length === 0}
              title={
                template.registryId
                  ? "Push your latest edits to the public registry"
                  : "Share this template publicly so other users can auto-fill the same form"
              }
            >
              {publishState === "publishing"
                ? "Publishing…"
                : template.registryId
                ? "Update published"
                : "Publish to registry"}
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
