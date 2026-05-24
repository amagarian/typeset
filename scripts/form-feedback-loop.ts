import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Template, TemplateField } from "../src/types";
import { computeTemplateAccuracy, type TemplateAccuracyOptions } from "../src/utils/templateAccuracy";
import { CANONICAL_FIELD_DEFINITIONS } from "../src/utils/fieldCatalog";

type ProviderName = "fixture" | "gemini";

interface EvalManifest {
  version: 1;
  cases: EvalCase[];
}

interface EvalCase {
  id: string;
  pdf: string;
  expectedTemplate: string;
  predictedTemplate?: string;
  consoleLog?: string;
  filledPdf?: string;
  notes?: string;
}

interface CliOptions {
  manifestPath: string;
  outDir: string;
  provider: ProviderName;
  threshold: number;
  repeat: number;
  delayMs: number;
  model?: string;
  promptFile?: string;
  accuracyOptions: TemplateAccuracyOptions;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface CaseResult {
  id: string;
  passed: boolean;
  accuracy: number;
  expectedFieldCount: number;
  predictedFieldCount: number;
  outputDir: string;
  notes?: string;
}

const DEFAULT_MODEL = "gemini-3.5-flash";

function usage(): string {
  return [
    "Usage: npm run eval:forms -- --manifest <manifest.json> [options]",
    "",
    "Options:",
    "  --provider fixture|gemini       Detection source. Default: fixture",
    "  --out <dir>                     Output directory. Default: .eval/form-feedback",
    "  --threshold <0..1>              Required overall accuracy. Default: 1",
    "  --position-tolerance <points>   Accepted x/y delta. Default: 6",
    "  --size-tolerance <points>       Accepted width/height delta. Default: 8",
    "  --model <name>                  Gemini model. Default: GEMINI_MODEL or gemini-3.5-flash",
    "  --prompt <file>                 Extra Gemini prompt instructions",
    "  --repeat <n>                    Repeat loop count. Use 0 for continuous",
    "  --delay-ms <n>                  Delay between repeats. Default: 5000",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return value;
  };

  const options: CliOptions = {
    manifestPath: "",
    outDir: ".eval/form-feedback",
    provider: "fixture",
    threshold: 1,
    repeat: 1,
    delayMs: 5000,
    accuracyOptions: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--manifest":
        options.manifestPath = next(index, arg);
        index += 1;
        break;
      case "--out":
        options.outDir = next(index, arg);
        index += 1;
        break;
      case "--provider":
        options.provider = next(index, arg) as ProviderName;
        index += 1;
        break;
      case "--threshold":
        options.threshold = Number(next(index, arg));
        index += 1;
        break;
      case "--position-tolerance":
        options.accuracyOptions.positionTolerance = Number(next(index, arg));
        index += 1;
        break;
      case "--size-tolerance":
        options.accuracyOptions.sizeTolerance = Number(next(index, arg));
        index += 1;
        break;
      case "--model":
        options.model = next(index, arg);
        index += 1;
        break;
      case "--prompt":
        options.promptFile = next(index, arg);
        index += 1;
        break;
      case "--repeat":
        options.repeat = Number(next(index, arg));
        index += 1;
        break;
      case "--delay-ms":
        options.delayMs = Number(next(index, arg));
        index += 1;
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  if (!options.manifestPath) throw new Error(`Missing --manifest\n\n${usage()}`);
  if (!["fixture", "gemini"].includes(options.provider)) {
    throw new Error(`Unsupported provider: ${options.provider}`);
  }
  if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) {
    throw new Error("--threshold must be between 0 and 1");
  }
  return options;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveFromManifest(manifestPath: string, inputPath: string): string {
  return path.resolve(path.dirname(manifestPath), inputPath);
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error("Provider response did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function normalizeField(raw: Partial<TemplateField>, index: number): TemplateField {
  return {
    id: String(raw.id ?? `field-${index + 1}`),
    label: String(raw.label ?? `Field ${index + 1}`),
    mappedProjectKey: raw.mappedProjectKey ?? "",
    canonicalFieldId: raw.canonicalFieldId,
    pageNumber: Number(raw.pageNumber ?? 1),
    x: Number(raw.x ?? 0),
    y: Number(raw.y ?? 0),
    width: Number(raw.width ?? 0),
    height: Number(raw.height ?? 0),
    confidence: Number(raw.confidence ?? 0),
    fieldType: raw.fieldType ?? "text",
    fieldKind: raw.fieldKind,
    detectionSource: raw.detectionSource ?? "claude",
    sectionId: raw.sectionId,
    groupId: raw.groupId,
    anchorText: raw.anchorText,
    confidenceDetails: raw.confidenceDetails,
    checkboxValue: raw.checkboxValue,
    customValue: raw.customValue,
    promptLabel: raw.promptLabel,
    optional: raw.optional,
    estimatedFontSize: raw.estimatedFontSize,
    contextSnippet: raw.contextSnippet,
  };
}

function normalizeTemplate(raw: unknown, fallbackName: string): Template {
  const candidate = raw as Partial<Template> & { fields?: Partial<TemplateField>[] };
  if (!Array.isArray(candidate.fields)) {
    throw new Error("Template JSON must contain a fields array");
  }
  const now = new Date().toISOString();
  return {
    id: String(candidate.id ?? `eval-${fallbackName}`),
    name: String(candidate.name ?? fallbackName),
    status: candidate.status ?? "local-draft",
    version: candidate.version,
    source: candidate.source,
    fingerprint: candidate.fingerprint,
    fields: candidate.fields.map(normalizeField),
    pageCount: candidate.pageCount,
    registryId: candidate.registryId,
    createdAt: String(candidate.createdAt ?? now),
    updatedAt: String(candidate.updatedAt ?? now),
  };
}

async function loadFixturePrediction(manifestPath: string, testCase: EvalCase): Promise<Template> {
  if (!testCase.predictedTemplate) {
    throw new Error(`Case ${testCase.id} is missing predictedTemplate for fixture provider`);
  }
  const predictionPath = resolveFromManifest(manifestPath, testCase.predictedTemplate);
  return normalizeTemplate(await readJson<unknown>(predictionPath), `${testCase.id}-prediction`);
}

function buildGeminiPrompt(extraPrompt: string | null): string {
  const canonicalFields = CANONICAL_FIELD_DEFINITIONS.map((field) => ({
    id: field.id,
    label: field.label,
    mappedProjectKey: field.mappedProjectKey,
    fieldKind: field.fieldKind,
    aliases: field.aliases,
    checkboxValue: field.checkboxValue,
  }));
  return [
    "Extract every fillable field from this PDF form.",
    "Return only JSON shaped like { \"fields\": TemplateField[] }.",
    "Coordinates must use PDF points with origin at the top-left of each page.",
    "Use the closest canonicalFieldId and mappedProjectKey when a field matches this catalog:",
    JSON.stringify(canonicalFields),
    "Each field must include: id, label, mappedProjectKey, canonicalFieldId, pageNumber, x, y, width, height, confidence, fieldType, fieldKind, checkboxValue when relevant.",
    "Do not omit checkboxes, signatures, repeated fields, or fields that need custom prompt values.",
    extraPrompt ? `Additional run instructions:\n${extraPrompt}` : "",
  ].filter(Boolean).join("\n\n");
}

async function loadGeminiPrediction(
  manifestPath: string,
  testCase: EvalCase,
  options: CliOptions,
  caseOutDir: string
): Promise<Template> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for --provider gemini");

  const pdfPath = resolveFromManifest(manifestPath, testCase.pdf);
  const pdfBytes = await readFile(pdfPath);
  const model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const extraPrompt = options.promptFile
    ? await readFile(path.resolve(options.promptFile), "utf8")
    : null;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: buildGeminiPrompt(extraPrompt) },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: pdfBytes.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
        },
      }),
    }
  );

  const rawText = await response.text();
  await writeFile(path.join(caseOutDir, "provider-response.json"), rawText);
  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status}): ${rawText}`);
  }
  const body = JSON.parse(rawText) as GeminiResponse;
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  const parsed = extractJson(text);
  return normalizeTemplate(parsed, `${testCase.id}-gemini`);
}

async function collectOptionalArtifacts(manifestPath: string, testCase: EvalCase): Promise<Record<string, unknown>> {
  const artifacts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    pdf: testCase.pdf,
    filledPdf: testCase.filledPdf,
    consoleLog: testCase.consoleLog,
  })) {
    if (!value) continue;
    const artifactPath = resolveFromManifest(manifestPath, value);
    if (!existsSync(artifactPath)) {
      artifacts[key] = { path: value, exists: false };
      continue;
    }
    const bytes = await readFile(artifactPath);
    artifacts[key] = {
      path: value,
      exists: true,
      sha256: hashBytes(bytes),
      bytes: bytes.length,
      preview:
        key === "consoleLog"
          ? bytes.toString("utf8").split("\n").slice(0, 80).join("\n")
          : undefined,
    };
  }
  return artifacts;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "");
}

async function runCase(
  manifestPath: string,
  testCase: EvalCase,
  options: CliOptions,
  runOutDir: string
): Promise<CaseResult> {
  const caseOutDir = path.join(runOutDir, sanitizeId(testCase.id));
  await mkdir(caseOutDir, { recursive: true });
  const expectedPath = resolveFromManifest(manifestPath, testCase.expectedTemplate);
  const expectedTemplate = normalizeTemplate(await readJson<unknown>(expectedPath), `${testCase.id}-expected`);
  const predictedTemplate =
    options.provider === "fixture"
      ? await loadFixturePrediction(manifestPath, testCase)
      : await loadGeminiPrediction(manifestPath, testCase, options, caseOutDir);
  const report = computeTemplateAccuracy(
    expectedTemplate,
    predictedTemplate,
    options.threshold,
    options.accuracyOptions
  );
  const artifacts = await collectOptionalArtifacts(manifestPath, testCase);

  await writeJson(path.join(caseOutDir, "expected-template.json"), expectedTemplate);
  await writeJson(path.join(caseOutDir, "predicted-template.json"), predictedTemplate);
  await writeJson(path.join(caseOutDir, "accuracy-report.json"), { ...report, artifacts });

  return {
    id: testCase.id,
    passed: report.passed,
    accuracy: report.overallAccuracy,
    expectedFieldCount: report.expectedFieldCount,
    predictedFieldCount: report.predictedFieldCount,
    outputDir: caseOutDir,
    notes: testCase.notes,
  };
}

async function writeImprovementBrief(runOutDir: string, results: CaseResult[]): Promise<void> {
  const failingResults = results.filter((result) => !result.passed);
  const lines = [
    "# Form feedback loop brief",
    "",
    `Cases: ${results.length}`,
    `Passing: ${results.length - failingResults.length}`,
    `Failing: ${failingResults.length}`,
    "",
  ];
  if (failingResults.length === 0) {
    lines.push("All cases reached the required threshold.");
  } else {
    lines.push("## Cases needing changes", "");
    for (const result of failingResults) {
      lines.push(
        `- ${result.id}: ${(result.accuracy * 100).toFixed(2)}% accuracy, report: ${path.relative(runOutDir, path.join(result.outputDir, "accuracy-report.json"))}`
      );
    }
    lines.push(
      "",
      "Use each accuracy report with the provider response, console log preview, and filled PDF hash to adjust prompts, post-processing, or template mappings before rerunning the loop."
    );
  }
  await writeFile(path.join(runOutDir, "improvement-brief.md"), `${lines.join("\n")}\n`);
}

async function runOnce(manifestPath: string, options: CliOptions, iteration: number): Promise<boolean> {
  const manifest = await readJson<EvalManifest>(manifestPath);
  if (manifest.version !== 1 || !Array.isArray(manifest.cases)) {
    throw new Error("Manifest must be version 1 and include cases[]");
  }

  const runOutDir = path.resolve(options.outDir, `run-${String(iteration).padStart(3, "0")}`);
  await mkdir(runOutDir, { recursive: true });
  const results: CaseResult[] = [];
  for (const testCase of manifest.cases) {
    console.log(`[feedback-loop] ${testCase.id}: running ${options.provider}`);
    const result = await runCase(manifestPath, testCase, options, runOutDir);
    results.push(result);
    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `[feedback-loop] ${testCase.id}: ${status} ${(result.accuracy * 100).toFixed(2)}% (${result.predictedFieldCount}/${result.expectedFieldCount} fields)`
    );
  }

  const averageAccuracy =
    results.length === 0
      ? 1
      : results.reduce((sum, result) => sum + result.accuracy, 0) / results.length;
  const allPassed = results.every((result) => result.passed);
  await writeJson(path.join(runOutDir, "summary.json"), {
    provider: options.provider,
    model: options.model ?? process.env.GEMINI_MODEL ?? (options.provider === "gemini" ? DEFAULT_MODEL : null),
    threshold: options.threshold,
    averageAccuracy,
    allPassed,
    results,
  });
  await writeImprovementBrief(runOutDir, results);
  console.log(`[feedback-loop] run ${iteration}: ${allPassed ? "PASS" : "FAIL"} ${(averageAccuracy * 100).toFixed(2)}%`);
  console.log(`[feedback-loop] artifacts: ${runOutDir}`);
  return allPassed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(options.manifestPath);
  const repeatForever = options.repeat === 0;
  let iteration = 1;
  let finalPass = false;

  do {
    finalPass = await runOnce(manifestPath, options, iteration);
    if (!repeatForever && iteration >= options.repeat) break;
    iteration += 1;
    await delay(options.delayMs);
  } while (repeatForever || iteration <= options.repeat);

  if (!finalPass) process.exitCode = 1;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
