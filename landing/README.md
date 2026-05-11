# Typeset landing page

Static, single-file landing page for [mytypeset.com](https://mytypeset.com).

## Files

- `index.html` — entire page, inline CSS, no build step
- `icon.png` — app icon (copied from `src-tauri/icons/128x128@2x.png`)

## Local preview

```bash
cd landing
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy

Any static host works — point `mytypeset.com` at it.

- **Vercel / Netlify / Cloudflare Pages** — set this folder as the project root, no build command, output dir `.`
- **GitHub Pages** — push `landing/` contents to a `gh-pages` branch (or use the repo's `/docs` setting)
- **S3 + CloudFront** — upload `index.html` and `icon.png` to the bucket root

## How the download works

The button points at GitHub Releases' stable "latest" URL:

```
https://github.com/amagarian/typeset/releases/latest/download/Typeset.dmg
```

GitHub redirects this to whatever the most recent tagged release's `Typeset.dmg` asset is, so the link **never needs to change** — `scripts/release.sh` already uploads `Typeset.dmg` to a fresh tag on every release.

A tiny inline `<script>` fetches `api.github.com/repos/amagarian/typeset/releases/latest` and swaps the placeholder version text under the button for the live tag (e.g. `v0.5.15`). It fails silently if the API is unreachable — the download itself doesn't depend on it.

## Things to update before going live

1. **Contact email** in the footer (`hello@mytypeset.com`) — update or remove
2. **OG image** — currently reuses `icon.png`. Replace with a wider 1200×630 social card if you want richer link previews
