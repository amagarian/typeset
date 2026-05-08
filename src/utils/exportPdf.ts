function downloadInBrowser(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type PdfExportMode = "prompt" | "downloads";

/**
 * Tries to use native Tauri "Save as…" + filesystem write when available.
 * Falls back to browser download when running as web.
 */
export async function exportPdfBytes(
  bytes: Uint8Array,
  suggestedFileName: string,
  mode: PdfExportMode = "prompt"
): Promise<{
  method: "tauri" | "browser";
  canceled?: boolean;
}> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    if (mode === "downloads") {
      const { downloadDir, join } = await import("@tauri-apps/api/path");
      const downloadsPath = await downloadDir();
      const fullPath = await join(downloadsPath, suggestedFileName);
      await writeFile(fullPath, bytes);
      return { method: "tauri" };
    }

    const { downloadDir, join } = await import("@tauri-apps/api/path");
    const downloadsPath = await downloadDir();
    const defaultPath = await join(downloadsPath, suggestedFileName);

    const path = await save({
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });

    if (!path) return { method: "tauri", canceled: true };
    await writeFile(path, bytes);
    return { method: "tauri" };
  } catch {
    downloadInBrowser(bytes, suggestedFileName);
    return { method: "browser" };
  }
}

