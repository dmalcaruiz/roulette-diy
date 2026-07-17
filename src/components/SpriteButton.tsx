import { useState, useRef, useLayoutEffect, useEffect, type CSSProperties } from 'react';

// Hand-drawn sprite-sheet button — assembled from BOTONES PIXEL.png
// (public/images/botones-pixel.png) instead of procedural drawing.
//
// Sheet anatomy (sprite px, art-true coordinates — a couple of spritesheet.txt
// entries are off by one; the PNG wins):
//   • Three FACE layers sharing one 9-slice layout, drawn bottom→top:
//     fill (cyan #00C0FE placeholder → recolored to `color`, centre = plain
//     fill), semi-transparent white highlight, dark #1F263E stroke.
//   • A SHADE layer (blue #286CCA placeholder) — the peek tucked under the
//     face's bottom; only W/SW/S tiles exist (its top hides under the face).
//     Teal #2C9498 strips are the shade's own edge highlight.
//   • Only NW/W/SW/N/S tiles are drawn — E/NE/SE are horizontal mirrors.
//   • Corners are 6×6; N/S edges repeat every 3 px, W/E every 3 px.
//
// Rendering: composed at SPRITE resolution (1 sprite px = 1 block =
// `pixelScale` CSS px — the wheel grid), label drawn in the pixel font and
// palette-snapped (kills font AA), then the canvas CSS-upscales with
// image-rendering: pixelated. Press drops the face by `depth` onto the shade,
// exactly like PixelButton — instant, no eased transition.

const SHEET_URL = '/images/botones-pixel.png';
const PIXEL_FONT = "'LoRes9OTWide-Bold'";
const CORNER = 6; // corner tile size (sprite px)
const EDGE = 3;   // edge tile repeat length (sprite px)

// [x, y, w, h] source rects in the sheet.
type Tile = [number, number, number, number];
interface TileSet { nw?: Tile; n?: Tile; w?: Tile; sw?: Tile; s?: Tile }
const TILES: Record<'stroke' | 'hi' | 'fill' | 'shade' | 'shadeHi', TileSet> = {
  stroke:  { nw: [13, 0, 6, 6], n: [19, 0, 3, 6], w: [13, 20, 6, 3], sw: [13, 22, 6, 6], s: [19, 22, 3, 6] },
  hi:      { nw: [22, 0, 6, 6], n: [28, 0, 3, 6], w: [22, 20, 6, 3], sw: [22, 22, 6, 6], s: [28, 22, 3, 6] },
  fill:    { nw: [31, 0, 6, 6], n: [37, 0, 3, 6], w: [31, 20, 6, 3], sw: [31, 22, 6, 6], s: [37, 22, 3, 6] },
  // Shade tiles: the art sits at x50/x42 (the .txt says 49/40-41) — the boxes
  // below follow the pixels so W and SW stay column-aligned.
  shade:   { w: [49, 20, 6, 3], sw: [49, 22, 6, 6], s: [55, 22, 3, 6] },
  shadeHi: { w: [41, 20, 6, 3], sw: [41, 22, 6, 6] },
};

// ── Sheet loading (module-wide, once) ─────────────────────────────────────
let sheetImg: HTMLImageElement | null = null;
let sheetPromise: Promise<HTMLImageElement> | null = null;
function loadSheet(): Promise<HTMLImageElement> {
  if (!sheetPromise) {
    sheetPromise = new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { sheetImg = img; res(img); };
      img.onerror = rej;
      img.src = SHEET_URL;
    });
  }
  return sheetPromise;
}

// ── OKLab helpers (self-contained) ────────────────────────────────────────
// The sheet's dynamic colours are recolored by measuring, IN THE ART, how the
// shade (#286CCA) and shade-highlight (#2C9498) relate to the base cyan
// (#00C0FE) in OKLCH, then applying that same delta to the runtime base — so
// the artist's peek/glint relationships hold for any button colour.
function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lr = lin(r), lg = lin(g), lb = lin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const gam = (c: number) => {
    c = Math.max(0, Math.min(1, c));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  };
  return [gam(lr), gam(lg), gam(lb)];
}
// Apply the OKLCH delta (spriteBase → spriteVariant) to a runtime base colour.
function applyArtDelta(base: [number, number, number], spriteBase: [number, number, number], spriteVariant: [number, number, number]): [number, number, number] {
  const [Lb, ab, bb] = srgbToOklab(...base);
  const [Ls, as_, bs] = srgbToOklab(...spriteBase);
  const [Lv, av, bv] = srgbToOklab(...spriteVariant);
  const Cb = Math.hypot(ab, bb), Cs = Math.hypot(as_, bs), Cv = Math.hypot(av, bv);
  const hb = Math.atan2(bb, ab), hs = Math.atan2(bs, as_), hv = Math.atan2(bv, av);
  const L = Lb + (Lv - Ls);
  const C = Cs > 1e-6 ? Cb * (Cv / Cs) : Cv;
  const h = hb + (hv - hs);
  return oklabToSrgb(L, C * Math.cos(h), C * Math.sin(h));
}

