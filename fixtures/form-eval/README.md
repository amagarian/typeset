# Form evaluation fixtures

Use this folder for local feedback-loop data. Real PDFs and filled PDFs can be
large or sensitive, so keep them local unless the team intentionally adds them
through Git LFS or a private fixture store.

## Case layout

Each manifest case points at:

- `pdf`: source form PDF to detect.
- `expectedTemplate`: reviewed, correct template JSON. This is the ground truth.
- `predictedTemplate`: optional fixture prediction for offline scorer tests.
- `consoleLog`: optional app/provider console output captured during processing.
- `filledPdf`: optional filled result PDF for traceability.

Run the included fixture example:

```bash
npm run eval:forms:sample
```

Run real PDFs through Gemini:

```bash
GEMINI_API_KEY=... npm run eval:forms -- \
  --manifest fixtures/form-eval/manifest.json \
  --provider gemini \
  --threshold 1 \
  --repeat 0
```

The command writes per-case predictions, accuracy reports, provider responses,
and an `improvement-brief.md` under `.eval/form-feedback`.
