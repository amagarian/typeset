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

## Pending: corpus-wide analysis (32 forms)

Worker analyzing
`/Users/aidenmagarian/TYPEFACE Dropbox/Aiden Magarian/_AI DOCUMENTS/Archive.zip`
(22 rental agreements + 10 credit card auths). Output will be written to
`/tmp/typeset-corpus-analysis.md` and the high-level findings will be appended to
this doc once it returns.

Specifically looking for:

- Layout patterns the current detector likely fails on (boxed fields, tables,
  multi-page, multi-line text areas, repeated row groups, initial boxes,
  date ranges, conditional sections, single-shared underlines)
- New canonical field categories (Tax ID, EIN, driver's license, insurance,
  bank info, daily/hourly rates, deposits, rental periods, job/PO numbers, etc.)
- AcroForm presence (high-value: skip Gemini for forms with native fields)
- Predicted failure modes per form
- Project schema additions to support the new canonicals
- High-value architectural shifts (multi-page orchestration, table extraction,
  section-aware detection, AcroForm-first pipeline)

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
