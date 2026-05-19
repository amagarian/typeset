#!/usr/bin/env python3
"""
Filled-output semantic QC harness.

This script evaluates the artifact the user actually sees: the filled PDF.
It renders the original and filled versions side-by-side, asks Gemini 3.5
Flash to judge semantic fill correctness, and writes structured findings plus
annotated artifacts under tmp/filled_pdf_qc/.

Primary goal: catch inaccurate filling caused by wrong field identity /
canonical mapping ("right-looking box, wrong project value"). Geometry issues
are reported only when they cause overlap, clipping, or ambiguity.

Requires:
  python3 -m pip install --user pypdfium2 Pillow
  macOS keychain item: service=typeset, account=gemini-api-key
"""

from __future__ import annotations

import base64
import io
import json
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
OUTPUT_DIR = Path("tmp/filled_pdf_qc")

ORIGINAL_DIR = Path(
    "/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/credit card auths"
)
FILLED_DIR = Path("/Users/aidenmagarian/Downloads/3.5 flash")


PROJECT_PROFILE: dict[str, Any] = {
    "note": (
        "This initial profile intentionally emphasizes semantic slots rather "
        "than exact private values. If a value is visible in the filled PDF, "
        "judge whether it belongs under the printed label it was written into."
    ),
    "fields": [
        {
            "project_key": "productionCompany",
            "expected_printed_labels": [
                "Production Company",
                "Production Co.",
                "Company",
                "Account/Company Name",
                "Company Name",
            ],
            "wrong_if_under": ["Invoice", "Reference", "Cardholder Name", "Customer Name"],
        },
        {
            "project_key": "jobName",
            "expected_printed_labels": ["Job Name", "Job/Show Name", "Show Name"],
            "wrong_if_under": ["Company", "Invoice", "Reference"],
        },
        {
            "project_key": "invoiceNumber",
            "expected_printed_labels": ["Invoice Number", "Invoice #", "Contract/Invoice #", "Order#"],
            "wrong_if_under": ["Company", "Production Company", "Job Name"],
        },
        {
            "project_key": "reference",
            "expected_printed_labels": ["Reference"],
            "wrong_if_under": ["Company Name", "Production Company"],
        },
        {
            "project_key": "creditCardHolder",
            "expected_printed_labels": [
                "Cardholder Name",
                "Name on Card",
                "Name as appears on card",
                "Name of Cardholder",
            ],
            "wrong_if_under": ["Production Company", "Company", "Invoice"],
        },
        {
            "project_key": "creditCardNumber",
            "expected_printed_labels": ["Card Number", "Card #", "Credit Card Number", "Account Number"],
            "wrong_if_under": ["CVV", "Expiration", "Billing Address"],
        },
        {
            "project_key": "expDate",
            "expected_printed_labels": ["Expiration Date", "EXP", "Exp Date", "Month/Year of expiration"],
            "wrong_if_under": ["CVV", "Card Number", "Date"],
        },
        {
            "project_key": "ccv",
            "expected_printed_labels": ["CVV", "CVV2", "Security Code", "Card Identification Number"],
            "wrong_if_under": ["Expiration", "Card Number", "Card Type"],
        },
        {
            "project_key": "billingAddress",
            "expected_printed_labels": ["Billing Address", "Credit Card Billing Address", "Address"],
            "wrong_if_under": ["Card Number", "Company", "Signature"],
        },
        {
            "project_key": "billingCity",
            "expected_printed_labels": ["City"],
            "wrong_if_under": ["State", "Zip", "Company"],
        },
        {
            "project_key": "billingState",
            "expected_printed_labels": ["State"],
            "wrong_if_under": ["City", "Zip"],
        },
        {
            "project_key": "billingZipCode",
            "expected_printed_labels": ["Zip", "Zip Code", "Billing Zip Code"],
            "wrong_if_under": ["City", "State", "CVV"],
        },
        {
            "project_key": "phone",
            "expected_printed_labels": ["Phone", "Phone Number", "Phone#"],
            "wrong_if_under": ["Email", "Fax"],
        },
        {
            "project_key": "email",
            "expected_printed_labels": ["Email", "Email Address", "billing or recipient email"],
            "wrong_if_under": ["Phone", "Company"],
        },
        {
            "project_key": "cardholderSignature",
            "expected_printed_labels": ["Signature", "Cardholder Signature", "Customer Signature"],
            "wrong_if_under": ["Print Name", "Date", "Card Number"],
        },
        {
            "project_key": "authorizationDate",
            "expected_printed_labels": ["Date"],
            "wrong_if_under": ["Expiration Date", "Ship Date", "Booking Date"],
        },
        {
            "project_key": "creditCardType",
            "expected_printed_labels": ["Card Type", "Credit card type", "Account Type"],
            "wrong_if_under": ["CVV", "Card Number"],
        },
    ],
}


