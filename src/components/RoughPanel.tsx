import { useState, useRef, useLayoutEffect, type CSSProperties } from 'react';

// Hand-drawn white "sheet" behind the spin-button row: a very tapered squircle
// (superellipse-cornered rounded rect) with the same seeded harmonic roughness
// the wheel + PixelButton use, so it reads as part of the pixel-art world.
//
// Composed at sprite resolution then hard-upscaled to device pixels with
// nearest-neighbour drawImage (never CSS image-rendering) so the rough edge
// stays crisp. Fills its positioned parent; give it a parent with the desired
// outset via `style` (e.g. absolute inset with negative left/right).

interface Pt { x: number; y: number; nx: number; ny: number }

// Outline of a rounded rectangle with independent top/bottom corner radii,
// corners following a SUPERELLIPSE (exponent `p`): p=2 is a circular arc,
// p<2 tapers to a point ("very tapered"), p>2 squares off. A radius of 0 gives
// a sharp corner — pass rBot=0 for the flat-bottomed "bottom sheet" look.
// Points carry an outward normal so the roughening can push along it.
function sheetOutline(x0: number, y0: number, x1: number, y1: number, rTop: number, rBot: number, p: number, step: number): Pt[] {
  const maxR = Math.min((x1 - x0) / 2, y1 - y0);
  rTop = Math.max(0, Math.min(rTop, maxR));
  rBot = Math.max(0, Math.min(rBot, maxR));
  const pts: Pt[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let i = 0; i < n; i++) { const t = i / n; pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, nx, ny }); }
  };
  const corner = (cx: number, cy: number, r: number, a0: number) => {
    if (r <= 0) return; // sharp corner — the adjoining segments meet at (cx,cy)
    const n = Math.max(4, Math.round((Math.PI / 2 * r) / step));
    for (let i = 0; i < n; i++) {
      const a = a0 + (Math.PI / 2) * (i / n);
      const ct = Math.cos(a), st = Math.sin(a);
      const ex = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / p);
      const ey = Math.sign(st) * Math.pow(Math.abs(st), 2 / p);
      const x = cx + r * ex, y = cy + r * ey;
      const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1;
      pts.push({ x, y, nx: dx / L, ny: dy / L });
    }
  };
  seg(x0 + rTop, y0, x1 - rTop, y0, 0, -1);          // top edge
  corner(x1 - rTop, y0 + rTop, rTop, -Math.PI / 2);  // top-right
  seg(x1, y0 + rTop, x1, y1 - rBot, 1, 0);           // right edge
  corner(x1 - rBot, y1 - rBot, rBot, 0);             // bottom-right
  seg(x1 - rBot, y1, x0 + rBot, y1, 0, 1);           // bottom edge
  corner(x0 + rBot, y1 - rBot, rBot, Math.PI / 2);   // bottom-left
  seg(x0, y1 - rBot, x0, y0 + rTop, -1, 0);          // left edge
  corner(x0 + rTop, y0 + rTop, rTop, Math.PI);       // top-left
  return pts;
}

// Push every outline point along its normal by seeded, perimeter-periodic
// harmonics — the wheel's hand-drawn character (same recipe as PixelButton).
function roughen(pts: Pt[], amp: number, seed: number): Path2D {
  const ph = (c: number) => { const x = Math.sin(seed * 127.1 + c * 311.7 + 0.5) * 43758.5453; return (x - Math.floor(x)) * Math.PI * 2; };
  const p0 = ph(0), p1 = ph(1), p2 = ph(2), p3 = ph(3);
  const N = pts.length;
  const path = new Path2D();
  for (let i = 0; i < N; i++) {
    const t = i / N;
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

interface RoughPanelProps {
  color?: string;
  /** 'squircle' rounds all four corners; 'bottomSheet' rounds only the top
   *  two and leaves the bottom flat, so it reads as a small bottom sheet. */
  variant?: 'squircle' | 'bottomSheet';
  /** Top corner radius as a fraction of the shorter side. */
  radiusRatio?: number;
  /** Superellipse exponent: <2 tapers to points, 2 = circular, >2 squarer. */
  taper?: number;
  /** Roughness amplitude in SPRITE px. */
  roughAmp?: number;
  /** CSS px per sprite px — larger = chunkier pixels. Pass the buttons' scale
   *  to match their density. */
  pixelScale?: number;
  seed?: number;
  style?: CSSProperties;
}

export function RoughPanel({
  color = '#FFFFFF',
  variant = 'squircle',
  radiusRatio = 0.5,
  taper = 1.7,
  roughAmp = 1.6,
  pixelScale = 2,
  seed = 5,
  style,
}: RoughPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const composeRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || box.w <= 0 || box.h <= 0) return;

    // Sprite-space size, plus a pad so the outward wobble never clips.
    const W = Math.max(8, Math.round(box.w / pixelScale));
    const H = Math.max(8, Math.round(box.h / pixelScale));
    const pad = Math.ceil(roughAmp) + 1;
    if (!composeRef.current) composeRef.current = document.createElement('canvas');
    const compose = composeRef.current;
    if (compose.width !== W || compose.height !== H) { compose.width = W; compose.height = H; }
    const octx = compose.getContext('2d')!;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, W, H);

    // Bottom-sheet variant: the flat bottom is drawn PAST the canvas edge
    // (botY = H+pad) so its rough wobble clips to a clean straight line flush
    // at the bottom, instead of nicking inward. Squircle variant keeps the pad.
    const rTop = Math.min(W, H) * radiusRatio;
    const botY = variant === 'bottomSheet' ? H + pad : H - pad;
    const rBot = variant === 'bottomSheet' ? 0 : rTop;
    const outline = sheetOutline(pad, pad, W - pad, botY, rTop, rBot, taper, 2);
    octx.fillStyle = color;
    octx.fill(roughen(outline, roughAmp, seed));

    // Hard pixellation: threshold the AA edge so every block is fully opaque
    // color or fully clear — crisp pixel-art silhouette, no soft grey fringe.
    const id = octx.getImageData(0, 0, W, H), d = id.data;
    const [cr, cg, cb] = ((h) => { h = h.replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; const n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; })(color);
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] >= 128) { d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = 255; }
      else d[i + 3] = 0;
    }
    octx.putImageData(id, 0, 0);

    // Hard upscale to the box's device resolution (nearest-neighbour). Block
    // size ≈ pixelScale·dpr; a rough blob hides any ±1px block variance, so
    // filling the box exactly matters more than an integer block here.
    const dpr = window.devicePixelRatio || 1;
    const DW = Math.round(box.w * dpr), DH = Math.round(box.h * dpr);
    if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, DW, DH);
    ctx.drawImage(compose, 0, 0, W, H, 0, 0, DW, DH);
  }, [box, color, radiusRatio, taper, roughAmp, pixelScale, seed]);

  return (
    <div ref={rootRef} style={{ pointerEvents: 'none', ...style }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}
