//! Google Gemini API client invoked from the renderer via Tauri commands.
//!
//! Architecture (compared to the previous Anthropic-based backend):
//!
//!   * Single round-trip. Gemini 2.5 natively understands PDFs as a
//!     multimodal modality, so there is NO file-upload step, NO Python
//!     sandbox, NO agentic tool-call loop. The PDF is base64-inlined in
//!     the request body and the model reads it directly. This is what
//!     gives us 20-30s end-to-end detection times vs. the 60-90s we saw
//!     on Anthropic's code-execution path.
//!
//!   * Structured output. We pass a `responseSchema` so Gemini emits
//!     valid JSON matching our wire schema deterministically — no more
//!     "extract JSON from markdown fences" parsing dance.
//!
//!   * Streaming. We use the `:streamGenerateContent?alt=sse` endpoint
//!     so the renderer's progress bar can move in real time as tokens
//!     arrive. We don't need full streaming text buffering on the way
//!     back; the frontend just wants "phase + token count" updates.
//!
//! The single exposed surface is `gemini_detect_fields`, which:
//!   1. Emits `uploading_file` (we treat the inline-base64 step as the
//!      "upload" phase to keep the existing progress-bar phase machine
//!      working — see `frontend phase mappings` in geminiClient.ts).
//!   2. Opens the SSE stream against `streamGenerateContent`.
//!   3. Forwards token-count progress events.
//!   4. Concatenates the streamed text into a single response and
//!      returns it.
//!
//! Authentication is the standard Gemini API key in the `x-goog-api-key`
//! header. As of v0.5.37 the key is baked into the binary so beta
//! testers don't need to provision their own — the user (Aiden) is
//! footing the bill during the closed beta. The keychain helpers in
//! `keychain.rs` and the `set_gemini_key` / `get_gemini_key` /
//! `has_gemini_key` / `clear_gemini_key` Tauri commands are still
//! registered for back-compat with any persisted state on existing
//! installs, but the detection path no longer reads them.
//!
//! The hardcoded key is restricted at the Google Cloud project level
//! (per-minute + daily quota cap) so the worst-case fan-out from a
//! leaked binary is bounded. Rotate by editing `HARDCODED_GEMINI_API_KEY`
//! and shipping a new release.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const GEMINI_API_BASE: &str = "https://generativelanguage.googleapis.com";

/// Beta-cycle Gemini API key. Baked into the binary so testers can drop
/// a PDF immediately without configuring anything. See module-level
/// docs for the rationale + quota-cap caveat.
const HARDCODED_GEMINI_API_KEY: &str = "AIzaSyA0gmkWIXYFToqWRzAp7H6AxwBlSvSp9ik";

/// Streaming progress event emitted to the renderer over the
/// `gemini-progress` channel while a detection call is in flight. The
/// frontend (DocumentList) maps these phases to a 0-1 progress fraction
/// and to a user-facing status line.
#[derive(Clone, Debug, Serialize)]
pub struct GeminiProgress {
    /// One of:
    /// - `"uploading_file"`  PDF being base64-encoded into the request body
    /// - `"file_uploaded"`   request body assembled, about to fire
    /// - `"request_sent"`    SSE stream opened against Gemini
    /// - `"streaming"`       chunks arriving; `tokens` rises monotonically
    /// - `"done"`            stream terminated successfully
    /// - `"error"`           stream terminated with an error (see `detail`)
    pub phase: String,
    /// Free-form human-readable detail (e.g. error message).
    pub detail: Option<String>,
    /// Cumulative output token count for the current call. Used by the
    /// progress bar to interpolate during the long `streaming` phase.
    pub tokens: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DetectFieldsRequest {
    pub pdf_bytes: Vec<u8>,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    /// JSON schema (in the Gemini-supported subset) constraining the
    /// model's output. Pass `Value::Null` to disable structured-output
    /// mode (used by the v0.4.12 Stage-1a free-form description pass);
    /// any other JSON value is forwarded verbatim as Gemini's
    /// `responseSchema`.
    pub response_schema: Value,
    /// Maximum output tokens. Leave None for the model default.
    pub max_output_tokens: Option<u32>,
    /// Sampling temperature, 0.0 - 2.0. Lower = more deterministic.
    /// Defaults to 0.0 server-side when omitted.
    pub temperature: Option<f32>,
}

/// One rendered page, ready to inline as `inlineData` in the request
/// body. The renderer (pdf.js + canvas.toBlob) hands these to Rust as
/// raw PNG bytes; we base64-encode and inline them. Sent in `page_number`
/// order — Gemini sees them in the same order as the underlying PDF.
#[derive(Debug, Serialize, Deserialize)]
pub struct PageImage {
    pub png_bytes: Vec<u8>,
    /// 1-based page index (informational; Gemini infers position from
    /// the parts ordering).
    pub page_number: u32,
}

/// Image-based variant of `DetectFieldsRequest`. Sent by the v0.4.9+
/// detector after the renderer rasterizes each PDF page client-side
/// to a known-pixel-space PNG. See the comment block at the top of
/// `gemini_detect_fields_images` for the rationale.
#[derive(Debug, Serialize, Deserialize)]
pub struct DetectFieldsImagesRequest {
    pub images: Vec<PageImage>,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub response_schema: Value,
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DetectFieldsResponse {
    /// Concatenated text from every streamed chunk. The renderer parses
    /// this as JSON (the responseSchema guarantees it parses cleanly).
    pub text: String,
    /// The `finishReason` of the final candidate (`"STOP"`, `"MAX_TOKENS"`,
    /// `"SAFETY"`, etc.).
    pub finish_reason: Option<String>,
    /// Aggregate usage metadata reported by Gemini.
    pub usage: Option<Value>,
    /// Echoes the model id used (for diagnostics — Gemini sometimes
    /// substitutes a dated model id).
    pub model: String,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Even with native PDF support Gemini 2.5 Pro can take 30-60s on
        // a complex, dense form. 180s is comfortable headroom.
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))
}