QC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "document_verdict": {
            "type": "string",
            "enum": ["pass", "minor_issues", "fail"],
        },
        "summary": {"type": "string"},
        "semantic_score": {"type": "number"},
        "geometry_score": {"type": "number"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "page_number": {"type": "integer"},
                    "severity": {
                        "type": "string",
                        "enum": ["critical", "high", "medium", "low"],
                    },
                    "error_type": {
                        "type": "string",
                        "enum": [
                            "wrong_value",
                            "missing_value",
                            "duplicate_value",
                            "wrong_card_option",
                            "vendor_filled",
                            "signer_skipped_as_vendor",
                            "placement_overlap",
                            "placement_clipped",
                            "unclear",
                        ],
                    },
                    "printed_label": {"type": "string"},
                    "expected_project_key": {"type": "string"},
                    "expected_value": {"type": "string"},
                    "observed_value": {"type": "string"},
                    "visual_location": {"type": "string"},
                    "bbox": {"type": "array", "items": {"type": "number"}},
                    "message": {"type": "string"},
                    "likely_root_cause": {"type": "string"},
                    "fix_bucket": {
                        "type": "string",
                        "enum": [
                            "detection_prompt",
                            "canonical_mapping",
                            "mapped_project_key",
                            "fill_value_routing",
                            "party_classification",
                            "option_group_mapping",
                            "writer_alignment",
                            "template_specific_override",
                            "manual_review",
                        ],
                    },
                },
                "required": [
                    "id",
                    "page_number",
                    "severity",
                    "error_type",
                    "printed_label",
                    "expected_project_key",
                    "expected_value",
                    "observed_value",
                    "visual_location",
                    "bbox",
                    "message",
                    "likely_root_cause",
                    "fix_bucket",
                ],
            },
        },
    },
    "required": [
        "document_verdict",
        "summary",
        "semantic_score",
        "geometry_score",
        "findings",
    ],
}


QC_SYSTEM_PROMPT = """You are a senior QA reviewer for a PDF form-filling app.

You will receive paired images for each page:
1. Original blank form page.
2. Filled output page produced by the app.

Your primary task is semantic fill correctness, not template geometry.

Look for:
- expected project values written into the wrong printed field
- printed fields filled with the wrong semantic value
- values missing from obvious signer/cardholder fields
- duplicate values repeated in unrelated fields
- vendor/lessor/counterparty fields filled when they should stay blank
- signer/user fields skipped or treated as vendor
- wrong credit-card option/checkmark selected
- signature/date/address/city/state/zip/email/phone/card fields routed incorrectly

Only report placement issues when they cause overlap, clipping, or ambiguity.
Do not complain about tiny x/y alignment differences if the correct value is readable in the correct printed field.

Use the supplied project profile as the semantic map. Exact private values may not be known. If exact expected_value is unknown, use the project key and semantic expectation, and compare the visible observed value to the printed label.
Scores must be 0-100 numbers, where 100 means no issues in that category.

Return strict JSON only.
"""


@dataclass
class RenderedPage:
    page_number: int
    width_px: int
    height_px: int
    png_bytes: bytes
    image_path: Path


@dataclass
class DocumentPair:
    slug: str
    original_path: Path
    filled_path: Path


