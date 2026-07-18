import { useState, useRef, useLayoutEffect, useEffect, type CSSProperties } from 'react';
import { applyArtDelta, hexToRgb, ART_BASE } from './SpriteButton';

// Whole-art sprite buttons for the spin row — the hand-drawn SPIN pill
// (spintop.png + spinshadow.png) and the square icon buttons (wheels.png,
// edit.png), replacing the 9-slice sheet buttons.
//
// Art conventions (native sprite px). The art is drawn at 2× the wheel block
// grid — the pill face is 78 px ≈ the 40-block button box — so callers pass
// pixelScale = HALF a wheel block (spriteScaleFor(wheelSize / 2)). The
// device-pixel snap floors that at 1 device px per sprite px, which on
// dpr-1 windows lands the art at ~wheel-block chunkiness anyway.
//   • spintop.png 211×84: face art rows 0..77. Cyan #00C0FE family — recolored
//     to `color` by applying each pixel's OKLCH delta from the base cyan, so
//     the darker border and every hand-blended stray follows the runtime hue.
//   • spinshadow.png 211×84: the peek, art rows 9..83. Drawn first; the face
//     drops by PRESS_DEPTH (6 sprite px) onto it when pressed — bottoms align.
//   • Pill width stretches by 3-slice: end caps verbatim, middle slab TILED
//     (not scaled) so the wobbly hand-drawn border keeps its character.
//   • Icons 75×75: multicolour art, drawn verbatim (no recolor); press nudges
//     them down 2 sprite px.
//
// Rendering matches SpriteButton: composed at SPRITE resolution, then
// hard-upscaled (nearest-neighbour) into a display canvas at whole device
// pixels, absolutely positioned on a whole-device-pixel offset — no CSS
// image-rendering, nothing downstream can resample the pixels.

const PILL_TOP_URL = '/images/spintop.png';
const PILL_SHADOW_URL = '/images/spinshadow.png';
const PILL_W = 211;
const PILL_H = 84;
const FACE_H = 78;      // face art height (rows 0..77)
const PRESS_DEPTH = 6;  // face drop, sprite px — pressed face bottom = shadow bottom
const CAP = 24;         // 3-slice end-cap width, sprite px
const PIXEL_FONT = "'LoRes9OTWide-Bold'";

// ── Image loading (module-wide, once per URL) ─────────────────────────────
const imgCache = new Map<string, HTMLImageElement>();
const imgPromises = new Map<string, Promise<HTMLImageElement>>();
function loadSprite(url: string): Promise<HTMLImageElement> {
  let p = imgPromises.get(url);
  if (!p) {
    p = new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { imgCache.set(url, img); res(img); };
      img.onerror = rej;
      img.src = url;
    });
    imgPromises.set(url, p);
  }
  return p;
}
// Warm the spin-row sprites at module load so the first paint doesn't flash.
if (typeof window !== 'undefined') {
  for (const u of [PILL_TOP_URL, PILL_SHADOW_URL]) loadSprite(u).catch(() => {});
}

// Recoloured copy of a pill sprite per base colour. Every opaque pixel is a
// member of the art's cyan family, so each is mapped by its own OKLCH delta
// from ART_BASE — one memo per distinct source colour keeps it cheap.
const recolorCache = new Map<string, HTMLCanvasElement>();
function recoloredSprite(url: string, base: string): HTMLCanvasElement | null {
  const img = imgCache.get(url);
  if (!img) return null;
  const key = `${url}|${base}`;
  let c = recolorCache.get(key);
  if (c) return c;
  const baseRgb = hexToRgb(base);
  c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const memo = new Map<number, [number, number, number]>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let m = memo.get(k);
    if (!m) { m = applyArtDelta(baseRgb, ART_BASE, [d[i], d[i + 1], d[i + 2]]); memo.set(k, m); }
    [d[i], d[i + 1], d[i + 2]] = m;
  }
  ctx.putImageData(id, 0, 0);
  recolorCache.set(key, c);
  return c;
}

// 3-slice blit of a 211-wide pill layer into a W-wide box at vertical offset
// dy: caps verbatim, middle slab STRETCHED horizontally to fill (rows are
// near-uniform columns, so the stretch only widens the flat fill; the borders
// keep their vertical thickness).
function blitPill(ctx: CanvasRenderingContext2D, src: CanvasImageSource, W: number, dy: number): void {
  ctx.drawImage(src, 0, 0, CAP, PILL_H, 0, dy, CAP, PILL_H);
  ctx.drawImage(src, PILL_W - CAP, 0, CAP, PILL_H, W - CAP, dy, CAP, PILL_H);
  ctx.drawImage(src, CAP, 0, PILL_W - CAP * 2, PILL_H, CAP, dy, W - CAP * 2, PILL_H);
}

