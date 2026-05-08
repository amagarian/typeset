import type { Project, CreditCardType } from "@/types";
import styles from "./ProjectDetailForm.module.css";

interface ProjectDetailFormProps {
  project: Project;
  onChange: (updates: Partial<Project>) => void;
  readOnly?: boolean;
}

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
  { key: "cardholderSignature", label: "SIGNATURE" },
];

const CARD_TYPE_OPTIONS: { value: CreditCardType; label: string }[] = [
  { value: "", label: "— Select —" },
  { value: "visa", label: "Visa" },
  { value: "mastercard", label: "MasterCard" },
  { value: "discover", label: "Discover" },
  { value: "amex", label: "American Express" },
];

export function ProjectDetailForm({ project, onChange, readOnly }: ProjectDetailFormProps) {
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
            className={key === "cardholderSignature" ? styles.signatureInput : styles.input}
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
  );
}
