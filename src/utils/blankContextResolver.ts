/**
 * Pair geometric blank candidates with their surrounding text context
 * (v0.4.13 Precision mode).
 *
 * Each `BlankCandidate` gets:
 *   - `contextBefore` — text on the same row, immediately to the LEFT.
 *   - `contextAfter`  — text on the same row, immediately to the RIGHT.
 *   - `paragraph`     — wider context (~6 lines around the blank).
 *   - `hintLabel`     — the all-caps caption directly BELOW (Layout C)
 *                       OR the colon-terminated label directly LEFT
 *                       (Layout A) when one is present.
 *
 * The output mirrors the `context_before` / `context_after` fields
 * Pass 1 currently asks Gemini to emit (`geminiFieldDetector.ts`):
 *
 *   - Inline blanks within a sentence: contextBefore is the words
 *     before the blank, contextAfter is the words after.
 *   - Column-style label-LEFT rows: contextBefore ends with the
 *     printed label (e.g. "Cardholder Name:"), and `hintLabel` is
 *     set to that label.
 *   - Layout C (label-BELOW): hintLabel is the caption directly
 *     below the blank; contextBefore/After capture the surrounding
 *     row context if any.
 *
 * The downstream Gemini labeling call sees these strings and uses
 * them to pick a `canonical_field_id`. The deterministic post-
 * processing in `mapToTemplateField` (alias matcher → label matcher
 * → pattern matcher → model semantic) then runs on the same
 * `context_before` / `context_after` / `label` payload as today, so
 * the v0.4.6 CVV guard, v0.4.7 canonical-id ladder, v0.4.8 IoU
 * dedup, and v0.4.11 label matcher all apply unchanged.
 */

import type { BlankCandidate } from "./blankDetector";
import type { PdfPageText, PdfWord } from "./pdfTextLayer";

export interface BlankWithContext {
  candidate: BlankCandidate;
  /** Text immediately preceding the blank on the same row. */
  contextBefore: string;
  /** Text immediately following the blank on the same row. */
  contextAfter: string;
  /** Wider paragraph context (~6 lines around the blank). */
  paragraph: string;
  /**
   * The most-likely printed label for this blank, when one is
   * confidently identifiable. Populated for:
   *   - Layout C: the all-caps caption directly below the blank.
   *   - Layout A: a colon-terminated label directly left of the
   *     blank (when the colon sits within ~5px of the blank).
   * Empty when neither layout applies.
   */
  hintLabel?: string;
}

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

/** Pixel distance to look for words on the same row to the left. */
const SAME_ROW_LEFT_WINDOW_PX = 30;
/** Pixel distance to look for words on the same row to the right. */
const SAME_ROW_RIGHT_WINDOW_PX = 30;
/** Maximum vertical distance for a word to count as "below" the blank. */
const HINT_BELOW_GAP_PX = 20;
/** Maximum horizontal distance from the blank's left edge for a colon
 *  to count as the label-LEFT terminator. */
const HINT_COLON_GAP_PX = 5;

/** Vertical band to gather paragraph context (in PNG pixels). The
 *  spec calls for ±90 PDF points; at our 2048-long-edge render scale
 *  one US-letter page (792 pt tall) renders to ~2048 px, so 90 pt
 *  ≈ 230 px. We use 200 px as a clean round number that fits 5-7
 *  lines of body text. */
const PARAGRAPH_BAND_PX = 200;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pair every blank candidate with row-level + paragraph-level
 * context drawn from the page's pdf.js text layer.
 *
 * Words are bucketed by page first to keep the per-blank lookup
 * O(words-on-page) rather than O(words-on-document).
 */
