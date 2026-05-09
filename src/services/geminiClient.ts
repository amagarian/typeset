/**
 * Thin TypeScript wrapper over the Tauri commands defined in
 * `src-tauri/src/gemini.rs` and `keychain.rs`.
 *
 * Mirrors the shape of the previous `claudeClient.ts` so the rest of
 * the renderer didn't have to learn a new error vocabulary. The two
 * meaningful differences:
 *
 *   1. There's only ONE detection surface (`detectFieldsWithGemini`)
 *      because Gemini doesn't need the agentic / vision-only / files-
 *      API split that Anthropic forced on us.
 *   2. Progress events stream over `gemini-progress` instead of
 *      `anthropic-progress`, and the phase vocabulary is shorter:
 *      `uploading_file → file_uploaded → request_sent → streaming → done`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Thrown when the Gemini API key is missing or the desktop runtime is
 *  unavailable (e.g. plain `npm run dev` web-only mode). */
export class GeminiNotConfiguredError extends Error {
  constructor(message = "Gemini API key is not configured.") {
    super(message);
    this.name = "GeminiNotConfiguredError";
  }
}

/** Thrown for any non-2xx Gemini response, with the API's error text. */
export class GeminiApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiApiError";
  }
}

/**
 * One streaming progress event from a `gemini_detect_fields` invocation.
 * Subscribe via `subscribeGeminiProgress()` BEFORE calling the detector
 * so the early `uploading_file` event isn't missed.
 */
export interface GeminiProgress {
  /**
   * Current high-level phase. One of:
   * - `"uploading_file"` PDF being base64-encoded into the request body
   * - `"file_uploaded"`  request body assembled, about to fire
   * - `"request_sent"`   SSE stream opened against Gemini
   * - `"streaming"`      tokens flowing back; `tokens` rises monotonically
   * - `"done"`           stream terminated successfully
   * - `"error"`          stream terminated with an error (see `detail`)
   */
  phase: string;
  detail: string | null;
  /**
   * Cumulative output token count reported by Gemini's `usageMetadata`.
   * The DocumentList progress bar uses this to interpolate a smooth
   * curve during the long `streaming` phase.
   */
  tokens: number | null;
}

interface GeminiProgressRaw {
  phase: string;
  detail: string | null;
  tokens: number | null;
}

function normalizeProgress(raw: GeminiProgressRaw): GeminiProgress {
  return {
    phase: raw.phase,
    detail: raw.detail,
    tokens: raw.tokens,
  };
}

export async function subscribeGeminiProgress(
  callback: (progress: GeminiProgress) => void
): Promise<UnlistenFn> {
  if (!isTauriAvailable()) return () => {};
  return await listen<GeminiProgressRaw>("gemini-progress", (event) => {
    callback(normalizeProgress(event.payload));
  });
}

export interface GeminiUsage {
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
}

interface DetectFieldsResponseRaw {
  text: string;
  finish_reason: string | null;
  usage: unknown;
  model: string;
}

export interface DetectFieldsResult {
  text: string;
  finishReason: string | null;
  usage: GeminiUsage;
  /** Echoes the (possibly dated) model id Gemini actually used. */
  model: string;
}

export interface DetectFieldsOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Gemini-flavoured JSON schema constraining the output. Set this for
   * structured-output mode (the default for the field-detection,
   * project-import, and QC passes). Pass `null` to opt out of
   * structured output and ask Gemini for free-form text — used by the
   * v0.4.12 two-stage Maximum-mode pipeline's Stage 1a
   * (description-first) call.
   */
  responseSchema: Record<string, unknown> | null;
  maxOutputTokens?: number;
  temperature?: number;
}

