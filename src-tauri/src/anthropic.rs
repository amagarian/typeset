//! Anthropic Messages API client invoked from the renderer via Tauri commands.
//!
//! Two surfaces are exposed:
//!
//! 1. `analyze_pdf_with_claude` — single-shot Messages call. The renderer
//!    hands us PDF bytes + optional rendered page images + adaptive-thinking
//!    effort. Used for lighter-weight tasks like importing project values
//!    out of an already-filled PDF.
//!
//! 2. `analyze_pdf_agentic` — the high-fidelity flow used for first-time
//!    field detection. It uploads the PDF to Anthropic's Files API, then
//!    fires a Messages request with the hosted `code_execution_20250825`
//!    tool and a `container_upload` content block, so Claude can run real
//!    Python (pdfplumber / pypdf) inside Anthropic's sandbox to extract
//!    coordinates structurally — the same architecture Claude.ai uses
//!    under the hood. Anthropic loops the tool calls server-side; we receive
//!    the final assistant text in one response.
//!
//! All calls attach the API key from the OS keychain.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::keychain;

/// Event emitted to the renderer over the `anthropic-progress` channel
/// while the agentic flow is running. The frontend listens before invoking
/// the command and translates phases into user-facing status text.
#[derive(Clone, Debug, Serialize)]
pub struct AgenticProgress {
    /// One of: "uploading_file" | "file_uploaded" | "request_sent" |
    /// "thinking" | "tool_start" | "tool_executing" | "tool_done" |
    /// "writing" | "done" | "error"
    pub phase: String,
    /// Free-form human-readable detail (e.g. file id, tool name, error msg).
    pub detail: Option<String>,
    /// Sequential index of the current code-execution invocation (1-based).
    pub tool_index: Option<u32>,
    /// Cumulative count of code-execution invocations seen so far.
    pub tool_count: Option<u32>,
}

const ANTHROPIC_API_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const FILES_API_BETA: &str = "files-api-2025-04-14";
const CODE_EXECUTION_TOOL: &str = "code_execution_20250825";

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalyzePdfRequest {
    pub pdf_bytes: Vec<u8>,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub max_tokens: Option<u32>,
    /// Adaptive-thinking effort level. One of:
    /// `"low" | "medium" | "high" | "xhigh" | "max"`.
    ///
    /// When set, the request includes `thinking: { type: "adaptive" }` and
    /// `output_config: { effort: <effort> }`, the only thinking shape
    /// supported on Claude Opus 4.7+. (`xhigh` is Opus-4.7-only.)
    pub effort: Option<String>,
    /// Optional rendered page images (PNG bytes), one per page. Sent as
    /// inline image content blocks before the PDF document block so Claude
    /// has both a visual representation and the text-extracted PDF.
    pub page_images: Option<Vec<Vec<u8>>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalyzePdfAgenticRequest {
    pub pdf_bytes: Vec<u8>,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub max_tokens: Option<u32>,
    pub effort: Option<String>,
    /// Optional original filename (used for the multipart file part). When
    /// omitted, defaults to "document.pdf".
    pub filename: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalyzePdfResponse {
    /// Concatenated text content blocks from the assistant.
    pub text: String,
    pub stop_reason: Option<String>,
    pub usage: Option<Value>,
    /// Echoes the thinking mode used: `"adaptive"` or `"none"`.
    pub thinking_mode: String,
    /// File ID created (and best-effort deleted) during this call. Useful
    /// for the renderer to show in diagnostics.
    pub file_id: Option<String>,
    /// JSON of every code_execution / bash invocation Claude made. Empty
    /// vector for non-agentic calls.
    pub tool_calls: Vec<Value>,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Code-execution + xhigh thinking on a complex form can run 2-4 min.
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))
}

fn require_key() -> Result<String, String> {
    keychain::read_api_key().ok_or_else(|| {
        "Anthropic API key is not configured. Open Settings to add one.".to_string()
    })
}

/// Uploads a PDF to Anthropic's Files API and returns the file_id.
async fn upload_pdf_to_files_api(
    client: &reqwest::Client,
    api_key: &str,
    pdf_bytes: Vec<u8>,
    filename: &str,
) -> Result<String, String> {
    let part = reqwest::multipart::Part::bytes(pdf_bytes)
        .file_name(filename.to_owned())
        .mime_str("application/pdf")
        .map_err(|e| format!("Failed to construct multipart part: {e}"))?;

    let form = reqwest::multipart::Form::new().part("file", part);

    let response = client
        .post(format!("{ANTHROPIC_API_BASE}/v1/files"))
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FILES_API_BETA)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("File upload request failed: {e}"))?;

    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| format!("Failed to read file upload response: {e}"))?;

    if !status.is_success() {
        return Err(format_api_error(status.as_u16(), &raw));
    }

    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("File upload returned non-JSON success body: {e}"))?;
    parsed
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| format!("File upload response missing `id` field. Body: {raw}"))
}

