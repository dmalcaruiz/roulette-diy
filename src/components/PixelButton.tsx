import { useState, useRef, useLayoutEffect, useEffect, type CSSProperties } from 'react';
import { oklchShade, hexToRgba } from '../utils/colorUtils';
import { pixelateCanvas, PIXELATED, type Palette } from './WheelCanvas';

// Full pixel-art button — the WHOLE button (rough faces + stroke + LABEL) is
// drawn on one canvas and run through the same nearest-neighbour pixelate pass as
// the wheel, so the entire thing is a single 8-bit unit with zero AA — including
// the text (the label is NOT crisp DOM here; that was the last AA source).
// Rough hand-drawn edges match the wheel silhouette.

const PIXEL_FONT = "'LoRes9OTWide-Bold'";

interface RoughPt { x: number; y: number; nx: number; ny: number }

function roundedRectOutline(x0: number, y0: number, x1: number, y1: number, r: number, step: number): RoughPt[] {
  const pts: RoughPt[] = [];
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const seg = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let i = 0; i < n; i++) { const t = i / n; pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, nx, ny }); }
  };
  const arc = (cx: number, cy: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / step));
    for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, nx: Math.cos(a), ny: Math.sin(a) }); }
  };
  seg(x0 + r, y0, x1 - r, y0, 0, -1);
  arc(x1 - r, y0 + r, -Math.PI / 2, 0);
  seg(x1, y0 + r, x1, y1 - r, 1, 0);
  arc(x1 - r, y1 - r, 0, Math.PI / 2);
  seg(x1 - r, y1, x0 + r, y1, 0, 1);
  arc(x0 + r, y1 - r, Math.PI / 2, Math.PI);
  seg(x0, y1 - r, x0, y0 + r, -1, 0);
  arc(x0 + r, y0 + r, Math.PI, Math.PI * 1.5);
  return pts;
}

// Rough rounded-rect: each outline point pushed along its normal by seeded,
// perimeter-periodic harmonics — the wheel's hand-drawn character.
function roughRectPath(x0: number, y0: number, x1: number, y1: number, r: number, amp: number, seed: number): Path2D {
  const pts = roundedRectOutline(x0, y0, x1, y1, r, 3);
  const ph = (c: number) => { const x = Math.sin(seed * 127.1 + c * 311.7 + 0.5) * 43758.5453; return (x - Math.floor(x)) * Math.PI * 2; };
  const p0 = ph(0), p1 = ph(1), p2 = ph(2), p3 = ph(3);
  const N = pts.length;
  const path = new Path2D();
  for (let i = 0; i < N; i++) {
    const t = i / N;
    // Weighted toward HIGH harmonics → fine micro-grain rather than big
    // low-frequency (macro) wobble. The old 0.6·h3 dominant made the whole
    // edge bow; here the macro term is small and the energy sits in h9/h15.
    const n = Math.sin(2 * Math.PI * t * 3 + p0) * 0.18
            + Math.sin(2 * Math.PI * t * 6 + p1) * 0.24
            + Math.sin(2 * Math.PI * t * 9 + p2) * 0.30
            + Math.sin(2 * Math.PI * t * 15 + p3) * 0.28;
    const P = pts[i];
    const x = P.x + P.nx * amp * n, y = P.y + P.ny * amp * n;
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

interface PixelButtonProps {
  label: string;
  onTap?: () => void;
  color: string;
  height?: number;
  depth?: number;
  radius?: number;
  roughAmp?: number;
  seed?: number;
  // CSS px per pixel-block. Pass the wheel's block size (wheelWidth /
  // PIXEL_BLOCKS) so the button shares the wheel's exact grid density.
  pixelScale?: number;
  textColor?: string;
  fontSize?: number;
  letterSpacing?: number;
  style?: CSSProperties;
}

export function PixelButton({
  label,
  onTap,
  color,
  height = 54,
  depth = 6,
  radius = 10,
  roughAmp = 2,
  seed = 7,
  pixelScale = 2,
  textColor = '#FFFFFF',
  fontSize = 16,
  letterSpacing = 1,
  style,
}: PixelButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [width, setWidth] = useState(0);
  const [fontReady, setFontReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const bottomColor = oklchShade(color, 0.09);
  const faceHeight = height - depth;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Repaint once the pixel font has loaded, so fillText uses it (not a fallback).
  useEffect(() => {
    let cancelled = false;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) { setFontReady(true); return; }
    fonts.load(`${fontSize}px ${PIXEL_FONT}`).then(() => { if (!cancelled) setFontReady(true); }).catch(() => { if (!cancelled) setFontReady(true); });
    return () => { cancelled = true; };
  }, [fontSize]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const topOffset = pressed ? depth : 0;
    // Rough faces: depth, then the plain top face (no stroke ring).
    ctx.fillStyle = bottomColor;
    ctx.fill(roughRectPath(0, depth, width, height, radius, roughAmp, seed));
    ctx.fillStyle = color;
    ctx.fill(roughRectPath(0, topOffset, width, topOffset + faceHeight, radius, roughAmp, seed));

    // Label — drawn INTO the canvas so it pixelates with the rest (no AA).
    ctx.fillStyle = textColor;
    ctx.font = `${fontSize}px ${PIXEL_FONT}, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${letterSpacing}px`;
    ctx.fillText(label, width / 2, topOffset + faceHeight / 2 + 1);

    // Fixed palette (fill / depth / text) → every block snaps to a real
    // colour, hardening the text↔fill and face↔depth edges. Zero AA.
    const palette: Palette = [color, bottomColor, textColor].map(h => {
      const { r, g, b } = hexToRgba(h);
      return [r, g, b] as [number, number, number];
    });
    if (PIXELATED) pixelateCanvas(ctx, width, height, pixelScale, palette);
  }, [width, height, depth, radius, roughAmp, seed, pixelScale, color, bottomColor, faceHeight, pressed, label, textColor, fontSize, letterSpacing, fontReady]);

  const release = () => setPressed(false);

  return (
    <div
      ref={containerRef}
      onPointerDown={() => onTap && setPressed(true)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={() => onTap?.()}
      style={{
        height,
        position: 'relative',
        display: 'flow-root',
        cursor: onTap ? 'pointer' : 'default',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          imageRendering: PIXELATED ? 'pixelated' : undefined,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
