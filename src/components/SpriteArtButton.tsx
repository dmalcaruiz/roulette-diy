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
const CAP = 24;         // 3-slice end-cap width, art px
// Extra chunking for the PILL (art + letters): compose on a grid downsampled
// from the art by this factor, upscale by the same factor extra — same
// on-screen size, chunkier pixels. Native (1) read too high-res next to the
// icons, 2 was too crunchy; 1.5 splits the difference. Icons render native
// (ICON_DOWN below).
const PILL_DOWN = 1.5;
const R_PILL_H = PILL_H / PILL_DOWN;              // 56
const R_FACE_H = Math.round(78 / PILL_DOWN);      // face art rows 0..77 → 52
const R_PRESS = Math.round(6 / PILL_DOWN);        // face drop — pressed face bottom = shadow bottom
const R_CAP = CAP / PILL_DOWN;                    // 16
// Label face: cozy rounded Baloo 2 (self-hosted, see index.css). Drawn at
// sprite res and palette-snapped, so it pixellates with the art; the LoRes
// pixel face is the fallback while it loads. Used only for labels that have
// no hand-drawn letter sprites (see LETTER_SPRITES).
const LABEL_FONT = "'Baloo 2', 'LoRes9OTWide-Bold'";
const LABEL_WEIGHT = 700;
// Hand-drawn letter art for the SPIN label (~35×45 native px, authored at 2×
// the render grid like the pill — drawn downsampled by PILL_DOWN). When every
// character of a label has an entry the label renders from these sprites
// (bottom-aligned, kerned, no warp — the art carries its own character);
// otherwise it falls back to the Baloo 2 font path.
const LETTER_SPRITES: Record<string, string> = {
  S: '/images/letter-s.png',
  P: '/images/letter-p.png',
  I: '/images/letter-i.png',
  N: '/images/letter-n.png',
};
// Per-pair kerning tweaks for the sprite letters (render px added to the base
// gap between the pair) — the I art carries left padding, so it tucks in
// closer after the P.
const PAIR_KERN: Record<string, number> = { SP: -1, PI: -3 };

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
  for (const u of [PILL_TOP_URL, PILL_SHADOW_URL, ...Object.values(LETTER_SPRITES)]) loadSprite(u).catch(() => {});
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

// 3-slice blit of a pill layer into a W-render-px box at vertical offset dy:
// caps verbatim (nearest-downsampled by PILL_DOWN via the art→render size
// mismatch; the caller's ctx has smoothing off), middle slab STRETCHED
// horizontally to fill (rows are near-uniform columns, so the stretch only
// widens the flat fill; the borders keep their vertical thickness).
function blitPill(ctx: CanvasRenderingContext2D, src: CanvasImageSource, W: number, dy: number): void {
  ctx.drawImage(src, 0, 0, CAP, PILL_H, 0, dy, R_CAP, R_PILL_H);
  ctx.drawImage(src, PILL_W - CAP, 0, CAP, PILL_H, W - R_CAP, dy, R_CAP, R_PILL_H);
  ctx.drawImage(src, CAP, 0, PILL_W - CAP * 2, PILL_H, R_CAP, dy, W - R_CAP * 2, R_PILL_H);
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
  /** Staggered per-letter idle wave on the label. The wave is quantized to
   *  whole render px and the pill only re-bakes when a letter steps, so the
   *  rAF loop is almost always a no-op compare. */
  waveLabel?: boolean;
  style?: CSSProperties;
}

