import { invoke } from "@tauri-apps/api/core";

/**
 * Thrown when the Anthropic API key has not been configured (or when the
 * Tauri command is unavailable, e.g. in `npm run dev` web-only mode).
 */
export class ClaudeNotConfiguredError extends Error {
  constructor(message = "Anthropic API key is not configured.") {
    super(message);
    this.name = "ClaudeNotConfiguredError";
  }
}

/** Thrown when Claude returns a non-2xx response, with the API's error text. */
export class ClaudeApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeApiError";
  }
}

interface AnalyzePdfResponseRaw {
  text: string;
  stop_reason: string | null;
  usage: unknown;
  thinking_mode: string;
  file_id: string | null;
  tool_calls: unknown[];
}

/**
 * Adaptive-thinking effort level (Anthropic's `output_config.effort`).
 * - `"xhigh"` is Opus-4.7-only and gives the deepest reasoning.
 * - `"high"` is the default for Opus-4.6 / Sonnet-4.6 class models.
 * - `"medium"` / `"low"` trade thoroughness for cost.
 * - `"max"` removes token constraints entirely.
 */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface AnalyzePdfResult {
  text: string;
  stopReason: string | null;
  usage: ClaudeUsage;
  thinkingMode: string;
  /** File_id created by the agentic path (null for one-shot calls). */
  fileId: string | null;
  /**
   * Server-side tool-use blocks (code_execution invocations and their
   * results). Only populated by the agentic path. Useful for diagnostics
   * and surfacing "Claude ran N scripts" to the user.
   */
  toolCalls: unknown[];
}

export interface AnalyzePdfAgenticOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  effort?: ClaudeEffort;
  /** Optional original filename (default "document.pdf"). */
  filename?: string;
}

export interface AnalyzePdfOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  /**
   * Adaptive-thinking effort level. When set, the request enables
   * `thinking: { type: "adaptive" }` plus `output_config: { effort }`, which
   * is the only thinking shape supported on Claude Opus 4.7 and the
   * recommended mode on Opus 4.6 / Sonnet 4.6. Higher effort = deeper
   * spatial reasoning at the cost of latency and tokens.
   */
  effort?: ClaudeEffort;
  /**
   * Optional rendered page-image PNGs (one per page). Sent as image content
   * blocks before the PDF document block so Claude has both a visual
   * representation and the text-extracted PDF.
   */
  pageImages?: Uint8Array[];
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
    return new ClaudeNotConfiguredError(text);
  }
  return new ClaudeApiError(text);
}

function normalizeUsage(raw: unknown): ClaudeUsage {
  if (!raw || typeof raw !== "object") return {};
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
    cacheCreationInputTokens:
      typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined,
    cacheReadInputTokens:
      typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined,
  };
}

/**
 * Invokes the Rust-side `analyze_pdf_with_claude` command.
 *
 * Throws `ClaudeNotConfiguredError` when the desktop runtime is missing or
 * the API key is not set; throws `ClaudeApiError` for any other Anthropic
 * error so callers can show the upstream message.
 */
export async function analyzePdfWithClaude(
  pdfBytes: Uint8Array,
  opts: AnalyzePdfOptions
): Promise<AnalyzePdfResult> {
  if (!isTauriAvailable()) {
    throw new ClaudeNotConfiguredError(
      "Claude integration requires the desktop app (run `npm run tauri dev`)."
    );
  }

  try {
    const response = await invoke<AnalyzePdfResponseRaw>("analyze_pdf_with_claude", {
      request: {
        pdf_bytes: Array.from(pdfBytes),
        model: opts.model,
        system_prompt: opts.systemPrompt,
        user_prompt: opts.userPrompt,
        max_tokens: opts.maxTokens,
        effort: opts.effort,
        page_images: opts.pageImages?.map((img) => Array.from(img)),
      },
    });
    return {
      text: response.text,
      stopReason: response.stop_reason ?? null,
      usage: normalizeUsage(response.usage),
      thinkingMode: response.thinking_mode ?? "none",
      fileId: response.file_id ?? null,
      toolCalls: response.tool_calls ?? [],
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

/**
 * Agentic PDF analysis: uploads the PDF to Anthropic's Files API, then asks
 * Claude to use the hosted `code_execution_20250825` tool to extract data
 * structurally (Python sandbox with pdfplumber / pypdf / PIL). Anthropic
 * loops the tool calls server-side; this is a single round-trip from our
 * perspective, but can take 1-3 minutes for complex documents.
 *
 * This is the high-fidelity path used for first-time field detection; it
 * mirrors what Claude.ai does under the hood.
 */
export async function analyzePdfAgentic(
  pdfBytes: Uint8Array,
  opts: AnalyzePdfAgenticOptions
): Promise<AnalyzePdfResult> {
  if (!isTauriAvailable()) {
    throw new ClaudeNotConfiguredError(
      "Claude integration requires the desktop app (run `npm run tauri dev`)."
    );
  }

  try {
    const response = await invoke<AnalyzePdfResponseRaw>("analyze_pdf_agentic", {
      request: {
        pdf_bytes: Array.from(pdfBytes),
        model: opts.model,
        system_prompt: opts.systemPrompt,
        user_prompt: opts.userPrompt,
        max_tokens: opts.maxTokens,
        effort: opts.effort,
        filename: opts.filename,
      },
    });
    return {
      text: response.text,
      stopReason: response.stop_reason ?? null,
      usage: normalizeUsage(response.usage),
      thinkingMode: response.thinking_mode ?? "none",
      fileId: response.file_id ?? null,
      toolCalls: response.tool_calls ?? [],
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

/** Lightweight `messages` ping used by the Settings "Test connection" button. */
export async function testClaudeConnection(model: string): Promise<void> {
  if (!isTauriAvailable()) {
    throw new ClaudeNotConfiguredError(
      "Test connection requires the desktop app (run `npm run tauri dev`)."
    );
  }
  try {
    await invoke<string>("test_anthropic_connection", { model });
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function setApiKey(key: string): Promise<void> {
  if (!isTauriAvailable()) {
    throw new ClaudeNotConfiguredError(
      "Saving the API key requires the desktop app (run `npm run tauri dev`)."
    );
  }
  try {
    await invoke<void>("set_anthropic_key", { key });
  } catch (err) {
    throw normalizeError(err);
  }
}

export async function getApiKey(): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  try {
    const result = await invoke<string | null>("get_anthropic_key");
    return result ?? null;
  } catch {
    return null;
  }
}

export async function hasApiKey(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    return await invoke<boolean>("has_anthropic_key");
  } catch {
    return false;
  }
}

export async function clearApiKey(): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await invoke<void>("clear_anthropic_key");
  } catch (err) {
    throw normalizeError(err);
  }
}
