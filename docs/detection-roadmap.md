# Typeset detection roadmap

Living scope doc for field-detection improvements. Captures shipped state, the
v0.5.38 backlog, and analysis findings that inform future releases.

## Shipped (current channel: v0.5.37)

- Magic-link email auth + Sign in with Apple (Supabase OAuth via `tauri-plugin-shell`)
- End-to-end encrypted project sync (per-account AES-GCM key, Supabase backend)
- Encrypted local project persistence with autosave (AES-256-GCM, key in macOS Keychain)
- Empty-state pulse on `+ New project` button
- `option-group` field type with X-on-blank rendering for per-option underline selectors
- `shootDate` canonical with explicit date-disambiguation prompt rule
- Hardcoded Gemini API key + locked to Gemini 2.5 Flash Lite + locked to Fast accuracy
  (zero-config beta distribution)
- Vertical underline snap with text-row baseline fallback
- Horizontal underline snap with overlap-aware cap relaxation
- Template registry (Supabase) with anonymous device IDs and account migration

## v0.5.38 backlog

User-requested for the next batch:

1. **Signature image upload** — replace the typed/Caveat signature with an uploaded
   PNG/SVG. Should still autosize to the signature field's bbox.
2. **Explicit Save button** on the job edit page (bottom-left). Even with autosave
   running, users want a "queue out of this page" affordance. Should snap to the
   last autosave state (no-op if nothing pending) and show a brief "Saved ✓" pulse.
3. **Multi-page PDF support** — detect, render, and fill across all pages. Current
   pipeline operates on page 1 only. The 204 form (single page) hides this; rental
   agreements span 3-10+ pages.
4. **Boxed-field detection** — recognize labels embedded inside a bordered box where
   the writable area is to the right of the label, both inside the same box. Pattern
   currently fails: detector places bbox below the label or sized to the entire box.
5. **`Tel` / `Tel.` / `Telephone` aliases** for the `phone` canonical. Currently no
   alias match → falls back to Gemini semantic, which is unreliable.
6. **Bare `Name` / `Name:` should not auto-map to `creditCardHolder`** — current
   `inferByLabel` (`geminiFieldDetector.ts:1247-1253`) catches every officer Name
   field on the 204 form. Tighten the alias to require contextual qualifier
   (`Cardholder Name`, `Card Holder Name`, etc.) and let unqualified `Name` fall
   through to Gemini semantic.

## 204 form analysis (worker brief, May 10 2026)

- **Single page**, Sections 1-3.
- **Boxed grid pattern**: `[Production Company  ___]`, `[Producer  ___]`, etc.
  Repeats inside the "BASIC INFORMATION" section. Detector emits the bbox under
  the label rather than to the right.
- **Repeated Name/Title/Tel/Email rows** for officers (Section 1) and contacts
  (Section 1). Real repeats — not false-positive duplicates. Spatial dedup at
  12pt overlap (`geminiFieldDetector.ts:2253-2266`) correctly leaves them.
- **`inferByLabel` false positive**: bare `Name` / `Name:` maps to
  `creditCardHolder` for every officer/contact row. Fix: require qualifier
  ("Cardholder", "Print", "Authorized") in the matched label text before
  promoting to `creditCardHolder`.
- **No `Tel`/`Tel.` alias** for `phone` canonical → all `Tel:` fields rely on
  Gemini semantic, which the model gets wrong intermittently.
- **AcroForm presence not yet verified** for this PDF — `pdfinfo` did not run
  cleanly during analysis. Verify with `pdfinfo /path/to/204.pdf | grep Form`.
- **Optional**: many existing canonicals (`Federal ID`, `DUNS Number`,
  `Type of Organization`) are recognized correctly — the issues are concentrated
  in the boxed-grid layout and the bare-Name alias.

## Corpus analysis (32 forms — May 10 2026)

Full report: `/tmp/typeset-corpus-analysis.md` (~23k chars, tables, AcroForm
field names, per-form failure notes, implementation sketches). High-level
findings consolidated below.

### Inventory headlines

