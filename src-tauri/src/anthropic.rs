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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::keychain;

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
/// fields structurally, and return the final text content. Anthropic loops
/// tool calls server-side; we make a single request and receive the full
/// trace + final answer in one response.
#[tauri::command]
pub async fn analyze_pdf_agentic(
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

    let file_id =
        upload_pdf_to_files_api(&client, &api_key, pdf_bytes, &filename).await?;

    let result = run_agentic_messages(
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

    let mut response = result?;
    response.file_id = Some(file_id);
    Ok(response)
}

#[allow(clippy::too_many_arguments)]
async fn run_agentic_messages(
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
            truncate_for_log(&raw, 1500)
        ));
    }

    let tool_calls = collect_tool_calls(&parsed);

    Ok(AnalyzePdfResponse {
        text,
        stop_reason: parsed
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .map(str::to_owned),
        usage: parsed.get("usage").cloned(),
        thinking_mode: thinking_mode.to_string(),
        file_id: None,
        tool_calls,
    })
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

/// Pulls every server_tool_use / *_tool_result block out of the response
/// for diagnostics. The renderer logs a count so users can see Claude's
/// tool usage.
fn collect_tool_calls(parsed: &Value) -> Vec<Value> {
    parsed
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| {
                    matches!(
                        block.get("type").and_then(|t| t.as_str()),
                        Some("server_tool_use")
                            | Some("code_execution_tool_result")
                            | Some("bash_code_execution_tool_result")
                            | Some("text_editor_code_execution_tool_result")
                    )
                })
                .cloned()
                .collect::<Vec<_>>()
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
