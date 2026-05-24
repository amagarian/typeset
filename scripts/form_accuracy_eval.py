#!/usr/bin/env python3
"""
Headless PDF form accuracy evaluator.

This script is intentionally local-only and writes all heavy artifacts under
eval/forms/runs/<timestamp>/. It accepts a manifest of sample PDFs, captures
processing traces, runs Gemini 3.5 Flash detection/QC when requested, compares
against reviewed expected JSON, and produces batch reports grouped by fix bucket.

The preferred production signal is still the app's own processing console:
provide `consoleLog` and `filledPdf` in the manifest to evaluate the exact app
run. When those artifacts are absent, the runner still gives a fast direct
Gemini benchmark and visual overlays so new samples can be triaged quickly.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:
    import pypdfium2 as pdfium
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - dependency message only
    print(
        "Missing eval dependency. Install with: python3 -m pip install --user pypdfium2 Pillow",
        file=sys.stderr,
    )
    raise


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "eval/forms/manifest.json"
DEFAULT_RUNS_DIR = ROOT / "eval/forms/runs"
MODEL = "gemini-3.5-flash"
API_BASE = "https://generativelanguage.googleapis.com/v1beta"
LONG_EDGE_PX = 2048


DEFAULT_PROJECT_PROFILE: dict[str, Any] = {
    "label": "EVAL Sentinel Production",
    "jobName": "EVAL Job Name",
    "jobNumber": "EVAL-JOB-042",
    "poNumber": "EVAL-PO-314",
    "productionCompany": "EVAL Production Company LLC",
    "billingAddress": "123 Eval Street",
    "billingCity": "Los Angeles",
    "billingState": "CA",
    "billingZipCode": "90026",
    "producer": "Evan Evaluator",
    "email": "eval@example.test",
    "phone": "555-0104",
    "creditCardType": "visa",
    "creditCardHolder": "Casey Cardholder",
    "cardholderSignature": "Casey Cardholder",
    "creditCardNumber": "4111 1111 1111 1111",
    "expDate": "12/30",
    "ccv": "123",
    "authorizationDate": "05/23/26",
    "shootDate": "06/01/26",
    "invoiceNumber": "EVAL-INV-777",
    "reference": "EVAL-REF-888",
    "authorizedSignerName": "Sam Signer",
    "authorizedSignerTitle": "Producer",
    "initials": "CS",
}


VALID_CANONICAL_IDS = [
    "projectLabel",
    "jobName",
    "jobNumber",
    "poNumber",
    "authorizationDate",
    "shootDate",
    "productionCompany",
    "billingAddress",
    "billingCity",
    "billingState",
    "billingZipCode",
    "producer",
    "email",
    "phone",
    "creditCardTypeVisa",
    "creditCardTypeMastercard",
    "creditCardTypeDiscover",
    "creditCardTypeAmex",
    "cardType",
    "creditCardHolder",
    "cardholderSignature",
    "creditCardNumber",
    "expDate",
    "ccv",
    "federalTaxId",
    "dunsNumber",
    "dbaName",
    "authorizedSignerName",
    "authorizedSignerTitle",
    "secondAuthorizedSignerName",
    "secondAuthorizedSignerTitle",
    "bankName",
    "bankRoutingNumber",
    "bankAccountNumber",
    "fedExAccountNumber",
    "upsAccountNumber",
    "rentalStartDate",
    "rentalEndDate",
    "hourlyRateBuild",
    "hourlyRateShoot",
    "hoursBuild",
    "hoursShoot",
    "driverLicenseNumber",
    "vehicleVin",
    "vehiclePlate",
    "insuranceCarrier",
    "insurancePolicyNumber",
    "invoiceNumber",
    "dateBusinessStarted",
    "dateIncorporated",
    "parentCompany",
    "streetAddress",
    "deliveryAddress",
    "accountingContactName",
    "accountingEmail",
    "clauseInitials",
    "showName",
    "seasonNumber",
    "productionClassification",
    "resaleTaxCertificate",
    "yearsInBusiness",
    "unknown",
]

VALID_CANONICAL_ID_TEXT = ", ".join(VALID_CANONICAL_IDS)

CANONICAL_TO_PROJECT_KEY: dict[str, str] = {
    "projectLabel": "label",
    "jobName": "jobName",
    "jobNumber": "jobNumber",
    "poNumber": "poNumber",
    "authorizationDate": "authorizationDate",
    "shootDate": "shootDate",
    "productionCompany": "productionCompany",
    "billingAddress": "billingAddress",
    "billingCity": "billingCity",
    "billingState": "billingState",
    "billingZipCode": "billingZipCode",
    "producer": "producer",
    "email": "email",
    "phone": "phone",
    "creditCardTypeVisa": "creditCardType",
    "creditCardTypeMastercard": "creditCardType",
    "creditCardTypeDiscover": "creditCardType",
    "creditCardTypeAmex": "creditCardType",
    "cardType": "creditCardType",
    "creditCardHolder": "creditCardHolder",
    "cardholderSignature": "cardholderSignature",
    "creditCardNumber": "creditCardNumber",
    "expDate": "expDate",
    "ccv": "ccv",
    "federalTaxId": "federalTaxId",
    "dunsNumber": "dunsNumber",
    "dbaName": "dbaName",
    "authorizedSignerName": "authorizedSignerName",
    "authorizedSignerTitle": "authorizedSignerTitle",
    "secondAuthorizedSignerName": "secondAuthorizedSignerName",
    "secondAuthorizedSignerTitle": "secondAuthorizedSignerTitle",
    "bankName": "bankName",
    "bankRoutingNumber": "bankRoutingNumber",
    "bankAccountNumber": "bankAccountNumber",
    "fedExAccountNumber": "fedExAccountNumber",
    "upsAccountNumber": "upsAccountNumber",
    "rentalStartDate": "rentalStartDate",
    "rentalEndDate": "rentalEndDate",
    "hourlyRateBuild": "hourlyRateBuild",
    "hourlyRateShoot": "hourlyRateShoot",
    "hoursBuild": "hoursBuild",
    "hoursShoot": "hoursShoot",
    "driverLicenseNumber": "driverLicenseNumber",
    "vehicleVin": "vehicleVin",
    "vehiclePlate": "vehiclePlate",
    "insuranceCarrier": "insuranceCarrier",
    "insurancePolicyNumber": "insurancePolicyNumber",
    "invoiceNumber": "invoiceNumber",
    "dateBusinessStarted": "dateBusinessStarted",
    "dateIncorporated": "dateIncorporated",
    "parentCompany": "parentCompany",
    "streetAddress": "streetAddress",
    "deliveryAddress": "deliveryAddress",
    "accountingContactName": "accountingContactName",
    "accountingEmail": "accountingEmail",
    "clauseInitials": "initials",
    "showName": "showName",
    "seasonNumber": "seasonNumber",
    "productionClassification": "productionClassification",
    "resaleTaxCertificate": "resaleTaxCertificate",
    "yearsInBusiness": "yearsInBusiness",
}


DETECTION_SCHEMA: dict[str, Any] = {
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
                    "field_kind": {"type": "string"},
                    "canonical_id": {"type": "string"},
                    "mapped_project_key": {"type": "string"},
                    "party": {"type": "string"},
                    "bbox": {"type": "array", "items": {"type": "number"}},
                    "confidence": {"type": "number"},
                    "evidence": {"type": "string"},
                },
                "required": [
                    "label",
                    "page_number",
                    "field_type",
                    "field_kind",
                    "canonical_id",
                    "mapped_project_key",
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


FILLED_QC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "document_verdict": {
            "type": "string",
            "enum": ["pass", "minor_issues", "fail"],
        },
        "semantic_score": {"type": "number"},
        "geometry_score": {"type": "number"},
        "summary": {"type": "string"},
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
                    "error_type": {"type": "string"},
                    "printed_label": {"type": "string"},
                    "expected_project_key": {"type": "string"},
                    "observed_value": {"type": "string"},
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
                    "observed_value",
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
        "semantic_score",
        "geometry_score",
        "summary",
        "findings",
    ],
}


DETECTION_QC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "document_verdict": {
            "type": "string",
            "enum": ["pass", "minor_issues", "fail"],
        },
        "detection_score": {"type": "number"},
        "summary": {"type": "string"},
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
                            "missing_field",
                            "extra_field",
                            "duplicate_field",
                            "wrong_label",
                            "wrong_canonical",
                            "wrong_mapped_key",
                            "wrong_party",
                            "wrong_kind",
                            "wrong_option_group",
                            "bbox_too_large",
                            "bbox_too_small",
                            "bbox_shifted",
                            "unclear",
                        ],
                    },
                    "printed_label": {"type": "string"},
                    "expected": {"type": "string"},
                    "observed": {"type": "string"},
                    "bbox": {"type": "array", "items": {"type": "number"}},
                    "message": {"type": "string"},
                    "likely_root_cause": {"type": "string"},
                    "fix_bucket": {
                        "type": "string",
                        "enum": [
                            "detection_prompt",
                            "canonical_mapping",
                            "mapped_project_key",
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
                    "expected",
                    "observed",
                    "bbox",
                    "message",
                    "likely_root_cause",
                    "fix_bucket",
                ],
            },
        },
        "corrected_fields": DETECTION_SCHEMA["properties"]["fields"],
    },
    "required": [
        "document_verdict",
        "detection_score",
        "summary",
        "findings",
        "corrected_fields",
    ],
}


DETECTION_SYSTEM_PROMPT = f"""You are evaluating Wrapkit's PDF form-field detection pipeline for production paperwork.