def normalize_name(name: str) -> str:
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    stem = re.sub(r"\s*-\s*FILLED$", "", stem, flags=re.I)
    stem = re.sub(r"[^a-z0-9]+", " ", stem.lower())
    return " ".join(stem.split())


def slugify(name: str) -> str:
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    stem = re.sub(r"\s*-\s*FILLED$", "", stem, flags=re.I)
    stem = re.sub(r"[^A-Za-z0-9]+", "-", stem).strip("-").lower()
    return stem[:80] or "document"


def get_api_key() -> str:
    return subprocess.check_output(
        ["security", "find-generic-password", "-s", "typeset", "-a", "gemini-api-key", "-w"],
        text=True,
    ).strip()


def render_pdf(path: Path, out_dir: Path, prefix: str) -> list[RenderedPage]:
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
        image_path = out_dir / f"{prefix}-page-{index + 1}.png"
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


def make_side_by_side(
    doc_dir: Path, original_pages: list[RenderedPage], filled_pages: list[RenderedPage]
) -> list[Path]:
    paths: list[Path] = []
    for orig, filled in zip(original_pages, filled_pages):
        left = Image.open(orig.image_path).convert("RGB")
        right = Image.open(filled.image_path).convert("RGB")
        height = max(left.height, right.height)
        width = left.width + right.width + 40
        canvas = Image.new("RGB", (width, height + 46), "white")
        draw = ImageDraw.Draw(canvas)
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
        except Exception:
            font = ImageFont.load_default()
        draw.text((10, 10), "ORIGINAL", fill=(30, 30, 30), font=font)
        draw.text((left.width + 50, 10), "FILLED OUTPUT", fill=(30, 30, 30), font=font)
        canvas.paste(left, (0, 46))
        canvas.paste(right, (left.width + 40, 46))
        out = doc_dir / f"side-by-side-page-{orig.page_number}.png"
        canvas.save(out)
        paths.append(out)
    return paths


def draw_issue_overlay(
    doc_dir: Path, filled_pages: list[RenderedPage], findings: list[dict[str, Any]]
) -> list[Path]:
    out_paths: list[Path] = []
    by_page: dict[int, list[dict[str, Any]]] = {}
    for finding in findings:
        by_page.setdefault(int(finding.get("page_number", 1)), []).append(finding)

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
    except Exception:
        font = ImageFont.load_default()

    colors = {
        "critical": (185, 28, 28),
        "high": (220, 38, 38),
        "medium": (234, 88, 12),
        "low": (37, 99, 235),
    }
    for page in filled_pages:
        image = Image.open(page.image_path).convert("RGB")
        draw = ImageDraw.Draw(image)
        for idx, finding in enumerate(by_page.get(page.page_number, []), start=1):
            bbox = finding.get("bbox", [])
            color = colors.get(str(finding.get("severity", "medium")), (234, 88, 12))
            if len(bbox) == 4 and all(isinstance(v, (int, float)) for v in bbox):
                y1, x1, y2, x2 = [float(v) for v in bbox]
                rect = [
                    x1 / 1000 * page.width_px,
                    y1 / 1000 * page.height_px,
                    x2 / 1000 * page.width_px,
                    y2 / 1000 * page.height_px,
                ]
                draw.rectangle(rect, outline=color, width=5)
                text_pos = (rect[0], max(0, rect[1] - 26))
            else:
                text_pos = (20, 20 + idx * 30)
            label = f"{idx}. {finding.get('error_type')}: {finding.get('printed_label')}"
            draw.rectangle(
                [
                    text_pos[0],
                    text_pos[1],
                    min(page.width_px, text_pos[0] + 12 * min(len(label), 95)),
                    text_pos[1] + 24,
                ],
                fill=(255, 255, 255),
            )
            draw.text(text_pos, label[:95], fill=color, font=font)
        out = doc_dir / f"issues-page-{page.page_number}.png"
        image.save(out)
        out_paths.append(out)
    return out_paths


