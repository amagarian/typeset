#!/usr/bin/env python3
"""
Gemini 3.5 Flash PDF form regression harness.

Test-only script, not part of the shipped app. It renders each supplied PDF
page to a 2048px long-edge PNG (matching the app's image-based Gemini path),
runs a structured Gemini field-detection pass, runs a second structured QC pass,
and writes machine-readable JSON plus visual overlays for manual inspection.

Requires:
  python3 -m pip install --user pypdfium2
  macOS keychain item: service=typeset, account=gemini-api-key
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont


MODEL = "gemini-3.5-flash"
API_BASE = "https://generativelanguage.googleapis.com/v1beta"
LONG_EDGE_PX = 2048
OUTPUT_DIR = Path("tmp/gemini35_regression")

PDF_PATHS = [
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/204 Credit Card Authorization Form 2019.pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/Arrow CC Authorization.pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/BLP_CC_auth_InteractForm1.pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/CC Auth Form USD.pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/CC AUTH_Deposit and Rental .pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/HD CCAUTH (9) (2).pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/MILK CC Auth Form BLANK.pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/Omega Credit Card Authorization 2016.pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/Standard Camera CC Form.pdf",
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths/THERUBYCCAUTHFORM20242.pdf",
]


FIELD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "page_number": {"type": "integer"},
                    "field_type": {"type": "string"},
                    "canonical_id": {"type": "string"},
                    "party": {"type": "string"},
                    "bbox": {
                        "type": "array",
                        "items": {"type": "number"},
                    },
                    "confidence": {"type": "number"},
                    "evidence": {"type": "string"},
                },
                "required": [
                    "label",
                    "page_number",
                    "field_type",
                    "canonical_id",
                    "party",
                    "bbox",
                    "confidence",
                    "evidence",
                ],
            },
        },
        "notes": {"type": "string"},
    },
    "required": ["fields", "notes"],
}

QC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "corrected_fields": FIELD_SCHEMA["properties"]["fields"],
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string"},
                    "category": {"type": "string"},
                    "message": {"type": "string"},
                    "page_number": {"type": "integer"},
                },
                "required": ["severity", "category", "message", "page_number"],
            },
        },
        "verdict": {"type": "string"},
    },
    "required": ["corrected_fields", "findings", "verdict"],
}


DETECTION_SYSTEM_PROMPT = """You are testing a PDF form-field detector for a production paperwork app.

You are given page images for a credit-card authorization or vendor paperwork PDF. Identify every user-fillable field and return strict JSON only.

Rules:
- Return writable areas, not just printed captions.
- bbox must be [y_min, x_min, y_max, x_max] normalized 0-1000 relative to the rendered page image.
- Use page_number starting at 1.
- field_type should be one of: text, multiline, checkbox, option_group, signature, initials, date.
- canonical_id should be a useful semantic id when obvious: productionCompany, jobName, jobNumber, poNumber, creditCardHolder, creditCardNumber, expDate, ccv, billingAddress, billingCity, billingState, billingZipCode, email, phone, cardholderSignature, authorizedSignerTitle, initials, invoiceNumber, reference, unknown.
- party should be signer for the production/user side, vendor for counterparty/lessor/supplier fields, or unknown when unclear.
- Lessor/vendor/counterparty fields should be party=vendor even if they are visible blanks.
- Treat labels like “Signature”, “Cardholder Signature”, and “Its” as signature fields.
- Treat grouped card-brand checkboxes (Visa/MasterCard/AmEx/Discover) as one option_group if they share one question.
- For credit-card brand choices, prefer ONE option_group parent with options rather than four separate checkbox fields.
- Avoid duplicates: if one writable region has multiple nearby labels, pick the correct printed label and emit one field.
- Include fields at the bottom of the page; do not stop after the first section.
- Do not invent fields that are pure instructions or paragraphs with no writable blank/box.
- Boxed/grid layouts are common. If a table says “Please fill out all of the boxes below,” emit fields for the writable cells inside that table. Do not place those fields over the red instruction text above the table.
- If a table cell contains an inline label like “Card #:”, “EXP:”, “CVV2/Security Code:”, “Cardholder’s Name:”, “Billing Address:”, or “Signature:”, the bbox should cover the writable blank area in that same cell, starting after the printed label.
- For the Keslow-style grid: top Date/Contact/Company/Contract fields are in the four-header grid; card type/card number/EXP/CVV/name/billing/signature are in the lower credit card information table.
"""


QC_SYSTEM_PROMPT = """You are the quality-control reviewer for a PDF form-field detector.