Identify every user-fillable field in the provided PDF page images and return strict JSON only.

Rules:
- Return writable areas, not printed captions.
- bbox must be [y_min, x_min, y_max, x_max] normalized 0-1000 relative to the rendered page image.
- Use page_number starting at 1.
- field_type should be text, checkbox, or option_group.
- field_kind should be text, multiline, date, signature, checkbox-group, boolean-checkbox, or option-group.
- canonical_id must be one of Wrapkit's supported canonical IDs, or unknown. Supported IDs: {VALID_CANONICAL_ID_TEXT}.
- mapped_project_key should be the project key that should fill the field, __prompt__ when the user must supply it, or empty when the field should not be filled.
- party should be signer for the user's side, vendor for counterparty/lessor/supplier fields, or unknown. Do not invent other party values such as third_party; third-party sponsor blanks are signer-side prompt fields unless the form says the vendor must fill them.
- Counterparty/vendor fields should normally be party=vendor and not filled by Wrapkit.
- Any fillable field that does not safely map to the supplied project profile should use mapped_project_key "__prompt__". This includes third-party sponsor name/signature/date fields, write-in Other card type fields, and form-specific authorization blanks.
- Signature fields use field_type "text" and field_kind "signature"; field_type never equals "signature".
- Avoid duplicates. Emit one field per writable region.
- Include bottom sections, signatures, initials, card type selectors, and boxed/table layouts.
- If a table cell contains an inline label like Card #, EXP, CVV2/Security Code, Cardholder's Name, Billing Address, or Signature, bbox should start after the printed label inside that cell.
- For stacked closing blocks, pair each underline with the caption directly below it and horizontally overlapping it. A long line above "renting party, representative" is a signature field, not a nearby Date field. A long line above "print name and phone #" is a printed-name/phone field, not another signature. A date field must be horizontally local to the printed "Date:" label.
- Normalize bboxes against the FULL page image height and width, not the top half of the form, crop content, visible ink bounds, or any internal table region. A field halfway down the page should have y values around 500, not 250.
- If a horizontal card-brand row shows labels like Visa, MasterCard, AMEX, Discover with no drawn checkbox squares/circles beside them, emit one option_group field with per-option bboxes. Do not omit the brands and do not invent checkboxes. If there are drawn checkbox squares, emit separate checkbox fields.
- Rows like "__ Visa  __ Mastercard  __ Amex  __ Discover" are underline selectors, not four independent checkboxes. Emit one option_group for the brands.
- In signature / print-name / date blocks where captions sit below large empty bands, place bboxes in the actual empty band immediately above the caption. Do not place them up in paragraph text above the band.
- "I, ____ (full name as it appears on the credit card)" is a creditCardHolder field.
"""


FILLED_QC_SYSTEM_PROMPT = """You are a senior QA reviewer for a PDF form-filling app.