function isTauriAvailable(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

function normalizeError(message: unknown): Error {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  if (
    text.toLowerCase().includes("api key") &&
    text.toLowerCase().includes("not configured")
  ) {
    return new GeminiNotConfiguredError(text);
  }
  return new GeminiApiError(text);
}

function normalizeUsage(raw: unknown): GeminiUsage {
  if (!raw || typeof raw !== "object") return {};
  const u = raw as Record<string, unknown>;
  return {
    promptTokens:
      typeof u.promptTokenCount === "number" ? u.promptTokenCount : undefined,
    candidatesTokens:
      typeof u.candidatesTokenCount === "number"
        ? u.candidatesTokenCount
        : undefined,
    totalTokens:
      typeof u.totalTokenCount === "number" ? u.totalTokenCount : undefined,
  };
}

/**
 * Fires the streaming `:streamGenerateContent` request against Gemini
 * with the PDF inlined as `application/pdf`. Kept as a fallback path
 * (used by the project-import flow that doesn't need pixel-perfect
 * coordinates). v0.4.9+ field detection prefers
 * {@link detectFieldsWithGeminiImages}, which sidesteps Gemini's
 * opaque internal PDF rasterization.
 */
export async function detectFieldsWithGemini(
  pdfBytes: Uint8Array,
  opts: DetectFieldsOptions
): Promise<DetectFieldsResult> {
  if (!isTauriAvailable()) {
    throw new GeminiNotConfiguredError(
      "Gemini integration requires the desktop app (run `npm run tauri dev`)."
    );
  }
  try {
    const response = await invoke<DetectFieldsResponseRaw>(
      "gemini_detect_fields",
      {
        request: {
          pdf_bytes: Array.from(pdfBytes),
          model: opts.model,
          system_prompt: opts.systemPrompt,
          user_prompt: opts.userPrompt,
          response_schema: opts.responseSchema,
          max_output_tokens: opts.maxOutputTokens,
          temperature: opts.temperature,
        },
      }
    );
    return {
      text: response.text,
      finishReason: response.finish_reason ?? null,
      usage: normalizeUsage(response.usage),
      model: response.model,
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

/** One rendered page sent to Gemini as an `image/png` inlineData part. */
export interface GeminiPageImage {
  /** PNG bytes produced by `canvas.toBlob({ type: "image/png" })`. */
  pngBytes: Uint8Array;
  /** 1-based page index. Sent to Rust for diagnostic purposes only —
   *  Gemini uses parts ordering to determine page sequence. */
  pageNumber: number;
}

export interface DetectFieldsImagesOptions extends DetectFieldsOptions {
  images: GeminiPageImage[];
}

/**
 * v0.4.9+ image-based detection. The renderer rasterizes each PDF
 * page client-side via pdf.js to a known-pixel-space PNG, and we
 * inline those PNGs into the request. Gemini's normalized 0-1000
 * bbox coordinates then map cleanly to image-pixel space (and from
 * there to PDF user-space via the captured render scale).
 */
export async function detectFieldsWithGeminiImages(
  opts: DetectFieldsImagesOptions
): Promise<DetectFieldsResult> {
  if (!isTauriAvailable()) {
    throw new GeminiNotConfiguredError(
      "Gemini integration requires the desktop app (run `npm run tauri dev`)."
    );
  }
  try {
    const response = await invoke<DetectFieldsResponseRaw>(
      "gemini_detect_fields_images",
      {
        request: {
          images: opts.images.map((img) => ({
            png_bytes: Array.from(img.pngBytes),
            page_number: img.pageNumber,
          })),
          model: opts.model,
          system_prompt: opts.systemPrompt,
          user_prompt: opts.userPrompt,
          response_schema: opts.responseSchema,
          max_output_tokens: opts.maxOutputTokens,
          temperature: opts.temperature,
        },
      }
    );
    return {
      text: response.text,
      finishReason: response.finish_reason ?? null,
      usage: normalizeUsage(response.usage),
      model: response.model,
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Lightweight `generateContent` ping used by the Settings "Test
 *  connection" button. Returns void on success; throws on failure. */
export async function testGeminiConnection(model: string): Promise<void> {
  if (!isTauriAvailable()) {
    throw new GeminiNotConfiguredError(
      "Test connection requires the desktop app (run `npm run tauri dev`)."
    );
  }
  try {
    await invoke<string>("gemini_test_connection", { model });
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function setApiKey(key: string): Promise<void> {
  if (!isTauriAvailable()) {
    throw new GeminiNotConfiguredError(
      "Saving the API key requires the desktop app (run `npm run tauri dev`)."
    );
  }
  try {
    await invoke<void>("set_gemini_key", { key });
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function getApiKey(): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  try {
    const result = await invoke<string | null>("get_gemini_key");
    return result ?? null;
  } catch {
    return null;
  }
}

export async function hasApiKey(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    return await invoke<boolean>("has_gemini_key");
  } catch {
    return false;
  }
}

export async function clearApiKey(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await invoke<void>("clear_gemini_key");
  } catch (err) {
    throw normalizeError(err);
  }
}