// Sprite placeholder colours.
const ART_BASE: [number, number, number] = [0x00, 0xC0, 0xFE];  // fill cyan (also 00C0FF strays)
const ART_SHADE: [number, number, number] = [0x28, 0x6C, 0xCA]; // peek blue
const ART_GLINT: [number, number, number] = [0x2C, 0x94, 0x98]; // peek-highlight teal

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];
}

// Recoloured copy of the sheet per base colour (module cache).
const recolorCache = new Map<string, HTMLCanvasElement>();
function recoloredSheet(base: string): HTMLCanvasElement | null {
  if (!sheetImg) return null;
  let c = recolorCache.get(base);
  if (c) return c;
  const baseRgb = hexToRgb(base);
  const shade = applyArtDelta(baseRgb, ART_BASE, ART_SHADE);
  const glint = applyArtDelta(baseRgb, ART_BASE, ART_GLINT);
  c = document.createElement('canvas');
  c.width = sheetImg.width;
  c.height = sheetImg.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(sheetImg, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r === 0x00 && g === 0xC0 && (b === 0xFE || b === 0xFF)) { [d[i], d[i + 1], d[i + 2]] = baseRgb; }
    else if (r === 0x28 && g === 0x6C && b === 0xCA) { [d[i], d[i + 1], d[i + 2]] = shade; }
    else if (r === 0x2C && g === 0x94 && b === 0x98) { [d[i], d[i + 1], d[i + 2]] = glint; }
  }
  ctx.putImageData(id, 0, 0);
  recolorCache.set(base, c);
  return c;
}

interface SpriteButtonProps {
  label?: string;
  onTap?: () => void;
  color: string;
  /** Total CSS height incl. the peek. */
  height?: number;
  /** Peek depth in SPRITE px (how far the shade sticks out below the face). */
  depth?: number;
  /** CSS px per sprite px — pass the wheel's snapped block size. */
  pixelScale?: number;
  textColor?: string;
  /** Label size in CSS px (converted to sprite px internally). */
  fontSize?: number;
  letterSpacing?: number;
  style?: CSSProperties;
}

