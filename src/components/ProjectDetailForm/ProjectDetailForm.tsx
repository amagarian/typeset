import { useCallback, useRef } from "react";
import type { Project, CreditCardType } from "@/types";
import styles from "./ProjectDetailForm.module.css";

interface ProjectDetailFormProps {
  project: Project;
  onChange: (updates: Partial<Project>) => void;
  readOnly?: boolean;
  /**
   * v0.6.0 — surfaces upload errors back up to the host (App.tsx)
   * so the toast layer can render them. Local validation only fires
   * when this is supplied; otherwise we silently reject malformed
   * uploads (legacy preview contexts that may not pass a toast
   * channel down here).
   */
  onSignatureError?: (message: string) => void;
}

/**
 * v0.5.x baseline contact + payment fields. Always rendered inline
 * at the top of the form (no disclosure). v0.6.0 keeps these intact
 * so the muscle-memory path for the most-common CC-auth flow is
 * unchanged.
 */
const TEXT_FIELDS: { key: keyof Project; label: string }[] = [
  { key: "jobName", label: "JOB NAME" },
  { key: "jobNumber", label: "JOB NUMBER" },
  { key: "productionCompany", label: "PRODUCTION COMPANY" },
  { key: "billingAddress", label: "BILLING ADDRESS" },
  { key: "billingCity", label: "CITY" },
  { key: "billingState", label: "STATE" },
  { key: "billingZipCode", label: "ZIP CODE" },
  { key: "creditCardHolder", label: "NAME" },
  { key: "email", label: "EMAIL" },
  { key: "phone", label: "PHONE" },
];

const CARD_FIELDS: { key: keyof Project; label: string }[] = [
  { key: "creditCardNumber", label: "CARD NUMBER" },
  { key: "expDate", label: "EXP DATE" },
  { key: "ccv", label: "CCV" },
];

const CARD_TYPE_OPTIONS: { value: CreditCardType; label: string }[] = [
  { value: "", label: "— Select —" },
  { value: "visa", label: "Visa" },
  { value: "mastercard", label: "MasterCard" },
  { value: "discover", label: "Discover" },
  { value: "amex", label: "American Express" },
];

/**
 * v0.6.0 — per-section field group definitions. Each section is a
 * `<details>`/`<summary>` disclosure, collapsed by default. Names
 * mirror the canonical groupings in `fieldCatalog.ts`. Keeping these
 * out-of-band of TEXT_FIELDS lets us add ~30 fields without bloating
 * the always-visible form area.
 */
const SECTION_GROUPS: ReadonlyArray<{
  title: string;
  fields: ReadonlyArray<{
    key: keyof Project;
    label: string;
    type?: "text" | "date";
  }>;
}> = [
  {
    title: "BUSINESS",
    fields: [
      { key: "federalTaxId", label: "FEDERAL TAX ID" },
      { key: "dunsNumber", label: "DUNS NUMBER" },
      { key: "dbaName", label: "DBA NAME" },
      { key: "yearsInBusiness", label: "YEARS IN BUSINESS" },
      { key: "dateBusinessStarted", label: "DATE BUSINESS STARTED", type: "date" },
      { key: "dateIncorporated", label: "DATE INCORPORATED", type: "date" },
      { key: "parentCompany", label: "PARENT COMPANY" },
      { key: "resaleTaxCertificate", label: "RESALE TAX CERTIFICATE" },
    ],
  },
  {
    title: "AUTHORIZED SIGNER",
    fields: [
      { key: "authorizedSignerName", label: "SIGNER NAME" },
      { key: "authorizedSignerTitle", label: "SIGNER TITLE" },
      { key: "secondAuthorizedSignerName", label: "SECOND SIGNER NAME" },
      { key: "secondAuthorizedSignerTitle", label: "SECOND SIGNER TITLE" },
    ],
  },
  {
    title: "BANKING & SHIPPING",
    fields: [
      { key: "bankName", label: "BANK NAME" },
      { key: "bankRoutingNumber", label: "ROUTING #" },
      { key: "bankAccountNumber", label: "ACCOUNT #" },
      { key: "fedExAccountNumber", label: "FEDEX #" },
      { key: "upsAccountNumber", label: "UPS #" },
    ],
  },
  {
    title: "VEHICLE / DL",
    fields: [
      { key: "driverLicenseNumber", label: "DRIVER'S LICENSE #" },
      { key: "vehicleVin", label: "VIN" },
      { key: "vehiclePlate", label: "PLATE" },
      { key: "insuranceCarrier", label: "INSURANCE CARRIER" },
      { key: "insurancePolicyNumber", label: "POLICY #" },
    ],
  },
  {
    title: "PRODUCTION",
    fields: [
      { key: "showName", label: "SHOW NAME" },
      { key: "seasonNumber", label: "SEASON #" },
      { key: "productionClassification", label: "PRODUCTION TYPE" },
      { key: "hourlyRateBuild", label: "BUILD RATE" },
      { key: "hourlyRateShoot", label: "SHOOT RATE" },
      { key: "hoursBuild", label: "BUILD HOURS" },
      { key: "hoursShoot", label: "SHOOT HOURS" },
    ],
  },
  {
    title: "RENTAL PERIOD",
    fields: [
      { key: "rentalStartDate", label: "START DATE", type: "date" },
      { key: "rentalEndDate", label: "END DATE", type: "date" },
    ],
  },
  {
    title: "OTHER",
    fields: [
      { key: "invoiceNumber", label: "INVOICE #" },
      { key: "accountingContactName", label: "ACCOUNTING CONTACT" },
      { key: "accountingEmail", label: "ACCOUNTING EMAIL" },
      { key: "deliveryAddress", label: "DELIVERY ADDRESS" },
      { key: "streetAddress", label: "STREET ADDRESS" },
      { key: "initials", label: "INITIALS" },
    ],
  },
];