def pair_documents() -> list[DocumentPair]:
    originals = {
        normalize_name(path.name): path for path in ORIGINAL_DIR.glob("*.pdf")
    }
    pairs: list[DocumentPair] = []
    missing: list[str] = []
    for filled in sorted(FILLED_DIR.glob("*.pdf")):
        key = normalize_name(filled.name)
        original = originals.get(key)
        if not original:
            missing.append(filled.name)
            continue
        pairs.append(DocumentPair(slug=slugify(filled.name), original_path=original, filled_path=filled))
    if missing:
        raise RuntimeError("Missing originals for: " + ", ".join(missing))
    return pairs


def call_gemini_qc(
    api_key: str,
    pair: DocumentPair,
    original_pages: list[RenderedPage],
    filled_pages: list[RenderedPage],
) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    page_lines: list[str] = []
    for orig, filled in zip(original_pages, filled_pages):
        page_lines.append(
            f"- Page {orig.page_number}: original image then filled image "
            f"({orig.width_px}x{orig.height_px}px / {filled.width_px}x{filled.height_px}px)"
        )
        for page in [orig, filled]:
            parts.append(
                {
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": base64.b64encode(page.png_bytes).decode("ascii"),
                    }
                }
            )

    prompt = "\n".join(
        [
            f"Document: {pair.original_path.name}",
            f"Filled output: {pair.filled_path.name}",
            "",
            "Image order:",
            *page_lines,
            "",
            "Project semantic profile:",
            json.dumps(PROJECT_PROFILE, ensure_ascii=False, indent=2),
            "",
            "Evaluate the filled output against the original blank form. Focus first on inaccurate filling / wrong semantic field identity. Return the JSON schema exactly.",
        ]
    )
    parts.append({"text": prompt})

    body = {
        "systemInstruction": {
            "role": "system",
            "parts": [{"text": QC_SYSTEM_PROMPT}],
        },
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": QC_SCHEMA,
            "temperature": 0.0,
            "maxOutputTokens": 16384,
            "thinkingConfig": {"thinkingLevel": "medium"},
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
        "parsed": parsed,
        "raw_text": text,
        "modelVersion": raw.get("modelVersion"),
        "usageMetadata": raw.get("usageMetadata"),
        "finishReasons": [c.get("finishReason") for c in raw.get("candidates", [])],
    }


def normalize_score(value: Any) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.0
    if 0 < score <= 1:
        return round(score * 100, 2)
    return round(score, 2)