export function SpriteButton({
  label = '',
  onTap,
  color,
  height = 54,
  // 2 (was 4, then 3): minimal peek — the face (fill layer) keeps the
  // reclaimed pixels, so it reads taller inside the same button box.
  depth = 2,
  pixelScale = 2,
  textColor = '#FFFFFF',
  fontSize = 16,
  letterSpacing = 1,
  style,
}: SpriteButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [width, setWidth] = useState(0);
  const [assetsTick, setAssetsTick] = useState(0); // bumps when sheet/font arrive
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Offscreen used to COMPOSE the button at 1 canvas-px = 1 sprite-px, then
  // hard-upscaled (nearest-neighbour drawImage) into the display canvas at
  // full device resolution — so the sprite pixels are baked into real device
  // pixels and never rely on CSS `image-rendering` (which browsers interpolate
  // inconsistently) or land off the device grid via fractional centering.
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
    loadSheet().then(() => { if (!cancelled) setAssetsTick(t => t + 1); }).catch(() => {});
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.load(`${fontSize}px ${PIXEL_FONT}`)
      .then(() => { if (!cancelled) setAssetsTick(t => t + 1); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fontSize]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const sheet = recoloredSheet(color);
    if (!sheet) return; // repaints via assetsTick once loaded

    // Sprite-space geometry. Width rounds DOWN to whole sprite px (the display
    // canvas is grid-snapped in any leftover fraction); height rounds to nearest.
    const W = Math.max(CORNER * 2 + 1, Math.floor(width / pixelScale));
    const H = Math.max(CORNER * 2 + depth, Math.round(height / pixelScale));
    const faceH = H - depth;

    // Compose on the offscreen at sprite resolution (1 canvas-px = 1 sprite-px).
    if (!composeRef.current) composeRef.current = document.createElement('canvas');
    const compose = composeRef.current;
    if (compose.width !== W || compose.height !== H) { compose.width = W; compose.height = H; }
    const ctx = compose.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const blit = (t: Tile, dx: number, dy: number, mirror = false) => {
      if (!mirror) { ctx.drawImage(sheet, t[0], t[1], t[2], t[3], dx, dy, t[2], t[3]); return; }
      ctx.save();
      ctx.translate(dx + t[2], dy);
      ctx.scale(-1, 1);
      ctx.drawImage(sheet, t[0], t[1], t[2], t[3], 0, 0, t[2], t[3]);
      ctx.restore();
    };
    // Repeat a 3-px edge tile along a clipped run (handles non-multiple runs).
    const run = (t: Tile, rx: number, ry: number, rw: number, rh: number, horizontal: boolean, mirror = false) => {
      if (rw <= 0 || rh <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      if (horizontal) for (let x = rx; x < rx + rw; x += EDGE) blit(t, x, ry, mirror);
      else for (let y = ry; y < ry + rh; y += EDGE) blit(t, rx, y, mirror);
      ctx.restore();
    };
    // One 9-slice layer over the face box (corners + edge runs). E-side =
    // mirrored W-side, per the sheet's "invert the tile" convention.
    const layer = (set: TileSet, y0: number, h: number) => {
      if (set.nw) { blit(set.nw, 0, y0); blit(set.nw, W - CORNER, y0, true); }
      if (set.n) run(set.n, CORNER, y0, W - CORNER * 2, CORNER, true);
      if (set.w) { run(set.w, 0, y0 + CORNER, CORNER, h - CORNER * 2, false); run(set.w, W - CORNER, y0 + CORNER, CORNER, h - CORNER * 2, false, true); }
      if (set.sw) { blit(set.sw, 0, y0 + h - CORNER); blit(set.sw, W - CORNER, y0 + h - CORNER, true); }
      if (set.s) run(set.s, CORNER, y0 + h - CORNER, W - CORNER * 2, CORNER, true);
    };
    // Solid interior of a face-shaped box, avoiding the four corner boxes
    // (their cutouts must stay transparent — the tiles carry the curve):
    // a middle column inset 1px from the top/bottom stroke rows, plus side
    // bands between the corners inset 1px from the outline column.
    const interior = (col: string, boxY: number, boxH: number) => {
      ctx.fillStyle = col;
      ctx.fillRect(CORNER, boxY + 1, W - CORNER * 2, boxH - 2);
      const bandH = Math.max(0, boxH - CORNER * 2);
      ctx.fillRect(1, boxY + CORNER, CORNER - 1, bandH);
      ctx.fillRect(W - CORNER, boxY + CORNER, CORNER - 1, bandH);
    };

    const baseRgb = hexToRgb(color);
    const shadeRgb = applyArtDelta(baseRgb, ART_BASE, ART_SHADE);
    const rgb = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

    // ── Shade (peek) — bottom-anchored, no top tiles (face covers it) ──
    {
      // Start just high enough to sit under the FACE's bottom-corner curve.
      // Any higher (e.g. y = depth) and the face's TOP-corner cutouts expose
      // stray shade/glint pixels at the button's top corners.
      const sTop = faceH - CORNER;
      ctx.fillStyle = rgb(shadeRgb);
      // Interior column + side bands above the bottom corner boxes. The shade
      // silhouette is 1 px inset all around (matches its tiles).
      ctx.fillRect(CORNER, sTop, W - CORNER * 2, H - CORNER - sTop);
      ctx.fillRect(1, sTop, CORNER - 1, H - CORNER - sTop);
      ctx.fillRect(W - CORNER, sTop, CORNER - 1, H - CORNER - sTop);
      const sh = TILES.shade;
      run(sh.w!, 0, sTop, CORNER, H - CORNER - sTop, false);
      run(sh.w!, W - CORNER, sTop, CORNER, H - CORNER - sTop, false, true);
      blit(sh.sw!, 0, H - CORNER);
      blit(sh.sw!, W - CORNER, H - CORNER, true);
      run(sh.s!, CORNER, H - CORNER, W - CORNER * 2, CORNER, true);
      // Edge glint on the peek (left + mirrored right).
      const gl = TILES.shadeHi;
      run(gl.w!, 0, sTop, CORNER, H - CORNER - sTop, false);
      run(gl.w!, W - CORNER, sTop, CORNER, H - CORNER - sTop, false, true);
      blit(gl.sw!, 0, H - CORNER);
      blit(gl.sw!, W - CORNER, H - CORNER, true);
    }

    // ── Face: fill interior + fill/highlight tile layers ──
    const yOff = pressed ? depth : 0;
    interior(color, yOff, faceH);
    layer(TILES.fill, yOff, faceH);
    layer(TILES.hi, yOff, faceH);
    // ── Stroke — wraps the WHOLE button (face + peek), not just the face:
    // the shade tiles are inset 1px exactly like the fill, i.e. drawn to sit
    // inside this same outline. The stroke box rides the press (yOff → H) so
    // the whole unit compresses as one sprite when pressed. Drawn last so the
    // outline overlaps every layer edge, including the shade's bare bottom row.
    layer(TILES.stroke, yOff, H - yOff);

    // ── Label — pixel font at sprite res, then palette-snapped (no AA) ──
    if (label) {
      // Palette = every colour already on the canvas + the text colour; text
      // AA pixels snap to one of them (hard pixels), art pixels are already
      // exact members so they never change.
      const pre = ctx.getImageData(0, 0, W, H);
      const seen = new Set<number>();
      for (let i = 0; i < pre.data.length; i += 4) {
        if (pre.data[i + 3] === 255) seen.add((pre.data[i] << 16) | (pre.data[i + 1] << 8) | pre.data[i + 2]);
      }
      const tRgb = hexToRgb(textColor);
      seen.add((tRgb[0] << 16) | (tRgb[1] << 8) | tRgb[2]);
      const pal = [...seen].map(v => [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]);

      const fontPx = Math.max(5, Math.round(fontSize / pixelScale));
      ctx.fillStyle = textColor;
      ctx.font = `${fontPx}px ${PIXEL_FONT}, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${Math.max(0, Math.round(letterSpacing / pixelScale))}px`;
      ctx.fillText(label, Math.round(W / 2), yOff + Math.round(faceH / 2) + 1);

      const post = ctx.getImageData(0, 0, W, H);
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

    // ── Hard upscale: sprite grid → device pixels ──
    // Each sprite px becomes an S×S block of REAL device pixels (S is whole,
    // since pixelScale·dpr is integer by construction — spriteScaleFor snaps
    // it). imageSmoothingEnabled=false ⇒ nearest-neighbour ⇒ zero AA. The
    // display canvas is then shown 1:1 (CSS px = device px / dpr), so nothing
    // downstream can re-interpolate the pixels.
    const dpr = window.devicePixelRatio || 1;
    const S = Math.max(1, Math.round(pixelScale * dpr));
    const DW = W * S, DH = H * S;
    if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
    const dctx = canvas.getContext('2d')!;
    dctx.imageSmoothingEnabled = false;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, DW, DH);
    dctx.drawImage(compose, 0, 0, W, H, 0, 0, DW, DH);
  }, [width, height, depth, pixelScale, color, textColor, fontSize, letterSpacing, label, pressed, assetsTick]);

  const release = () => setPressed(false);

  // Display box + grid-snapped centering. CSS size = whole sprite px × scale;
  // the canvas is absolutely positioned at a WHOLE-device-pixel offset inside
  // the container so the baked device pixels can't be resampled by a
  // fractional centering position.
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const S = Math.max(1, Math.round(pixelScale * dpr)); // whole device px / sprite px (matches the bake)
  const spriteW = width > 0 ? Math.max(CORNER * 2 + 1, Math.floor(width / pixelScale)) : 0;
  const spriteH = Math.max(CORNER * 2 + depth, Math.round(height / pixelScale));
  // CSS size derived from the baked DEVICE dimensions (W·S) so the canvas
  // shows exactly 1 device px per baked px — no residual scaling even if a
  // caller passes a scale where pixelScale·dpr isn't already whole.
  const cssW = (spriteW * S) / dpr;
  const cssH = (spriteH * S) / dpr;
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const leftOff = snap(Math.max(0, (width - cssW) / 2));
  const topOff = snap(Math.max(0, (height - cssH) / 2));

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
      {spriteW > 0 && (
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
