import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * v0.5.24 — inline canvas confetti for milestone celebrations.
 *
 * Lightweight enough to not warrant pulling in `canvas-confetti` —
 * 30-50 particles, gravity, random colours from the Typeset palette,
 * lives ~1.5s, then unmounts itself. Renders into a portal at
 * document.body so the canvas always sits above modal / banner /
 * popover stacks regardless of the click target it was triggered
 * from.
 */

interface ConfettiBurstProps {
  /** Bumping this number re-fires the burst. Use a timestamp or a
   *  monotonic counter — stay away from booleans, which can't
   *  re-trigger on the same value. */
  triggerKey: number;
  /** Optional callback when the animation completes. */
  onDone?: () => void;
  /** Particle count. Defaults to 40. */
  particleCount?: number;
  /** Lifetime in ms. Defaults to 1500. */
  lifetimeMs?: number;
}

const PALETTE = [
  "#1a1a1a", // app text — high-contrast neutral
  "#fafaf9", // off-white
  "#3b82f6", // accent blue (matches DraggableField)
  "#16a34a", // verified-green family
  "#e67e22", // warm accent (matches FillPromptModal highlight)
  "#9333ea", // purple counterpoint
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationVel: number;
  size: number;
  color: string;
  shape: "rect" | "circle";
}

export function ConfettiBurst({
  triggerKey,
  onDone,
  particleCount = 40,
  lifetimeMs = 1500,
}: ConfettiBurstProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mountTarget, setMountTarget] = useState<HTMLElement | null>(null);

  // SSR / non-DOM safety: only attach to body once we know we're in
  // a browser context. Tauri is always DOM, but this also keeps the
  // tray webview happy on first render.
  useEffect(() => {
    if (typeof document !== "undefined") {
      setMountTarget(document.body);
    }
  }, []);

  useEffect(() => {
    if (!mountTarget) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (triggerKey === 0) return; // sentinel — no fire on initial mount

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Match the canvas backing buffer to the device pixel ratio so
    // the confetti stays crisp on retina displays.
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Burst origin: top-right corner, biased toward where the
    // ContributionBadge typically lives. We don't know the badge's
    // exact bounds (the burst is fired from App.tsx, decoupled from
    // the badge's mount point), so we approximate. A slight downward
    // initial velocity from this corner gives a natural fan into the
    // viewport.
    const originX = width - 80;
    const originY = 80;

    const particles: Particle[] = Array.from({ length: particleCount }, () => {
      const angle = Math.PI * 0.55 + Math.random() * Math.PI * 0.55; // 99°..198° — fan down-and-left
      const speed = 4 + Math.random() * 6;
      return {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4 - Math.random() * 3, // initial upward kick
        rotation: Math.random() * Math.PI * 2,
        rotationVel: (Math.random() - 0.5) * 0.3,
        size: 4 + Math.random() * 5,
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        shape: Math.random() < 0.7 ? "rect" : "circle",
      };
    });

    const startedAt = performance.now();
    let rafId = 0;
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;
      const elapsed = now - startedAt;
      const t = Math.min(1, elapsed / lifetimeMs);

      ctx.clearRect(0, 0, width, height);

      const gravity = 0.35;
      // Fade particles out over the last 30% of the lifetime.
      const opacity = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);

      for (const particle of particles) {
        particle.vy += gravity;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.rotation += particle.rotationVel;

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = particle.color;
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.rotation);
        if (particle.shape === "rect") {
          ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 0.6);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, particle.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (t < 1) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, width, height);
        onDone?.();
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      ctx.clearRect(0, 0, width, height);
    };
  }, [triggerKey, mountTarget, particleCount, lifetimeMs, onDone]);

  if (!mountTarget) return null;

  return createPortal(
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 2000,
      }}
    />,
    mountTarget
  );
}
