/**
 * v0.6.0 (Workstream F) — initial-field detector.
 *
 * Long rental agreements (e.g. Studio Contract Hollywood) include a
 * column of small square boxes adjacent to numbered clauses,
 * intended for the lessee to initial each clause. The pattern:
 *
 *   1. _____ Lorem ipsum…   ☐
 *   2. _____ Dolor sit…     ☐
 *   3. _____ Consectetur…   ☐
 *
 * Each ☐ is a small box (~12–20pt × 12–20pt). The boxes share a
 * common x-position (within ~6pt) and are vertically spaced
 * 30–80pt apart. Three-or-more stacked squares form a clause-
 * initial cluster.
 *
 * This post-processor:
 *
 *   1. Scans page renders for short horizontal dark runs
 *      (`minSquarePt`–`maxSquarePt`) and pairs top/bottom edges
 *      whose vertical spacing is within the same range — that's
 *      a square candidate.
 *   2. Verifies the left/right edges via interior-column
 *      sampling (≥ 1 of 2 samples dark on each side — squares
 *      are short so two is enough).
 *   3. Clusters squares with the same x (within
 *      `xClusterTolPt`) and reasonable inter-square vertical
 *      spacing.
 *   4. For clusters with ≥ `minSquaresInCluster` squares, emits
 *      one `clauseInitials` `TemplateField` per square (centred
 *      inside the box, single-line text — the form filler will
 *      render the project's `initials` value).
 *
 * Conservative thresholds keep false-positives low. Tables of
 * tiny cells (e.g. equipment row schedules) generally fail the
 * "≥3 in a column" gate because table cells aren't square AND
 * sit in multi-column rows; the cluster x-tolerance is tight
 * enough to avoid latching onto adjacent table columns.
 */

import type { TemplateField } from "@/types";
import type { PageRender } from "@/utils/underlineSnap";

export interface InitialBoxDetectorOptions {
  minSquarePt?: number;
  maxSquarePt?: number;
  /** Allowed deviation of side lengths to still call it "square". */
  squareToleranceP?: number;
  /** Tolerance for clustering boxes by x-position (PDF points). */
  xClusterTolPt?: number;
  minVerticalGapPt?: number;
  maxVerticalGapPt?: number;
  minSquaresInCluster?: number;
  darkLuminance?: number;
  verbose?: boolean;
}

const DEFAULT_OPTS: Required<InitialBoxDetectorOptions> = {
  minSquarePt: 10,
  maxSquarePt: 22,
  squareToleranceP: 0.4,
  xClusterTolPt: 6,
  minVerticalGapPt: 18,
  maxVerticalGapPt: 100,
  minSquaresInCluster: 3,
  darkLuminance: 80,
  verbose: false,
};

interface ShortRun {
  yPx: number;
  leftPx: number;
  rightPx: number;
}

interface SquareCandidate {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function isPixelDark(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  x: number,
  y: number,
  darkLuminance: number
): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const idx = (y * W + x) * 4;
  if (data[idx + 3] < 128) return false;
  const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  return lum < darkLuminance;
}

/**
 * Scan rows for short, horizontal dark runs whose length is within
 * `[minLenPx, maxLenPx]`. Unlike the boxed-field detector this
 * collects ALL qualifying runs per row (squares often cluster
 * tightly vs. the page-wide single-run-per-row model).
 */