def run_pair(api_key: str, pair: DocumentPair) -> dict[str, Any]:
    doc_dir = OUTPUT_DIR / pair.slug
    doc_dir.mkdir(parents=True, exist_ok=True)
    original_pages = render_pdf(pair.original_path, doc_dir, "original")
    filled_pages = render_pdf(pair.filled_path, doc_dir, "filled")
    side_by_side = make_side_by_side(doc_dir, original_pages, filled_pages)
    qc = call_gemini_qc(api_key, pair, original_pages, filled_pages)
    findings = qc.get("parsed", {}).get("findings", [])
    issue_overlays = draw_issue_overlay(doc_dir, filled_pages, findings)
    result = {
        "slug": pair.slug,
        "original_pdf": str(pair.original_path),
        "filled_pdf": str(pair.filled_path),
        "model": MODEL,
        "modelVersion": qc.get("modelVersion"),
        "finishReasons": qc.get("finishReasons"),
        "usageMetadata": qc.get("usageMetadata"),
        "document_verdict": qc.get("parsed", {}).get("document_verdict", "fail"),
        "summary": qc.get("parsed", {}).get("summary", ""),
        "semantic_score": normalize_score(qc.get("parsed", {}).get("semantic_score", 0)),
        "geometry_score": normalize_score(qc.get("parsed", {}).get("geometry_score", 0)),
        "findings": findings,
        "artifacts": {
            "side_by_side": [str(path) for path in side_by_side],
            "issue_overlays": [str(path) for path in issue_overlays],
        },
    }
    (doc_dir / "qc-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def write_summary(results: list[dict[str, Any]]) -> None:
    totals = {
        "critical": 0,
        "high": 0,
        "medium": 0,
        "low": 0,
    }
    by_type: dict[str, int] = {}
    by_bucket: dict[str, int] = {}
    for result in results:
        for finding in result.get("findings", []):
            sev = str(finding.get("severity", "low"))
            if sev in totals:
                totals[sev] += 1
            typ = str(finding.get("error_type", "unclear"))
            by_type[typ] = by_type.get(typ, 0) + 1
            bucket = str(finding.get("fix_bucket", "manual_review"))
            by_bucket[bucket] = by_bucket.get(bucket, 0) + 1

    lines = [
        "# Filled PDF Semantic QC Report",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Model: `{MODEL}`",
        "",
        "## Batch Summary",
        "",
        f"- Documents: {len(results)}",
        f"- Critical findings: {totals['critical']}",
        f"- High findings: {totals['high']}",
        f"- Medium findings: {totals['medium']}",
        f"- Low findings: {totals['low']}",
        "",
        "### Findings By Type",
        "",
    ]
    if by_type:
        for key, count in sorted(by_type.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"- `{key}`: {count}")
    else:
        lines.append("- none")

    lines.extend(["", "### Findings By Fix Bucket", ""])
    if by_bucket:
        for key, count in sorted(by_bucket.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"- `{key}`: {count}")
    else:
        lines.append("- none")

    lines.extend(["", "## Documents", ""])
    for result in results:
        findings = result.get("findings", [])
        lines.append(f"### {Path(result['filled_pdf']).name}")
        lines.append("")
        lines.append(f"- Verdict: `{result.get('document_verdict')}`")
        lines.append(f"- Semantic score: `{result.get('semantic_score')}`")
        lines.append(f"- Geometry score: `{result.get('geometry_score')}`")
        lines.append(f"- Findings: {len(findings)}")
        lines.append(f"- Summary: {result.get('summary')}")
        lines.append("- Artifacts:")
        for path in result.get("artifacts", {}).get("side_by_side", []):
            lines.append(f"  - `{path}`")
        for path in result.get("artifacts", {}).get("issue_overlays", []):
            lines.append(f"  - `{path}`")
        if findings:
            lines.append("- Findings detail:")
            for finding in findings:
                lines.append(
                    "  - "
                    f"`{finding.get('severity')}` / `{finding.get('error_type')}` / "
                    f"`{finding.get('fix_bucket')}`: "
                    f"{finding.get('message')} "
                    f"(label: `{finding.get('printed_label')}`, "
                    f"expected: `{finding.get('expected_project_key')}` / `{finding.get('expected_value')}`, "
                    f"observed: `{finding.get('observed_value')}`)"
                )
        lines.append("")

    (OUTPUT_DIR / "qc-report.md").write_text("\n".join(lines), encoding="utf-8")
    (OUTPUT_DIR / "qc-findings.json").write_text(json.dumps(results, indent=2), encoding="utf-8")


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pairs = pair_documents()
    api_key = get_api_key()
    results: list[dict[str, Any]] = []
    failures: list[str] = []
    for index, pair in enumerate(pairs, start=1):
        print(f"[{index}/{len(pairs)}] {pair.filled_path.name}", flush=True)
        try:
            result = run_pair(api_key, pair)
            results.append(result)
            print(
                f"  verdict={result['document_verdict']} "
                f"semantic={result['semantic_score']} findings={len(result['findings'])}",
                flush=True,
            )
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            msg = f"{pair.filled_path.name}: HTTP {err.code}: {body[:1200]}"
            print("  ERROR", msg, file=sys.stderr, flush=True)
            failures.append(msg)
        except Exception as err:
            msg = f"{pair.filled_path.name}: {type(err).__name__}: {err}"
            print("  ERROR", msg, file=sys.stderr, flush=True)
            failures.append(msg)

    write_summary(results)
    if failures:
        (OUTPUT_DIR / "failures.txt").write_text("\n".join(failures), encoding="utf-8")
    print(f"\nWrote {OUTPUT_DIR / 'qc-report.md'}")
    return 2 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
