import { useEffect, useRef, useState } from 'react';

// The wheel's top V pointer with the centre marker's two-layer shadow (see
// PixelatedMarker's halos): a wide faint halo and a tighter darker one — both
// scaled-up tinted silhouettes of the SAME art — then the sprite itself. No
// peek/bottom layer; just the halos.

const SRC = '/images/wheelmarker.png';

// Layer recipe: ADDITIVE growth (css px added to both dimensions — the same
// convention as the centre marker's halo1D = baseD + 28 / halo2D = baseD +
// 12, which is what gives its shadows their breathing room), y offset, tint.
const HALO1 = { grow: 28, dy: 2, tint: 'rgba(0,0,0,0.06)' };
const HALO2 = { grow: 12, dy: 1, tint: 'rgba(0,0,0,0.14)' };

// Padding around the marker box so halos/drops never clip.
const PAD = 18;

let img: HTMLImageElement | null = null;
let imgPromise: Promise<HTMLImageElement> | null = null;
function loadImg(): Promise<HTMLImageElement> {
  if (!imgPromise) {
    imgPromise = new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => { img = i; res(i); };
      i.onerror = rej;
      i.src = SRC;
    });
  }
  return imgPromise;
}

// Tinted silhouette of the art at native resolution (module cache per tint).
const tintCache = new Map<string, HTMLCanvasElement>();
function tinted(color: string): HTMLCanvasElement | null {
  if (!img) return null;
  let c = tintCache.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  tintCache.set(color, c);
  return c;
}

interface WheelTopMarkerProps {
  /** Display size of the marker sprite itself, css px. */
  width: number;
  height: number;
}

export default function WheelTopMarker({ width, height }: WheelTopMarkerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(!!img);
  const cssW = width + PAD * 2;
  const cssH = height + PAD * 2;

  useEffect(() => {
    let cancelled = false;
    loadImg().then(() => { if (!cancelled) setReady(true); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || !img) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cssW, cssH);

    const cx = cssW / 2, cy = cssH / 2;
    const layer = (src: CanvasImageSource, grow: number, dy: number) => {
      const w = width + grow, h = height + grow;
      ctx.drawImage(src, cx - w / 2, cy - h / 2 + dy, w, h);
    };
    const halo1 = tinted(HALO1.tint);
    const halo2 = tinted(HALO2.tint);
    if (halo1) layer(halo1, HALO1.grow, HALO1.dy);
    if (halo2) layer(halo2, HALO2.grow, HALO2.dy);
    layer(img, 0, 0);
  }, [ready, cssW, cssH, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: cssW,
        height: cssH,
        display: 'block',
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  );
}
