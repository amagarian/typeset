/**
 * Trim excess whitespace / transparency around signature raster data so
 * pdfWriter scales the actual ink, not a large empty frame.
 */

function isInk(r: number, g: number, b: number, a: number): boolean {
  if (a < 14) return false;
  // Near-white JPG backgrounds (no alpha)
  return r + g + b < 720;
}

/**
 * Returns a PNG data URL cropped to ink bounds (or the original if trim fails).
 */
export async function trimSignatureDataUrl(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith("data:image/")) return dataUrl;

  const img = new Image();
  const bmp = await new Promise<string | null>((resolve) => {
    img.onload = () => resolve(dataUrl);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
  if (!bmp) return dataUrl;

  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w < 2 || h < 2) return dataUrl;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;

  ctx.drawImage(img, 0, 0);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    return dataUrl;
  }

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  const d = data.data;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (isInk(d[i], d[i + 1], d[i + 2], d[i + 3])) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX >= maxX || minY >= maxY) return dataUrl;

  const pad = 3;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  if (cw < 2 || ch < 2) return dataUrl;

  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d");
  if (!octx) return dataUrl;
  octx.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  try {
    return out.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}