// Label wave tuning: every WAVE_INTERVAL seconds the letters play ONE
// staggered bob (letter i starts WAVE_STAGGER_S after letter i-1), then the
// label rests until the next burst. Each bob is a snappy up-flick of WAVE_AMP
// render px with a small rebound dip past the baseline on the way down —
// bouncy, but stepped to whole pixels so it stays pixel-art.
const WAVE_AMP = 4;
const WAVE_INTERVAL = 4;
const WAVE_PULSE = 0.75;
const WAVE_STAGGER_S = 0.2;
const WAVE_UP = 0.55;       // fraction of the pulse spent on the up-flick
const WAVE_REBOUND = 0.35;  // rebound dip amplitude, fraction of WAVE_AMP
function waveBob(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < WAVE_UP) return -Math.round(WAVE_AMP * Math.sin((Math.PI * p) / WAVE_UP));
  return Math.round(WAVE_AMP * WAVE_REBOUND * Math.sin((Math.PI * (p - WAVE_UP)) / (1 - WAVE_UP)));
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
  waveLabel = false,
  style,
}: SpritePillButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [width, setWidth] = useState(0);
  const [assetsTick, setAssetsTick] = useState(0);
  // Joined per-letter wave offsets (e.g. "0,-1,-2,-1") — string state so an
  // unchanged frame is reference-equal and re-renders/bakes are skipped.
  const [wave, setWave] = useState('');
  const waveRef = useRef('');
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const composeRef = useRef<HTMLCanvasElement | null>(null);
  const labelRef = useRef<HTMLCanvasElement | null>(null); // scratch for the per-letter dome warp

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
    Promise.all([PILL_TOP_URL, PILL_SHADOW_URL, ...Object.values(LETTER_SPRITES)].map(u => loadSprite(u)))
      .then(() => { if (!cancelled) setAssetsTick(t => t + 1); })
      .catch(() => {});
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.load(`${LABEL_WEIGHT} ${fontSize}px ${LABEL_FONT}`)
      .then(() => { if (!cancelled) setAssetsTick(t => t + 1); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fontSize]);

  // Periodic staggered letter bob — one burst every WAVE_INTERVAL, then rest.
  // Offsets are rounded to whole render px; state only changes (→ re-bake)
  // when some letter actually steps, so between bursts the loop is a no-op.
  useEffect(() => {
    if (!label || !waveLabel) { waveRef.current = ''; setWave(''); return; }
    let raf = 0;
    const t0 = performance.now();
    const n = [...label].length;
    const tick = (now: number) => {
      const cycle = ((now - t0) / 1000) % WAVE_INTERVAL;
      const offs: number[] = [];
      for (let i = 0; i < n; i++) {
        offs.push(waveBob((cycle - i * WAVE_STAGGER_S) / WAVE_PULSE));
      }
      const key = offs.join(',');
      if (key !== waveRef.current) { waveRef.current = key; setWave(key); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [label, waveLabel]);

  const { dpr, S } = useDeviceScale(pixelScale);
  const scaleCss = S / dpr;
  // Sprite width fits the box at the ZOOMED pixel size, so zoom grows the pill
  // vertically while the width keeps filling the flex space.
  const W = width > 0 ? Math.max(R_CAP * 2 + 1, Math.floor(width / (scaleCss * zoom * PILL_DOWN))) : 0;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || W <= 0) return;
    const top = recoloredSprite(PILL_TOP_URL, color);
    const shadow = recoloredSprite(PILL_SHADOW_URL, color);
    if (!top || !shadow) return; // repaints via assetsTick once loaded

    if (!composeRef.current) composeRef.current = document.createElement('canvas');
    const compose = composeRef.current;
    if (compose.width !== W || compose.height !== R_PILL_H) { compose.width = W; compose.height = R_PILL_H; }
    const ctx = compose.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, R_PILL_H);

    const yOff = pressed ? R_PRESS : 0;
    blitPill(ctx, shadow, W, 0);
    blitPill(ctx, top, W, yOff);

    // ── Label — hand-drawn LETTER SPRITES when every character has one (see
    // LETTER_SPRITES): each ~35×45 letter draws 2×-downsampled onto the
    // render grid, bottom-aligned on a flat base, kerned by `letterSpacing`,
    // with the wave-burst offsets shifting whole letters during the periodic
    // stagger bob. No warp — the art carries its own hand-drawn character.
    // Labels without sprite coverage fall back to Baloo 2 with the uniform
    // baseline-anchored stretch. Either way the palette snap below hardens
    // every edge into hard pixels.
    if (label) {
      const pre = ctx.getImageData(0, 0, W, R_PILL_H);
      const seen = new Set<number>();
      for (let i = 0; i < pre.data.length; i += 4) {
        if (pre.data[i + 3] === 255) seen.add((pre.data[i] << 16) | (pre.data[i + 1] << 8) | pre.data[i + 2]);
      }
      const tRgb = hexToRgb(textColor);
      seen.add((tRgb[0] << 16) | (tRgb[1] << 8) | tRgb[2]);
      const pal = [...seen].map(v => [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);

      const kern = Math.max(1, Math.round(letterSpacing / (scaleCss * PILL_DOWN)));
      const chars = [...label];
      const waveOffs = wave ? wave.split(',').map(Number) : [];
      const sprites = chars.map(c => {
        const url = LETTER_SPRITES[c.toUpperCase()];
        return url ? imgCache.get(url) : undefined;
      });

      if (sprites.every(Boolean)) {
        const dims = sprites.map(im => ({ w: Math.round(im!.width / PILL_DOWN), h: Math.round(im!.height / PILL_DOWN) }));
        const maxH = Math.max(...dims.map(d => d.h));
        const gap = (i: number) => kern + (PAIR_KERN[(chars[i] + chars[i + 1] || '').toUpperCase()] || 0);
        let total = dims.reduce((s, d) => s + d.w, 0);
        for (let i = 0; i < chars.length - 1; i++) total += gap(i);
        let x = Math.round(W / 2 - total / 2);
        const top0 = yOff + Math.round((R_FACE_H - maxH) / 2);
        for (let i = 0; i < chars.length; i++) {
          const im = sprites[i]!;
          const d = dims[i];
          ctx.drawImage(im, 0, 0, im.width, im.height, x, top0 + (maxH - d.h) + (waveOffs[i] || 0), d.w, d.h);
          x += d.w + gap(i);
        }
      } else {
        const fontPx = Math.max(5, Math.round(fontSize / (scaleCss * PILL_DOWN)));
        const arch = Math.max(1, Math.round(fontPx * 0.14)); // uniform stretch height
        if (!labelRef.current) labelRef.current = document.createElement('canvas');
        const lab = labelRef.current;
        if (lab.width !== W || lab.height !== R_PILL_H) { lab.width = W; lab.height = R_PILL_H; }
        const lctx = lab.getContext('2d')!;
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, W, R_PILL_H);
        lctx.fillStyle = textColor;
        lctx.font = `${LABEL_WEIGHT} ${fontPx}px ${LABEL_FONT}, monospace`;
        lctx.textAlign = 'left';
        lctx.textBaseline = 'alphabetic';
        // Vertical centre from the whole word's measured glyph box ('middle'
        // trusts font metrics, which sat Baloo 2 visibly off-centre); +arch/2
        // compensates the stretch lifting the letters' tops.
        const met = lctx.measureText(label);
        const asc = met.actualBoundingBoxAscent || fontPx * 0.7;
        const desc = met.actualBoundingBoxDescent || 0;
        const baseY = Math.round(yOff + R_FACE_H / 2 + arch / 2 + (asc - desc) / 2);
        const widths = chars.map(c => lctx.measureText(c).width);
        const total = widths.reduce((s, w) => s + w, 0) + kern * (chars.length - 1);
        const startX = W / 2 - total / 2;
        let x = startX;
        for (let i = 0; i < chars.length; i++) {
          lctx.fillText(chars[i], Math.round(x), baseY + (waveOffs[i] || 0));
          x += widths[i] + kern;
        }
        // Uniform warp, flat base: the text band stretches vertically by
        // `arch`, anchored at the baseline.
        const bandTop = Math.max(0, baseY - Math.ceil(asc) - 4);
        const bandH = Math.min(R_PILL_H, baseY + 4) - bandTop;
        const bx0 = Math.floor(startX) - 2, bx1 = Math.ceil(startX + total) + 2;
        ctx.drawImage(lab, bx0, bandTop, bx1 - bx0, bandH, bx0, bandTop - arch, bx1 - bx0, bandH + arch);
      }

      const post = ctx.getImageData(0, 0, W, R_PILL_H);
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
    const DW = Math.round(W * S * zoom * PILL_DOWN), DH = Math.round(R_PILL_H * S * zoom * PILL_DOWN);
    if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
    const dctx = canvas.getContext('2d')!;
    dctx.imageSmoothingEnabled = false;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, DW, DH);
    dctx.drawImage(compose, 0, 0, W, R_PILL_H, 0, 0, DW, DH);
  }, [W, S, zoom, color, textColor, fontSize, letterSpacing, label, pressed, assetsTick, scaleCss, wave]);

  const release = () => setPressed(false);
  const cssW = Math.round(W * S * zoom * PILL_DOWN) / dpr;
  const cssH = Math.round(R_PILL_H * S * zoom * PILL_DOWN) / dpr;
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