/// v0.5.37 — always returns the baked-in key. The previous keychain
/// lookup is gone; the renderer no longer renders an "API key not
/// configured" path because the key is guaranteed to be present.
fn require_key() -> Result<String, String> {
    Ok(HARDCODED_GEMINI_API_KEY.to_string())
}

fn emit_progress(app: &AppHandle, payload: GeminiProgress) {
    if let Err(err) = app.emit("gemini-progress", payload) {
        eprintln!("[gemini] failed to emit progress event: {err}");
    }
}

/// Strips an optional `data:` prefix and decodes base64. Used when
/// echoing inline data back from the response (defensive — Gemini
/// shouldn't return data parts for a JSON-mode response, but we want
/// to be robust).
fn _strip_data_prefix(value: &str) -> &str {
    value
        .strip_prefix("data: ")
        .unwrap_or_else(|| value.trim_start())
}

/// Parses a single SSE `data:` line as a Gemini stream chunk. Returns
/// `None` for the `[DONE]` sentinel and for empty / non-data lines.
fn parse_sse_chunk(line: &str) -> Option<Value> {
    let payload = line.strip_prefix("data: ").or_else(|| line.strip_prefix("data:"))?;
    let trimmed = payload.trim();
    if trimmed.is_empty() || trimmed == "[DONE]" {
        return None;
    }
    serde_json::from_str::<Value>(trimmed).ok()
}

/// Internal options shared by both `gemini_detect_fields` (PDF input,
/// kept as a fallback path) and `gemini_detect_fields_images` (the
/// preferred v0.4.9+ image-input path).
struct StreamArgs {
    /// Already-assembled `parts` array. The caller decides whether it
    /// contains a single PDF inlineData part, a list of image inlineData
    /// parts, etc. The trailing user-prompt text part is appended here
    /// so callers don't repeat themselves.
    parts: Vec<Value>,
    user_prompt: String,
    system_prompt: String,
    model: String,
    response_schema: Value,
    max_output_tokens: Option<u32>,
    temperature: Option<f32>,
    /// Detail string for the initial `uploading_file` progress event.
    upload_detail: String,
}