function findShortHorizontalRuns(
  render: PageRender,
  minLenPx: number,
  maxLenPx: number,
  darkLuminance: number
): ShortRun[] {
  const out: ShortRun[] = [];
  const data = render.imageData.data;
  const W = render.width;
  const H = render.height;
  const MAX_GAP = 1;

  for (let y = 0; y < H; y += 1) {
    const rowOff = y * W * 4;
    let curStart = -1;
    let curRight = -1;
    let curGap = 0;
    for (let x = 0; x < W; x += 1) {
      const idx = rowOff + x * 4;
      const a = data[idx + 3];
      let isDark: boolean;
      if (a < 128) {
        isDark = false;
      } else {
        const lum =
          0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        isDark = lum < darkLuminance;
      }
      if (isDark) {
        if (curStart < 0) curStart = x;
        curRight = x;
        curGap = 0;
      } else if (curStart >= 0) {
        if (curGap < MAX_GAP) {
          curGap += 1;
        } else {
          const len = curRight - curStart + 1;
          if (len >= minLenPx && len <= maxLenPx) {
            out.push({ yPx: y, leftPx: curStart, rightPx: curRight });
          }
          curStart = -1;
          curRight = -1;
          curGap = 0;
        }
      }
    }
    if (curStart >= 0) {
      const len = curRight - curStart + 1;
      if (len >= minLenPx && len <= maxLenPx) {
        out.push({ yPx: y, leftPx: curStart, rightPx: curRight });
      }
    }
  }
  return out;
}

/**
 * Pair short horizontal runs at the same x-extent into square
 * candidates: top edge + bottom edge with vertical spacing matching
 * the run width (within `squareToleranceP`).
 */
function findSquareCandidatesForPage(
  page: number,
  render: PageRender,
  opts: Required<InitialBoxDetectorOptions>
): SquareCandidate[] {
  const ppp = 1 / Math.max(1e-6, render.pdfPointsPerPixel);
  const minLenPx = opts.minSquarePt * ppp;
  const maxLenPx = opts.maxSquarePt * ppp;

  const runs = findShortHorizontalRuns(render, minLenPx, maxLenPx, opts.darkLuminance);
  if (runs.length < 2) return [];

  const data = render.imageData.data;
  const W = render.width;
  const H = render.height;
  const out: SquareCandidate[] = [];
  const xTolPx = Math.max(2, Math.round(2 * ppp));

  for (let i = 0; i < runs.length; i += 1) {
    const top = runs[i];
    const widthPx = top.rightPx - top.leftPx + 1;
    for (let j = i + 1; j < runs.length; j += 1) {
      const bot = runs[j];
      const dy = bot.yPx - top.yPx;
      if (dy < minLenPx) continue;
      if (dy > maxLenPx) break;

      if (Math.abs(bot.leftPx - top.leftPx) > xTolPx) continue;
      const botWidth = bot.rightPx - bot.leftPx + 1;
      if (Math.abs(botWidth - widthPx) > xTolPx + 1) continue;

      // Squareness: height ≈ width within tolerance.
      const ratio = dy / widthPx;
      if (ratio < 1 - opts.squareToleranceP || ratio > 1 + opts.squareToleranceP) continue;

      // Verify left/right vertical edges.
      const leftCol = top.leftPx;
      const rightCol = top.rightPx;
      const sampleYs = [
        Math.round(top.yPx + dy * 0.33),
        Math.round(top.yPx + dy * 0.66),
      ];
      let leftHits = 0;
      let rightHits = 0;
      for (const y of sampleYs) {
        if (isPixelDark(data, W, H, leftCol, y, opts.darkLuminance)) leftHits += 1;
        if (isPixelDark(data, W, H, rightCol, y, opts.darkLuminance)) rightHits += 1;
      }
      if (leftHits < 1 || rightHits < 1) continue;

      out.push({
        page,
        x: top.leftPx * render.pdfPointsPerPixel,
        y: top.yPx * render.pdfPointsPerPixel,
        width: widthPx * render.pdfPointsPerPixel,
        height: dy * render.pdfPointsPerPixel,
      });
      // Skip ahead — once we found a partner for `top` we don't
      // want to also pair it with deeper runs (would over-count).
      break;
    }
  }
  return out;
}

interface ColumnCluster {
  page: number;
  centerX: number;
  squares: SquareCandidate[];
}