// ── Square icon button — one multicolour sprite ───────────────────────────
// Icons render NATIVE (no downsample — chunked variants read mangled); only
// the pill takes the PILL_DOWN treatment.
const ICON_DOWN = 1;
const ICON_PRESS = 2; // press nudge, render px

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
    // Render grid = art nearest-downsampled by ICON_DOWN (matches the pill).
    const W = Math.round(img.width / ICON_DOWN), H = Math.round(img.height / ICON_DOWN) + ICON_PRESS;

    if (!composeRef.current) composeRef.current = document.createElement('canvas');
    const compose = composeRef.current;
    if (compose.width !== W || compose.height !== H) { compose.width = W; compose.height = H; }
    const ctx = compose.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, img.width, img.height, 0, pressed ? ICON_PRESS : 0, W, H - ICON_PRESS);

    const DW = Math.round(W * S * zoom * ICON_DOWN), DH = Math.round(H * S * zoom * ICON_DOWN);
    if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
    const dctx = canvas.getContext('2d')!;
    dctx.imageSmoothingEnabled = false;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, DW, DH);
    dctx.drawImage(compose, 0, 0, W, H, 0, 0, DW, DH);
  }, [src, S, zoom, pressed, assetsTick]);

  const release = () => setPressed(false);
  const img = imgCache.get(src);
  const cssW = img ? Math.round(Math.round(img.width / ICON_DOWN) * S * zoom * ICON_DOWN) / dpr : 0;
  const cssH = img ? Math.round((Math.round(img.height / ICON_DOWN) + ICON_PRESS) * S * zoom * ICON_DOWN) / dpr : 0;
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