- **31 PDFs + 1 .docx**
- **8 PDFs have native AcroForm fields** (authoritative via `pdf-lib`):
  - `credit card auths/204 Credit Card Authorization Form 2019.pdf` — 26 fields
  - `credit card auths/BLP_CC_auth_InteractForm1.pdf` — 9 fields (`Text1`–`Text9`,
    no semantic names)
  - `credit card auths/MILK CC Auth Form BLANK.pdf` — 17 fields
  - `rental agreements/204 New Account Form 2018.pdf` — 48 fields
  - `rental agreements/###Camtec Account Set-Up__2025-01.pdf` — 52 fields
  - `rental agreements/ISS Deposit COD Account Agreement Form.pdf` — 49 fields
  - `rental agreements/ISS PO Account Agreement Form.pdf` — 68 fields
  - `rental agreements/Studio Contract Hollywood.pdf` — 58 fields
- **19 multi-page PDFs**, longest at 12 pages (`RENTAL AGREEMENT_2023.pdf`),
  8 pages (`Camtec`, `Rental Agreement_aiden`), 6 pages (`SYNCRentalPaperwork`)
- Visual-only PDFs (no AcroForm) dominate the long rental-agreement set

### Top architectural shifts (must-have)

1. **AcroForm-first ingestion pipeline.** When `pdf-lib` reports interactive
   widgets, map them directly to `TemplateField` and skip Gemini for those pages.
   Hybrid: Gemini still runs on AcroForm-empty pages of partial-coverage forms.
   Marks `detectionSource: 'acroform'` in templates.
