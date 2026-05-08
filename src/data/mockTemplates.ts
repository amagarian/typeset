import type { Template, TemplateField } from "@/types";

const baseFields: TemplateField[] = [
  {
    id: "f1",
    label: "Production Company",
    mappedProjectKey: "productionCompany",
    pageNumber: 1,
    x: 120,
    y: 180,
    width: 280,
    height: 22,
    confidence: 0.95,
    fieldType: "text",
  },
  {
    id: "f2",
    label: "Job Name",
    mappedProjectKey: "jobName",
    pageNumber: 1,
    x: 120,
    y: 220,
    width: 280,
    height: 22,
    confidence: 0.9,
    fieldType: "text",
  },
  {
    id: "f3",
    label: "Billing Address",
    mappedProjectKey: "billingAddress",
    pageNumber: 1,
    x: 120,
    y: 260,
    width: 320,
    height: 22,
    confidence: 0.88,
    fieldType: "text",
  },
];

/** Draft template with guessed fields (used when Gemini detection fails) */
export const mockDraftTemplate: Template = {
  id: "tpl-draft-1",
  name: "Unknown form — draft",
  status: "local-draft",
  fields: baseFields.map((f, i) => ({
    ...f,
    id: `draft-${i + 1}`,
    confidence: 0.5,
  })),
  pageCount: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
