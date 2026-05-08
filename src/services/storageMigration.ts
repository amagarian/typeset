/**
 * One-time storage migration: copy any leftover `wrapkit.*` localStorage keys
 * into their `typeset.*` equivalents on first launch of the rebranded build.
 *
 * Idempotent: only runs if the typeset.* key is missing AND the wrapkit.* key
 * is present. Safe to call on every launch.
 */

const MIGRATIONS: Record<string, string> = {
  "wrapkit.local-templates.v1": "typeset.local-templates.v1",
  "wrapkit.template-cache.v1": "typeset.template-cache.v1",
  "wrapkit.template-submissions.v1": "typeset.template-submissions.v1",
  "wrapkit.anthropic.model.v1": "typeset.anthropic.model.v1",
};

const MIGRATION_FLAG = "typeset.migration.wrapkit-to-typeset.v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function migrateLegacyStorage(): void {
  if (!canUseStorage()) return;

  try {
    if (window.localStorage.getItem(MIGRATION_FLAG)) return;

    let migratedCount = 0;
    for (const [oldKey, newKey] of Object.entries(MIGRATIONS)) {
      const oldValue = window.localStorage.getItem(oldKey);
      if (oldValue === null) continue;

      const existingNew = window.localStorage.getItem(newKey);
      if (existingNew === null) {
        window.localStorage.setItem(newKey, oldValue);
        migratedCount += 1;
      }
      window.localStorage.removeItem(oldKey);
    }

    window.localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());

    if (migratedCount > 0) {
      console.log(
        `[TYPESET] Migrated ${migratedCount} legacy wrapkit.* localStorage key(s) to typeset.*`
      );
    }
  } catch (error) {
    console.warn("[TYPESET] Storage migration failed:", error);
  }
}