You will receive original blank PDF page images and, when available, filled output page images. Judge whether the filled output placed the correct semantic project values into the correct printed fields.

Report:
- wrong semantic value under a printed label
- missing values in obvious signer/cardholder fields
- duplicate values in unrelated fields
- vendor/counterparty fields filled when they should stay blank
- signer fields skipped as vendor
- wrong card type option
- geometry issues only when they overlap, clip, or make the value ambiguous

Use the supplied project profile for expected values. Return strict JSON only.
"""


DETECTION_QC_SYSTEM_PROMPT = f"""You are the strict quality-control judge for a PDF field detector.

You will receive original blank PDF page images and the detector's proposed JSON fields.

Your job is to find real accuracy problems:
- missed fillable blanks, boxes, signature lines, date fields, initials, card details, card type selectors, and bottom-section fields
- non-fillable printed captions or instructional text incorrectly emitted as fields
- duplicates for the same writable region
- wrong label, canonical_id, mapped_project_key, field_kind, option-group structure, or party classification
- bboxes that include printed labels when the writable area starts after the label
- bboxes that are shifted to a neighboring underline/cell, too wide, too narrow, too high, or too low enough to affect filling

Be strict but not noisy:
- Do not report tiny geometry imperfections unless they would cause overlap, clipping, wrong-field filling, or ambiguous placement.
- The app's party model is only signer/vendor/unknown. Do not report third-party sponsor blanks as wrong_party just because they are not a distinct third_party party. They are signer-side prompt fields unless the form states the vendor/counterparty fills them.
- field_type is limited to text, checkbox, and option_group. A signature line is correct when field_type is text and field_kind is signature.
- Only these canonical IDs exist in Wrapkit: {VALID_CANONICAL_ID_TEXT}.
- Never report a wrong_canonical finding merely because you prefer a different naming convention. If the detector uses one of the supported canonical IDs above and it routes to the correct project value, it is correct.
- If a useful semantic concept has no supported canonical ID above, canonical_id "unknown" with mapped_project_key "__prompt__" is correct. Do not invent canonical IDs like customerName, thirdPartySignature, date_signed, card_number, billing_email, notes, rentalType, or contactName.
- For card-brand rows with no visible boxes/circles, expect one option_group field, not separate checkbox fields. Only report missing checkbox fields when the original image visibly contains drawn checkbox squares/circles.
- Do not flag duplicate mapped_project_key usage when repeated fields should receive the same project value, such as cardholder/cardholder-name repeats. Report it only when the repeated mapping would visibly fill a different semantic field with the wrong value.
- A signature field may map to cardholderSignature or __prompt__ depending on whether it is clearly the primary cardholder signature. Do not flag this unless the visible output would be wrong.
- Do not require vendor/counterparty fields to be fillable by Wrapkit; if they are detected, they should be party=vendor and mapped_project_key empty or __prompt__ only when user input is truly expected.
- Prefer general fix buckets over template-specific overrides unless the form is genuinely unique.