/**
 * v0.6.0 — 2MB cap on uploaded signature images. Stored inline as a
 * base64 dataUrl on the encrypted `Project` blob; the encryption +
 * sync layer carries the entire blob, so a 2MB image survives the
 * round-trip but a multi-MB photo would balloon every sync write.
 * Beta testers consistently want a quick scribble — 2MB is more than
 * generous for a transparent PNG / SVG signature.
 */
const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
const SIGNATURE_ACCEPT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/svg+xml",
]);

export function ProjectDetailForm({ project, onChange, readOnly, onSignatureError }: ProjectDetailFormProps) {
  const signatureInputRef = useRef<HTMLInputElement>(null);

  const handleSignatureUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file later
      if (!file) return;

      // Type + size gates first — the FileReader read is async, so
      // failing early avoids a wasted blob load and a confusing
      // "Saved ✓" pulse on a payload we're about to reject.
      if (!SIGNATURE_ACCEPT_TYPES.has(file.type)) {
        onSignatureError?.(
          `Unsupported file type. Use PNG, JPEG, or SVG.`
        );
        return;
      }
      if (file.size > SIGNATURE_MAX_BYTES) {
        onSignatureError?.(
          `Signature image is too large (${(file.size / 1024 / 1024).toFixed(2)}MB). Max 2MB.`
        );
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => {
        onSignatureError?.("Could not read signature image. Please try again.");
      };
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          onSignatureError?.("Could not read signature image. Please try again.");
          return;
        }

        // v0.6.0 — rasterize SVG → PNG up-front so the storage
        // payload is always something pdf-lib can embed natively
        // (`embedPng` / `embedJpg`). SVGs ride in fine for the
        // on-screen preview but pdf-lib has no SVG embedding path
        // and we don't want the fill-time renderer doing a
        // round-trip rasterize on every export. The conversion runs
        // in a hidden Image element + canvas; output is a
        // 1024-wide PNG (preserving aspect) which is more than
        // enough resolution for an 80×200pt signature crop and
        // keeps the dataUrl under the 2MB budget.
        if (file.type === "image/svg+xml") {
          const img = new Image();
          img.onload = () => {
            const targetW = 1024;
            const aspect = img.height / Math.max(img.width, 1);
            const targetH = Math.max(1, Math.round(targetW * aspect));
            const canvas = document.createElement("canvas");
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              onSignatureError?.("Could not rasterize SVG signature. Try a PNG instead.");
              return;
            }
            ctx.drawImage(img, 0, 0, targetW, targetH);
            try {
              const pngDataUrl = canvas.toDataURL("image/png");
              onChange({
                signatureImage: { dataUrl: pngDataUrl, uploadedAt: Date.now() },
              });
            } catch {
              onSignatureError?.("Could not convert SVG to PNG. Try uploading a PNG instead.");
            }
          };
          img.onerror = () => {
            onSignatureError?.("Could not load SVG signature. Try a PNG instead.");
          };
          img.src = result;
          return;
        }

        onChange({
          signatureImage: { dataUrl: result, uploadedAt: Date.now() },
        });
      };
      reader.readAsDataURL(file);
    },
    [onChange, onSignatureError]
  );

  const handleRemoveSignature = useCallback(() => {
    onChange({ signatureImage: undefined });
  }, [onChange]);

  return (
    <div className={styles.form}>
      {TEXT_FIELDS.map(({ key, label }) => (
        <div key={key} className={styles.field}>
          <input
            id={key}
            type="text"
            className={styles.input}
            value={(project[key] as string) ?? ""}
            onChange={(e) => onChange({ [key]: e.target.value })}
            readOnly={readOnly}
            placeholder=" "
          />
          <label className={styles.label} htmlFor={key}>
            {label}
          </label>
        </div>
      ))}

      {/*
        v0.5.31 — Shoot Date input. Sits between Phone (last entry in
        TEXT_FIELDS) and Card Type so it lands in the booking-context
        group rather than the payment group.
      */}
      <div className={styles.field}>
        <input
          id="shootDate"
          type="date"
          className={styles.input}
          value={project.shootDate ?? ""}
          onChange={(e) => onChange({ shootDate: e.target.value })}
          readOnly={readOnly}
          placeholder=" "
        />
        <label className={styles.label} htmlFor="shootDate">
          SHOOT DATE
        </label>
      </div>

      <div className={styles.field}>
        <select
          id="creditCardType"
          className={styles.input}
          value={project.creditCardType || ""}
          onChange={(e) => onChange({ creditCardType: e.target.value as CreditCardType })}
          disabled={readOnly}
        >
          {CARD_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <label className={styles.label} htmlFor="creditCardType">
          CARD TYPE
        </label>
      </div>

      {CARD_FIELDS.map(({ key, label }) => (
        <div key={key} className={styles.field}>
          <input
            id={key}
            type="text"
            className={styles.input}
            value={(project[key] as string) ?? ""}
            onChange={(e) => onChange({ [key]: e.target.value })}
            readOnly={readOnly}
            placeholder=" "
          />
          <label className={styles.label} htmlFor={key}>
            {label}
          </label>
        </div>
      ))}

      {/*
        v0.6.0 — signature block. Three states:
          1. No image uploaded: Caveat-style typed signature input
             (legacy v0.5 behaviour) PLUS an "Upload signature image"
             button that lets the user replace the typed path with
             a real scribble.
          2. Image uploaded: thumbnail preview at ~80×200 with
             Replace + Remove. Typed-Caveat input is hidden because
             the image takes precedence at fill time.
        Both paths are persisted on `Project`; the form filler reads
        `signatureImage` first and falls back to `cardholderSignature`
        when absent.
      */}
      <div className={styles.signatureBlock}>
        {project.signatureImage ? (
          <div className={styles.signaturePreviewRow}>
            <div className={styles.signaturePreviewWrap}>
              <img
                src={project.signatureImage.dataUrl}
                alt="Uploaded signature"
                className={styles.signaturePreviewImg}
              />
              <span className={styles.signatureCaption}>SIGNATURE</span>
            </div>
            {!readOnly && (
              <div className={styles.signatureActions}>
                <button
                  type="button"
                  className={styles.signatureActionBtn}
                  onClick={() => signatureInputRef.current?.click()}
                  title="Replace uploaded signature image"
                >
                  Replace
                </button>
                <button
                  type="button"
                  className={`${styles.signatureActionBtn} ${styles.signatureActionDanger}`}
                  onClick={handleRemoveSignature}
                  title="Remove uploaded signature image and revert to typed signature"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className={styles.field}>
              <input
                id="cardholderSignature"
                type="text"
                className={styles.signatureInput}
                value={project.cardholderSignature ?? ""}
                onChange={(e) => onChange({ cardholderSignature: e.target.value })}
                readOnly={readOnly}
                placeholder=" "
              />
              <label className={styles.label} htmlFor="cardholderSignature">
                SIGNATURE
              </label>
            </div>
            {!readOnly && (
              <div className={styles.signatureUploadRow}>
                <button
                  type="button"
                  className={styles.signatureActionBtn}
                  onClick={() => signatureInputRef.current?.click()}
                  title="Upload a PNG, JPEG, or SVG of your signature (max 2MB)"
                >
                  Upload signature image
                </button>
                <span className={styles.signatureHint}>
                  PNG / JPEG / SVG · max 2MB
                </span>
              </div>
            )}
          </>
        )}
        <input
          ref={signatureInputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml"
          className={styles.signatureFileInput}
          onChange={handleSignatureUpload}
        />
      </div>

      {/*
        v0.6.0 — corpus-driven optional sections. Each `<details>`
        ships collapsed; users only expand the slice they need for
        the current job. Empty by default so first-run UX is
        identical to v0.5.x for users who never touch them.
      */}
      {SECTION_GROUPS.map(({ title, fields }) => (
        <details key={title} className={styles.sectionDisclosure}>
          <summary className={styles.sectionSummary}>{title}</summary>
          <div className={styles.sectionBody}>
            {fields.map(({ key, label, type }) => (
              <div key={key} className={styles.field}>
                <input
                  id={key}
                  type={type ?? "text"}
                  className={styles.input}
                  value={(project[key] as string) ?? ""}
                  onChange={(e) => onChange({ [key]: e.target.value })}
                  readOnly={readOnly}
                  placeholder=" "
                />
                <label className={styles.label} htmlFor={key}>
                  {label}
                </label>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
