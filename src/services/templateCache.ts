import type { Template } from "@/types";

const LOCAL_TEMPLATES_KEY = "typeset.local-templates.v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(key: string, fallback: T): T {
  if (!canUseStorage()) return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (error) {
    console.warn(`Failed to read local cache key "${key}"`, error);
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  if (!canUseStorage()) return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Failed to write local cache key "${key}"`, error);
  }
}

export function readLocalTemplates(): Template[] {
  return readJson<Template[]>(LOCAL_TEMPLATES_KEY, []);
}

export function writeLocalTemplates(templates: Template[]): void {
  writeJson(LOCAL_TEMPLATES_KEY, templates);
}

export function upsertLocalTemplate(template: Template): Template[] {
  const existing = readLocalTemplates().filter((entry) => entry.id !== template.id);
  const nextTemplates = [template, ...existing].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
  writeLocalTemplates(nextTemplates);
  return nextTemplates;
}

export function deleteLocalTemplate(templateId: string): Template[] {
  const next = readLocalTemplates().filter((t) => t.id !== templateId);
  writeLocalTemplates(next);
  return next;
}
