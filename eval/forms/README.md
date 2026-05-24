# PDF Form Accuracy Evaluation

This folder defines the local benchmark corpus for Wrapkit PDF field accuracy.
The runner writes large artifacts under `runs/`, which is intentionally ignored.

## Manifest

Create or edit `manifest.json` with samples like:

```json
{
  "samples": [
    {
      "id": "cc-auth-usd",
      "pdf": "/absolute/path/to/CC Auth Form USD.pdf",
      "expected": "expected/cc-auth-usd.json",
      "correction": "corrections/cc-auth-usd.json",
      "filledPdf": "/absolute/path/to/CC Auth Form USD - FILLED.pdf",
      "consoleLog": "/absolute/path/to/app-console.log"
    }
  ]
}
```

Only `id` and `pdf` are required. Optional fields:

- `expected`: durable reviewed field truth for strict JSON comparison.
- `correction`: human-reviewed overrides promoted from failures.
- `filledPdf`: app-produced filled output for visual/semantic QC.
- `consoleLog`: copied into the run so app console decisions are reviewed beside the PDF artifacts.

## Commands

```bash
npm run eval:forms
npm run eval:forms -- --manifest eval/forms/manifest.example.json --limit 3 --skip-gemini
npm run eval:forms:loop -- --interval 300
```

The runner stores each run under `eval/forms/runs/<timestamp>/`.