/// Drives a Gemini streaming request end-to-end and emits progress
/// events as bytes arrive. Shared by the PDF path (legacy fallback)
/// and the image path (v0.4.9+ default).
async fn run_gemini_stream(
    app: AppHandle,
    mut args: StreamArgs,
) -> Result<DetectFieldsResponse, String> {
    let api_key = require_key()?;
    let client = build_client()?;

    emit_progress(
        &app,
        GeminiProgress {
            phase: "uploading_file".into(),
            detail: Some(args.upload_detail.clone()),
            tokens: None,
        },
    );

    // Structured-output mode is opt-in. When the caller supplies a
    // non-null `response_schema` we set `responseMimeType: application/json`
    // + `responseSchema` so Gemini emits strict JSON. When the caller
    // passes `null` (Stage 1a free-form description in the v0.4.12 two-
    // stage Maximum-mode pipeline), we omit both keys so Gemini returns
    // ordinary text. Either path uses the same SSE plumbing and progress
    // events.
    let structured = !args.response_schema.is_null();
    let mut generation_config = if structured {
        json!({
            "responseMimeType": "application/json",
            "responseSchema": args.response_schema,
        })
    } else {
        json!({})
    };
    if let Some(t) = args.temperature {
        generation_config["temperature"] = json!(t);
    } else {
        // Default to 0 for deterministic structural extraction.
        generation_config["temperature"] = json!(0.0);
    }
    if let Some(m) = args.max_output_tokens {
        generation_config["maxOutputTokens"] = json!(m);
    }

    // Append the user prompt text part to whatever inlineData parts
    // the caller assembled.
    args.parts.push(json!({ "text": args.user_prompt }));

    let body = json!({
        "systemInstruction": {
            "role": "system",
            "parts": [{ "text": args.system_prompt }],
        },
        "contents": [{
            "role": "user",
            "parts": args.parts,
        }],
        "generationConfig": generation_config,
    });

    emit_progress(
        &app,
        GeminiProgress {
            phase: "file_uploaded".into(),
            detail: None,
            tokens: None,
        },
    );

    let url = format!(
        "{base}/v1beta/models/{model}:streamGenerateContent?alt=sse",
        base = GEMINI_API_BASE,
        model = args.model,
    );

    let response = client
        .post(&url)
        .header("x-goog-api-key", &api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error talking to Gemini: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let detail = format!("Gemini returned HTTP {status}: {text}");
        emit_progress(
            &app,
            GeminiProgress {
                phase: "error".into(),
                detail: Some(detail.clone()),
                tokens: None,
            },
        );
        return Err(detail);
    }

    emit_progress(
        &app,
        GeminiProgress {
            phase: "request_sent".into(),
            detail: None,
            tokens: None,
        },
    );

    let mut stream = response.bytes_stream();
    let mut text_acc = String::new();
    let mut buf = String::new();
    let mut finish_reason: Option<String> = None;
    let mut last_usage: Option<Value> = None;
    let mut model_echo = args.model.clone();
    let mut total_tokens: u32 = 0;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream read failed: {e}"))?;
        let s = String::from_utf8_lossy(&chunk);
        buf.push_str(&s);

        // SSE frames are separated by blank lines (\n\n). Process every
        // complete line we see, leaving any partial trailing line in
        // `buf` for the next iteration.
        loop {
            let Some(newline_idx) = buf.find('\n') else {
                break;
            };
            let line = buf[..newline_idx].trim_end_matches('\r').to_string();
            buf.drain(..=newline_idx);
            if line.is_empty() {
                continue;
            }
            let Some(value) = parse_sse_chunk(&line) else {
                continue;
            };

            // Standard chunk shape:
            // {
            //   "candidates": [{
            //     "content": { "parts": [{ "text": "..." }], "role": "model" },
            //     "finishReason": "STOP" (only on last chunk),
            //     ...
            //   }],
            //   "usageMetadata": { "candidatesTokenCount": N, ... },
            //   "modelVersion": "gemini-2.5-pro-..."
            // }
            if let Some(arr) = value.get("candidates").and_then(Value::as_array) {
                for cand in arr {
                    if let Some(parts) = cand
                        .get("content")
                        .and_then(|c| c.get("parts"))
                        .and_then(Value::as_array)
                    {
                        for part in parts {
                            if let Some(t) = part.get("text").and_then(Value::as_str) {
                                text_acc.push_str(t);
                            }
                        }
                    }
                    if let Some(reason) = cand.get("finishReason").and_then(Value::as_str) {
                        finish_reason = Some(reason.to_string());
                    }
                }
            }

            if let Some(usage) = value.get("usageMetadata") {
                last_usage = Some(usage.clone());
                if let Some(t) = usage
                    .get("candidatesTokenCount")
                    .and_then(Value::as_u64)
                {
                    total_tokens = t as u32;
                }
            }

            if let Some(m) = value.get("modelVersion").and_then(Value::as_str) {
                model_echo = m.to_string();
            }

            emit_progress(
                &app,
                GeminiProgress {
                    phase: "streaming".into(),
                    detail: None,
                    tokens: Some(total_tokens),
                },
            );
        }
    }

    emit_progress(
        &app,
        GeminiProgress {
            phase: "done".into(),
            detail: finish_reason.clone(),
            tokens: Some(total_tokens),
        },
    );

    Ok(DetectFieldsResponse {
        text: text_acc,
        finish_reason,
        usage: last_usage,
        model: model_echo,
    })
}

