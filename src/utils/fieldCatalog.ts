import type { CanonicalFieldId, Project, TemplateFieldKind } from "@/types";

export interface CanonicalFieldDefinition {
  id: CanonicalFieldId;
  label: string;
  mappedProjectKey: keyof Project | "";
  fieldKind: TemplateFieldKind;
  aliases: string[];
  sectionHints: string[];
  checkboxValue?: string;
  groupId?: string;
  multiline?: boolean;
  allowDuplicates?: boolean;
}

export const CANONICAL_FIELD_DEFINITIONS: CanonicalFieldDefinition[] = [
  {
    id: "projectLabel",
    label: "Project label",
    mappedProjectKey: "label",
    fieldKind: "text",
    aliases: ["project label", "show title", "show label"],
    sectionHints: ["header", "job"],
  },
  {
    id: "jobName",
    label: "Job Name",
    mappedProjectKey: "jobName",
    fieldKind: "text",
    aliases: ["job name", "project name", "show name"],
    sectionHints: ["job", "header"],
  },
  {
    id: "jobNumber",
    label: "Job No.",
    mappedProjectKey: "jobNumber",
    fieldKind: "text",
    aliases: ["job no", "job number", "job #"],
    sectionHints: ["job", "header"],
  },
  {
    id: "poNumber",
    label: "PO No.",
    mappedProjectKey: "poNumber",
    fieldKind: "text",
    aliases: ["po no", "po number", "po #", "purchase order", "order #", "order no", "order number", "order#"],
    sectionHints: ["job", "billing"],
  },
  {
    id: "authorizationDate",
    label: "Date",
    mappedProjectKey: "authorizationDate",
    fieldKind: "date",
    aliases: ["authorization date", "auth date"],
    sectionHints: ["authorization", "signature", "footer"],
  },
  {
    id: "productionCompany",
    label: "Production Company",
    mappedProjectKey: "productionCompany",
    fieldKind: "text",
    aliases: [
      "production company",
      "company / contact",
      "name of company",
      "business",
      "company name",
      "production co",
      "prod co",
    ],
    sectionHints: ["billing", "contact", "header"],
  },
  {
    id: "billingAddress",
    label: "Billing Address",
    mappedProjectKey: "billingAddress",
    fieldKind: "multiline",
    aliases: [
      "billing address",
      "billing address of card holder",
      "company address",
      "credit card billing address",
      "mailing address",
      "remit to",
    ],
    sectionHints: ["billing", "payment", "contact"],
    multiline: true,
  },
  {
    id: "billingCity",
    label: "City",
    mappedProjectKey: "billingCity",
    fieldKind: "text",
    aliases: ["city", "billing city"],
    sectionHints: ["billing", "payment", "contact"],
  },
  {
    id: "billingState",
    label: "State",
    mappedProjectKey: "billingState",
    fieldKind: "text",
    aliases: ["state", "billing state", "st"],
    sectionHints: ["billing", "payment", "contact"],
  },
  {
    id: "billingZipCode",
    label: "Zip Code",
    mappedProjectKey: "billingZipCode",
    fieldKind: "text",
    aliases: ["zip", "zip code", "postal code", "billing zip", "billing postal code"],
    sectionHints: ["billing", "payment", "contact"],
  },
  {
    id: "producer",
    label: "Producer",
    mappedProjectKey: "producer",
    fieldKind: "text",
    aliases: ["producer", "production coordinator", "upm", "authorized by", "contact name"],
    sectionHints: ["contact", "authorization"],
  },
  {
    id: "email",
    label: "Email",
    mappedProjectKey: "email",
    fieldKind: "text",
    aliases: ["email", "email address", "e-mail"],
    sectionHints: ["contact", "billing"],
  },
  {
    id: "phone",
    label: "Phone",
    mappedProjectKey: "phone",
    fieldKind: "text",
    aliases: ["phone", "phone #", "phone number", "phone numbers", "telephone", "telephone #", "mobile", "cell"],
    sectionHints: ["contact", "billing"],
  },
  {
    id: "creditCardHolder",
    label: "Cardholder Name",
    mappedProjectKey: "creditCardHolder",
    fieldKind: "text",
    aliases: [
      "card holder",
      "name of cardholder",
      "cardholder name",
      "cardholder name as shown on card",
      "name on card",
      "customer name",
    ],
    sectionHints: ["payment", "authorization"],
  },
  {
    id: "cardholderSignature",
    label: "Signature",
    mappedProjectKey: "cardholderSignature",
    fieldKind: "signature",
    aliases: [
      "signature of cardholder",
      "cardholder signature",
      "customer signature",
      "authorized signature",
      "signature",
    ],
    sectionHints: ["signature", "authorization", "footer"],
    allowDuplicates: true,
  },
  {
    id: "creditCardNumber",
    label: "Credit Card Number",
    mappedProjectKey: "creditCardNumber",
    fieldKind: "text",
    aliases: [
      "credit card number",
      "credit card #",
      "card number",
      "cc number",
      "cc #",
      "cc#",
      "card identification number",
      "account number",
    ],
    sectionHints: ["payment", "billing"],
  },
  {
    id: "expDate",
    label: "Expiration Date",
    mappedProjectKey: "expDate",
    fieldKind: "date",
    aliases: [
      "expiration date",
      "exp date",
      "exp.",
      "expiry",
      "expiration",
      "mm/yy",
      "mm yy",
    ],
    sectionHints: ["payment", "billing"],
  },
  {
    id: "ccv",
    label: "Security Code",
    mappedProjectKey: "ccv",
    fieldKind: "text",
    aliases: ["security code", "verification code", "cvv", "cvc", "cid", "ccv"],
    sectionHints: ["payment", "billing"],
  },
  {
    id: "creditCardTypeVisa",
    label: "VISA",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["visa"],
    checkboxValue: "visa",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
  {
    id: "creditCardTypeMastercard",
    label: "MasterCard",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["mastercard", "master card", "mc"],
    checkboxValue: "mastercard",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
  {
    id: "creditCardTypeDiscover",
    label: "Discover",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["discover"],
    checkboxValue: "discover",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
  {
    id: "creditCardTypeAmex",
    label: "AMEX",
    mappedProjectKey: "creditCardType",
    fieldKind: "checkbox-group",
    aliases: ["amex", "american express"],
    checkboxValue: "amex",
    groupId: "creditCardType",
    sectionHints: ["payment", "card-type"],
  },
];

export const CANONICAL_FIELD_BY_ID: Record<CanonicalFieldId, CanonicalFieldDefinition> =
  Object.fromEntries(CANONICAL_FIELD_DEFINITIONS.map((field) => [field.id, field])) as Record<
    CanonicalFieldId,
    CanonicalFieldDefinition
  >;

export function getCanonicalFieldDefinition(
  id: CanonicalFieldId
): CanonicalFieldDefinition | undefined {
  return CANONICAL_FIELD_BY_ID[id];
}
