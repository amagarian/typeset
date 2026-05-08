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
//! header, fetched from the OS keychain.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::keychain;

const GEMINI_API_BASE: &str = "https://generativelanguage.googleapis.com";

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
    /// model's output. Required — we only ever call Gemini with a fixed
    /// output shape.
    pub response_schema: Value,
    /// Maximum output tokens. Leave None for the model default.
    pub max_output_tokens: Option<u32>,
    /// Sampling temperature, 0.0 - 2.0. Lower = more deterministic.
    /// Defaults to 0.0 server-side when omitted.
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

fn require_key() -> Result<String, String> {
    keychain::read_api_key()
        .ok_or_else(|| "Gemini API key is not configured. Open Settings to add one.".to_string())
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

/// Drives the Gemini streaming request end-to-end and emits progress
/// events as bytes arrive.
#[tauri::command]
pub async fn gemini_detect_fields(
    app: AppHandle,
    request: DetectFieldsRequest,
) -> Result<DetectFieldsResponse, String> {
    let api_key = require_key()?;
    let client = build_client()?;

    emit_progress(
        &app,
        GeminiProgress {
            phase: "uploading_file".into(),
            detail: Some(format!("{} bytes", request.pdf_bytes.len())),
            tokens: None,
        },
    );

    // Inline base64. Gemini caps inline payloads at ~20MB and forms
    // are typically <2MB so we stay well inside the limit. The
    // alternative (Files API resumable upload) adds two extra round-
    // trips and ~3-5s of overhead for no accuracy benefit.
    let pdf_b64 = B64.encode(&request.pdf_bytes);

    let mut generation_config = json!({
        "responseMimeType": "application/json",
        "responseSchema": request.response_schema,
    });
    if let Some(t) = request.temperature {
        generation_config["temperature"] = json!(t);
    } else {
        // Default to 0 for deterministic structural extraction.
        generation_config["temperature"] = json!(0.0);
    }
    if let Some(m) = request.max_output_tokens {
        generation_config["maxOutputTokens"] = json!(m);
    }

    let body = json!({
        "systemInstruction": {
            "role": "system",
            "parts": [{ "text": request.system_prompt }],
        },
        "contents": [{
            "role": "user",
            "parts": [
                { "inlineData": { "mimeType": "application/pdf", "data": pdf_b64 } },
                { "text": request.user_prompt },
            ],
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
        model = request.model,
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
    let mut model_echo = request.model.clone();
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