/// Best-effort delete of an uploaded file. Errors are swallowed.
async fn delete_file(client: &reqwest::Client, api_key: &str, file_id: &str) {
    let _ = client
        .delete(format!("{ANTHROPIC_API_BASE}/v1/files/{file_id}"))
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FILES_API_BETA)
        .send()
        .await;
}

/// Single-shot Messages call. Used for lightweight tasks (project-value
/// extraction). The renderer can optionally include rendered page-image
/// PNGs for spatial accuracy.
#[tauri::command]
pub async fn analyze_pdf_with_claude(
    request: AnalyzePdfRequest,
) -> Result<AnalyzePdfResponse, String> {
    let api_key = require_key()?;
    let client = build_client()?;

    if request.pdf_bytes.is_empty() {
        return Err("PDF is empty.".into());
    }

    const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;
    if request.pdf_bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "PDF is {} MB; Anthropic limits document blocks to 32 MB.",
            request.pdf_bytes.len() / (1024 * 1024)
        ));
    }

    let mut content_blocks: Vec<Value> = Vec::new();
    if let Some(images) = &request.page_images {
        for (index, image_bytes) in images.iter().enumerate() {
            if image_bytes.is_empty() {
                continue;
            }
            content_blocks.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": B64.encode(image_bytes),
                }
            }));
            content_blocks.push(json!({
                "type": "text",
                "text": format!("Rendered image of page {} (use this for spatial accuracy).", index + 1),
            }));
        }
    }

    content_blocks.push(json!({
        "type": "document",
        "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": B64.encode(&request.pdf_bytes),
        }
    }));
    content_blocks.push(json!({
        "type": "text",
        "text": request.user_prompt,
    }));

    let effort_normalized = request
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    let thinking_mode = if effort_normalized.is_some() {
        "adaptive"
    } else {
        "none"
    };
    let resolved_max = request.max_tokens.unwrap_or(if effort_normalized.is_some() {
        16384
    } else {
        8192
    });

    let mut body = json!({
        "model": request.model,
        "max_tokens": resolved_max,
        "system": request.system_prompt,
        "messages": [
            {
                "role": "user",
                "content": content_blocks,
            }
        ]
    });

    if let Some(effort) = effort_normalized {
        body["thinking"] = json!({ "type": "adaptive" });
        body["output_config"] = json!({ "effort": effort });
    }

    let response = client
        .post(format!("{ANTHROPIC_API_BASE}/v1/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;

    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Anthropic response body: {e}"))?;

    if !status.is_success() {
        return Err(format_api_error(status.as_u16(), &raw));
    }

    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Anthropic returned non-JSON success body: {e}"))?;

    let text = collect_text_blocks(&parsed);
    if text.is_empty() {
        return Err(format!(
            "Claude returned no text content. Raw payload: {}",
            truncate_for_log(&raw, 800)
        ));
    }

    Ok(AnalyzePdfResponse {
        text,
        stop_reason: parsed
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .map(str::to_owned),
        usage: parsed.get("usage").cloned(),
        thinking_mode: thinking_mode.to_string(),
        file_id: None,
        tool_calls: Vec::new(),
    })
}

/// Agentic flow: upload the PDF to the Files API, ask Claude to use
/// `code_execution_20250825` (Anthropic's hosted Python sandbox) to extract
/// fields structurally, and stream the response back. Anthropic loops tool
/// calls server-side; we stream SSE events from `/v1/messages` and emit
/// `anthropic-progress` Tauri events as each phase begins so the renderer
/// can show a live feed of what Claude is doing.
#[tauri::command]
pub async fn analyze_pdf_agentic(
    app: AppHandle,
    request: AnalyzePdfAgenticRequest,
) -> Result<AnalyzePdfResponse, String> {
    let api_key = require_key()?;
    let client = build_client()?;

    if request.pdf_bytes.is_empty() {
        return Err("PDF is empty.".into());
    }

    const MAX_PDF_BYTES: usize = 100 * 1024 * 1024;
    if request.pdf_bytes.len() > MAX_PDF_BYTES {
        return Err(format!(
            "PDF is {} MB; Anthropic Files API caps uploads at 100 MB.",
            request.pdf_bytes.len() / (1024 * 1024)
        ));
    }

    let AnalyzePdfAgenticRequest {
        pdf_bytes,
        model,
        system_prompt,
        user_prompt,
        max_tokens,
        effort,
        filename,
    } = request;

    let filename = filename
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("document.pdf")
        .to_owned();

    emit_progress(&app, "uploading_file", Some(&filename), None, None);
    let file_id =
        upload_pdf_to_files_api(&client, &api_key, pdf_bytes, &filename).await?;
    emit_progress(&app, "file_uploaded", Some(&file_id), None, None);

    let result = run_agentic_messages_streaming(
        &app,
        &client,
        &api_key,
        &file_id,
        &model,
        &system_prompt,
        &user_prompt,
        max_tokens,
        effort.as_deref(),
    )
    .await;

    delete_file(&client, &api_key, &file_id).await;

    match result {
        Ok(mut response) => {
            response.file_id = Some(file_id);
            emit_progress(&app, "done", None, None, None);
            Ok(response)
        }
        Err(err) => {
            emit_progress(&app, "error", Some(&err), None, None);
            Err(err)
        }
    }
}

fn emit_progress(
    app: &AppHandle,
    phase: &str,
    detail: Option<&str>,
    tool_index: Option<u32>,
    tool_count: Option<u32>,
) {
    let payload = AgenticProgress {
        phase: phase.to_string(),
        detail: detail.map(str::to_owned),
        tool_index,
        tool_count,
    };
    let _ = app.emit("anthropic-progress", payload);
}

/// Streams the Messages API response with `stream: true` and parses SSE
/// events on the fly. Emits an `anthropic-progress` event whenever a new
/// content block (thinking / server_tool_use / tool_result / text) starts
/// or stops, so the renderer can surface live status. Accumulates the
/// final assistant content into `AnalyzePdfResponse`.
#[allow(clippy::too_many_arguments)]
async fn run_agentic_messages_streaming(
    app: &AppHandle,
    client: &reqwest::Client,
    api_key: &str,
    file_id: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: Option<u32>,
    effort: Option<&str>,
) -> Result<AnalyzePdfResponse, String> {
    let content_blocks = json!([
        {
            "type": "container_upload",
            "file_id": file_id,
        },
        {
            "type": "text",
            "text": user_prompt,
        }
    ]);

    let effort_normalized = effort
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    let thinking_mode = if effort_normalized.is_some() {
        "adaptive"
    } else {
        "none"
    };
    let resolved_max = max_tokens.unwrap_or(if effort_normalized.is_some() {
        32768
    } else {
        16384
    });

    let mut body = json!({
        "model": model,
        "max_tokens": resolved_max,
        "system": system_prompt,
        "stream": true,
        "messages": [
            { "role": "user", "content": content_blocks }
        ],
        "tools": [
            { "type": CODE_EXECUTION_TOOL, "name": "code_execution" }
        ]
    });

    if let Some(effort) = effort_normalized {
        body["thinking"] = json!({ "type": "adaptive" });
        body["output_config"] = json!({ "effort": effort });
    }

    let response = client
        .post(format!("{ANTHROPIC_API_BASE}/v1/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FILES_API_BETA)
        .header("accept", "text/event-stream")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(format_api_error(status.as_u16(), &raw));
    }

    emit_progress(app, "request_sent", None, None, None);

    // Per-block accumulators keyed by block index. Anthropic streams blocks
    // by integer index; deltas reference the index they belong to.
    let mut block_types: std::collections::HashMap<u64, String> =
        std::collections::HashMap::new();
    let mut text_chunks: std::collections::HashMap<u64, String> =
        std::collections::HashMap::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut tool_count: u32 = 0;
    let mut stop_reason: Option<String> = None;
    let mut usage: Option<Value> = None;

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // SSE events are separated by blank lines (\n\n).
        while let Some(idx) = buffer.find("\n\n") {
            let event_block: String = buffer.drain(..idx + 2).collect();
            let mut data_payload = String::new();
            for line in event_block.lines() {
                if let Some(rest) = line.strip_prefix("data:") {
                    if !data_payload.is_empty() {
                        data_payload.push('\n');
                    }
                    data_payload.push_str(rest.trim_start());
                }
            }
            if data_payload.is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&data_payload) {
                Ok(v) => v,
                Err(_) => continue,
            };
            handle_sse_event(
                app,
                &value,
                &mut block_types,
                &mut text_chunks,
                &mut tool_calls,
                &mut tool_count,
                &mut stop_reason,
                &mut usage,
            );
        }
    }

    let mut indices: Vec<u64> = text_chunks.keys().copied().collect();
    indices.sort_unstable();
    let text: String = indices
        .into_iter()
        .filter_map(|i| text_chunks.remove(&i))
        .collect::<Vec<_>>()
        .join("\n");

    if text.is_empty() {
        return Err(
            "Claude returned no text content (stream completed with empty assistant message)."
                .to_string(),
        );
    }

    Ok(AnalyzePdfResponse {
        text,
        stop_reason,
        usage,
        thinking_mode: thinking_mode.to_string(),
        file_id: None,
        tool_calls,
    })
}