Compare the page images against the proposed JSON detections. Return strict JSON only.

Your job:
- Remove duplicates.
- Fix wrong labels and wrong canonical ids.
- Add any missed obvious fillable fields.
- Mark vendor/lessor/counterparty fields as party=vendor.
- Verify bottom-section fields, signatures, CVV/card ID, expiration date, billing address, phone/email, and card type checkboxes.
- Keep credit-card brand choices as a single option_group when the app should write one card-type value; do not split Visa/MasterCard/AMEX/Discover into separate fields unless the form is asking independent yes/no questions.
- For boxed/grid layouts, ensure each bbox is inside the actual writable table cell. Reject detections that float over instruction paragraphs or red instructional text when a boxed table below contains the real fields.
- Keep bbox coordinates normalized [y_min, x_min, y_max, x_max] 0-1000.
- Report findings for any remaining uncertainty.
"""


@dataclass
class RenderedPage:
    page_number: int
    width_px: int
    height_px: int
    png_bytes: bytes
    image_path: Path


def slugify(path: Path) -> str:
    stem = re.sub(r"[^A-Za-z0-9]+", "-", path.stem).strip("-").lower()
    return stem[:80] or "document"


def get_api_key() -> str:
    return subprocess.check_output(
        ["security", "find-generic-password", "-s", "typeset", "-a", "gemini-api-key", "-w"],
        text=True,
    ).strip()


def render_pdf(path: Path, out_dir: Path) -> list[RenderedPage]:
    pdf = pdfium.PdfDocument(str(path))
    pages: list[RenderedPage] = []
    for index in range(len(pdf)):
        page = pdf[index]
        width_pt, height_pt = page.get_size()
        scale = LONG_EDGE_PX / max(width_pt, height_pt)
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        png_bytes = buf.getvalue()
        image_path = out_dir / f"page-{index + 1}.png"
        image.save(image_path)
        pages.append(
            RenderedPage(
                page_number=index + 1,
                width_px=image.width,
                height_px=image.height,
                png_bytes=png_bytes,
                image_path=image_path,
            )
        )
    return pages


def call_gemini(
    api_key: str,
    *,
    system_prompt: str,
    text_prompt: str,
    pages: list[RenderedPage],
    response_schema: dict[str, Any],
    max_output_tokens: int = 32768,
) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    for page in pages:
        parts.append(
            {
                "inlineData": {
                    "mimeType": "image/png",
                    "data": base64.b64encode(page.png_bytes).decode("ascii"),
                }
            }
        )
    parts.append({"text": text_prompt})

    body = {
        "systemInstruction": {
            "role": "system",
            "parts": [{"text": system_prompt}],
        },
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
            "temperature": 0.0,
            "maxOutputTokens": max_output_tokens,
        },
    }
    request = urllib.request.Request(
        f"{API_BASE}/models/{MODEL}:generateContent",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = json.loads(response.read().decode("utf-8"))
    text = "".join(
        part.get("text", "")
        for candidate in raw.get("candidates", [])
        for part in candidate.get("content", {}).get("parts", [])
    )
    parsed = json.loads(text) if text.strip() else {}
    return {
        "raw": raw,
        "text": text,
        "parsed": parsed,
        "modelVersion": raw.get("modelVersion"),
        "usageMetadata": raw.get("usageMetadata"),
        "finishReasons": [c.get("finishReason") for c in raw.get("candidates", [])],
    }


def bbox_iou(a: list[float], b: list[float]) -> float:
    if len(a) != 4 or len(b) != 4:
        return 0.0
    ay1, ax1, ay2, ax2 = a
    by1, bx1, by2, bx2 = b
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union else 0.0


def heuristic_findings(fields: list[dict[str, Any]]) -> list[str]:
    findings: list[str] = []
    for field in fields:
        bbox = field.get("bbox", [])
        if len(bbox) != 4:
            findings.append(f"{field.get('label', '?')}: invalid bbox length")
            continue
        if any(not isinstance(v, (int, float)) or math.isnan(float(v)) for v in bbox):
            findings.append(f"{field.get('label', '?')}: non-numeric bbox")
        if any(float(v) < -5 or float(v) > 1005 for v in bbox):
            findings.append(f"{field.get('label', '?')}: bbox out of normalized range {bbox}")
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            findings.append(f"{field.get('label', '?')}: inverted bbox {bbox}")
    for i, left in enumerate(fields):
        for right in fields[i + 1 :]:
            if left.get("page_number") != right.get("page_number"):
                continue
            iou = bbox_iou(left.get("bbox", []), right.get("bbox", []))
            if iou >= 0.65:
                findings.append(
                    f"possible duplicate p{left.get('page_number')}: "
                    f"{left.get('label')} / {right.get('label')} IoU={iou:.2f}"
                )
    return findings


def draw_overlays(doc_dir: Path, pages: list[RenderedPage], fields: list[dict[str, Any]]) -> list[str]:
    overlay_paths: list[str] = []
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
    except Exception:
        font = ImageFont.load_default()

    fields_by_page: dict[int, list[dict[str, Any]]] = {}
    for field in fields:
        fields_by_page.setdefault(int(field.get("page_number", 1)), []).append(field)

    colors = {
        "text": (0, 122, 255),
        "multiline": (0, 122, 255),
        "checkbox": (34, 197, 94),
        "option_group": (168, 85, 247),
        "signature": (239, 68, 68),
        "initials": (245, 158, 11),
        "date": (14, 165, 233),
    }
    for page in pages:
        image = Image.open(page.image_path).convert("RGB")
        draw = ImageDraw.Draw(image)
        for idx, field in enumerate(fields_by_page.get(page.page_number, []), start=1):
            bbox = field.get("bbox", [])
            if len(bbox) != 4:
                continue
            y1, x1, y2, x2 = [float(v) for v in bbox]
            rect = [
                x1 / 1000 * page.width_px,
                y1 / 1000 * page.height_px,
                x2 / 1000 * page.width_px,
                y2 / 1000 * page.height_px,
            ]
            field_type = str(field.get("field_type", "text"))
            color = colors.get(field_type, (0, 122, 255))
            if field.get("party") == "vendor":
                color = (107, 114, 128)
            draw.rectangle(rect, outline=color, width=4)
            label = f"{idx}. {field.get('label', '')} [{field_type}]"
            text_pos = (rect[0], max(0, rect[1] - 24))
            draw.rectangle(
                [text_pos[0], text_pos[1], text_pos[0] + min(700, 9 * len(label)), text_pos[1] + 22],
                fill=(255, 255, 255),
            )
            draw.text(text_pos, label[:90], fill=color, font=font)
        overlay_path = doc_dir / f"overlay-page-{page.page_number}.png"
        image.save(overlay_path)
        overlay_paths.append(str(overlay_path))
    return overlay_paths


def run_document(api_key: str, path: Path) -> dict[str, Any]:
    slug = slugify(path)
    doc_dir = OUTPUT_DIR / slug
    doc_dir.mkdir(parents=True, exist_ok=True)
    pages = render_pdf(path, doc_dir)
    page_summary = "\n".join(
        f"- Page {p.page_number}: {p.width_px}x{p.height_px}px" for p in pages
    )
    detection_prompt = (
        f"Filename: {path.name}\n"
        f"Rendered pages:\n{page_summary}\n\n"
        "Detect all fillable fields. Return the JSON schema exactly."
    )
    detection = call_gemini(
        api_key,
        system_prompt=DETECTION_SYSTEM_PROMPT,
        text_prompt=detection_prompt,
        pages=pages,
        response_schema=FIELD_SCHEMA,
        max_output_tokens=32768,
    )
    first_fields = detection.get("parsed", {}).get("fields", [])
    qc_prompt = (
        f"Filename: {path.name}\n"
        f"Rendered pages:\n{page_summary}\n\n"
        "Here is the proposed detection JSON. Audit it against the images, then return corrected_fields and findings.\n\n"
        f"{json.dumps(detection.get('parsed', {}), ensure_ascii=False)}"
    )
    qc = call_gemini(
        api_key,
        system_prompt=QC_SYSTEM_PROMPT,
        text_prompt=qc_prompt,
        pages=pages,
        response_schema=QC_SCHEMA,
        max_output_tokens=32768,
    )
    corrected_fields = qc.get("parsed", {}).get("corrected_fields", [])
    heuristics = heuristic_findings(corrected_fields)
    overlays = draw_overlays(doc_dir, pages, corrected_fields)
    result = {
        "file": str(path),
        "model": MODEL,
        "pages": [
            {
                "page_number": p.page_number,
                "width_px": p.width_px,
                "height_px": p.height_px,
                "image_path": str(p.image_path),
            }
            for p in pages
        ],
        "first_pass": {
            "field_count": len(first_fields),
            "fields": first_fields,
            "finishReasons": detection.get("finishReasons"),
            "modelVersion": detection.get("modelVersion"),
            "usageMetadata": detection.get("usageMetadata"),
            "notes": detection.get("parsed", {}).get("notes", ""),
        },
        "qc_pass": {
            "field_count": len(corrected_fields),
            "fields": corrected_fields,
            "findings": qc.get("parsed", {}).get("findings", []),
            "verdict": qc.get("parsed", {}).get("verdict", ""),
            "finishReasons": qc.get("finishReasons"),
            "modelVersion": qc.get("modelVersion"),
            "usageMetadata": qc.get("usageMetadata"),
        },
        "heuristic_findings": heuristics,
        "overlays": overlays,
    }
    (doc_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def write_summary(results: list[dict[str, Any]]) -> None:
    lines = [
        "# Gemini 3.5 Flash PDF Form Regression",
        "",
        f"Model: `{MODEL}`",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## Summary",
        "",
    ]
    for result in results:
        file_name = Path(result["file"]).name
        first_count = result["first_pass"]["field_count"]
        qc_count = result["qc_pass"]["field_count"]
        verdict = result["qc_pass"].get("verdict", "")
        findings = result["qc_pass"].get("findings", [])
        heuristics = result.get("heuristic_findings", [])
        lines.append(f"### {file_name}")
        lines.append("")
        lines.append(f"- Pages: {len(result['pages'])}")
        lines.append(f"- First pass fields: {first_count}")
        lines.append(f"- QC fields: {qc_count}")
        lines.append(f"- Verdict: {verdict or 'n/a'}")
        lines.append(f"- Model echo: {result['qc_pass'].get('modelVersion')}")
        if findings:
            lines.append("- QC findings:")
            for finding in findings[:12]:
                lines.append(
                    f"  - p{finding.get('page_number')}: "
                    f"{finding.get('severity')} / {finding.get('category')}: "
                    f"{finding.get('message')}"
                )
        if heuristics:
            lines.append("- Heuristic flags:")
            for finding in heuristics[:12]:
                lines.append(f"  - {finding}")
        lines.append("- Fields:")
        for idx, field in enumerate(result["qc_pass"]["fields"], start=1):
            lines.append(
                f"  - {idx}. p{field.get('page_number')} "
                f"`{field.get('label')}` "
                f"({field.get('field_type')}, {field.get('canonical_id')}, {field.get('party')}, "
                f"conf={field.get('confidence')})"
            )
        lines.append("")
    (OUTPUT_DIR / "summary.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    missing = [path for path in PDF_PATHS if not Path(path).exists()]
    if missing:
        print("Missing PDFs:", file=sys.stderr)
        for path in missing:
            print(f"  {path}", file=sys.stderr)
        return 1

    api_key = get_api_key()
    results: list[dict[str, Any]] = []
    for index, pdf_path in enumerate(PDF_PATHS, start=1):
        path = Path(pdf_path)
        print(f"[{index}/{len(PDF_PATHS)}] {path.name}", flush=True)
        try:
            result = run_document(api_key, path)
            results.append(result)
            print(
                f"  first={result['first_pass']['field_count']} qc={result['qc_pass']['field_count']} "
                f"verdict={result['qc_pass'].get('verdict', '')}",
                flush=True,
            )
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            print(f"  ERROR HTTP {err.code}: {body[:1200]}", file=sys.stderr, flush=True)
            results.append({"file": str(path), "error": f"HTTP {err.code}: {body}"})
        except Exception as err:
            print(f"  ERROR {type(err).__name__}: {err}", file=sys.stderr, flush=True)
            results.append({"file": str(path), "error": str(err)})
    write_summary([r for r in results if "error" not in r])
    (OUTPUT_DIR / "all-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nWrote {OUTPUT_DIR / 'summary.md'}")
    return 0 if all("error" not in r for r in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())
