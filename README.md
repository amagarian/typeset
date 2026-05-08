# Typeset

Desktop app for film and production: auto-fill production PDFs using project-level source data and Anthropic Claude for first-time field detection. Once a form is reviewed, the local template fingerprint match short-circuits future drops — no Claude call required.

## Tech stack

- **Tauri 2** — desktop shell (Rust backend, system keychain, tray)
- **React 18** + **TypeScript** — UI
- **Vite** — build / dev server
- **Anthropic Claude** (Opus 4.7 default, Sonnet 4.6 alternate) — single-pass field detection via the Messages API with PDF document blocks
- **pdf-lib** + **pdfjs-dist** — PDF rendering / writing / page sizing
- **CSS Modules** — styling (grayscale, minimal)

## Getting started

```bash
cd typeset
npm install
npm run tauri dev
```

On first launch, click the gear icon at the bottom of the sidebar to open Settings. Paste your Anthropic API key (it's stored in your OS keychain via the `keyring` crate — never written to disk in plain text), pick a model, and hit Test connection.

For a web-only preview (no Tauri, no Claude):

```bash
npm run dev
```

Then open http://localhost:5173.

## Architecture

```
PDF dropped
   ↓
templateFingerprint (local hash)
   ↓
   ├── match in templateCache (≥0.92) → pdfWriter.fill (no Claude)
   └── no match
        ↓
       claudeFieldDetector (renderer)
        ↓
       Tauri command: analyze_pdf_with_claude
        ↓
       src-tauri/anthropic.rs  →  api.anthropic.com
        ↑
       src-tauri/keychain.rs (OS keychain via `keyring`)
        ↓
       TemplateReviewModal (user confirms → local-verified)
```

The renderer never holds the API key. All Anthropic traffic is proxied through Rust.

## Project structure

```
typeset/
├── src/
│   ├── types/           # Project, Template, TemplateField, PdfMatchResult
│   ├── data/            # mockProjects, mockTemplates (seeded fallback data)
│   ├── services/
│   │   ├── claudeClient.ts        # Tauri invoke wrapper + error types
│   │   ├── anthropicSettings.ts   # model preference (localStorage)
│   │   └── templateCache.ts       # local-only template store
│   ├── utils/
│   │   ├── claudeFieldDetector.ts # detect + extractProject from PDF
│   │   ├── templateFingerprint.ts # token + page-size hash matching
│   │   ├── fieldCatalog.ts
│   │   ├── fill.ts
│   │   ├── pdfWriter.ts
│   │   ├── exportPdf.ts
│   │   └── trayManager.ts
│   ├── components/
│   │   ├── AppShell/
│   │   ├── Sidebar/
│   │   ├── ProjectList/
│   │   ├── ProjectWorkspace/
│   │   ├── ProjectDetailForm/
│   │   ├── NewProjectView/
│   │   ├── PdfDropzone/
│   │   ├── MatchStatusModal/
│   │   ├── SettingsModal/
│   │   └── TemplateReviewModal/
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # command registration
│   │   ├── keychain.rs       # OS keychain CRUD
│   │   └── anthropic.rs      # Messages API + connection test
│   └── tauri.conf.json
└── vite.config.ts
```

## Data flow

- **First time you drop a form**: Claude is called once. The user reviews detected fields in the Template Review modal, hits Save, and the template is stored locally.
- **Every time after that**: a fingerprint match against your local templates short-circuits the API call entirely. Repeat drops fill deterministically with `pdf-lib`.
