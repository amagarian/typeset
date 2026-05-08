# Typeset

Desktop app for film and production: auto-fill production PDFs using project-level source data and **Google Gemini** for first-time field detection. Once a form is reviewed, the local template fingerprint match short-circuits future drops — no Gemini call required.

## Tech stack

- **Tauri 2** — desktop shell (Rust backend, system keychain, tray)
- **React 18** + **TypeScript** — UI
- **Vite** — build / dev server
- **Google Gemini 2.5 Pro** (default) / **Flash** — single-pass field detection via `:streamGenerateContent` with native multimodal PDF input and `responseSchema`-constrained JSON output
- **pdf-lib** + **pdfjs-dist** — PDF rendering / writing / page sizing
- **CSS Modules** — styling (grayscale, minimal)

## Getting started

```bash
cd typeset
npm install
npm run tauri dev
```

On first launch, click the gear icon at the bottom of the sidebar to open Settings. Paste your Gemini API key (get one at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)). It's stored in your OS keychain via the `keyring` crate — never written to disk in plain text. Pick a model and hit **Test connection**.

For a web-only preview (no Tauri, no Gemini):

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
   ├── match in templateCache (≥0.92) → pdfWriter.fill (no Gemini call)
   └── no match
        ↓
       geminiFieldDetector (renderer)
        ↓
       Tauri command: gemini_detect_fields
        ↓
       src-tauri/gemini.rs  →  generativelanguage.googleapis.com
        ↑
       src-tauri/keychain.rs (OS keychain via `keyring`)
        ↓
       TemplateReviewModal (user confirms → local-verified)
```

The renderer never holds the API key. All Gemini traffic is proxied through Rust. The PDF is base64-inlined in the request body — no separate upload step, no Python sandbox, no agentic tool loop. Native multimodal PDF understanding does the heavy lifting in a single round-trip, which is why end-to-end detection lands at 20-30s on Pro / 10-15s on Flash.

## Project structure

```
typeset/
├── src/
│   ├── types/           # Project, Template, TemplateField, PdfMatchResult
│   ├── data/            # mockProjects, mockTemplates (seeded fallback data)
│   ├── services/
│   │   ├── geminiClient.ts        # Tauri invoke wrapper + error types
│   │   ├── geminiSettings.ts      # model preference (localStorage)
│   │   └── templateCache.ts       # local-only template store
│   ├── utils/
│   │   ├── geminiFieldDetector.ts # detect + extractProject from PDF
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
│   │   └── gemini.rs         # streamGenerateContent + connection test
│   └── tauri.conf.json
└── vite.config.ts
```

## Data flow

- **First time you drop a form**: Gemini is called once. The user reviews detected fields in the Template Review modal, hits Save, and the template is stored locally.
- **Every time after that**: a fingerprint match against your local templates short-circuits the API call entirely. Repeat drops fill deterministically with `pdf-lib`.

## Branches

- `main` — last Claude-backed build (v0.3.22) plus the WIP public-template-registry workstream that was paused for the Gemini exploration. Preserved as an archive.
- `gemini` (this branch) — current build, Gemini-only.