/// PDF-input detection (legacy fallback as of v0.4.9). Inlines the
/// entire PDF as a single `application/pdf` part. Kept for back-compat
/// — the v0.4.9+ default path uses `gemini_detect_fields_images` to
/// avoid Gemini's opaque internal PDF rendering, which produced a
/// systematic ~one-row vertical offset on dense forms.
#[tauri::command]
pub async fn gemini_detect_fields(
    app: AppHandle,
    request: DetectFieldsRequest,
) -> Result<DetectFieldsResponse, String> {
    // Inline base64. Gemini caps inline payloads at ~20MB and forms
    // are typically <2MB so we stay well inside the limit.
    let pdf_b64 = B64.encode(&request.pdf_bytes);
    let upload_detail = format!("{} bytes", request.pdf_bytes.len());

    run_gemini_stream(
        app,
        StreamArgs {
            parts: vec![
                json!({ "inlineData": { "mimeType": "application/pdf", "data": pdf_b64 } }),
            ],
            user_prompt: request.user_prompt,
            system_prompt: request.system_prompt,
            model: request.model,
            response_schema: request.response_schema,
            max_output_tokens: request.max_output_tokens,
            temperature: request.temperature,
            upload_detail,
        },
    )
    .await
}

/// Image-input detection (v0.4.9+ default).
///
/// Background:
/// Sending Gemini a raw PDF works in principle (it's natively
/// multimodal) but the model's internal rasterizer is an opaque black
/// box — different from pdf.js's MediaBox-based viewport — so the
/// 0-1000 normalized bbox coordinates Gemini emits don't map cleanly
/// back to pdf.js's user-space points. On the ARROW Credit-Card
/// Authorization form (and similar dense forms), this manifested as
/// every detected field overlay sitting one row above the actual
/// blank.
///
/// Gemini's own web/standalone app sidesteps this by rendering the
/// PDF to an image client-side and uploading that image — at which
/// point the bbox→image-pixel mapping is exact (by construction, the
/// image dimensions are the model's frame of reference). This command
/// implements the same approach: the renderer rasterizes each PDF
/// page via pdf.js, sends the resulting PNG bytes here, and we inline
/// them as `image/png` parts. Multi-page forms send multiple parts,
/// in page order. Gemini's multimodal API handles that natively.
#[tauri::command]
pub async fn gemini_detect_fields_images(
    app: AppHandle,
    request: DetectFieldsImagesRequest,
) -> Result<DetectFieldsResponse, String> {
    if request.images.is_empty() {
        return Err("No page images supplied to gemini_detect_fields_images.".into());
    }

    let mut total_bytes: usize = 0;
    let mut parts: Vec<Value> = Vec::with_capacity(request.images.len());
    for image in &request.images {
        total_bytes += image.png_bytes.len();
        let b64 = B64.encode(&image.png_bytes);
        parts.push(json!({
            "inlineData": { "mimeType": "image/png", "data": b64 },
        }));
    }

    let upload_detail = format!(
        "{} page image(s), {} bytes",
        request.images.len(),
        total_bytes
    );

    run_gemini_stream(
        app,
        StreamArgs {
            parts,
            user_prompt: request.user_prompt,
            system_prompt: request.system_prompt,
            model: request.model,
            response_schema: request.response_schema,
            max_output_tokens: request.max_output_tokens,
            temperature: request.temperature,
            upload_detail,
        },
    )
    .await
}

/// Lightweight `generateContent` ping used by the Settings "Test
/// connection" button. Returns "ok" on success, an error string on
/// failure. We use the non-streaming endpoint here because there's
/// nothing to stream — we just want to confirm the key + model.
#[tauri::command]
pub async fn gemini_test_connection(model: String) -> Result<String, String> {
    let api_key = require_key()?;
    let client = build_client()?;

    let url = format!(
        "{base}/v1beta/models/{model}:generateContent",
        base = GEMINI_API_BASE,
    );
    let body = json!({
        "contents": [{
            "role": "user",
            "parts": [{ "text": "Reply with the single word: ok" }],
        }],
        "generationConfig": { "maxOutputTokens": 8, "temperature": 0.0 },
    });

    let response = client
        .post(&url)
        .header("x-goog-api-key", &api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Gemini returned HTTP {status}: {text}"));
    }

    Ok("ok".into())
}
