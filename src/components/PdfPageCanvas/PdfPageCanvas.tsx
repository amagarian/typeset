import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist";
import styles from "./PdfPageCanvas.module.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface PdfPageCanvasProps {
  pdfBytes: Uint8Array;
  pageNumber?: number;
  maxWidth?: number;
  maxHeight?: number;
  onDimensions?: (dims: { width: number; height: number; scale: number }) => void;
}

export function PdfPageCanvas({
  pdfBytes,
  pageNumber = 1,
  maxWidth = 600,
  maxHeight = 700,
  onDimensions,
}: PdfPageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const onDimensionsRef = useRef(onDimensions);
  
  useEffect(() => {
    onDimensionsRef.current = onDimensions;
  }, [onDimensions]);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      // Cancel any in-progress render
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }

      setLoading(true);
      setError(null);

      try {
        const bytesCopy = new Uint8Array(pdfBytes);
        const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const unscaledViewport = page.getViewport({ scale: 1 });
        const scaleX = maxWidth / unscaledViewport.width;
        const scaleY = maxHeight / unscaledViewport.height;
        const scale = Math.min(scaleX, scaleY, 1.5);

        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderTask = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        if (cancelled) return;

        renderTaskRef.current = null;
        onDimensionsRef.current?.({ width: viewport.width, height: viewport.height, scale });
        setLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        // Ignore cancellation errors
        if (err instanceof Error && err.message.includes("cancelled")) {
          return;
        }
        console.error("PDF render error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to render PDF: ${msg}`);
        setLoading(false);
      }
    }

    void render();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pdfBytes, pageNumber, maxWidth, maxHeight]);

  if (error) {
    return <div className={styles.error}>{error}</div>;
  }

  return (
    <div className={styles.wrapper}>
      {loading && <div className={styles.loading}>Loading…</div>}
      <canvas ref={canvasRef} className={styles.canvas} />
    </div>
  );
}