#[allow(clippy::too_many_arguments)]
fn handle_sse_event(
    app: &AppHandle,
    value: &Value,
    block_types: &mut std::collections::HashMap<u64, String>,
    text_chunks: &mut std::collections::HashMap<u64, String>,
    tool_calls: &mut Vec<Value>,
    tool_count: &mut u32,
    stop_reason: &mut Option<String>,
    usage: &mut Option<Value>,
) {
    let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match event_type {
        "content_block_start" => {
            let index = value.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let block = value.get("content_block").cloned().unwrap_or(Value::Null);
            let block_type = block
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            block_types.insert(index, block_type.clone());

            match block_type.as_str() {
                "thinking" => {
                    emit_progress(app, "thinking", None, None, Some(*tool_count));
                }
                "server_tool_use" => {
                    *tool_count += 1;
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    emit_progress(
                        app,
                        "tool_start",
                        Some(name),
                        Some(*tool_count),
                        Some(*tool_count),
                    );
                    tool_calls.push(block.clone());
                }
                "code_execution_tool_result"
                | "bash_code_execution_tool_result"
                | "text_editor_code_execution_tool_result" => {
                    emit_progress(
                        app,
                        "tool_done",
                        Some(&block_type),
                        Some(*tool_count),
                        Some(*tool_count),
                    );
                    tool_calls.push(block.clone());
                }
                "text" => {
                    emit_progress(app, "writing", None, None, Some(*tool_count));
                    text_chunks.entry(index).or_default();
                }
                _ => {}
            }
        }
        "content_block_delta" => {
            let index = value.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            let delta = value.get("delta").cloned().unwrap_or(Value::Null);
            let delta_type = delta
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if delta_type == "text_delta" {
                if let Some(t) = delta.get("text").and_then(|t| t.as_str()) {
                    text_chunks
                        .entry(index)
                        .or_default()
                        .push_str(t);
                }
            }
            // input_json_delta (for tool_use blocks) and thinking_delta
            // are intentionally not surfaced here — the start event is
            // enough for the live feed and we keep the raw tool_use block
            // captured at content_block_start in `tool_calls`.
        }
        "content_block_stop" => {
            let index = value.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
            if let Some(bt) = block_types.get(&index) {
                if bt == "server_tool_use" {
                    emit_progress(
                        app,
                        "tool_executing",
                        None,
                        Some(*tool_count),
                        Some(*tool_count),
                    );
                }
            }
        }
        "message_delta" => {
            if let Some(reason) = value
                .get("delta")
                .and_then(|d| d.get("stop_reason"))
                .and_then(|r| r.as_str())
            {
                *stop_reason = Some(reason.to_string());
            }
            if let Some(u) = value.get("usage") {
                *usage = Some(u.clone());
            }
        }
        _ => {}
    }
}

/// Lightweight ping used by the Settings "Test connection" button.
#[tauri::command]
pub async fn test_anthropic_connection(model: String) -> Result<String, String> {
    let api_key = require_key()?;
    let client = build_client()?;

    let body = json!({
        "model": model,
        "max_tokens": 8,
        "messages": [
            { "role": "user", "content": "ping" }
        ]
    });

    let response = client
        .post(format!("{ANTHROPIC_API_BASE}/v1/messages"))
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;

    let status = response.status();
    let raw = response.text().await.unwrap_or_default();

    if status.is_success() {
        Ok("OK".into())
    } else {
        Err(format_api_error(status.as_u16(), &raw))
    }
}

fn collect_text_blocks(parsed: &Value) -> String {
    parsed
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        block.get("text").and_then(|t| t.as_str()).map(str::to_owned)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn format_api_error(status: u16, raw: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if let Some(message) = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
        {
            return format!("Anthropic API error ({status}): {message}");
        }
    }
    format!(
        "Anthropic API error ({}): {}",
        status,
        truncate_for_log(raw, 400)
    )
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}