Return strict JSON only. corrected_fields should contain your best corrected field list.
"""


@dataclass
class RenderedPage:
    page_number: int
    width_px: int
    height_px: int
    png_bytes: bytes
    image_path: Path


@dataclass
class Sample:
    sample_id: str
    pdf: Path
    expected: Path | None
    correction: Path | None
    filled_pdf: Path | None
    console_log: Path | None


class Trace:
    def __init__(self, sample_id: str, out_dir: Path) -> None:
        self.sample_id = sample_id
        self.out_dir = out_dir
        self.events: list[dict[str, Any]] = []

    def emit(self, level: str, event: str, message: str, **data: Any) -> None:
        row = {
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
            "sample": self.sample_id,
            "level": level,
            "event": event,
            "message": message,
            **data,
        }
        self.events.append(row)
        print(f"[{self.sample_id}] {level.upper()} {event}: {message}", flush=True)

    def write(self) -> None:
        ndjson = self.out_dir / "console.ndjson"
        text = self.out_dir / "console.txt"
        ndjson.write_text(
            "\n".join(json.dumps(e, ensure_ascii=False) for e in self.events) + "\n",
            encoding="utf-8",
        )
        text.write_text(
            "\n".join(
                f"{e['ts']} {e['level'].upper()} {e['event']}: {e['message']}"
                for e in self.events
            )
            + "\n",
            encoding="utf-8",
        )


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-").lower()
    return slug[:90] or "document"


def resolve_path(base: Path, value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return (base / path).resolve()


def load_manifest(path: Path) -> tuple[list[Sample], dict[str, Any]]:
    manifest = load_json(path)
    base = path.parent
    samples: list[Sample] = []
    seen: set[str] = set()
    for raw in manifest.get("samples", []):
        pdf = resolve_path(base, raw.get("pdf"))
        if not pdf:
            raise ValueError("Manifest sample missing pdf")
        sample_id = str(raw.get("id") or slugify(pdf.stem))
        if sample_id in seen:
            raise ValueError(f"Duplicate sample id: {sample_id}")
        seen.add(sample_id)
        samples.append(
            Sample(
                sample_id=sample_id,
                pdf=pdf,
                expected=resolve_path(base, raw.get("expected")),
                correction=resolve_path(base, raw.get("correction")),
                filled_pdf=resolve_path(base, raw.get("filledPdf")),
                console_log=resolve_path(base, raw.get("consoleLog")),
            )
        )
    project_profile = {
        **DEFAULT_PROJECT_PROFILE,
        **(manifest.get("projectProfile") or {}),
    }
    return samples, project_profile


def get_api_key() -> str:
    env = os.environ.get("GEMINI_API_KEY", "").strip()
    if env:
        return env
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


def call_gemini(
    api_key: str,
    *,
    system_prompt: str,
    user_prompt: str,
    pages: Iterable[RenderedPage],
    response_schema: dict[str, Any],
    max_output_tokens: int,
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
    parts.append({"text": user_prompt})
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
    with urllib.request.urlopen(request, timeout=240) as response:
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


def detection_prompt(sample: Sample, pages: list[RenderedPage]) -> str:
    page_lines = "\n".join(
        f"- Page {p.page_number}: {p.width_px}x{p.height_px}px" for p in pages
    )
    return (
        f"Document id: {sample.sample_id}\n"
        f"Filename: {sample.pdf.name}\n"
        f"Rendered pages:\n{page_lines}\n\n"
        "Detect all fillable fields. Return the schema exactly."
    )


def draw_detection_overlays(
    out_dir: Path, pages: list[RenderedPage], fields: list[dict[str, Any]]
) -> list[str]:
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
    except Exception:
        font = ImageFont.load_default()
    by_page: dict[int, list[dict[str, Any]]] = {}
    for field in fields:
        try:
            page_number = int(field.get("page_number", 1))
        except Exception:
            page_number = 1
        by_page.setdefault(page_number, []).append(field)
    paths: list[str] = []
    colors = {
        "text": (0, 122, 255),
        "multiline": (0, 122, 255),
        "checkbox": (34, 197, 94),
        "option_group": (168, 85, 247),
        "option-group": (168, 85, 247),
        "signature": (239, 68, 68),
        "date": (14, 165, 233),
    }
    for page in pages:
        image = Image.open(page.image_path).convert("RGB")
        draw = ImageDraw.Draw(image)
        for idx, field in enumerate(by_page.get(page.page_number, []), start=1):
            bbox = field.get("bbox") or []
            if len(bbox) != 4:
                continue
            y1, x1, y2, x2 = [float(v) for v in bbox]
            rect = [
                x1 / 1000 * page.width_px,
                y1 / 1000 * page.height_px,
                x2 / 1000 * page.width_px,
                y2 / 1000 * page.height_px,
            ]
            kind = str(field.get("field_kind") or field.get("field_type") or "text")
            color = colors.get(kind, (0, 122, 255))
            if field.get("party") == "vendor":
                color = (107, 114, 128)
            draw.rectangle(rect, outline=color, width=4)
            label = f"{idx}. {field.get('label', '')} [{field.get('canonical_id', '')}]"
            text_pos = (rect[0], max(0, rect[1] - 24))
            draw.rectangle(
                [text_pos[0], text_pos[1], min(page.width_px, text_pos[0] + 10 * len(label)), text_pos[1] + 22],
                fill=(255, 255, 255),
            )
            draw.text(text_pos, label[:100], fill=color, font=font)
        out = out_dir / f"detection-overlay-page-{page.page_number}.png"
        image.save(out)
        paths.append(str(out))
    return paths


def normalize_detected_fields(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for field in fields:
        out = dict(field)
        canonical = str(out.get("canonical_id") or "unknown")
        if canonical not in VALID_CANONICAL_IDS:
            canonical = "unknown"
            out["canonical_id"] = canonical
        mapped = CANONICAL_TO_PROJECT_KEY.get(canonical)
        if mapped:
            out["mapped_project_key"] = mapped
        elif out.get("party") != "vendor":
            out["mapped_project_key"] = "__prompt__"
        else:
            out["mapped_project_key"] = ""
        normalized.append(out)
    return normalized


def run_detection_qc(
    api_key: str,
    sample: Sample,
    out_dir: Path,
    original_pages: list[RenderedPage],
    detection: dict[str, Any],
    skip_gemini: bool,
) -> dict[str, Any]:
    if skip_gemini:
        return {
            "status": "skipped",
            "summary": "Gemini detection QC skipped.",
            "findings": [],
            "corrected_fields": [],
        }
    fields = detection.get("fields", [])
    prompt = (
        f"Document id: {sample.sample_id}\n"
        f"Filename: {sample.pdf.name}\n\n"
        "Detector output JSON:\n"
        f"{json.dumps({'fields': fields}, ensure_ascii=False, indent=2)}\n\n"
        "Audit the detector output against the page images. Return the schema exactly."
    )
    qc = call_gemini(
        api_key,
        system_prompt=DETECTION_QC_SYSTEM_PROMPT,
        user_prompt=prompt,
        pages=original_pages,
        response_schema=DETECTION_QC_SCHEMA,
        max_output_tokens=32768,
    )
    parsed = qc["parsed"]
    corrected = parsed.get("corrected_fields") or []
    if corrected:
        parsed["corrected_overlays"] = draw_detection_overlays(
            out_dir, original_pages, corrected
        )
    parsed["modelVersion"] = qc.get("modelVersion")
    parsed["usageMetadata"] = qc.get("usageMetadata")
    parsed["finishReasons"] = qc.get("finishReasons")
    return parsed


def normalized_bbox_iou(a: list[Any], b: list[Any]) -> float:
    if len(a) != 4 or len(b) != 4:
        return 0.0
    try:
        ay1, ax1, ay2, ax2 = [float(v) for v in a]
        by1, bx1, by2, bx2 = [float(v) for v in b]
    except Exception:
        return 0.0
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union else 0.0


def field_key(field: dict[str, Any]) -> str:
    canonical = str(field.get("canonical_id") or field.get("canonicalFieldId") or "").strip()
    label = str(field.get("label") or "").strip().lower()
    page = str(field.get("page_number") or field.get("pageNumber") or "")
    kind = str(field.get("field_kind") or field.get("fieldKind") or field.get("field_type") or field.get("fieldType") or "")
    return "|".join([page, canonical or label, kind])


def compare_expected(
    expected_doc: dict[str, Any] | None,
    correction_doc: dict[str, Any] | None,
    detected_fields: list[dict[str, Any]],
) -> dict[str, Any]:
    if correction_doc and correction_doc.get("fields"):
        expected_doc = correction_doc
    if not expected_doc:
        return {"status": "skipped", "findings": [], "summary": "No expected/correction JSON."}
    expected_fields = expected_doc.get("fields", [])
    detected_by_key = {field_key(f): f for f in detected_fields}
    expected_by_key = {field_key(f): f for f in expected_fields}
    findings: list[dict[str, Any]] = []
    for key, expected in expected_by_key.items():
        actual = detected_by_key.get(key)
        if not actual:
            findings.append(
                {
                    "severity": "high",
                    "error_type": "missing_field",
                    "fix_bucket": "detection_prompt",
                    "message": f"Expected field not detected: {key}",
                    "expected": expected,
                }
            )
            continue
        iou = normalized_bbox_iou(expected.get("bbox", []), actual.get("bbox", []))
        if expected.get("bbox") and actual.get("bbox") and iou < 0.55:
            findings.append(
                {
                    "severity": "medium",
                    "error_type": "bbox_mismatch",
                    "fix_bucket": "writer_alignment",
                    "message": f"Field {key} bbox IoU {iou:.2f} below 0.55.",
                    "expected": expected,
                    "actual": actual,
                }
            )
        for prop, bucket in [
            ("party", "party_classification"),
            ("mapped_project_key", "mapped_project_key"),
            ("canonical_id", "canonical_mapping"),
            ("field_kind", "detection_prompt"),
        ]:
            ev = expected.get(prop)
            av = actual.get(prop)
            if ev not in (None, "") and av not in (None, "") and ev != av:
                findings.append(
                    {
                        "severity": "high" if prop in {"canonical_id", "mapped_project_key"} else "medium",
                        "error_type": f"{prop}_mismatch",
                        "fix_bucket": bucket,
                        "message": f"Field {key} expected {prop}={ev!r}, got {av!r}.",
                        "expected": expected,
                        "actual": actual,
                    }
                )
    for key, actual in detected_by_key.items():
        if key not in expected_by_key:
            findings.append(
                {
                    "severity": "medium",
                    "error_type": "extra_field",
                    "fix_bucket": "detection_prompt",
                    "message": f"Detected extra field: {key}",
                    "actual": actual,
                }
            )
    return {
        "status": "pass" if not findings else "fail",
        "findings": findings,
        "summary": f"{len(findings)} expected-json finding(s).",
    }


def make_side_by_side(
    out_dir: Path, original_pages: list[RenderedPage], filled_pages: list[RenderedPage]
) -> list[str]:
    paths: list[str] = []
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
    except Exception:
        font = ImageFont.load_default()
    for orig, filled in zip(original_pages, filled_pages):
        left = Image.open(orig.image_path).convert("RGB")
        right = Image.open(filled.image_path).convert("RGB")
        width = left.width + right.width + 40
        height = max(left.height, right.height) + 46
        canvas = Image.new("RGB", (width, height), "white")
        draw = ImageDraw.Draw(canvas)
        draw.text((10, 10), "ORIGINAL", fill=(30, 30, 30), font=font)
        draw.text((left.width + 50, 10), "FILLED OUTPUT", fill=(30, 30, 30), font=font)
        canvas.paste(left, (0, 46))
        canvas.paste(right, (left.width + 40, 46))
        out = out_dir / f"side-by-side-page-{orig.page_number}.png"
        canvas.save(out)
        paths.append(str(out))
    return paths


def run_filled_qc(
    api_key: str,
    sample: Sample,
    out_dir: Path,
    project_profile: dict[str, Any],
    original_pages: list[RenderedPage],
    filled_pdf: Path,
    skip_gemini: bool,
) -> dict[str, Any]:
    filled_pages = render_pdf(filled_pdf, out_dir, "filled")
    side_by_side = make_side_by_side(out_dir, original_pages, filled_pages)
    if skip_gemini:
        return {
            "status": "skipped",
            "summary": "Gemini QC skipped.",
            "artifacts": {"side_by_side": side_by_side},
            "findings": [],
        }
    parts_order = "\n".join(
        f"- Page {p.page_number}: original image then filled image" for p in original_pages
    )
    prompt = (
        f"Document id: {sample.sample_id}\n"
        f"Original: {sample.pdf.name}\n"
        f"Filled: {filled_pdf.name}\n\n"
        f"Image order:\n{parts_order}\n\n"
        f"Project profile:\n{json.dumps(project_profile, ensure_ascii=False, indent=2)}\n\n"
        "Evaluate the filled output. Return the JSON schema exactly."
    )
    pages: list[RenderedPage] = []
    for orig, filled in zip(original_pages, filled_pages):
        pages.extend([orig, filled])
    qc = call_gemini(
        api_key,
        system_prompt=FILLED_QC_SYSTEM_PROMPT,
        user_prompt=prompt,
        pages=pages,
        response_schema=FILLED_QC_SCHEMA,
        max_output_tokens=16384,
    )
    parsed = qc["parsed"]
    parsed["artifacts"] = {"side_by_side": side_by_side}
    parsed["modelVersion"] = qc.get("modelVersion")
    parsed["usageMetadata"] = qc.get("usageMetadata")
    return parsed


def copy_optional_artifact(source: Path | None, target: Path, trace: Trace, event: str) -> str | None:
    if not source:
        return None
    if not source.exists():
        trace.emit("warn", event, f"Configured artifact does not exist: {source}")
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    trace.emit("info", event, f"Copied artifact: {source.name}", path=str(target))
    return str(target)


def run_sample(
    sample: Sample,
    run_dir: Path,
    project_profile: dict[str, Any],
    api_key: str | None,
    skip_gemini: bool,
) -> dict[str, Any]:
    sample_dir = run_dir / sample.sample_id
    sample_dir.mkdir(parents=True, exist_ok=True)
    trace = Trace(sample.sample_id, sample_dir)
    started = time.time()
    trace.emit("info", "start", f"Processing {sample.pdf}")
    copied_console = copy_optional_artifact(
        sample.console_log, sample_dir / "app-console-source.log", trace, "console_ingest"
    )
    if not sample.pdf.exists():
        trace.emit("error", "missing_pdf", f"PDF does not exist: {sample.pdf}")
        trace.write()
        return {
            "id": sample.sample_id,
            "pdf": str(sample.pdf),
            "status": "error",
            "error": "missing_pdf",
            "console": {"captured": str(sample_dir / "console.ndjson"), "source": copied_console},
        }

    original_pages = render_pdf(sample.pdf, sample_dir, "original")
    trace.emit("info", "render", f"Rendered {len(original_pages)} page(s).")

    detection: dict[str, Any] = {
        "status": "skipped",
        "fields": [],
        "summary": "Gemini detection skipped.",
    }
    if not skip_gemini and api_key:
        trace.emit("info", "gemini_detection", f"Calling {MODEL} for field detection.")
        gemini = call_gemini(
            api_key,
            system_prompt=DETECTION_SYSTEM_PROMPT,
            user_prompt=detection_prompt(sample, original_pages),
            pages=original_pages,
            response_schema=DETECTION_SCHEMA,
            max_output_tokens=32768,
        )
        fields = normalize_detected_fields(gemini.get("parsed", {}).get("fields", []))
        overlays = draw_detection_overlays(sample_dir, original_pages, fields)
        detection = {
            "status": "complete",
            "model": MODEL,
            "modelVersion": gemini.get("modelVersion"),
            "finishReasons": gemini.get("finishReasons"),
            "usageMetadata": gemini.get("usageMetadata"),
            "fields": fields,
            "field_count": len(fields),
            "notes": gemini.get("parsed", {}).get("notes", ""),
            "overlays": overlays,
        }
        trace.emit("info", "gemini_detection", f"Detected {len(fields)} field(s).")
    write_json(sample_dir / "detection.json", detection)

    detection_qc: dict[str, Any] = {
        "status": "skipped",
        "findings": [],
        "summary": "Detection QC skipped because detection did not run.",
    }
    if detection.get("status") == "complete" and api_key:
        trace.emit("info", "detection_qc", "Auditing detected fields against original PDF.")
        detection_qc = run_detection_qc(
            api_key,
            sample,
            sample_dir,
            original_pages,
            detection,
            skip_gemini,
        )
        trace.emit(
            "info",
            "detection_qc",
            f"{detection_qc.get('document_verdict', detection_qc.get('status', 'unknown'))}: {len(detection_qc.get('findings', []))} finding(s).",
        )
    write_json(sample_dir / "detection-qc.json", detection_qc)

    expected_doc = load_json(sample.expected) if sample.expected and sample.expected.exists() else None
    correction_doc = (
        load_json(sample.correction) if sample.correction and sample.correction.exists() else None
    )
    expected_diff = compare_expected(expected_doc, correction_doc, detection.get("fields", []))
    write_json(sample_dir / "expected-diff.json", expected_diff)
    trace.emit("info", "expected_compare", expected_diff["summary"])

    filled_qc: dict[str, Any] = {"status": "skipped", "findings": [], "summary": "No filledPdf configured."}
    copied_filled = copy_optional_artifact(
        sample.filled_pdf, sample_dir / "filled-source.pdf", trace, "filled_pdf_ingest"
    )
    if sample.filled_pdf and sample.filled_pdf.exists():
        trace.emit("info", "filled_qc", "Evaluating filled PDF output.")
        filled_qc = run_filled_qc(
            api_key or "",
            sample,
            sample_dir,
            project_profile,
            original_pages,
            sample.filled_pdf,
            skip_gemini or not api_key,
        )
        write_json(sample_dir / "filled-qc.json", filled_qc)
        trace.emit(
            "info",
            "filled_qc",
            f"{filled_qc.get('document_verdict', filled_qc.get('status', 'unknown'))}: {len(filled_qc.get('findings', []))} finding(s).",
        )

    trace.emit("info", "done", f"Finished in {time.time() - started:.1f}s.")
    trace.write()
    result = {
        "id": sample.sample_id,
        "pdf": str(sample.pdf),
        "status": "complete",
        "duration_sec": round(time.time() - started, 2),
        "detection": {
            "status": detection.get("status"),
            "field_count": len(detection.get("fields", [])),
            "path": str(sample_dir / "detection.json"),
            "overlays": detection.get("overlays", []),
        },
        "detection_qc": {
            "status": detection_qc.get("document_verdict", detection_qc.get("status")),
            "score": detection_qc.get("detection_score"),
            "findings": len(detection_qc.get("findings", [])),
            "path": str(sample_dir / "detection-qc.json"),
            "corrected_overlays": detection_qc.get("corrected_overlays", []),
        },
        "expected": {
            "status": expected_diff.get("status"),
            "findings": len(expected_diff.get("findings", [])),
            "path": str(sample_dir / "expected-diff.json"),
        },
        "filled_qc": {
            "status": filled_qc.get("document_verdict", filled_qc.get("status")),
            "semantic_score": filled_qc.get("semantic_score"),
            "geometry_score": filled_qc.get("geometry_score"),
            "findings": len(filled_qc.get("findings", [])),
            "path": str(sample_dir / "filled-qc.json") if sample.filled_pdf else None,
        },
        "console": {
            "captured": str(sample_dir / "console.ndjson"),
            "text": str(sample_dir / "console.txt"),
            "source": copied_console,
        },
        "artifacts": {
            "dir": str(sample_dir),
            "filled_source": copied_filled,
        },
    }
    write_json(sample_dir / "result.json", result)
    return result


def collect_findings(run_dir: Path, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    all_findings: list[dict[str, Any]] = []
    for result in results:
        sample_dir = run_dir / result["id"]
        for filename, source in [
            ("detection-qc.json", "detection_qc"),
            ("expected-diff.json", "expected"),
            ("filled-qc.json", "filled_qc"),
        ]:
            path = sample_dir / filename
            if not path.exists():
                continue
            doc = load_json(path)
            for finding in doc.get("findings", []):
                all_findings.append(
                    {
                        "sample": result["id"],
                        "source": source,
                        "severity": finding.get("severity", "low"),
                        "error_type": finding.get("error_type", "unclear"),
                        "fix_bucket": finding.get("fix_bucket", "manual_review"),
                        "message": finding.get("message", ""),
                        "artifact_dir": str(sample_dir),
                    }
                )
    return all_findings


def write_report(run_dir: Path, results: list[dict[str, Any]]) -> int:
    findings = collect_findings(run_dir, results)
    by_bucket: dict[str, int] = {}
    by_type: dict[str, int] = {}
    severe = 0
    for finding in findings:
        bucket = str(finding.get("fix_bucket") or "manual_review")
        typ = str(finding.get("error_type") or "unclear")
        by_bucket[bucket] = by_bucket.get(bucket, 0) + 1
        by_type[typ] = by_type.get(typ, 0) + 1
        if finding.get("severity") in {"critical", "high"}:
            severe += 1

    lines = [
        "# PDF Form Accuracy Evaluation",
        "",
        f"Generated: {dt.datetime.now().isoformat(timespec='seconds')}",
        f"Run directory: `{run_dir}`",
        "",
        "## Batch Summary",
        "",
        f"- Samples: {len(results)}",
        f"- Total findings: {len(findings)}",
        f"- Critical/high findings: {severe}",
        f"- Pass gate: {'PASS' if not findings else 'FAIL'}",
        "",
        "## Findings By Fix Bucket",
        "",
    ]
    if by_bucket:
        for key, count in sorted(by_bucket.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"- `{key}`: {count}")
    else:
        lines.append("- none")
    lines.extend(["", "## Findings By Type", ""])
    if by_type:
        for key, count in sorted(by_type.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"- `{key}`: {count}")
    else:
        lines.append("- none")
    lines.extend(["", "## Samples", ""])
    for result in results:
        lines.append(f"### {result['id']}")
        lines.append("")
        lines.append(f"- Status: `{result.get('status')}`")
        lines.append(f"- PDF: `{result.get('pdf')}`")
        lines.append(f"- Fields: `{result.get('detection', {}).get('field_count')}`")
        lines.append(
            f"- Detection QC: `{result.get('detection_qc', {}).get('status')}` "
            f"(score `{result.get('detection_qc', {}).get('score')}`, "
            f"{result.get('detection_qc', {}).get('findings')} finding(s))"
        )
        lines.append(
            f"- Expected diff: `{result.get('expected', {}).get('status')}` ({result.get('expected', {}).get('findings')} finding(s))"
        )
        lines.append(
            f"- Filled QC: `{result.get('filled_qc', {}).get('status')}` ({result.get('filled_qc', {}).get('findings')} finding(s))"
        )
        lines.append(f"- Console trace: `{result.get('console', {}).get('text')}`")
        lines.append(f"- Artifacts: `{result.get('artifacts', {}).get('dir')}`")
        lines.append("")
    if findings:
        lines.extend(["## Finding Details", ""])
        for finding in findings:
            lines.append(
                f"- `{finding['sample']}` / `{finding['severity']}` / `{finding['fix_bucket']}`: {finding['message']} (`{finding['artifact_dir']}`)"
            )
    write_json(run_dir / "all-results.json", results)
    write_json(run_dir / "all-findings.json", findings)
    (run_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    latest = DEFAULT_RUNS_DIR / "latest"
    if latest.exists() or latest.is_symlink():
        latest.unlink()
    try:
        latest.symlink_to(run_dir, target_is_directory=True)
    except OSError:
        pass
    print(f"\nWrote {run_dir / 'report.md'}")
    return 0 if not findings and all(r.get("status") == "complete" for r in results) else 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--runs-dir", type=Path, default=DEFAULT_RUNS_DIR)
    parser.add_argument("--sample", action="append", help="Run only this sample id. May be repeated.")
    parser.add_argument("--limit", type=int, default=0, help="Limit sample count after filtering.")
    parser.add_argument("--skip-gemini", action="store_true", help="Render/copy/compare only; do not call Gemini.")
    parser.add_argument("--run-id", default="", help="Override timestamped run id.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = args.manifest.resolve()
    samples, project_profile = load_manifest(manifest)
    if args.sample:
        wanted = set(args.sample)
        samples = [s for s in samples if s.sample_id in wanted]
    if args.limit:
        samples = samples[: args.limit]
    run_id = args.run_id or dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = args.runs_dir.resolve() / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    write_json(
        run_dir / "run-config.json",
        {
            "manifest": str(manifest),
            "model": MODEL,
            "skip_gemini": args.skip_gemini,
            "samples": [s.sample_id for s in samples],
            "projectProfile": project_profile,
        },
    )
    if not samples:
        print(f"No samples configured in {manifest}.")
        write_json(run_dir / "all-results.json", [])
        (run_dir / "report.md").write_text(
            "# PDF Form Accuracy Evaluation\n\nNo samples configured.\n",
            encoding="utf-8",
        )
        return 0
    api_key = None if args.skip_gemini else get_api_key()
    results: list[dict[str, Any]] = []
    for index, sample in enumerate(samples, start=1):
        print(f"\n[{index}/{len(samples)}] {sample.sample_id}", flush=True)
        try:
            results.append(run_sample(sample, run_dir, project_profile, api_key, args.skip_gemini))
        except urllib.error.HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")
            results.append(
                {
                    "id": sample.sample_id,
                    "pdf": str(sample.pdf),
                    "status": "error",
                    "error": f"HTTP {err.code}: {body[:1200]}",
                }
            )
            print(f"ERROR {sample.sample_id}: HTTP {err.code}: {body[:1200]}", file=sys.stderr)
        except Exception as err:
            results.append(
                {
                    "id": sample.sample_id,
                    "pdf": str(sample.pdf),
                    "status": "error",
                    "error": f"{type(err).__name__}: {err}",
                }
            )
            print(f"ERROR {sample.sample_id}: {type(err).__name__}: {err}", file=sys.stderr)
    return write_report(run_dir, results)


if __name__ == "__main__":
    raise SystemExit(main())
