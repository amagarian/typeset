#!/usr/bin/env node
/**
 * v0.6.0 spot-check script — runs the AcroForm ingest module
 * against a list of PDF paths and dumps the extracted field set
 * to stdout for visual inspection. Used during development to
 * verify the ingest logic produces sensible TemplateField output
 * for the 8 AcroForm PDFs cited in the corpus analysis.
 *
 * Usage:
 *   node scripts/spot-check-acroform.mjs <path-to.pdf> [more.pdf ...]
 *
 * Notes:
 * - Imports the production module directly via tsx so we run the
 *   actual TS source. If `tsx` isn't installed, run with
 *   `npx tsx scripts/spot-check-acroform.mjs ...`.
 * - Does NOT modify the PDF. Read-only.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node scripts/spot-check-acroform.mjs <pdf> [more...]");
    process.exit(2);
  }

  const { tryAcroFormIngest } = await import("../src/utils/acroFormIngest.ts");

  for (const rawPath of args) {
    const path = resolve(process.cwd(), rawPath);
    console.log(`\n=== ${path} ===`);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (err) {
      console.error(`  Failed to read: ${err.message}`);
      continue;
    }

    let result;
    try {
      result = await tryAcroFormIngest(new Uint8Array(bytes));
    } catch (err) {
      console.error(`  AcroForm ingest threw: ${err?.message ?? err}`);
      continue;
    }

    if (!result) {
      console.log("  No AcroForm fields detected.");
      continue;
    }

    console.log(
      `  ${result.fields.length} field(s) on ${result.pageNumbers.size} page(s):`
    );
    for (const f of result.fields) {
      const canonical = f.canonicalFieldId ?? "—";
      const mapped = f.mappedProjectKey ?? "—";
      const opts = f.options
        ? ` options=[${f.options.map((o) => o.label).join(", ")}]`
        : "";
      console.log(
        `    p${f.pageNumber} ${f.fieldKind ?? f.fieldType ?? "?"} ` +
          `[${f.x.toFixed(1)},${f.y.toFixed(1)} ${f.width.toFixed(1)}x${f.height.toFixed(1)}] ` +
          `"${f.label}" → canonical=${canonical} mapped=${mapped}${opts}`
      );
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