// Shared display maths: whole device px per sprite px + grid-snapped centering.
function useDeviceScale(pixelScale: number) {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const S = Math.max(1, Math.round(pixelScale * dpr));
  return { dpr, S };
}

interface SpritePillButtonProps {
  label?: string;
  onTap?: () => void;
  color: string;
  /** Total CSS height of the box (pill incl. peek centres inside). */
  height?: number;
  /** CSS px per sprite px — HALF the wheel block (see header). */
  pixelScale?: number;
  textColor?: string;
  /** Label size in CSS px (converted to sprite px internally). */
  fontSize?: number;
  letterSpacing?: number;
  /** Extra size multiplier applied at the device blit (same contract as
   *  SpriteIconButton.zoom): width stays fitted to the box, so zoom makes the
   *  pill TALLER with proportionally chunkier pixels + label. Fractional —
   *  not snapped to whole device px (±1 px pixel variance on hand-drawn art). */
  zoom?: number;
  /** Vertical nudge of the rendered pill inside its box, CSS px (+ = down). */
  offsetY?: number;
  style?: CSSProperties;
}

export function SpritePillButton({
  label = '',
  onTap,
  color,
  height = 54,
  pixelScale = 0.65,
  textColor = '#FFFFFF',
  fontSize = 16,
  letterSpacing = 1,
  zoom = 1,
  offsetY = 0,
  style,
}: SpritePillButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [width, setWidth] = useState(0);
  const [assetsTick, setAssetsTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const composeRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSprite(PILL_TOP_URL), loadSprite(PILL_SHADOW_URL)])
      .then(() => { if (!cancelled) setAssetsTick(t => t + 1); })
      .catch(() => {});
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.load(`${fontSize}px ${PIXEL_FONT}`)
      .then(() => { if (!cancelled) setAssetsTick(t => t + 1); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fontSize]);

  const { dpr, S } = useDeviceScale(pixelScale);
  const scaleCss = S / dpr;
  // Sprite width fits the box at the ZOOMED pixel size, so zoom grows the pill
  // vertically while the width keeps filling the flex space.
  const W = width > 0 ? Math.max(CAP * 2 + 1, Math.floor(width / (scaleCss * zoom))) : 0;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || W <= 0) return;
    const top = recoloredSprite(PILL_TOP_URL, color);
    const shadow = recoloredSprite(PILL_SHADOW_URL, color);
    if (!top || !shadow) return; // repaints via assetsTick once loaded

    if (!composeRef.current) composeRef.current = document.createElement('canvas');
    const compose = composeRef.current;
    if (compose.width !== W || compose.height !== PILL_H) { compose.width = W; compose.height = PILL_H; }
    const ctx = compose.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, PILL_H);

    const yOff = pressed ? PRESS_DEPTH : 0;
    blitPill(ctx, shadow, W, 0);
    blitPill(ctx, top, W, yOff);

    // ── Label — pixel font at sprite res, palette-snapped (no AA), exactly
    // like SpriteButton: AA pixels snap to a colour already on the canvas.
    if (label) {
      const pre = ctx.getImageData(0, 0, W, PILL_H);
      const seen = new Set<number>();
      for (let i = 0; i < pre.data.length; i += 4) {
        if (pre.data[i + 3] === 255) seen.add((pre.data[i] << 16) | (pre.data[i + 1] << 8) | pre.data[i + 2]);
      }
      const tRgb = hexToRgb(textColor);
      seen.add((tRgb[0] << 16) | (tRgb[1] << 8) | tRgb[2]);
      const pal = [...seen].map(v => [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);

      const fontPx = Math.max(5, Math.round(fontSize / scaleCss));
      ctx.fillStyle = textColor;
      ctx.font = `${fontPx}px ${PIXEL_FONT}, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.max(0, Math.round(letterSpacing / scaleCss))}px`;
      ctx.fillText(label, Math.round(W / 2), yOff + Math.round(FACE_H / 2) + 1);

      const post = ctx.getImageData(0, 0, W, PILL_H);
      const d = post.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] !== 255) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        let best = 0, bestDist = Infinity;
        for (let p = 0; p < pal.length; p++) {
          const dr = pal[p][0] - r, dg = pal[p][1] - g, db = pal[p][2] - b;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) { bestDist = dist; best = p; }
        }
        d[i] = pal[best][0]; d[i + 1] = pal[best][1]; d[i + 2] = pal[best][2];
      }
      ctx.putImageData(post, 0, 0);
    }

    // Hard upscale: sprite grid → device pixels (zoom applied here).
    const DW = Math.round(W * S * zoom), DH = Math.round(PILL_H * S * zoom);
    if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
    const dctx = canvas.getContext('2d')!;
    dctx.imageSmoothingEnabled = false;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, DW, DH);
    dctx.drawImage(compose, 0, 0, W, PILL_H, 0, 0, DW, DH);
  }, [W, S, zoom, color, textColor, fontSize, letterSpacing, label, pressed, assetsTick, scaleCss]);

  const release = () => setPressed(false);
  const cssW = Math.round(W * S * zoom) / dpr;
  const cssH = Math.round(PILL_H * S * zoom) / dpr;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const leftOff = snap(Math.max(0, (width - cssW) / 2));
  // Centre WITHOUT clamping (a zoomed pill overhangs its box symmetrically),
  // then apply the caller's downward nudge.
  const topOff = snap((height - cssH) / 2 + offsetY);

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
      {W > 0 && (
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            left: leftOff,
            top: topOff,
            display: 'block',
            width: cssW,
            height: cssH,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}

// ── Square icon button — one multicolour sprite, 2× downsampled ───────────
const ICON_PRESS = 2; // press nudge, sprite px

interface SpriteIconButtonProps {
  /** Sprite URL (e.g. /images/wheels.png) — native-res art, drawn 1:1. */
  src: string;
  onTap?: () => void;
  /** CSS box (width = height); the sprite centres inside. */
  box: number;
  /** CSS px per sprite px — same scale as the pill. */
  pixelScale?: number;
  /** Extra size multiplier applied at the device blit. Unlike the base scale
   *  it is NOT snapped to whole device px per sprite px (integer steps are far
   *  too coarse for a "bit larger" nudge) — nearest-neighbour at a fractional
   *  factor gives ±1-device-px pixel variance, invisible on this organic
   *  hand-drawn art. Keep 1 for grid-critical sprites. */
  zoom?: number;
  /** Vertical nudge of the rendered icon inside its box, CSS px (+ = down). */
  offsetY?: number;
  style?: CSSProperties;
}

export function SpriteIconButton({ src, onTap, box, pixelScale = 0.65, zoom = 1, offsetY = 0, style }: SpriteIconButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [assetsTick, setAssetsTick] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const composeRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSprite(src).then(() => { if (!cancelled) setAssetsTick(t => t + 1); }).catch(() => {});
    return () => { cancelled = true; };
  }, [src]);

  const { dpr, S } = useDeviceScale(pixelScale);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const img = imgCache.get(src);
    if (!canvas || !img) return; // repaints via assetsTick once loaded
    const W = img.width, H = img.height + ICON_PRESS;

    if (!composeRef.current) composeRef.current = document.createElement('canvas');
    const compose = composeRef.current;
    if (compose.width !== W || compose.height !== H) { compose.width = W; compose.height = H; }
    const ctx = compose.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, pressed ? ICON_PRESS : 0);

    const DW = Math.round(W * S * zoom), DH = Math.round(H * S * zoom);
    if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
    const dctx = canvas.getContext('2d')!;
    dctx.imageSmoothingEnabled = false;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, DW, DH);
    dctx.drawImage(compose, 0, 0, W, H, 0, 0, DW, DH);
  }, [src, S, zoom, pressed, assetsTick]);

  const release = () => setPressed(false);
  const img = imgCache.get(src);
  const cssW = img ? Math.round(img.width * S * zoom) / dpr : 0;
  const cssH = img ? Math.round((img.height + ICON_PRESS) * S * zoom) / dpr : 0;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const leftOff = snap(Math.max(0, (box - cssW) / 2));
  const topOff = snap(Math.max(0, (box - cssH) / 2) + offsetY);

  return (
    <div
      onPointerDown={() => onTap && setPressed(true)}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={() => onTap?.()}
      style={{
        width: box,
        height: box,
        position: 'relative',
        display: 'flow-root',
        cursor: onTap ? 'pointer' : 'default',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        ...style,
      }}
    >
      {img && (
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            left: leftOff,
            top: topOff,
            display: 'block',
            width: cssW,
            height: cssH,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