/**
 * Group square candidates into vertical-column clusters. Two
 * squares are in the same cluster when their x-centres differ by
 * ≤ `xClusterTolPt` AND the inter-square gap fits within
 * `[minVerticalGapPt, maxVerticalGapPt]`.
 */
function clusterSquares(
  squares: SquareCandidate[],
  opts: Required<InitialBoxDetectorOptions>
): ColumnCluster[] {
  if (squares.length === 0) return [];
  const out: ColumnCluster[] = [];

  const sorted = [...squares].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.x - b.x) > opts.xClusterTolPt) return a.x - b.x;
    return a.y - b.y;
  });

  for (const sq of sorted) {
    const centerX = sq.x + sq.width / 2;
    const found = out.find((cluster) => {
      if (cluster.page !== sq.page) return false;
      if (Math.abs(cluster.centerX - centerX) > opts.xClusterTolPt) return false;
      const last = cluster.squares[cluster.squares.length - 1];
      const gap = sq.y - (last.y + last.height);
      return gap >= opts.minVerticalGapPt - last.height &&
             gap <= opts.maxVerticalGapPt;
    });
    if (found) {
      found.squares.push(sq);
      // Move centerX toward the running mean so a slight column
      // drift doesn't compound.
      const n = found.squares.length;
      found.centerX = ((found.centerX * (n - 1)) + centerX) / n;
    } else {
      out.push({ page: sq.page, centerX, squares: [sq] });
    }
  }
  return out;
}

/**
 * Public entry point. Returns the augmented field list with one
 * `clauseInitials` field per detected square in qualifying
 * column-clusters. Existing fields are not modified — initials
 * boxes never overlap with text-input field bboxes.
 */
export function annotateInitialBoxes(
  fields: TemplateField[],
  pageRenders: Record<number, PageRender>,
  options: InitialBoxDetectorOptions = {}
): TemplateField[] {
  const opts = { ...DEFAULT_OPTS, ...options };

  const allCandidates: SquareCandidate[] = [];
  for (const [pageStr, render] of Object.entries(pageRenders)) {
    const page = Number(pageStr);
    const candidates = findSquareCandidatesForPage(page, render, opts);
    allCandidates.push(...candidates);
  }
  if (allCandidates.length === 0) return fields;

  const clusters = clusterSquares(allCandidates, opts).filter(
    (c) => c.squares.length >= opts.minSquaresInCluster
  );
  if (clusters.length === 0) {
    if (opts.verbose) {
      console.log(`[initialBox] ${allCandidates.length} square(s) found but no cluster met min=${opts.minSquaresInCluster}.`);
    }
    return fields;
  }

  const out: TemplateField[] = [...fields];
  let added = 0;
  for (const cluster of clusters) {
    const clusterId = `${cluster.page}-${Math.round(cluster.centerX)}`;
    cluster.squares.forEach((sq, idx) => {
      // Avoid double-emitting if a field at this exact bbox already
      // exists (the boxed-field detector might have emitted it).
      const tol = 6;
      const collision = out.some(
        (f) =>
          f.pageNumber === sq.page &&
          Math.abs(f.x - sq.x) <= tol &&
          Math.abs(f.y - sq.y) <= tol &&
          Math.abs(f.width - sq.width) <= tol &&
          Math.abs(f.height - sq.height) <= tol
      );
      if (collision) return;

      out.push({
        id: `clause-init-${clusterId}-${idx + 1}-${Date.now().toString(36)}`,
        label: `Clause initials ${idx + 1}`,
        mappedProjectKey: "initials",
        canonicalFieldId: "clauseInitials",
        pageNumber: sq.page,
        x: sq.x,
        y: sq.y,
        width: sq.width,
        height: sq.height,
        confidence: 0.88,
        fieldType: "text",
        fieldKind: "text",
        detectionSource: "geometry-box",
      });
      added += 1;
    });
  }

  console.log(
    `[initialBox] emitted ${added} clauseInitials field(s) across ${clusters.length} cluster(s).`
  );
  return out;
}
