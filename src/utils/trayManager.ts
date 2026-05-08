import { TrayIcon } from "@tauri-apps/api/tray";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import { Image } from "@tauri-apps/api/image";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

let trayInstance: TrayIcon | null = null;
let cachedProjects: { id: string; label: string }[] = [];
const DROP_ZONE_WIDTH = 270;

async function loadTrayIcon(): Promise<Image> {
  const response = await fetch("/icons/tray-icon.png");
  const buffer = await response.arrayBuffer();
  return Image.fromBytes(new Uint8Array(buffer));
}

async function toggleDropZone(iconX: number, iconY: number, iconWidth: number, iconHeight: number) {
  const win = await WebviewWindow.getByLabel("dropzone");
  if (!win) return;

  const isVisible = await win.isVisible();
  if (isVisible) {
    await win.hide();
    return;
  }

  const x = Math.round(iconX + iconWidth / 2 - DROP_ZONE_WIDTH / 2);
  const y = Math.round(iconY + iconHeight + 4);

  await win.setPosition(new PhysicalPosition(x, y));
  await emitTo("dropzone", "tray-projects-sync", cachedProjects);
  await win.show();
  await win.setFocus();
}

export async function initTray(
  projects: { id: string; label: string }[]
): Promise<void> {
  if (trayInstance) return;

  cachedProjects = projects;
  const icon = await loadTrayIcon();

  trayInstance = await TrayIcon.new({
    id: "typeset-tray",
    icon,
    iconAsTemplate: true,
    tooltip: "Typeset — Drop PDFs",
    showMenuOnLeftClick: false,
    action: (event) => {
      if (
        event.type === "Click" &&
        event.button === "Left" &&
        event.buttonState === "Up"
      ) {
        const rect = event.rect;
        void toggleDropZone(
          rect.position.x,
          rect.position.y,
          rect.size.width,
          rect.size.height
        );
      }
    },
  });
}

export async function updateTrayMenu(
  projects: { id: string; label: string }[]
): Promise<void> {
  cachedProjects = projects;
}

export async function destroyTray(): Promise<void> {
  if (trayInstance) {
    await trayInstance.close();
    trayInstance = null;
  }
}