export function pairBlanksWithContext(
  blanks: BlankCandidate[],
  pageText: PdfPageText[]
): BlankWithContext[] {
  const wordsByPage = new Map<number, PdfWord[]>();
  for (const pt of pageText) {
    wordsByPage.set(pt.page, pt.words);
  }

  const out: BlankWithContext[] = [];
  for (const blank of blanks) {
    const words = wordsByPage.get(blank.page) ?? [];
    const contextBefore = collectSameRow(blank, words, "left").trim();
    const contextAfter = collectSameRow(blank, words, "right").trim();
    const paragraph = collectParagraph(blank, words).trim();
    const hintLabel = resolveHintLabel(blank, words);
    out.push({
      candidate: blank,
      contextBefore,
      contextAfter,
      paragraph,
      hintLabel,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Words on the same horizontal row as the blank. We accept a word
 * when its vertical extent overlaps the blank's vertical extent by
 * ≥ 50% — this accommodates blanks that sit at slightly different
 * y-positions than the surrounding text (common for underscore
 * lines, where the underscores are baseline-aligned but the
 * surrounding text ascender is taller).
 */
function isSameRow(blank: BlankCandidate, word: PdfWord): boolean {
  const wordTop = word.y;
  const wordBottom = word.y + word.height;
  const blankTop = blank.y;
  const blankBottom = blank.y + blank.height;
  const overlap = Math.min(wordBottom, blankBottom) - Math.max(wordTop, blankTop);
  if (overlap <= 0) return false;
  const minHeight = Math.min(word.height, blank.height);
  return overlap >= minHeight * 0.5;
}

function collectSameRow(
  blank: BlankCandidate,
  words: PdfWord[],
  direction: "left" | "right"
): string {
  const sameRow = words.filter((w) => isSameRow(blank, w));
  if (sameRow.length === 0) return "";

  const window =
    direction === "left" ? SAME_ROW_LEFT_WINDOW_PX : SAME_ROW_RIGHT_WINDOW_PX;

  if (direction === "left") {
    // Words whose right edge is at-or-before the blank's left edge,
    // and within `window` px of it.
    const cluster = sameRow
      .filter(
        (w) =>
          w.x + w.width <= blank.x + 4 &&
          w.x + w.width >= blank.x - window
      )
      .sort((a, b) => a.x - b.x);

    // Pull in any further-left words on the same row that are part
    // of the same sentence (continuous, no large gaps). We extend
    // the window ANY time the next word is within 200 px of the
    // previous one — this captures phrases like
    // "...charged an additional $" preceding an inline blank.
    const tail: PdfWord[] = [];
    if (cluster.length > 0) {
      tail.push(cluster[cluster.length - 1]);
      for (let i = cluster.length - 2; i >= 0; i -= 1) {
        const next = cluster[i];
        const prev = tail[tail.length - 1];
        if (prev.x - (next.x + next.width) > 200) break;
        tail.push(next);
      }
    }
    const ordered = tail.reverse();
    // Pick up additional words on the same row that are further
    // left, if the cluster is too short to be useful.
    if (ordered.length === 0 && sameRow.length > 0) {
      const allLeft = sameRow
        .filter((w) => w.x + w.width <= blank.x + 4)
        .sort((a, b) => a.x - b.x);
      // Keep the rightmost ~8 words.
      const slice = allLeft.slice(Math.max(0, allLeft.length - 8));
      return slice.map((w) => w.text).join(" ");
    }
    return ordered.map((w) => w.text).join(" ");
  }

  // Right side.
  const cluster = sameRow
    .filter(
      (w) =>
        w.x >= blank.x + blank.width - 4 &&
        w.x <= blank.x + blank.width + window
    )
    .sort((a, b) => a.x - b.x);

  const tail: PdfWord[] = [...cluster];
  // Extend rightward as long as the next word is within 200 px of
  // the previous.
  if (tail.length > 0) {
    const allRight = sameRow
      .filter((w) => w.x >= blank.x + blank.width - 4)
      .sort((a, b) => a.x - b.x);
    let last = tail[tail.length - 1];
    for (const w of allRight) {
      if (w === last) continue;
      if (w.x - (last.x + last.width) > 200) break;
      if (!tail.includes(w)) {
        tail.push(w);
        last = w;
      }
    }
  }

  if (tail.length === 0 && sameRow.length > 0) {
    const allRight = sameRow
      .filter((w) => w.x >= blank.x + blank.width - 4)
      .sort((a, b) => a.x - b.x)
      .slice(0, 8);
    return allRight.map((w) => w.text).join(" ");
  }
  return tail.map((w) => w.text).join(" ");
}

function collectParagraph(blank: BlankCandidate, words: PdfWord[]): string {
  const yMid = blank.y + blank.height / 2;
  const inBand = words
    .filter((w) => {
      const wMid = w.y + w.height / 2;
      return Math.abs(wMid - yMid) <= PARAGRAPH_BAND_PX;
    })
    .sort((a, b) => {
      const aRowKey = Math.round(a.y / 6);
      const bRowKey = Math.round(b.y / 6);
      if (aRowKey !== bRowKey) return aRowKey - bRowKey;
      return a.x - b.x;
    });
  return inBand.map((w) => w.text).join(" ");
}

function resolveHintLabel(
  blank: BlankCandidate,
  words: PdfWord[]
): string | undefined {
  // Layout C: caption directly BELOW the blank.
  const captionBelow = findCaptionBelow(blank, words);
  if (captionBelow) return captionBelow;

  // Layout A: colon-terminated label directly LEFT of the blank.
  const labelLeft = findColonLabelLeft(blank, words);
  if (labelLeft) return labelLeft;

  return undefined;
}

function findCaptionBelow(
  blank: BlankCandidate,
  words: PdfWord[]
): string | undefined {
  const blankBottom = blank.y + blank.height;
  // Words whose top edge is below the blank, within HINT_BELOW_GAP_PX,
  // AND that horizontally overlap the blank's x-range.
  const candidates = words.filter((w) => {
    if (w.y < blankBottom - 2) return false;
    if (w.y > blankBottom + HINT_BELOW_GAP_PX) return false;
    const overlap =
      Math.min(w.x + w.width, blank.x + blank.width) - Math.max(w.x, blank.x);
    return overlap > 0;
  });
  if (candidates.length === 0) return undefined;

  // Group adjacent words on the same row into a phrase.
  candidates.sort((a, b) => a.x - b.x);
  const phrase = candidates.map((c) => c.text.trim()).filter(Boolean);
  if (phrase.length === 0) return undefined;

  // Apply the same all-caps caption test as the blank detector.
  const joined = phrase.join(" ").trim();
  if (!isAllCapsCandidate(joined)) return undefined;
  if (joined.length > 30) return undefined;

  return joined;
}

function findColonLabelLeft(
  blank: BlankCandidate,
  words: PdfWord[]
): string | undefined {
  // Find a word ending in ":" whose right edge sits within
  // HINT_COLON_GAP_PX of the blank's left edge AND on the same row.
  const sameRow = words.filter((w) => isSameRow(blank, w));
  const colonWord = sameRow.find((w) => {
    const trimmed = w.text.trim();
    if (!trimmed.endsWith(":")) return false;
    const rightEdge = w.x + w.width;
    return Math.abs(rightEdge - blank.x) <= HINT_COLON_GAP_PX;
  });
  if (!colonWord) return undefined;

  // Extend leftward to capture the full label (e.g.
  // "Cardholder Name:" → label is "Cardholder Name:").
  const leftWords = sameRow
    .filter((w) => w.x + w.width <= colonWord.x + colonWord.width)
    .sort((a, b) => a.x - b.x);
  // Keep up to 4 trailing words.
  const tail = leftWords.slice(Math.max(0, leftWords.length - 4));
  return tail.map((w) => w.text).join(" ").trim();
}

function isAllCapsCandidate(text: string): boolean {
  if (!text) return false;
  if (!/[A-Z]/.test(text)) return false;
  if (/[a-z]/.test(text)) return false;
  return /^[A-Z0-9 .,&#'/-]{3,}$/.test(text);
}