2. **Multi-page orchestration with section-aware merging.** Per-page detection
   budgets, page-local rendering, global dedup that respects section IDs (so
   officer Name on page 1 doesn't collide with cardholder Name on page 3).
3. **Table / line-item extraction stage** (optional second pass). Equipment +
   rate grids on HydroFlex, PSIS, Studio Contract, Daily Rental, Production
   Agreement won't be solved by prompt tweaks alone.

### P0 items (corpus quality unblockers)

1. **AcroForm-first ingestion** for the 8 interactive PDFs (paths above)
2. **Fix `inferByLabel` bare `Name` → `creditCardHolder` hijack** using section
   cues or negating patterns (`officer`, `title`, `president`, `authorized signer`).
   Driven by: 204 New Account, ISS, Camtec.
3. **Add `tel` / `tel.` / `telephone` aliases** to `phone` canonical
4. **Multi-page reliability**: per-page field budget + merge pass that rejects
   duplicate labels across pages unless explicitly allowed. Driven by:
   `RENTAL AGREEMENT_2023.pdf` (12p), Camtec (8p), SYNCRental (6p).
5. **Template fingerprint for alias-less AcroForm** (BLP `Text1`-`Text9`):
   store coordinate + page + neighbor label OCR in template registry so users
   don't re-map every time.

### P1 (post-P0 polish)

- **Dual CC blocks** (Camtec, MILK) with group IDs / suffixes
- **Initial field detector**: short square bbox clusters after clause numbers
  → `clauseInitials` prompt fields (Studio Contract, long rentals)
- **Rate + hour row pairing** near `Rate`/`Hr` tokens (Studio Contract)
- **Single-shared-stroke option-groups** (Arrow CC card-type row): detect
  one stroke spanning all labels, draw underline tick at computed offset

### P2 (future)

- Full table extraction pipeline (equipment rows) as second model pass with
  JSON schema
- Section-aware canonical resolution (cluster on bold ALL-CAPS lines to
  partition `inferByLabel` scope)
- Workflow flags UI: parse "initial each page", "wet ink", "notarize" from
  text layer

### New canonical fields proposed (~22)

Highlights — full list in `/tmp/typeset-corpus-analysis.md` §3:

| Canonical | Aliases | Source | Auto/Prompt |
|---|---|---|---|
| `federalTaxId` | Federal ID, Tax ID, EIN, FEIN | 204 New Account, Rental Agreement Jan 25 2021 | Both |
| `dunsNumber` | DUNS, D.U.N.S. | 204 New Account | Prompt |
| `dbaName` | DBA, d/b/a | ISS Deposit/PO | Both |
| `authorizedSignerName` | Name (officer) — must NOT map to `creditCardHolder` | 204 New Account, ISS, Camtec | Both |
| `authorizedSignerTitle` | Title (officer) | 204 New Account, Studio | Both |
| `bankName` / `bankRoutingNumber` / `bankAccountNumber` | Routing, ABA, Account # | ISS PO, FS Rental, RA Onelight | Prompt + encrypt |
| `fedExAccountNumber` / `upsAccountNumber` | FedEx #, UPS # | ISS Acro | Prompt |
| `rentalStartDate` / `rentalEndDate` | Start, End, Pickup, Return | Studio, all rentals | Both |
| `hourlyRateBuild` / `hourlyRateShoot` / `hoursBuild` / `hoursShoot` | Build Rate, Shoot Rate, Build Hr, Shoot Hr | Studio Contract | Prompt |
| `driverLicenseNumber` / `vehicleVin` / `vehiclePlate` | DL #, VIN, Plate | Omega Application Credit, FNJ Studios, PSIS DOT | Prompt |
| `insuranceCarrier` / `insurancePolicyNumber` | Insurance, Policy # | Omega, PSIS | Prompt |
| `invoiceNumber` | Invoice # | 204 CC Auth Acro | Prompt |
| `accountingContactName` / `accountingEmail` | Accounting Contact | Camtec | Both |
| `clauseInitials` | (per-section initial boxes) | Long rentals, Studio | Prompt + special render |

### `Project` schema additions (TypeScript sketch)

Full sketch in corpus report §6. Highlights:

```ts
// Encrypt bank/SSN/account fields at rest (mirror credit card handling)
federalTaxId?: string;
dunsNumber?: string;
dbaName?: string;
authorizedSignerName?: string;
authorizedSignerTitle?: string;
bankName?: string;
bankRoutingNumber?: string;
bankAccountNumber?: string;
fedExAccountNumber?: string;
upsAccountNumber?: string;
rentalStartDate?: string;
rentalEndDate?: string;
hourlyRateBuild?: string;
hourlyRateShoot?: string;
driverLicenseNumber?: string;
vehicleVin?: string;
vehiclePlate?: string;
insuranceCarrier?: string;
insurancePolicyNumber?: string;
invoiceNumber?: string;
// Consider contacts: Array<{ role; name; phone; email }> for ISS/Camtec
// repeated contact rows instead of unbounded `*Name_2` fields.
```

### Key risks (corpus-driven)

- AcroForm pages may omit visual-only annex pages → hybrid pipeline + UI
  warning when page count > AcroForm coverage
- Aggressive `Name` disambiguation may hurt true cardholder blanks → gate
  negation on proximity to payment section headers OR AcroForm field names
- Table extraction stage risks over-segmentation → keep user review UI for
  manual merge
- New Project PII fields (bank, SSN, DL) widen attack surface → keep
  encryption + opt-in "sensitive data" expander
- Per-page Gemini cost on 12p forms could spike usage → page cap or
  template-fingerprint cache priority

### Suggested release sequencing (informed by corpus)

- **v0.5.38**: P0 user-requested items (signature upload, save button) +
  P0 detection items 2 + 3 (Name disambiguation, Tel alias) — small,
  surgical fixes that unlock the 204 form
- **v0.5.39**: P0 architectural shift 1 (AcroForm-first pipeline) —
  unlocks 8 of the most complex forms
- **v0.6.0**: P0 architectural shift 2 (multi-page orchestration) —
  unlocks 19 of the longest forms
- **v0.6.x**: Tables, initials, dual-CC blocks, single-shared-stroke
  option-groups, section-aware canonical resolution

Per-version scope and exact ordering subject to user direction.

## Cross-cutting risks

- Tightening the `Name` alias may regress simple CC auth forms where bare
  `Name` correctly means `creditCardHolder`. Mitigate: require qualifier OR
  require detection of a credit card section header within ~80pt above.
- Multi-page support changes coordinate handling (`pageNumber` was already
  clamped in v0.5.22; verify the clamp doesn't fight the new pipeline).
- AcroForm-first detection can produce a different visual experience than
  Gemini detection — users who learned the manual-tweak workflow may be
  confused by zero-touch fills. Surface "this form had native fields,
  skipped AI detection" in the UI.
- Hardcoded API key billing exposure (v0.5.37): set Gemini quota cap in
  Google Cloud Console before the DMG circulates publicly.

## Release strategy

Per user direction (May 9 2026): commit each fix with `vX.Y.Z:` prefix to the
`gemini` branch. Run `bash scripts/release.sh` only when a meaningful batch is
ready — do not auto-release on every commit. Versions currently shipped via
GitHub Releases get picked up by the Tauri auto-updater on user app launch.
