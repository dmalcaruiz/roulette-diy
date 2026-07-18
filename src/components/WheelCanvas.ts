import { WheelItem } from '../models/types';
import { hexToRgba, lerpColor, withAlpha, oklchShade, oklchMix, readableTextColor, tintedTextColor } from '../utils/colorUtils';
import { drawIconNode, getSegmentImage, drawSegmentImageCover } from './segmentVisuals';

// Preset segment textures — a repeating pattern overlaid on the fill colour.
// 'none' = solid colour. Shared with the editor's texture picker.
export const SEGMENT_TEXTURES = ['none', 'dots', 'stripes', 'grid', 'crosshatch'] as const;
export type SegmentTexture = (typeof SEGMENT_TEXTURES)[number];

// Semi-transparent contrasting overlay for the pattern, so it reads on both
// light and dark fills.
function textureOverlayColor(fill: string): string {
  return withAlpha(readableTextColor(fill), 0.18);
}

// Draw a repeating pattern clipped to a segment's wedge `path`, over its fill.
// Centred on (cx, cy) and spanning the wheel radius, so every segment shares one
// aligned global pattern (it rotates with the wheel, as the call site is inside
// the rotated frame).
function drawSegmentTexture(
  ctx: CanvasRenderingContext2D, path: Path2D, cx: number, cy: number,
  radius: number, texture: string, overlay: string,
): void {
  if (!texture || texture === 'none' || radius <= 0) return;
  const sp = Math.max(7, radius * 0.05); // pattern spacing
  ctx.save();
  ctx.clip(path);
  ctx.fillStyle = overlay;
  ctx.strokeStyle = overlay;
  if (texture === 'dots') {
    const dr = sp * 0.2;
    for (let x = cx - radius; x <= cx + radius; x += sp) {
      for (let y = cy - radius; y <= cy + radius; y += sp) {
        ctx.beginPath();
        ctx.arc(x, y, dr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (texture === 'grid') {
    ctx.lineWidth = Math.max(1, sp * 0.09);
    for (let x = cx - radius; x <= cx + radius; x += sp) {
      ctx.beginPath(); ctx.moveTo(x, cy - radius); ctx.lineTo(x, cy + radius); ctx.stroke();
    }
    for (let y = cy - radius; y <= cy + radius; y += sp) {
      ctx.beginPath(); ctx.moveTo(cx - radius, y); ctx.lineTo(cx + radius, y); ctx.stroke();
    }
  } else { // stripes / crosshatch — diagonal lines
    ctx.lineWidth = Math.max(1, sp * 0.16);
    for (let o = -2 * radius; o <= 2 * radius; o += sp) {
      ctx.beginPath();
      ctx.moveTo(cx - radius, cy - radius + o);
      ctx.lineTo(cx + radius, cy + radius + o);
      ctx.stroke();
    }
    if (texture === 'crosshatch') {
      for (let o = -2 * radius; o <= 2 * radius; o += sp) {
        ctx.beginPath();
        ctx.moveTo(cx - radius, cy + radius - o);
        ctx.lineTo(cx + radius, cy - radius - o);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

// Draw a segment's visual (custom image or lucide icon) at the slice's outer
// edge. Called inside the per-segment rotated frame (slice centre = +X), so its
// right edge aligns with `textX` (= radius − 20·scale) — matching the space
// computeFittedText reserves. Skips when there's none, or shows a faint
// placeholder while a custom image is still decoding (it pops in on load).
function drawSegmentVisual(
  ctx: CanvasRenderingContext2D, item: WheelItem,
  textX: number, imageSize: number, scale: number, fill: string,
): void {
  if (!item.imagePath && !item.iconName) return;
  const vis = imageSize * scale;
  if (vis <= 0) return;
  const cx = textX - vis / 2;
  if (item.imagePath) {
    const img = getSegmentImage(item.imagePath);
    const r = Math.min(vis * 0.16, vis / 2);
    if (img) {
      drawSegmentImageCover(ctx, img, cx - vis / 2, -vis / 2, vis, vis, r);
    } else {
      ctx.save();
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(cx - vis / 2, -vis / 2, vis, vis, r);
      else ctx.rect(cx - vis / 2, -vis / 2, vis, vis);
      ctx.fillStyle = withAlpha(readableTextColor(fill), 0.14);
      ctx.fill();
      ctx.restore();
    }
  } else if (item.iconName) {
    drawIconNode(ctx, item.iconName, cx, 0, vis * 0.9, withAlpha(readableTextColor(fill), 0.92));
  }
}

// Minimum combined (strokeWidth + outerStrokeWidth) for the decorative outer
// dots to be available/drawn — below this there isn't enough chrome band to
// host them. Shared with the editor so the toggle unlocks at the same point.
export const OUTER_DOTS_MIN_STROKE = 12;
// No-bg-circle corner cull (see drawOuterDots): a DIVIDER dot is dropped once
// the rounded corners on both sides have undercut it by this many dot-radii of
// arc. Lower = dots vanish at a gentler corner radius. In-between dots have no
// such grace factor — they drop the instant their centre leaves solid fill.
const DIVIDER_CORNER_CULL = 0.75;

// Default bezel-dot colour: black at 40% over a light base, white at 40% over a
// dark one — soft beads that read on the chrome either way (20% washed out).
function defaultDotColor(baseColor: string): string {
  const { r, g, b } = hexToRgba(baseColor);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)';
}

// Resolve the bezel-dot fill for the non-'segment' modes (segment mode tints
// per-dot inside drawOuterDots).
function bezelDotColor(mode: 'default' | 'custom' | 'segment' | undefined,
                       baseColor: string, customColor?: string): string {
  if (mode === 'custom') return customColor || '#FFFFFF';
  return defaultDotColor(baseColor); // 'default' (and a safe fill for 'segment')
}

// The opaque colours the bezel dots actually LAND as on the baked wheel — what
// the pixelate palette must contain. The default dot is 40% ink composited over
// the chrome band (wheelBaseColor); 'segment' divider dots are the oklch mix of
// each adjacent pair (interior dots use the slice colours, already in the
// palette). Without these entries the palette vote snapped resting dots to the
// nearest segment colour (grey default dots read purple at rest, then back to
// grey on motion frames, which skip the palette).
function bezelDotPaletteColors(mode: 'default' | 'custom' | 'segment' | undefined,
                               baseColor: string, customColor: string | undefined,
                               items: WheelItem[]): string[] {
  if (mode === 'segment') {
    const n = items.length;
    const mixes: string[] = [];
    for (let i = 0; i < n; i++) mixes.push(oklchMix(items[(i - 1 + n) % n].color, items[i].color));
    return mixes;
  }
  if (mode === 'custom') return [customColor || '#FFFFFF'];
  const { r, g, b } = hexToRgba(baseColor);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return [lerpColor(baseColor, lum > 0.5 ? '#000000' : '#FFFFFF', 0.4)];
}

// Decorative carnival-bulb bezel: a dot on each segment divider plus evenly-
// spaced in-between dots. Spacing is set by the dot SIZE (which the stroke band
// defines) — ~9 dot-diameters of arc, so a ~30-wide band lands ~30° apart (the
// reference) and a thinner band makes smaller dots that pack tighter → MORE
// in-between dots. A super-slim segment, whose two divider dots would crowd,
// drops those edge dots for ONE central dot. Geometry in render px.
function drawOuterDots(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number,
  strokeWidth: number, outerStrokeWidth: number, dotColor: string,
  dividerAngles: number[], sweeps: number[], dotRadiusScale = 1,
  // When given, dots are tinted per-slice ('segment' mode): a divider dot mixes
  // its two neighbours; interior + slim dots take the slice colour.
  segmentColors?: string[],
  // Corner culling — ONLY when there's no background circle to back the dots
  // (`cullAtCorners`). `cornerRadius` (render px) is the segment corner rounding;
  // where a rounded corner pulls the segment fill inward, a dot would float over
  // the bare notch. So as the corner grows: divider dots drop first (once the
  // rounding undercuts them), then in-between dots peel off from the ends inward.
  // With a bg circle the notches are filled, so this is off and every dot draws.
  cornerRadius = 0,
  cullAtCorners = false,
): void {
  // Full chrome band: the divider stroke STRADDLES `radius` (±strokeWidth/2) and
  // the outer stroke sits beyond it → union centred at radius+osw/2; the dots
  // ride that centre. The band's total width also drives the dot size below.
  const bandWidth = strokeWidth + outerStrokeWidth;
  if (bandWidth <= 0 || radius <= 0) return;
  const dotRing = radius + outerStrokeWidth / 2;
  // Dot radius tracks the band, so a wider stroke ⇒ bigger dots (and the spacing
  // + slim thresholds below scale with it, since they derive from dotR). The
  // radius term is just a loose safety cap so dots can't blow up on tiny wheels.
  // `dotRadiusScale` lets the thumbnail cancel its ×1.15 stroke boost on the
  // dots (which would otherwise make them read oversized on the mini previews).
  // Low floor (0.5) so small-band dots stay proportionally TINY on the small
  // preview tiles instead of clamping to 1px (the full wheel never hits it —
  // its dots are always ≥~4px once the option is unlocked).
  const dotR = Math.max(0.5, Math.min(bandWidth * 0.34, radius * 0.08) * dotRadiusScale);
  const dot = (a: number, color: string) => {
    // Ride the hand-drawn rim: offset the dot ring by the same rim wobble the
    // silhouette uses (rimNoise at this angle), so the bezel band follows the
    // deformed edge instead of sitting on a perfect circle.
    const r = dotRing + (ROUGHNESS.enabled ? rimNoise(a, radius) : 0);
    const ox = cx + Math.cos(a) * r;
    const oy = cy + Math.sin(a) * r;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (ROUGHNESS.enabled) {
      // Per-dot hash from the angle (+ per-wheel phase) → a little SIZE variation
      // and a slightly irregular, hand-drawn blob instead of a perfect circle.
      const hash = (k: number) => {
        const x = Math.sin(a * k + roughPhases[0]) * 43758.5453;
        return x - Math.floor(x);
      };
      const dr = dotR * (0.925 + 0.15 * hash(91.7));   // ~[0.925, 1.075]× size
      const w0 = hash(12.9) * Math.PI * 2;
      const w1 = hash(78.2) * Math.PI * 2;
      const steps = 10;
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const wob = 1 + 0.07 * (Math.sin(t * 2 + w0) * 0.6 + Math.sin(t * 3 + w1) * 0.4);
        const px = ox + Math.cos(t) * dr * wob;
        const py = oy + Math.sin(t) * dr * wob;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(ox, oy, dotR, 0, Math.PI * 2);
    }
    ctx.fill();
  };
  const n = dividerAngles.length;

  // Spacing relative to the dot size: ~7.5 diameters (= 15·dotR) of arc between
  // dots. Smaller dots ⇒ smaller gap ⇒ more in-between dots. The per-segment
  // count then just follows from its arc (pure geometry → symmetric).
  const targetGap = (15 * dotR) / dotRing;
  // A segment whose two divider dots would sit closer than ~1¼ diameters is
  // "super slim": suppress its (shared) edge dots and place one central dot.
  const slimArc = (2.5 * dotR) / dotRing;
  const slim = sweeps.map((s) => s < slimArc);

  // Corner cull (no-bg-circle only): the arc rounded away at each segment end,
  // clamped to sweep/2 to mirror buildSegmentPath. The solid outer fill of
  // segment i then spans [cornerArc, sweep − cornerArc]; anything outside floats.
  // `dotAngR` is a dot's angular half-width, the yardstick for the divider grace.
  const cornerArcs = cullAtCorners && cornerRadius > 0
    ? sweeps.map((s) => Math.min(cornerRadius / radius, s / 2))
    : null;
  const dotAngR = dotR / dotRing;
  // Per-divider cull: divider i sits between segments (i−1) and i; once BOTH
  // sides' corners have undercut it by DIVIDER_CORNER_CULL dot-radii it floats
  // over the notch → drop. Precomputed so a segment can also tell when BOTH of
  // its own dividers are gone (→ it keeps a central dot, below).
  const dividerCulled = cornerArcs
    ? dividerAngles.map((_, i) => {
        const prev = (i - 1 + n) % n;
        return Math.min(cornerArcs[prev], cornerArcs[i]) >= dotAngR * DIVIDER_CORNER_CULL;
      })
    : null;

  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    // 'segment' mode: a divider dot blends its two neighbours; interior/slim dots
    // take the slice colour. Otherwise every dot shares the one `dotColor`.
    const divColor = segmentColors ? oklchMix(segmentColors[prev], segmentColors[i]) : dotColor;
    const segColor = segmentColors ? segmentColors[i] : dotColor;
    // Shared divider dot — suppressed if either adjacent segment is super-slim
    // (collapse into the central dot), or once the corners have culled it.
    if (!slim[i] && !slim[prev] && !(dividerCulled && dividerCulled[i])) dot(dividerAngles[i], divColor);
    if (slim[i]) {
      dot(dividerAngles[i] + sweeps[i] / 2, segColor); // one central dot on the slim segment
    } else {
      const interior = Math.max(0, Math.min(40, Math.round(sweeps[i] / targetGap) - 1));
      const ca = cornerArcs ? cornerArcs[i] : 0;
      let drew = 0;
      for (let j = 1; j <= interior; j++) {
        const off = sweeps[i] * (j / (interior + 1));
        // Drop in-between dots whose centre has fallen into the rounded-away
        // region near either end — peels them off the ends inward as corner grows.
        if (off < ca || off > sweeps[i] - ca) continue;
        dot(dividerAngles[i] + off, segColor);
        drew++;
      }
      // The CENTRE dot is sacred. Once a segment has lost both its divider
      // (intersection) dots AND every in-between dot to the cull, it would go
      // completely bare — so keep one central dot instead. (Odd in-between counts
      // already carry a centre dot, which the cull never touches, so this only
      // fires for the even / no-in-between segments.)
      if (dividerCulled && drew === 0 && dividerCulled[i] && dividerCulled[next]) {
        dot(dividerAngles[i] + sweeps[i] / 2, segColor);
      }
    }
  }
}

export interface WheelPainterConfig {
  items: WheelItem[];
  rotation: number;
  fontSize: number;
  cornerRadius: number;
  strokeWidth: number;
  // Per-segment text auto-fit is always on: `fontSize` is the TARGET (max) and
  // each label shrinks independently to fit its own wedge (length + angular
  // thickness) down to TEXT_FIT_FLOOR × target, then a middle "…".
  textWrap?: boolean;      // allow wrapping a long label onto 2 lines
  // Centre marker diameter (the % value from config). Only used to keep auto-
  // fit text clear of the marker: its circle radius pushes the text's inner
  // limit outward, so a bigger marker truncates/ellipsizes text sooner.
  markerDiameter?: number;
  // Extra ring outside the wheel edge, separate from `strokeWidth`. 0 = off.
  outerStrokeWidth?: number;
  // Decorative dots/beads around the outer stroke band (carnival-bulb bezel).
  outerStrokeDots?: boolean;
  bezelDotsColorMode?: 'default' | 'custom' | 'segment';
  bezelDotsCustomColor?: string;
  showBackgroundCircle: boolean;
  // Colour of the wheel's "white" parts — segment dividers + outer ring
  // stroke and the background circle. Defaults to white. (The 3D base is a
  // darkened copy of this.)
  wheelBaseColor?: string;
  imageSize: number;
  overlayColor: string;
  textVerticalOffset: number;
  innerCornerStyle: 'none' | 'rounded' | 'circular' | 'straight';
  centerInset: number;
  overlayOpacity: number;
  winningIndex: number;
  loadingAngle: number;
  // Transition support
  fromItems?: WheelItem[] | null;
  transition: number;
  // Per-wheel roughness seed (stable, e.g. roughSeedFromId(config.id)). Varies
  // the hand-drawn wobble between wheels. Omitted → 0 (a fixed base pattern).
  roughSeed?: number;
  // Skip the expensive palette-vote quantization for this bake and use the cheap
  // nearest pixelate instead. Set on MOTION frames — live-drag moves and the rAF
  // settle animations (reset / focusSegment / add-remove transition) — which bake
  // many times per second; the final settle frame quantizes for real, so the
  // wheel is always palette-crisp at rest.
  fastPixelate?: boolean;
  // Render ONLY the win dim mask (rough disc minus the winning wedge), opaque, so
  // it can be composited OVER the already-baked wheel as a separate layer whose
  // opacity is CSS-animated — no per-frame wheel re-bake. Uses winningIndex.
  dimMaskOnly?: boolean;
  // Win bake: refill the winning wedge (fill + texture) OVER the finished
  // chrome so the divider/rim ink that straddles its boundary is covered by
  // the winner's own colour. The dim mask punches this SAME path out, so the
  // bright cutout shows ONLY winner fill — no chrome slivers inside it and no
  // re-dimmed band around it. Set while the win overlay is in flight.
  winInkCover?: boolean;
  // Win-flash text pop: transient scale/alpha applied to the WINNING label in
  // the crisp text pass. Driven per-frame by SpinningWheel via
  // repaintTextLayer (text canvas only — the art stays baked); rest bakes
  // leave it undefined.
  winTextPop?: { scale: number; alpha: number };
}

// A point on a segment's outline plus the divider stroke-width MULTIPLIER at that
// point (1 = base Inner Stroke). Drives the hand-drawn "ink" stroke that swells
// and tapers along each divider. `m` is a pure function of the point's geometry,
// so both sides of a shared divider compute identical widths (seam stays matched).
interface StrokePt { x: number; y: number; m: number; }
interface CachedLayout {
  paths: Path2D[];
  outlines: StrokePt[][];
  startAngles: number[];
  segmentSizes: number[];
  effectiveWeights: number[];
}

// Per-segment fitted label: the size it renders at and the line(s) to draw.
interface FittedText { fontSize: number; lines: string[]; textX: number; }

// Break a label into (up to) two balanced lines at the space nearest the
// middle. Returns [text] when there's no usable space.
function splitTwoLines(text: string): string[] {
  const trimmed = text.trim();
  const mid = trimmed.length / 2;
  let best = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === ' ' && (best === -1 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  if (best === -1) return [trimmed];
  return [trimmed.slice(0, best).trim(), trimmed.slice(best + 1).trim()];
}

// Shorten a line with a MIDDLE "…" (keep head + tail, e.g. "Super…stic") until
// it fits `avail` px at `fontSize`. `ctx.font` must already be set to the
// TARGET size (widths scale linearly).
function ellipsize(ctx: CanvasRenderingContext2D, line: string, targetFont: number, fontSize: number, avail: number): string {
  const k = fontSize / targetFont;
  if (ctx.measureText(line).width * k <= avail) return line;
  // Prefer to drop an interior CONNECTOR (a 1–2 char glue word: y, o, de, of, to,
  // …) and bridge with "…", so the meaningful words on each side survive instead
  // of being chopped mid-character. Try the connector nearest the middle first.
  const words = line.split(/\s+/);
  if (words.length >= 3) {
    const mid = (words.length - 1) / 2;
    const conns: number[] = [];
    for (let i = 1; i < words.length - 1; i++) if (words[i].length <= 2) conns.push(i);
    conns.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    for (const i of conns) {
      const cand = `${words.slice(0, i).join(' ')}…${words.slice(i + 1).join(' ')}`;
      if (ctx.measureText(cand).width * k <= avail) return cand;
    }
  }
  // Otherwise fall back to a character-level cut. Aim for a fraction of the
  // available width so a few extra characters are dropped — leaves breathing
  // room and keeps the head/tail clearly legible instead of crammed to the edge.
  const target = avail * 0.82;
  // `keep` = total characters retained, split head/tail around the ellipsis.
  const build = (keep: number) => {
    const head = line.slice(0, Math.ceil(keep / 2)).trimEnd();
    const tail = keep > 1 ? line.slice(line.length - Math.floor(keep / 2)).trimStart() : '';
    return head + '…' + tail;
  };
  let lo = 0, hi = line.length - 1;
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(build(m)).width * k <= target) lo = m;
    else hi = m - 1;
  }
  // Give one character back to each half (head + tail) past the `target` fit, as
  // long as it still clears the real available width — eats a bit less.
  for (let extra = 0; extra < 2 && lo < line.length - 1; extra++) {
    if (ctx.measureText(build(lo + 1)).width * k <= avail) lo++;
    else break;
  }
  return lo > 0 ? build(lo) : '…';
}

// Smallest a label may shrink, as a fraction of the target size, before it
// ellipsizes instead. Locked (not user-configurable).
const TEXT_FIT_FLOOR = 0.4;

// Compute the rendered size + lines for every segment. Pure given its inputs;
// the caller memoizes (see `_ftKey`) so a spin (only rotation changes) reuses
// it instead of re-measuring every frame.
function computeFittedText(
  ctx: CanvasRenderingContext2D,
  items: WheelItem[],
  targetFont: number,
  textX: number,
  scale: number,
  centerInset: number,
  markerRadius: number,
  wrap: boolean,
  imageSize: number,
): FittedText[] {
  const total = items.reduce((s, it) => s + it.weight, 0) || 1;
  // Text must clear both the donut inset AND the centre marker's circle — with a
  // small gap past the marker so the label doesn't kiss its edge.
  const markerGap = markerRadius > 0 ? 24 * scale : 0;
  const innerLimit = Math.max(centerInset, markerRadius + markerGap, 0);
  // A segment carrying a visual (image/icon) reserves space for it at the outer
  // edge, so that label's right edge moves inward by the visual box + a gap.
  const visBox = imageSize * scale;
  const floorPx = Math.max(targetFont * TEXT_FIT_FLOOR, 6 * scale);
  // Separate floor for LENGTH-driven shrinking: a too-long label shrinks this
  // far before we ellipsize instead of going all the way to the Min Size floor.
  // (Thin-wedge / angular shrinking still goes all the way to floorPx.) Lower →
  // labels stay whole (just smaller) much longer before the "…" kicks in.
  const lengthFloorPx = Math.max(targetFont * 0.45, floorPx);
  const ANG_MARGIN = 1 * scale;
  // Visual glyph height as a fraction of font size (Inter, centred baseline).
  // Using the full font size over-shrinks labels that actually fit; 0.82 keeps
  // uniform wheels at the target while the wedge clip still catches any sliver.
  const GLYPH_H = 0.82;
  ctx.font = `600 ${targetFont}px ${WHEEL_FONT}`;

  return items.map((it) => {
    const half = Math.min(((2 * Math.PI * it.weight) / total) / 2, Math.PI / 2);
    const sinHalf = Math.sin(half);

    // Pull this label's right edge in when it carries a visual (image/icon).
    const reserve = (it.iconName || it.imagePath) ? visBox + 10 * scale : 0;
    const itemTextX = textX - reserve;
    const avail = Math.max(0, itemTextX - innerLimit);

    // Best font size for a given set of lines: the largest size that clears both
    // the radial (length / centre-marker) and angular (wedge thickness) limits.
    const fitLines = (lines: string[], cap: number): number => {
      let wTarget = 0;
      for (const ln of lines) wTarget = Math.max(wTarget, ctx.measureText(ln).width);
      const nLines = lines.length;
      // Single line → just the glyph height; two lines → a line of spacing
      // plus a glyph height on top.
      const lineFactor = nLines > 1 ? (nLines - 1) * 1.05 + GLYPH_H : GLYPH_H;
      // Fit predicate: does size `f` clear the wedge thickness AND fit radially
      // (or sit below the length floor, past which we ellipsize)? This is
      // monotonic — true while small, false once too big — so we BINARY-SEARCH
      // the largest fitting size. The old fixed-factor step quantised the size,
      // so a growing centre marker left the text untouched until a step boundary
      // then jumped it (the "wiggle room then push"); the search makes the text
      // track the marker diameter CONTINUOUSLY.
      const fits = (f: number): boolean => {
        const textW = (wTarget * f) / targetFont;
        const rInner = itemTextX - textW;
        const thickness = 2 * Math.max(rInner, innerLimit) * sinHalf;
        const angularOK = f * lineFactor + ANG_MARGIN <= thickness;
        const radialOK = rInner >= innerLimit;
        return angularOK && (radialOK || f <= lengthFloorPx);
      };
      if (fits(cap)) return cap;
      if (!fits(floorPx)) return floorPx;
      let lo = floorPx, hi = cap;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      return lo;
    };

    // Single words can't wrap, so they're the only labels bottlenecked by the
    // size cap — give them a slightly higher one so short ones grow into the
    // spare room near the rim. Phrases keep the target cap; a word already
    // filling the wedge (touching the centre) stays put, since the radial limit
    // caps it below the boost regardless.
    const maxFont = it.text.trim().includes(' ') ? targetFont : targetFont * 1.15;
    let lines = [it.text];
    let f = fitLines(lines, maxFont);
    // Prefer wrapping a too-long (or uncomfortably small) single line into two
    // lines — first line whole, second ellipsised only if it must — and pick
    // whichever of the two layouts renders LARGER. `comfortablePx` is only the
    // TRIGGER to attempt a wrap on a single line that fits but came out small;
    // the choice itself is "bigger wins", so the tiny single-ellipsised fallback
    // happens only when two lines are genuinely smaller (a thin/low-weight wedge)
    // — not because the wrap dipped below an absolute comfort threshold.
    const comfortablePx = targetFont * 0.6;
    const singleOverflows = (ctx.measureText(it.text).width * f) / targetFont > avail;
    // Below ~3% of the wheel the wedge is too thin for two lines to ever help, so
    // don't even consider wrapping — commit straight to a single (ellipsised)
    // line instead of flip-flopping in and out of a two-line layout.
    const wrapAllowed = wrap && it.weight / total >= 0.03;
    if (wrapAllowed && (singleOverflows || f < comfortablePx)) {
      const split = splitTwoLines(it.text);
      if (split.length === 2) {
        const f2 = fitLines(split, targetFont);
        // Take the wrap whenever two lines render at least as big as the single
        // line — i.e. the wedge has the vertical room for two. Two lines at a
        // comfortable size beat collapsing to a smaller single line, even if a
        // line has to ellipsise.
        if (f2 >= f) {
          // Keep the SECOND line as the one that ellipsises: shift whole words
          // off line one until it fits at f2, pushing the overflow (and so the
          // truncation) onto line two. Only an unsplittable long first word can
          // still force line one to trim.
          let [l1, l2] = split;
          const maxW = (avail * targetFont) / f2;
          while (l1.includes(' ') && ctx.measureText(l1).width > maxW) {
            const sp = l1.lastIndexOf(' ');
            l2 = `${l1.slice(sp + 1)} ${l2}`;
            l1 = l1.slice(0, sp);
          }
          lines = [l1, l2];
          f = f2;
        }
      }
    }
    // Ellipsise each line that overflows. In the usual wrap the first line fits
    // whole and only the second truncates; if the first genuinely can't fit it
    // truncates too — still better than dropping to a tiny single line.
    lines = lines.map((ln) => ellipsize(ctx, ln, targetFont, f, avail));
    return { fontSize: f, lines, textX: itemTextX };
  });
}

// Font for the wheel's crisp label pass (the app's default pixel face).
// WHEEL_FONT_FAMILY alone is what fonts.load()/check() need; WHEEL_FONT is the
// full ctx.font stack with fallbacks for while it loads.
// SV — the app's default face (see index.css); segment labels draw at weight
// 600, which maps to the svbold cut. LoRes stays as the loading fallback.
export const WHEEL_FONT_FAMILY = "'SV'";
export const WHEEL_FONT = `${WHEEL_FONT_FAMILY}, 'LoRes12OT-Bold', Inter, sans-serif`;

// Memoize-last: only one wheel animates at a time, so a single-entry cache hits
// every spin frame (key omits rotation). Thumbnails draw no text, so they
// never touch this.
let _ftKey = '';
let _ftVal: FittedText[] = [];

// Memoize-last for the segment geometry (paths + rough outlines) — same
// single-entry idea; key omits rotation. See the build site in paintWheel.
let _layoutKey = '';
let _layoutVal: CachedLayout | null = null;

// ── Pixelate post-process ───────────────────────────────────────────────────
// Retro "lo-fi" filter applied AFTER the wheel is fully drawn: smooth-downsample
// the whole canvas to a coarse grid, then upscale back with nearest-neighbour →
// chunky, averaged pixels (nicer than rendering low-res directly, which just
// aliases). This is the "post-process pass" — done in Canvas-2D rather than a
// separate WebGL canvas because the spin is a CSS transform on THIS element, so
// a second GL canvas would mean rerouting the whole transform pipeline for the
// identical nearest-neighbour result. Cost is bake-time only (spins are GPU
// rotations of the baked bitmap), so it's free per spin frame.
// Lo-fi grid RESOLUTION: the wheel is always PIXEL_BLOCKS blocks across,
// independent of its rendered size — a 700px desktop wheel and a 380px phone
// wheel share the same pixel density. Sibling pixel-art surfaces (PixelButton,
// PixelatedMarker) take a matching CSS-px block size derived from the same
// constant (wheelWidth / PIXEL_BLOCKS) via their `pixelScale` prop, so the
// whole UI reads as one grid. PIXELATED = master enable for the lo-fi look.
// NOTE: when enabled the displayed ART <canvas> MUST carry `image-rendering:
// pixelated` (labels render on a SEPARATE smooth canvas so they stay crisp),
// or the GPU bilinear-smooths the baked blocks back into AA during the
// CSS-rotate spin and the dpr downscale. SpinningWheel keys the split + that
// CSS off these exports.
export const PIXELATED = true;
export const PIXEL_BLOCKS = 300;

// CSS px per SPRITE pixel: the wheel's block size snapped to whole DEVICE
// pixels, so hand-drawn sprite pixels (and block-sized UI boxes like the
// 32-block buttons) render as perfectly uniform squares at ~wheel density.
// The wheel itself keeps its exact non-snapped 300-block grid; the snap is
// only for pixel-perfect sprite surfaces.
export function spriteScaleFor(wheelWidth: number): number {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return Math.max(1, Math.round((wheelWidth / PIXEL_BLOCKS) * dpr)) / dpr;
}
let _pixelTmp: HTMLCanvasElement | null = null;
let _pixelBig: HTMLCanvasElement | null = null;
// Reused across bakes (the vote output + flat palette) so per-frame quantizes
// don't churn the GC with fresh ImageData / arrays.
let _pixelOut: ImageData | null = null;
let _palFlat = new Int32Array(0);
// Palette entry: [r, g, b]. When a palette is supplied, pixelateCanvas snaps every
// block to its nearest colour → true fixed-palette 8-bit, which hardens even
// COLOUR-on-colour edges (segment dividers, text-on-fill) that plain nearest
// sampling can't. Without a palette it's a simple hard nearest downsample.
export type Palette = [number, number, number][];

// keepTranslucent: when true the per-block vote is THREE-way (opaque / translucent
// / empty) — opaque blocks snap hard to the palette, translucent blocks keep their
// own colour+alpha (blocky, NOT thresholded away), and only truly-empty blocks
// drop. Use it for art with intentional semi-transparent layers (e.g. the marker's
// shadow halos) that must survive the pixelation. Default (false) thresholds alpha
// on/off for a fully hard silhouette (wheel/button).
// Despeckle for the hard-silhouette vote: fill tiny ENCLOSED transparent
// pockets. A sharp concave crevice in the silhouette — the notch valley where
// two rounded segment corners meet, on a wheel with no backing disc — tapers
// below one block wide, and the coverage vote renders its sub-block tip as an
// isolated transparent block: a pinhole showing the page through the seam
// between a fill and its stroke. Flood the transparent blocks 4-connected from
// the border; what's left unreached is an enclosed pocket. Pockets up to
// PINHOLE_MAX_AREA blocks get filled with their most common neighbouring
// colour (the stroke, at a crevice tip). Intentional enclosed holes — a donut
// wheel's open centre — are far larger and stay open. Diagonal-only contact
// does not connect a pocket to the outside (4-connected on purpose): blocks
// touching only at a corner still read as a sealed hole.
const PINHOLE_MAX_AREA = 8;
function fillEnclosedPinholes(od: Uint8ClampedArray, sw: number, sh: number): void {
  const n = sw * sh;
  const empty = (i: number) => od[i * 4 + 3] === 0;
  // 0 = opaque, 1 = transparent unreached, 2 = transparent reached from border
  const state = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (empty(i)) state[i] = 1;
  const stack: number[] = [];
  for (let x = 0; x < sw; x++) {
    if (state[x] === 1) { state[x] = 2; stack.push(x); }
    const b = (sh - 1) * sw + x;
    if (state[b] === 1) { state[b] = 2; stack.push(b); }
  }
  for (let y = 0; y < sh; y++) {
    const l = y * sw, r = y * sw + sw - 1;
    if (state[l] === 1) { state[l] = 2; stack.push(l); }
    if (state[r] === 1) { state[r] = 2; stack.push(r); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % sw;
    if (x > 0 && state[i - 1] === 1) { state[i - 1] = 2; stack.push(i - 1); }
    if (x < sw - 1 && state[i + 1] === 1) { state[i + 1] = 2; stack.push(i + 1); }
    if (i >= sw && state[i - sw] === 1) { state[i - sw] = 2; stack.push(i - sw); }
    if (i < n - sw && state[i + sw] === 1) { state[i + sw] = 2; stack.push(i + sw); }
  }
  for (let i = 0; i < n; i++) {
    if (state[i] !== 1) continue;
    // Collect this enclosed component.
    const comp = [i];
    state[i] = 2;
    for (let s = 0; s < comp.length; s++) {
      const c = comp[s], x = c % sw;
      if (x > 0 && state[c - 1] === 1) { state[c - 1] = 2; comp.push(c - 1); }
      if (x < sw - 1 && state[c + 1] === 1) { state[c + 1] = 2; comp.push(c + 1); }
      if (c >= sw && state[c - sw] === 1) { state[c - sw] = 2; comp.push(c - sw); }
      if (c < n - sw && state[c + sw] === 1) { state[c + sw] = 2; comp.push(c + sw); }
    }
    if (comp.length > PINHOLE_MAX_AREA) continue;
    for (const c of comp) {
      // Most common opaque colour among the 8 neighbours (there's always at
      // least one — the pocket is enclosed by opaque blocks).
      const x = c % sw, y = (c / sw) | 0;
      const colors: number[] = [], counts: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
          const ni = (ny * sw + nx) * 4;
          if (od[ni + 3] === 0) continue;
          const rgb = (od[ni] << 16) | (od[ni + 1] << 8) | od[ni + 2];
          const k = colors.indexOf(rgb);
          if (k < 0) { colors.push(rgb); counts.push(1); } else counts[k]++;
        }
      }
      let best = -1, bc = 0;
      for (let k = 0; k < colors.length; k++) if (counts[k] > bc) { bc = counts[k]; best = colors[k]; }
      if (best < 0) continue; // fully surrounded by other pocket blocks — leave
      const oi = c * 4;
      od[oi] = (best >> 16) & 255; od[oi + 1] = (best >> 8) & 255; od[oi + 2] = best & 255; od[oi + 3] = 255;
    }
  }
}

export function pixelateCanvas(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, scale: number, palette?: Palette, keepTranslucent = false): void {
  const canvas = ctx.canvas;
  if (canvas.width === 0 || canvas.height === 0) return;
  const sw = Math.max(1, Math.round(cssW / scale));
  const sh = Math.max(1, Math.round(cssH / scale));
  if (!_pixelTmp) _pixelTmp = document.createElement('canvas');
  if (_pixelTmp.width !== sw || _pixelTmp.height !== sh) { _pixelTmp.width = sw; _pixelTmp.height = sh; }
  const tctx = _pixelTmp.getContext('2d');
  if (!tctx) return;

  tctx.clearRect(0, 0, sw, sh);
  if (palette && palette.length) {
    // MODE-VOTE each block: point-sample a K×K grid and take the most common
    // palette colour — counting only samples that EXACTLY match a palette
    // colour (± compositing round-off) when the block has any, so an anti-
    // aliased seam blend can never outvote the real surfaces it sits between,
    // even when some palette colour happens to lie near the blend (grey bezel
    // dots vs a white↔dark divider seam). Blocks with no exact sample
    // (textures, all-blend slivers) fall back to nearest-colour voting. The
    // transparent-vs-opaque vote also gives a coverage-based (clean) silhouette.
    const K = 3;
    const bw = sw * K, bh = sh * K;
    if (!_pixelBig) _pixelBig = document.createElement('canvas');
    if (_pixelBig.width !== bw || _pixelBig.height !== bh) { _pixelBig.width = bw; _pixelBig.height = bh; }
    // willReadFrequently keeps this buffer CPU-backed: getImageData below becomes
    // a memcpy instead of a GPU readback stall. (Attribute binds on first
    // getContext of the element, which is here.)
    const bctx = _pixelBig.getContext('2d', { willReadFrequently: true });
    if (!bctx) return;
    bctx.imageSmoothingEnabled = false;
    bctx.clearRect(0, 0, bw, bh);
    bctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, bw, bh);
    const src = bctx.getImageData(0, 0, bw, bh).data;
    // 32-bit view of the samples — used ONLY for whole-pixel equality (the
    // uniform-block fast path below), so it's endian-agnostic.
    const src32 = new Uint32Array(src.buffer, src.byteOffset, bw * bh);
    if (!_pixelOut || _pixelOut.width !== sw || _pixelOut.height !== sh) _pixelOut = tctx.createImageData(sw, sh);
    const out = _pixelOut;
    const od = out.data;
    const P = palette.length;
    // Flat palette + a per-bake colour→index memo. The samples are point-sampled
    // vector art, so distinct colours number in the dozens: after the first few
    // blocks every nearest-palette search is one Map hit instead of an O(P) scan.
    if (_palFlat.length < P * 3) _palFlat = new Int32Array(P * 3);
    const pal = _palFlat;
    for (let p = 0; p < P; p++) { pal[p * 3] = palette[p][0]; pal[p * 3 + 1] = palette[p][1]; pal[p * 3 + 2] = palette[p][2]; }
    const memo = new Map<number, number>();
    // A sample is an EXACT palette hit when it sits within compositing round-off
    // of its nearest colour (±2/channel) — i.e. it's a real painted surface, not
    // an anti-aliased blend. Only exact hits VOTE (see below); the art is flat
    // vector fills, so every non-edge pixel is exact. Encoded index*2 + exactBit.
    const EXACT_D2 = 12;
    const nearest = (r: number, g: number, b: number): number => {
      const key = r | (g << 8) | (b << 16);
      let m = memo.get(key);
      if (m === undefined) {
        let best = 0, bestDist = Infinity;
        for (let p = 0; p < P; p++) {
          const pr = pal[p * 3] - r, pg = pal[p * 3 + 1] - g, pb = pal[p * 3 + 2] - b;
          const dist = pr * pr + pg * pg + pb * pb;
          if (dist < bestDist) { bestDist = dist; best = p; }
        }
        memo.set(key, m = best * 2 + (bestDist <= EXACT_D2 ? 1 : 0));
      }
      return m;
    };
    const counts = new Int32Array(P);    // exact-hit votes
    const countsAll = new Int32Array(P); // nearest-snap votes (fallback)
    for (let by = 0; by < sh; by++) {
      const row0 = by * K * bw;
      for (let bx = 0; bx < sw; bx++) {
        const base = row0 + bx * K;
        const oi = ((by * sw) + bx) * 4;
        // Fast path: a block whose K×K samples are all the SAME rgba — the flat
        // interior of a wedge, i.e. the vast majority — needs no vote. Its
        // outcome is identical to the full vote below (9-0 majority).
        const v0 = src32[base];
        let uniform = true;
        for (let dy = 0; dy < K && uniform; dy++) {
          const r0 = base + dy * bw;
          for (let dx = 0; dx < K; dx++) if (src32[r0 + dx] !== v0) { uniform = false; break; }
        }
        if (uniform) {
          const si = base * 4;
          const a = src[si + 3];
          if (a >= 128) {
            const w3 = (nearest(src[si], src[si + 1], src[si + 2]) >> 1) * 3;
            od[oi] = pal[w3]; od[oi + 1] = pal[w3 + 1]; od[oi + 2] = pal[w3 + 2]; od[oi + 3] = 255;
          } else if (keepTranslucent && a >= 8) {
            od[oi] = src[si]; od[oi + 1] = src[si + 1]; od[oi + 2] = src[si + 2]; od[oi + 3] = a;
          } else {
            od[oi + 3] = 0;
          }
          continue;
        }
        counts.fill(0);
        countsAll.fill(0);
        let opaqueN = 0, transN = 0, emptyN = 0, exactN = 0;
        // Representative for a translucent-dominated block: the sample with the
        // highest alpha (uniform halos make any sample equivalent).
        let repA = 0, repR = 0, repG = 0, repB = 0;
        for (let dy = 0; dy < K; dy++) {
          for (let dx = 0; dx < K; dx++) {
            const si = (base + dy * bw + dx) * 4;
            const a = src[si + 3];
            if (a < 8) { emptyN++; continue; }
            if (a >= 128) {
              opaqueN++;
              const e = nearest(src[si], src[si + 1], src[si + 2]);
              countsAll[e >> 1]++;
              if (e & 1) { counts[e >> 1]++; exactN++; }
            } else {
              transN++;
              if (keepTranslucent && a > repA) { repA = a; repR = src[si]; repG = src[si + 1]; repB = src[si + 2]; }
            }
          }
        }
        // Winner among EXACT hits when the block has any — an off-palette blend
        // (the AA hairline where a stroke crosses a fill) then can't outvote the
        // real surfaces it sits between, even when a palette colour happens to
        // lie near the blend (grey bezel dots vs a white↔dark seam). Blocks with
        // no exact hit (textures, all-blend slivers) fall back to nearest-snap.
        const voteCounts = exactN > 0 ? counts : countsAll;
        let win = -1, wc = 0;
        for (let p = 0; p < P; p++) { if (voteCounts[p] > wc) { wc = voteCounts[p]; win = p; } }
        if (keepTranslucent) {
          // Three-way majority: opaque > translucent > empty.
          if (opaqueN > 0 && opaqueN >= transN && opaqueN >= emptyN) {
            const w3 = win * 3;
            od[oi] = pal[w3]; od[oi + 1] = pal[w3 + 1]; od[oi + 2] = pal[w3 + 2]; od[oi + 3] = 255;
          } else if (transN > 0 && transN >= emptyN) {
            od[oi] = repR; od[oi + 1] = repG; od[oi + 2] = repB; od[oi + 3] = repA;
          } else {
            od[oi + 3] = 0;
          }
        } else {
          // Two-way: opaque palette colour, else transparent (hard silhouette).
          // Drop to transparent only when transparent samples outnumber ALL
          // opaque samples — not just the winning colour's count. Comparing
          // against `wc` alone punched pinholes through blocks that straddle a
          // fill↔stroke seam at the silhouette edge: majority-opaque, but the
          // opaque vote split between the two colours and lost to a
          // transparent minority. Pure-edge blocks (one colour vs outside) are
          // unchanged: there wc === opaqueN.
          const trans = transN + emptyN;
          if (win < 0 || trans > opaqueN) { od[oi + 3] = 0; }
          else { const w3 = win * 3; od[oi] = pal[w3]; od[oi + 1] = pal[w3 + 1]; od[oi + 2] = pal[w3 + 2]; od[oi + 3] = 255; }
        }
      }
    }
    if (!keepTranslucent) fillEnclosedPinholes(od, sw, sh);
    tctx.putImageData(out, 0, 0);
  } else {
    // No palette → point-sampled hard nearest (fast; flat-shape silhouettes only).
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, sw, sh);
  }

  // Upscale back nearest-neighbour → blocky. ctx is dpr-scaled, so we draw in CSS
  // px and it fills the whole backing store. save/restore keeps smoothing default.
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(_pixelTmp, 0, 0, sw, sh, 0, 0, cssW, cssH);
  ctx.restore();
}

export function paintWheel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: WheelPainterConfig,
  // Optional second context for the crisp text/visual pass. When the pixelate
  // pass is on, labels go here (a smooth overlay canvas) instead of onto the
  // pixelated art canvas. Caller sets its dpr transform + clears it. If omitted,
  // text is drawn on `ctx` as before (pixelated with everything else).
  textCtx?: CanvasRenderingContext2D | null,
): void {
  const { items, rotation, cornerRadius, strokeWidth, showBackgroundCircle,
          imageSize, overlayColor, textVerticalOffset, innerCornerStyle,
          centerInset, overlayOpacity, winningIndex, fromItems, transition } = config;
  const wheelBaseColor = config.wheelBaseColor ?? '#FFFFFF';
  const outerStrokeWidth = config.outerStrokeWidth ?? 0;
  const outerStrokeDots = config.outerStrokeDots ?? false;
  const textWrap = config.textWrap ?? false;
  // Per-wheel wobble: set the phase offsets before any rough path is built.
  if (ROUGHNESS.enabled) roughPhases = computeRoughPhases(config.roughSeed ?? 0);

  const center = { x: width / 2, y: height / 2 };
  const strokeInset = strokeWidth > 0 ? strokeWidth / 2 + 0.5 : 0;
  // Reserve room at the edge for the extra outer ring (drawn after segments).
  const outerInset = outerStrokeWidth > 0 ? outerStrokeWidth + 0.5 : 0;
  const radius = Math.min(width, height) / 2 - strokeInset - outerInset;
  const scale = radius / 350;
  const textX = radius - 20 * scale;
  // Edge peak softening from the Inner Stroke. `strokeWidth` arrives scaled by
  // `scale` (= radius/350), so divide it back to slider units before mapping.
  if (ROUGHNESS.enabled) edgeSoftKnee = kneeFromStroke(scale > 0 ? strokeWidth / scale : strokeWidth);

  ctx.clearRect(0, 0, width, height);

  // Background circle (not rotated). Edge case: when BOTH strokeWidth and
  // cornerRadius are 0, the disc lines up exactly with the segment outer
  // arc — strict canvasR reads as too tight with no ring band or rounded
  // corners to lift it visually. Pull it in to 0.98 so a thin dark sliver
  // at the edge breaks the silhouette (mirrors the thumbnail's logic).
  // Rough mode draws its backing later, in the slices' rotated frame, sampled
  // to match the slice rim exactly (see buildRoughDisc) — an independently
  // sampled rough disc here poked past the slices at divider valleys, leaking
  // a white sliver. Clean mode keeps the simple concentric disc.
  if (showBackgroundCircle && !ROUGHNESS.enabled) {
    const noStrokeNoRound = strokeWidth === 0 && cornerRadius === 0;
    const bgRadius = noStrokeNoRound ? radius * 0.98 : radius;
    // 50% grey in the no-stroke / no-round edge case (the disc is the
    // only visible "outline" since there's no ring or rounded corners);
    // white otherwise.
    ctx.fillStyle = noStrokeNoRound ? '#808080' : wheelBaseColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, bgRadius, 0, Math.PI * 2);
    ctx.fill();
    if (strokeWidth > 0) {
      ctx.strokeStyle = wheelBaseColor;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  // Compute effective weights (for transitions)
  const effectiveWeights: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (fromItems && i < fromItems.length && transition < 1) {
      effectiveWeights.push(fromItems[i].weight + (items[i].weight - fromItems[i].weight) * transition);
    } else {
      effectiveWeights.push(items[i].weight);
    }
  }

  const totalWeight = effectiveWeights.reduce((s, w) => s + w, 0);
  const arcSize = (2 * Math.PI) / totalWeight;

  // Precompute layout — memoize-last, like the fitted text. The geometry is
  // rotation-INDEPENDENT (rotation is applied as a canvas transform at draw
  // time), so drag / reset / focus frames — where only rotation changes — reuse
  // the previous bake's Path2Ds + outlines instead of rebuilding every segment.
  // Weight transitions change effectiveWeights per frame and rebuild, as they
  // must. (roughPhases/edgeSoftKnee feed the build but derive purely from
  // roughSeed/strokeWidth, which are in the key.)
  const layoutKey = `${width}|${height}|${strokeWidth}|${outerStrokeWidth}|${cornerRadius}|${innerCornerStyle}|${centerInset}|${config.roughSeed ?? 0}|${ROUGHNESS.enabled ? 1 : 0}|` + effectiveWeights.join(',');
  let layout: CachedLayout;
  if (_layoutVal && _layoutKey === layoutKey) {
    layout = _layoutVal;
  } else {
    layout = { paths: [], outlines: [], startAngles: [], segmentSizes: [], effectiveWeights };
    const n = items.length;
    const sizes = effectiveWeights.map((w) => arcSize * w);
    let startAngle = 0;
    for (let i = 0; i < n; i++) {
      const segmentSize = sizes[i];
      layout.startAngles.push(startAngle);
      layout.segmentSizes.push(segmentSize);
      // Smooth each edge by the THINNER of the two slices it divides (wrapping at
      // the seam), so a low-% slice gets near-straight edges. Both slices of a
      // divider see the same min → the shared edge stays identical.
      const startEdgeSmooth = edgeSmoothFactor(Math.min(segmentSize, sizes[(i - 1 + n) % n]));
      const endEdgeSmooth = edgeSmoothFactor(Math.min(segmentSize, sizes[(i + 1) % n]));
      const outline: StrokePt[] = [];
      layout.paths.push(buildSegmentPath(center, radius, startAngle, startAngle + segmentSize, cornerRadius, innerCornerStyle, centerInset, startEdgeSmooth, endEdgeSmooth, outline));
      layout.outlines.push(outline);
      startAngle += segmentSize;
    }
    _layoutKey = layoutKey;
    _layoutVal = layout;
  }

  // Win DIM MASK mode: draw ONLY the dark tint — a rough disc with the winning
  // wedge punched out — opaque, then blocky-pixelate it. The caller composites
  // this over the already-baked wheel as a separate layer and fades its CSS
  // opacity, so the win dim never re-bakes/re-quantizes the wheel itself.
  if (config.dimMaskOnly) {
    ctx.clearRect(0, 0, width, height);
    const strokeHalf = strokeWidth > 0 ? strokeWidth / 2 : 0;
    const inkMax = ROUGHNESS.enabled && ROUGHNESS.strokeWidthVar > 0 ? 1 + ROUGHNESS.strokeWidthVar : 1;
    const overlayRadius = radius + (strokeHalf + outerStrokeWidth) * inkMax + 1;
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(rotation);
    ctx.translate(-center.x, -center.y);
    ctx.fillStyle = overlayColor;
    if (ROUGHNESS.enabled) ctx.fill(roughCirclePath(center.x, center.y, overlayRadius, radius));
    else { ctx.beginPath(); ctx.arc(center.x, center.y, overlayRadius, 0, Math.PI * 2); ctx.fill(); }
    if (winningIndex >= 0 && winningIndex < layout.paths.length) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill(layout.paths[winningIndex]); // keep the winner bright (hole in the dim)
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    if (PIXELATED) pixelateCanvas(ctx, width, height, width / PIXEL_BLOCKS);
    return;
  }

  // Auto-fit text layout (per-segment size + lines). Memoized on everything
  // it depends on EXCEPT rotation, and sized off the TARGET weights (`items`)
  // not the interpolated ones, so a spin / add-remove transition reuses the
  // cached result instead of re-measuring every frame.
  {
    // Marker circle radius in canvas px — mirrors SpinningWheel's overlay
    // (box = size·250/700, circle = box·markerDiameter/100), centred.
    const markerDiameter = config.markerDiameter ?? 0;
    const markerRadius = (width * (250 / 700) * (markerDiameter / 100)) / 2;
    // Font-ready bit: measurements taken while the pixel face is still loading
    // use the fallback's metrics — once it lands (SpinningWheel repaints on
    // fonts.load), the changed key forces a re-measure in the real face.
    const fontReady = typeof document !== 'undefined' && !!document.fonts?.check(`600 12px ${WHEEL_FONT_FAMILY}`);
    const key = `${fontReady ? 'F' : 'f'}|${width}|${strokeWidth}|${outerStrokeWidth}|${centerInset}|${markerDiameter}|${config.fontSize}|${textWrap ? 1 : 0}|${imageSize}|`
      + items.map((it) => `${it.text}${it.weight}${(it.iconName || it.imagePath) ? 'V' : '_'}`).join('');
    if (key !== _ftKey) {
      _ftVal = computeFittedText(ctx, items, config.fontSize, textX, scale, centerInset, markerRadius, textWrap, imageSize);
      _ftKey = key;
    }
  }

  // Draw rotated segments
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rotation);
  ctx.translate(-center.x, -center.y);

  // Rough backing — drawn here (inside the slices' rotation) and sampled to
  // match the slice rim exactly, so it can't poke past a slice at a divider
  // valley. Hidden by the colour fills everywhere except the donut centre,
  // mirroring clean mode's full-disc backing.
  if (ROUGHNESS.enabled && showBackgroundCircle) {
    const noStrokeNoRound = strokeWidth === 0 && cornerRadius === 0;
    const inkRim = strokeWidth > 0 && ROUGHNESS.strokeWidthVar > 0;
    const discOutline: StrokePt[] = [];
    const disc = buildRoughDisc(center, radius, layout.startAngles, layout.segmentSizes, inkRim ? discOutline : undefined);
    ctx.fillStyle = noStrokeNoRound ? '#808080' : wheelBaseColor;
    ctx.fill(disc);
    // Continuous outer ring at the rim. The rounded corners pull each slice IN at
    // every divider, so the per-slice rim strokes alone leave the wheel's outer
    // border notched. Stroking the backing disc (sampled to match the slice rim)
    // closes those gaps into one clean rough ring — mirrors clean mode's bg-circle
    // stroke. The notches then read as white indentations just inside the ring.
    if (strokeWidth > 0) {
      ctx.strokeStyle = wheelBaseColor;
      ctx.lineJoin = 'round';
      if (inkRim && discOutline.length > 1) strokeVariableWidth(ctx, discOutline, strokeWidth);
      else { ctx.lineWidth = strokeWidth; ctx.stroke(disc); }
    }
  }

  // Extra outer ring, silhouette-following. With no background circle the
  // outline is the segment union (a "flower" once corners are rounded). A
  // scaled copy was used here, but a uniform scale offsets each edge in
  // proportion to its distance from centre, so the ring TAPERED where the
  // rounded corners curve inward. Instead STROKE the segment outlines: the
  // outer half lands `outerStrokeWidth` past the segment's own edge stroke, and
  // the fills + dividers below cover the inner half and every interior edge —
  // leaving a constant-width ring that hugs the true outline (corners included).
  if (outerStrokeWidth > 0 && !showBackgroundCircle && radius > 0) {
    // Donut wheels have an inner hole; clip it out so the wide stroke doesn't
    // also ring the inner edge. (innerCornerStyle 'none' fills to the centre, so
    // the inner half is covered there and no clip is needed.)
    const innerHole = centerInset > 0 && innerCornerStyle !== 'none' ? centerInset : 0;
    ctx.save();
    if (innerHole > 0) {
      ctx.beginPath();
      ctx.rect(-width, -height, width * 3, height * 3);
      ctx.arc(center.x, center.y, innerHole, 0, Math.PI * 2);
      ctx.clip('evenodd');
    }
    ctx.strokeStyle = wheelBaseColor;
    ctx.lineJoin = 'round';
    const ringWidth = strokeWidth + outerStrokeWidth * 2;
    const inkRing = ROUGHNESS.enabled && ROUGHNESS.strokeWidthVar > 0;
    for (let i = 0; i < layout.paths.length; i++) {
      const outline = layout.outlines[i];
      // Match the dividers' ink swell/taper so the ring reads hand-drawn too.
      if (inkRing && outline && outline.length > 1) {
        strokeVariableWidth(ctx, outline, ringWidth, RING_INK_SCALE);
      } else {
        ctx.lineWidth = ringWidth;
        ctx.stroke(layout.paths[i]);
      }
    }
    ctx.restore();
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const path = layout.paths[i];
    const effSize = layout.segmentSizes[i];

    // Skip rendering segments whose effective angular size is essentially
    // zero (the WheelEditor sends a 0.001 placeholder weight on add/remove
    // so the wheel can transition same-count without redoing layout).
    // Drawing the path's fill is invisible at this size, but the stroke
    // (drawn around the path) creates a visible radial line that sits
    // right next to the neighbouring boundary and briefly thickens it —
    // that's the flicker the user sees just before/after the animation.
    if (effSize < 0.005) continue;

    // Segment fill — colors snap instantly to the new value (no lerp
    // across the transition window) so swapping segment cards doesn't
    // produce a cross-fade. Weights still interpolate above so the
    // wedge size animation is preserved.
    const effectiveColor = item.color;

    ctx.fillStyle = effectiveColor;
    ctx.fill(path);

    // Seal the rough divider seam: stroke the wedge with its own fill colour so
    // it overlaps each neighbour by ~half the width, covering the anti-aliased
    // hairline that otherwise lets the background disc bleed through where the
    // jittered edges run diagonally. (The radial edges are already geometrically
    // identical between neighbours — this only hides AA, it doesn't move them.)
    if (ROUGHNESS.enabled && ROUGHNESS.seamSeal > 0) {
      ctx.strokeStyle = effectiveColor;
      ctx.lineWidth = ROUGHNESS.seamSeal;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    }

    // Texture — pattern overlay on the fill (under the divider stroke + text).
    if (item.texture) drawSegmentTexture(ctx, path, center.x, center.y, radius, item.texture, textureOverlayColor(effectiveColor));

    // Stroke
    if (strokeWidth > 0) {
      ctx.strokeStyle = wheelBaseColor;
      // Round joins instead of the default 'miter' — at small wheel sizes
      // the join between the radial edge and the rounded-corner curve gets
      // acute enough that miter joins spike well past the stroke width,
      // producing visible spike artifacts on the wheel's outer rim.
      ctx.lineJoin = 'round';
      const outline = layout.outlines[i];
      if (ROUGHNESS.enabled && ROUGHNESS.strokeWidthVar > 0 && outline && outline.length > 1) {
        // Hand-drawn "ink" stroke: width swells/tapers along each divider.
        strokeVariableWidth(ctx, outline, strokeWidth);
      } else {
        ctx.lineWidth = strokeWidth;
        ctx.stroke(path);
      }
    }

    // Text + per-slice visuals are NOT drawn here. They're deferred to a crisp
    // pass AFTER the pixelate post-process (see paintSegmentContent below), so
    // the labels stay sharp while the wheel art gets the lo-fi blocks.
  }

  ctx.restore(); // remove rotation

  // ── Extra outer ring (disc silhouette) ──
  // Background circle on → the outline is a true circle, so a concentric ring
  // is exact and cheap. (No-bg-circle wheels use the silhouette-following copy
  // drawn above instead.) Sits just outside the wheel's existing edge; same
  // colour as the rest of the chrome, so it reads as a thicker outer border
  // that — unlike `strokeWidth` — doesn't also thicken the dividers.
  if (outerStrokeWidth > 0 && showBackgroundCircle) {
    // Extend the ring's INNER edge in to `radius` so it OVERLAPS the wheel's own
    // edge stroke rather than merely abutting it at radius+strokeWidth/2. That
    // abutment left a sub-pixel AA seam — a faint dark sliver — whenever
    // strokeWidth > 0 (at strokeWidth 0 the ring already started flush at radius,
    // which is why the artifact vanished there). Outer edge is unchanged.
    const innerEdge = radius;
    const outerEdge = radius + (strokeWidth > 0 ? strokeWidth / 2 : 0) + outerStrokeWidth;
    ctx.strokeStyle = wheelBaseColor;
    ctx.lineWidth = outerEdge - innerEdge;
    if (ROUGHNESS.enabled) {
      // Rotate the rough ring with the slices so its wobble stays concentric.
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(rotation);
      ctx.translate(-center.x, -center.y);
      ctx.stroke(roughCirclePath(center.x, center.y, (innerEdge + outerEdge) / 2, radius));
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(center.x, center.y, (innerEdge + outerEdge) / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── Decorative outer dots (carnival-bulb bezel) ──
  // A dot on every segment divider AND every segment centre. Drawn inside a
  // rotation so they're baked WITH the wheel (rotate during a live drag, ride the
  // CSS transform during a tap-spin). Flag is gated by the stroke threshold at
  // save time, so the painter just honours it.
  if (outerStrokeDots) {
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(rotation);
    ctx.translate(-center.x, -center.y);
    const dotMode = config.bezelDotsColorMode ?? 'default';
    drawOuterDots(ctx, center.x, center.y, radius, strokeWidth, outerStrokeWidth,
      bezelDotColor(dotMode, wheelBaseColor, config.bezelDotsCustomColor),
      layout.startAngles, layout.segmentSizes, 1,
      dotMode === 'segment' ? items.map(it => it.color) : undefined,
      cornerRadius, !showBackgroundCircle);
    ctx.restore();
  }

  // ── Win ink cover (see WheelPainterConfig.winInkCover) ──
  // Drawn AFTER every chrome pass (divider strokes, rim rings, bezel dots) so
  // the refill wins over any ink that intrudes into the wedge.
  if (config.winInkCover && winningIndex >= 0 && winningIndex < items.length) {
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(rotation);
    ctx.translate(-center.x, -center.y);
    const winItem = items[winningIndex];
    ctx.fillStyle = winItem.color;
    ctx.fill(layout.paths[winningIndex]);
    if (winItem.texture) drawSegmentTexture(ctx, layout.paths[winningIndex], center.x, center.y, radius, winItem.texture, textureOverlayColor(winItem.color));
    ctx.restore();
  }

  // ── Overlay: dark tint + winning segment highlight ──
  if (overlayOpacity > 0 && winningIndex >= 0 && winningIndex < items.length) {
    // Extend past the outermost stroke's MAX extent. The divider / rim-ring /
    // outer-ring strokes ride the rim AND swell with the ink variation (up to
    // 1 + strokeWidthVar), so the tint has to clear that swollen width or the
    // fattened bits poke out as a bright rim on the dimmed win frame. The rough
    // disc below adds the rim wobble on top, so this only needs the stroke band.
    const strokeHalf = strokeWidth > 0 ? strokeWidth / 2 : 0;
    const inkMax = ROUGHNESS.enabled && ROUGHNESS.strokeWidthVar > 0 ? 1 + ROUGHNESS.strokeWidthVar : 1;
    const overlayRadius = radius + (strokeHalf + outerStrokeWidth) * inkMax + 1;

    // Dark overlay. With roughness on, the rim wobbles past a clean circle, so a
    // plain arc left the peaks uncovered — fill a rough disc that rides the same
    // rim wobble (offset out past the stroke band) instead, drawn rotated so it
    // lines up with the wheel.
    const oc = hexToRgba(overlayColor);
    ctx.fillStyle = `rgba(${oc.r}, ${oc.g}, ${oc.b}, ${overlayOpacity * 0.7})`;
    if (ROUGHNESS.enabled) {
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(rotation);
      ctx.translate(-center.x, -center.y);
      ctx.fill(roughCirclePath(center.x, center.y, overlayRadius, radius));
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(center.x, center.y, overlayRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Winning segment highlight
    ctx.save();
    ctx.globalAlpha = overlayOpacity;
    ctx.translate(center.x, center.y);
    ctx.rotate(rotation);
    ctx.translate(-center.x, -center.y);

    const winItem = items[winningIndex];
    ctx.fillStyle = winItem.color;
    ctx.fill(layout.paths[winningIndex]);
    if (winItem.texture) drawSegmentTexture(ctx, layout.paths[winningIndex], center.x, center.y, radius, winItem.texture, textureOverlayColor(winItem.color));

    // Winning segment text is deferred to the crisp content pass below.

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Pixelate the ART (fills, strokes, rings, dots, win highlight), THEN lay the
  // text + per-slice visuals on top crisp — on the separate text canvas when one
  // was supplied (so it escapes the art canvas's nearest-neighbour scaling).
  // Build a fixed palette (segment fills + chrome) so blocks snap to real colours
  // → hard segment dividers, zero AA. Skipped during the win overlay, whose dark
  // dimming produces blended tints that aren't in the palette.
  let palette: Palette | undefined;
  if (PIXELATED && !config.fastPixelate) {
    const seen = new Set<string>();
    palette = [];
    const add = (hex?: string) => {
      if (!hex || hex[0] !== '#' || seen.has(hex)) return;
      seen.add(hex);
      const { r, g, b } = hexToRgba(hex);
      palette!.push([r, g, b]);
    };
    for (const it of items) add(it.color);
    add(wheelBaseColor);
    // Grey backing fill — only painted in the no-stroke/no-round bg case, so
    // only offer it to the vote then. Unconditionally adding it gave the
    // white↔dark-fill seam blends a mid-grey to snap to, which won the vote in
    // blocks straddling a divider → grey specks along those seams.
    if (strokeWidth === 0 && cornerRadius === 0 && showBackgroundCircle) add('#808080');
    const dotColors = outerStrokeDots
      ? bezelDotPaletteColors(config.bezelDotsColorMode, wheelBaseColor, config.bezelDotsCustomColor, items)
      : [];
    for (const c of dotColors) add(c);
    if (overlayOpacity > 0) {
      // Win overlay dims everything toward overlayColor by a = opacity*0.7. Add
      // those dimmed variants so the win state quantises hard too (the winning
      // slice stays its bright, un-dimmed colour — already added above).
      const a = overlayOpacity * 0.7;
      for (const it of items) add(lerpColor(it.color, overlayColor, a));
      add(lerpColor(wheelBaseColor, overlayColor, a));
      for (const c of dotColors) add(lerpColor(c, overlayColor, a));
      add(overlayColor);
    }
  }
  if (PIXELATED) pixelateCanvas(ctx, width, height, width / PIXEL_BLOCKS, palette);

  paintSegmentContent(textCtx ?? ctx, items, layout, {
    center, rotation, textX, imageSize, scale, textVerticalOffset,
    fromItems, transition, overlayOpacity, winningIndex,
    winTextPop: config.winTextPop,
  });
}

// Crisp content layer — per-slice labels + visuals — drawn AFTER the pixelate
// pass so text stays sharp over the lo-fi wheel art. Reproduces the same clip /
// rotate / fade the interleaved draw used, plus the win-state dimming (the dark
// overlay is already baked into the pixelated art, so here we just fade the
// non-winning labels to match and redraw the winner bright).
interface SegmentContentCtx {
  center: { x: number; y: number };
  rotation: number;
  textX: number;
  imageSize: number;
  scale: number;
  textVerticalOffset: number;
  fromItems?: WheelItem[] | null;
  transition: number;
  overlayOpacity: number;
  winningIndex: number;
  winTextPop?: { scale: number; alpha: number };
}

function paintSegmentContent(
  ctx: CanvasRenderingContext2D,
  items: WheelItem[],
  layout: CachedLayout,
  c: SegmentContentCtx,
): void {
  const { center, rotation, textX, imageSize, scale, textVerticalOffset,
          fromItems, transition, overlayOpacity, winningIndex, winTextPop } = c;
  const won = overlayOpacity > 0 && winningIndex >= 0 && winningIndex < items.length;

  const drawLabel = (i: number, alpha: number, pop?: { scale: number; alpha: number }) => {
    const ft = _ftVal[i];
    if (!ft) return;
    const item = items[i];
    ctx.save();
    ctx.globalAlpha = alpha * (pop ? pop.alpha : 1);
    // Clip to the slice's exact wedge (same rotated frame the fill used) so
    // over-long labels crop at the boundary instead of spilling. (A popping
    // label's overshoot clips here too — it stays inside its slice.)
    ctx.clip(layout.paths[i]);
    ctx.translate(center.x, center.y);
    ctx.rotate(layout.startAngles[i] + layout.segmentSizes[i] / 2);
    // Font set BEFORE the pop transform — the scale anchor needs line widths.
    ctx.font = `600 ${ft.fontSize}px ${WHEEL_FONT}`;
    if (pop && pop.scale !== 1) {
      // Win-flash pop: scale the label (+ its visual) about its visual centre.
      let w = 0;
      for (const ln of ft.lines) w = Math.max(w, ctx.measureText(ln).width);
      const ax = ft.textX - w / 2;
      const ay = -textVerticalOffset;
      ctx.translate(ax, ay);
      ctx.scale(pop.scale, pop.scale);
      ctx.translate(-ax, -ay);
    }
    ctx.fillStyle = tintedTextColor(item.color);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    drawSegmentVisual(ctx, item, textX, imageSize, scale, item.color);
    const lineH = ft.fontSize * 1.05;
    const y0 = -textVerticalOffset - ((ft.lines.length - 1) * lineH) / 2;
    for (let li = 0; li < ft.lines.length; li++) {
      ctx.fillText(ft.lines[li], ft.textX, y0 + li * lineH);
    }
    ctx.restore();
  };

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rotation);
  ctx.translate(-center.x, -center.y);

  for (let i = 0; i < items.length; i++) {
    if (layout.segmentSizes[i] < 0.005) continue;
    // The winner is redrawn bright below; its dimmed copy would just sit under
    // the bright win fill, so skip it here.
    if (won && i === winningIndex) continue;

    // Add/remove fade: labels on a sliver-thin (near-zero-weight) slice fade
    // rather than pop at full opacity.
    let alpha = 1;
    if (fromItems && i < fromItems.length && transition < 1) {
      const fromWeight = fromItems[i].weight;
      const toWeight = items[i].weight;
      if (fromWeight <= 0.002) alpha = transition;
      else if (toWeight <= 0.002) alpha = 1 - transition;
    }
    // The pixelated art already carries the dark win overlay; fade non-winning
    // labels by the same amount so they recede with it.
    if (won) alpha *= 1 - overlayOpacity * 0.7;
    if (alpha <= 0) continue;
    // The CSS-dim win path (dim canvas above, wedge punched out) keeps
    // overlayOpacity at 0 — the winner is a normal label here, so the pop
    // rides this call. The baked-overlay path pops via the bright call below.
    drawLabel(i, alpha, i === winningIndex ? winTextPop : undefined);
  }

  // Winner, bright, on top — matches the old overlay's globalAlpha = overlayOpacity.
  if (won) drawLabel(winningIndex, overlayOpacity, winTextPop);

  ctx.restore();
}

// Repaint ONLY the crisp text layer, reusing the module caches (_layoutVal /
// _ftVal) left warm by the last full paintWheel bake — valid during the win
// flash, which never re-bakes the wheel. Lets the winning label animate
// (config.winTextPop) per frame while the art canvas stays untouched. The
// text layer is always crisp anti-aliased — never pixelated.
export function repaintTextLayer(
  textCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: WheelPainterConfig,
): void {
  if (!_layoutVal) return;
  const outerStrokeWidth = config.outerStrokeWidth ?? 0;
  const strokeInset = config.strokeWidth > 0 ? config.strokeWidth / 2 + 0.5 : 0;
  const outerInset = outerStrokeWidth > 0 ? outerStrokeWidth + 0.5 : 0;
  const radius = Math.min(width, height) / 2 - strokeInset - outerInset;
  const scale = radius / 350;
  textCtx.clearRect(0, 0, width, height);
  paintSegmentContent(textCtx, config.items, _layoutVal, {
    center: { x: width / 2, y: height / 2 },
    rotation: config.rotation,
    textX: radius - 20 * scale,
    imageSize: config.imageSize,
    scale,
    textVerticalOffset: config.textVerticalOffset,
    fromItems: config.fromItems,
    transition: config.transition,
    overlayOpacity: config.overlayOpacity,
    winningIndex: config.winningIndex,
    winTextPop: config.winTextPop,
  });
}

// ── Hand-drawn "rough" wheel geometry ───────────────────────────────────────
// Procedural roughness so the wheel reads hand-drawn rather than geometrically
// perfect: slice edges (dividers) get SMALL-chunk wobble, the outer silhouette
// gets LARGER-chunk wobble. All jitter is DETERMINISTIC (seeded by angle), so
// it's stable frame-to-frame — the wheel is baked once and GPU-rotated, and even
// a re-bake reproduces the identical wobble (no shimmer/crawl). Shared dividers
// key off the SAME angle, so neighbouring slices wobble identically (seamless).
export const ROUGHNESS = {
  enabled: true,
  rimAmp: 0.009,  // outer-silhouette amplitude, fraction of radius (LARGE chunks)
  // Soft-clip on the silhouette: compresses the taller rim peaks while leaving
  // small wobble near-linear. At this knee it reaches into the MID-RANGE peaks
  // (not just the very tallest). Symmetric → mean radius unchanged. LOWER = more
  // peak smoothing (reaches further down the range); raise toward ~3 to disable.
  rimSoftKnee: 0.8,
  edgeAmp: 0.0105, // slice-edge amplitude, fraction of radius (SMALL chunks); also scales all grain layers
  // Adjacent wedges share an identical jittered divider (same angle → same
  // jitter), but the two fills still anti-alias against the background disc
  // along that diagonal seam, leaking a sub-pixel hairline of bg ("peak meets
  // valley" bleed). Sealing each wedge with a thin stroke in its OWN fill
  // colour overlaps neighbours by ~half this width and covers the seam. CSS px.
  seamSeal: 1.2,
  // Per-edge asymmetry. Without these every divider has the SAME amplitude and
  // SAME wiggle-count (only its phase varies), which reads as too uniform. These
  // give each edge its own character via low-harmonic envelopes sampled at the
  // divider angle — and because dividers are irregularly spaced, the result is
  // lumpy (some edges wobble hard / busy, others nearly straight / loose) rather
  // than a smooth gradient. 0 = uniform (old look); ~1 = strong spread.
  edgeAmpVar: 0.8,  // depth of per-edge AMPLITUDE variation (straight ↔ wobbly)
  edgeDensVar: 0.55, // depth of per-edge DENSITY variation (loose ↔ busy wiggles)
  // Neighbour decorrelation. Every envelope above is a SLOWLY-varying function of
  // the divider `angle` (low harmonics), so on a tight wheel two near-adjacent
  // dividers sit at almost the same angle → almost the same wobble phase → they
  // bulge in unison, which reads as the whole surface being nudged rather than
  // each edge being an independent painted stroke. This adds a SECOND source: a
  // high-harmonic phase (sampled at the divider angle) mixed into the base
  // wobble, so it swings a lot between close dividers (→ neighbours get their own
  // stroke shape) while staying integer-harmonic and 2π-periodic (→ shared
  // dividers, incl. the wrap seam, still match exactly). It only re-phases the
  // wobble, never its amplitude, so the tuned roughness level is unchanged.
  // 0 = old correlated look; ~1 = neighbours fully independent; raise for tighter
  // wheels.
  edgeDecorr: 1,
  // Third source — per-edge amplitude decorrelation. `edgeDecorr` above gives each
  // edge its own wobble PHASE; this gives each its own wobble STRENGTH, so a
  // phase-shifted family of equally-tall edges becomes one of genuinely
  // independent strokes (some neighbours wobbly, some calm). Again high integer
  // harmonics (19, 31, distinct from the phase source's 23/37) for neighbour
  // decorrelation that stays 2π-periodic, and it MULTIPLIES the base wobble
  // (centred on 1) so it scatters amplitude without biasing the overall level the
  // grain/edgeAmp knobs set. At ~1 the per-edge multiplier spans ~[0, 2]; kept
  // ≥0 (no wobble inversion) for edgeAmpDecorr ≤ 1. 0 = uniform strength.
  edgeAmpDecorr: 0.5,
  // Grain: a fine, high-frequency detail layer added ON TOP of the wobble, but
  // only in some sectors — gated by a per-section envelope (high harmonics →
  // several scattered patches) so a few edges read sketchy/grainy and the rest
  // stay clean. Distinct from edgeDensVar, which only stretches the existing
  // wavelength. 0 = no grain. Amplitude is a multiple of edgeAmp (1 ≈ as strong
  // as the base wobble), applied only in the gated sectors.
  edgeGrain: 0.4,
  // Second, FINER grain layer (t·41 vs layer 1's t·27) with its own gate on
  // different harmonics, so its patches fall in different sectors — overlapping
  // grain scales (some edges coarse-grainy, some fine, some both). 0 = off.
  edgeGrain2: 0.3,
  // Third, EVEN FINER grain layer (t·83) — micro-grain on top of layers 1 & 2.
  // Present on EVERY edge, really small and pretty uniform (only a gentle ±15%
  // variation), so it reads as a fine even texture, not scattered patches.
  // 0 = off.
  edgeGrain3: 0.085,
  // Second micro-grain — same uniform character as grain 3 but a FINER frequency
  // (t·101) and ~half the intensity, layered on for a richer fine texture. A
  // different frequency is what makes it add detail rather than just scaling
  // grain 3. 0 = off.
  edgeGrain4: 0.09,
  // NOTE: edge peak softening (the tanh soft-clip knee) is NOT a knob here — it's
  // derived from the wheel's Inner Stroke width (see kneeFromStroke): a thicker
  // divider stroke wants a harder knee so rough peaks stay tucked under it.
  // Narrow-slice smoothing: a divider between thin slices (low %) gets its edge
  // wobble scaled DOWN toward a straight line, since the same wobble that looks
  // good on a wide slice looks cramped between two close dividers. This is the
  // angular width (radians) at/above which an edge keeps full wobble; below it
  // the edge progressively straightens (smoothstep), reaching ~straight near 0.
  // The SLOW half of edgeSmoothFactor's two-part ramp: the angular width (rad) by
  // which a slice reaches FULL wobble. ~0.8 rad ≈ 13% of the wheel. (The fast half
  // — EDGE_SMOOTH_FAST — lifts the ultra-thins to a baseline so they aren't dead,
  // and the plateau between keeps the few-% slices calm.) The factor keys off the
  // THINNER adjacent slice, computed at layout time and passed to both sides, so
  // the shared edge still matches.
  edgeSmoothWidth: 0.8,
  // Micro-grain retention on thin slices. Narrow-slice smoothing (above)
  // straightens the base wobble + coarse grain on thin slices, and used to flatten
  // the micro grain (layers 3 & 4) with them, leaving thin slices reading as clean
  // vector edges. This sets how much of the micro grain is KEPT at the thinnest
  // (smooth→0): the micro factor lerps from 1 (wide slice, full grain) to this
  // value (thinnest). 0 = old behaviour (micro killed on thin); ~0.3 = a bit of
  // texture retained; 1 = micro never reduced; >1 = thin slices grainier than wide.
  microGrainThinBoost: 0.3,
  // Roughness of the rounded corners themselves. Without this the corner curves
  // are clean quadratics — vector-smooth tips against the hand-drawn edges. This
  // jitters each corner curve along its normal (tapered to 0 at both ends so it
  // still meets the radial edge and the arc cleanly). Corners aren't shared
  // between slices, so this has no seam constraint. Amplitude is a multiple of
  // edgeAmp. 0 = clean rounding; ~0.6 = hand-drawn tips; raise for scruffier.
  cornerRough: 0.6,
  // Divider stroke-width "ink" variation. Without it the divider/border lines are
  // a constant thickness (vector-flat) against the hand-drawn edges. This swells
  // and tapers the stroke ALONG each line like a pen — a per-point multiplier on
  // the Inner Stroke width (low harmonics in t for a couple of swells per edge,
  // plus the divider angle so lines differ). 0 = constant width; ~0.4 = gentle
  // ink; higher = scratchier. Clamped so the line never fully disappears.
  strokeWidthVar: 0.3,
};

// Per-wheel seed → phase offsets. Each wheel passes a stable seed (hashed from
// its config id — see roughSeedFromId) so its wobble differs from other wheels
// while staying IDENTICAL frame-to-frame (a per-frame random seed would make the
// edges boil during a spin). The seed only shifts each harmonic's PHASE — never
// its integer angle multiplier — so the 2π wrap-seam periodicity survives, and
// one seed drives BOTH the rim and the slice edges, so a wheel's silhouette and
// its dividers vary together. Channels: 0-2 rim, 3-4 edge wobble, 5-8 edge
// amplitude/density asymmetry envelopes, 9-11 grain layer 1, 12-14 grain layer
// 2, 15-17 grain layer 3, 18-19 grain layer 4, 20-21 phase-decorr source, 22-23
// amplitude-decorr source, 24-25 corner roughness, 26-27 stroke-width ink.
// Edge peak softening (the tanh soft-clip knee) is driven by the wheel's Inner
// Stroke width rather than being a fixed knob: a thicker divider stroke wants a
// harder (lower) knee so the rough peaks stay tucked under the stroke, while a
// thin / no stroke wants a soft knee that lets the peaks breathe. Linear from
// KNEE_AT_0 at stroke 0 to KNEE_AT_MAX at stroke >= STROKE_KNEE_MAX (in Inner
// Stroke slider units), clamped. Tweak these three to retune the relationship.
const STROKE_KNEE_MAX = 15;
const KNEE_AT_0 = 1.0;
const KNEE_AT_MAX = 0.3;
function kneeFromStroke(strokeWidth: number): number {
  const x = Math.min(1, Math.max(0, strokeWidth / STROKE_KNEE_MAX));
  return KNEE_AT_0 + (KNEE_AT_MAX - KNEE_AT_0) * x;
}
// Set per-paint from the Inner Stroke (module state, like roughPhases — safe
// because paints run synchronously).
let edgeSoftKnee = KNEE_AT_0;

function computeRoughPhases(seed: number): number[] {
  const phases: number[] = [];
  for (let c = 0; c < 28; c++) {
    // fract(sin(x) · k) → [0,1) → [0, 2π). Distinct per (seed, channel),
    // deterministic, no Math.random.
    const x = Math.sin(seed * 127.1 + c * 311.7 + 0.5) * 43758.5453;
    phases.push((x - Math.floor(x)) * Math.PI * 2);
  }
  return phases;
}
// Set at the top of each paint from the wheel's seed. Safe as module state
// because canvas paints run synchronously — one wheel is fully drawn before the
// next starts, so there's no interleaving that could read a stale value.
let roughPhases = computeRoughPhases(0);

// Stable [0,1) seed from a wheel's id (or any stable string). FNV-1a: cheap and
// well-spread, so distinct wheels get distinct wobble. Derive from the id (not
// the items) so editing/typing a label doesn't reshuffle the silhouette.
export function roughSeedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// Radial wobble for the outer silhouette — periodic over 2π (integer harmonics)
// so it's seamless where the rim wraps; LOW frequencies → large chunks. Amplitude
// scales by `ampRadius` — pass the WHEEL radius everywhere so concentric circles
// wobble in parallel instead of the bigger ones wobbling more. Per-wheel phase
// from roughPhases (constant in angle → periodicity preserved).
function rimNoise(angle: number, ampRadius: number): number {
  const s =
    Math.sin(angle * 4 + roughPhases[0]) * 0.6 +
    Math.sin(angle * 7 + roughPhases[1]) * 0.32 +
    Math.sin(angle * 11 + roughPhases[2]) * 0.08;
  // Soft-clip: ≈ linear for small |s| (typical wobble untouched), compresses
  // |s|→1 (the tallest peaks). tanh is monotonic and 2π-periodic in `s`, so the
  // wrap seam and the slice/backing/ring consistency all hold.
  const k = ROUGHNESS.rimSoftKnee;
  return ampRadius * ROUGHNESS.rimAmp * k * Math.tanh(s / k);
}

// Tangential wobble along a slice edge. `t`: 0 at centre → 1 at rim; tapered to 0
// at both ends so edges pin to the centre and meet the rim without a gap. Seeded
// by the divider `angle` so the two slices sharing it wobble identically. HIGHER
// frequencies in t → small chunks.
function edgeNoise(angle: number, t: number, ampRadius: number, smooth: number): number {
  const taper = Math.sin(Math.PI * t);
  // Per-edge character envelopes, sampled at the divider `angle`. Each is a sum
  // of two low integer harmonics in [-1, 1]; integer harmonics keep them
  // 2π-periodic (wrap seam matches) and they depend only on `angle` (shared
  // dividers agree). `amp`: how wobbly this edge is (some ~straight, some big).
  // `dens`: its wiggle-count (some loose, some busy). Irregular divider spacing
  // turns these smooth envelopes into lumpy, asymmetrical per-edge variation.
  const ampEnv  = Math.sin(angle * 2 + roughPhases[5]) * 0.65 + Math.sin(angle * 5 + roughPhases[6]) * 0.35;
  const densEnv = Math.sin(angle * 3 + roughPhases[7]) * 0.6  + Math.sin(angle * 7 + roughPhases[8]) * 0.4;
  // Per-edge amplitude decorrelation (third source): high integer harmonics
  // (19, 31) so it swings hard between close dividers, MULTIPLYING the base
  // wobble strength so neighbours differ in how much they wobble (not just how).
  // Centred on 1; integer harmonics keep it 2π-periodic so shared dividers/the
  // wrap seam still match. Clamped ≥0 so a big knob can't invert the wobble.
  const ampDecorr = Math.max(0, 1 + ROUGHNESS.edgeAmpDecorr * (
    Math.sin(angle * 19 + roughPhases[22]) * 0.6 +
    Math.sin(angle * 31 + roughPhases[23]) * 0.4
  ));
  const amp  = (1 + ROUGHNESS.edgeAmpVar  * ampEnv) * ampDecorr;  // per-edge strength
  const dens = 1 + ROUGHNESS.edgeDensVar * densEnv;  // ~[1-var, 1+var]
  // Grain gate: 0 over the sectors where the envelope is negative (clean edges),
  // rising in scattered positive patches (grainy edges), and peaking slightly
  // past 1 (weights sum to 1.1) where both harmonics align — those few spots get
  // a touch more grain than the rest. High harmonics (6, 8) → several small
  // patches around the wheel, not one big region.
  const grainGate = Math.max(0, Math.sin(angle * 6 + roughPhases[9]) * 0.6 + Math.sin(angle * 8 + roughPhases[10]) * 0.5);
  // Layer-2 gate — different harmonics (5, 11) so its grainy patches sit in
  // different sectors than layer 1's.
  const grainGate2 = Math.max(0, Math.sin(angle * 5 + roughPhases[12]) * 0.6 + Math.sin(angle * 11 + roughPhases[13]) * 0.5);
  // Layer-3 amount — NOT a patchy gate: a near-constant level (≈0.85 ± 0.15) so
  // the micro-grain sits on every edge, pretty uniform — a fine even texture
  // rather than scattered patches. The per-edge phase (angle·6 in the term
  // below) still keeps neighbouring edges from looking identical.
  const grainAmt3 = 0.85 + 0.15 * Math.sin(angle * 5 + roughPhases[15]);
  // Layer-4 amount — same uniform treatment as layer 3 (different harmonic/phase).
  const grainAmt4 = 0.85 + 0.15 * Math.sin(angle * 4 + roughPhases[18]);
  // Neighbour-decorrelation phase (the SECOND source). HIGH integer harmonics
  // (23, 37) so the value swings a lot between close dividers — two adjacent
  // edges on a tight wheel land on very different phases and stop bulging in
  // unison. Integers keep it 2π-periodic, so a shared divider (same angle, both
  // sides) and the wrap seam still match. Folded into the base wobble's phase
  // below: it re-shapes each edge's stroke without changing its amplitude.
  const decorr = ROUGHNESS.edgeDecorr * Math.PI * (
    Math.sin(angle * 23 + roughPhases[20]) * 0.6 +
    Math.sin(angle * 37 + roughPhases[21]) * 0.4
  );
  // The `angle` multipliers MUST stay integers so this is periodic over 2π: the
  // wrap-around divider is angle 0 to the first slice but 2π to the last, and
  // only a 2π-periodic seed makes those two edges wobble identically (interior
  // dividers share an exact angle, so they match regardless). Was 3.1 / 1.7 —
  // non-integer — which leaked the bg at that one seam. `dens` scaling the t
  // frequency is fine: it's a periodic function of angle, and the taper pins
  // both ends to 0 regardless of frequency. Grain (t·27) is added independent of
  // `amp`, so even a near-straight edge can carry fine grain in a grainy sector.
  // Base wobble + coarse grain (layers 1-2): the cramped-looking part that the
  // narrow-slice smoothing straightens on thin slices.
  const baseCoarse =
    amp * (
      Math.sin(t * 9 * dens + angle * 3 + roughPhases[3] + decorr) * 0.6 +
      Math.sin(t * 17 * dens + angle * 2 + roughPhases[4] + decorr) * 0.4
    ) +
    grainGate * ROUGHNESS.edgeGrain * Math.sin(t * 27 + angle * 4 + roughPhases[11]) +
    grainGate2 * ROUGHNESS.edgeGrain2 * Math.sin(t * 41 + angle * 5 + roughPhases[14]);
  // Micro grain (layers 3-4): fine texture, NOT cramped by close dividers, so it
  // shouldn't be smoothed away as hard as the base wobble. Its factor lerps from 1
  // (wide) to microGrainThinBoost (thinnest), so thin slices keep some texture.
  // `smooth` (1 wide → 0 thin) is identical on both sides of a divider, so the
  // seam still matches.
  const micro =
    grainAmt3 * ROUGHNESS.edgeGrain3 * Math.sin(t * 83 + angle * 6 + roughPhases[17]) +
    grainAmt4 * ROUGHNESS.edgeGrain4 * Math.sin(t * 101 + angle * 7 + roughPhases[19]);
  // Apply narrow-slice smoothing HERE (not as an outer multiply): base+coarse fade
  // toward straight, micro fades only toward its retention floor. So `raw` already
  // bakes in the per-slice thinness — the caller no longer scales the result.
  const microFactor = smooth + ROUGHNESS.microGrainThinBoost * (1 - smooth);
  const raw = baseCoarse * smooth + micro * microFactor;
  // Soft-clip the summed offset: tanh ≈ identity for small |raw| (already-soft
  // edges pass through), saturating toward ±knee for large |raw| (rough edges /
  // grain spikes get compressed) — softens the rough without flattening the
  // calm. Monotonic and a function of `raw` alone, so shared dividers still
  // match and the 2π periodicity holds; the taper is applied AFTER, so the ends
  // still pin to the centre and rim.
  const k = edgeSoftKnee;
  const softened = k * Math.tanh(raw / k);
  return ampRadius * ROUGHNESS.edgeAmp * taper * softened;
}

// Edge-wobble scale for a divider, from the angular width of the THINNER slice
// it separates: 1 for slices ≥ edgeSmoothWidth (full wobble), smoothstepping to
// 0 (straight edge) as they get narrow — so close-together dividers don't carry
// cramped wobble. Computed at layout time and passed to BOTH slices of a divider
// (see paintWheel), so the shared edge still matches exactly.
// Two-part ramp so the wobble-vs-slice-size curve isn't a single monotone rise
// (which forced a bad trade: calm the chaotic few-% slices OR keep the ultra-thins
// and mids alive, never both). A FAST smoothstep (≈0.8% wide) brings the ultra-
// thin slices up to EDGE_SMOOTH_FLOOR quickly so they aren't dead-straight; a SLOW
// smoothstep (edgeSmoothWidth, ≈13%) carries the rest up to full. Between them the
// curve plateaus, so the 2–4.5% slices stay calm (no full-amplitude wobble cramped
// into a narrow wedge) while ultra-thins and mids both keep life.
const EDGE_SMOOTH_FAST = 0.05;   // fast-rise width (rad) ≈ 0.8% of the wheel
const EDGE_SMOOTH_FLOOR = 0.5;   // wobble the fast rise tops out at (the plateau)
function edgeSmoothFactor(minSweep: number): number {
  const ss = (w: number) => { const x = Math.min(1, minSweep / w); return x * x * (3 - 2 * x); };
  return EDGE_SMOOTH_FLOOR * ss(EDGE_SMOOTH_FAST) + (1 - EDGE_SMOOTH_FLOOR) * ss(ROUGHNESS.edgeSmoothWidth);
}

// Per-point divider stroke-width multiplier — the "ink" variation that swells and
// tapers the border along its length. Low harmonics in `t` (a couple of swells
// per radial edge) plus the divider `angle` (so lines differ). A pure function of
// (angle, t), so both sides of a shared divider produce identical widths and the
// seam stays matched. Clamped so the line never vanishes. `t` is the inner→rim
// fraction for radial edges, or the angle itself for arc/corner points.
function strokeMul(angle: number, t: number): number {
  const w = Math.sin(t * 5 + angle * 3 + roughPhases[26]) * 0.6
          + Math.sin(t * 12 + angle * 8 + roughPhases[27]) * 0.4;
  return Math.max(0.2, 1 + ROUGHNESS.strokeWidthVar * w);
}

// Draw a segment outline as a variable-width "ink" stroke: each adjacent pair of
// outline points is stroked as its own round-capped sub-stroke at the points'
// averaged width multiplier, so the line swells and tapers along its length (the
// round caps overlap and read as one continuous stroke). Bake-time only — the
// spin is a CSS transform, so paintWheel doesn't run per frame. The outline is a
// closed loop; the final segment back to the first point closes it (zero-length
// for centre-meeting wedges, the inner donut edge otherwise).
// How much of the divider ink variation the (wider) outer ring gets — lower so
// the ring's swell stays subtle relative to the thin dividers. 1 = same as
// dividers, 0 = uniform ring.
const RING_INK_SCALE = 0.65;
// `mScale` damps the width variation toward a constant (1 = full ink, 0 = uniform)
// — used to give the wide outer ring a gentler swell than the thin dividers.
function strokeVariableWidth(ctx: CanvasRenderingContext2D, pts: StrokePt[], baseWidth: number, mScale = 1): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i % pts.length];
    // Skip near-zero-length sub-strokes — a round-capped dot would otherwise
    // appear (notably the centre-meeting closing segment of a 'none'-inner wedge).
    if (Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05) continue;
    const ma = 1 + (a.m - 1) * mScale;
    const mb = 1 + (b.m - 1) * mScale;
    ctx.lineWidth = baseWidth * (ma + mb) * 0.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.lineCap = 'butt'; // restore default so later strokes aren't round-capped
}

// A closed hand-drawn circle (rim wobble applied) for the background disc and the
// concentric outer ring, so the silhouette stays consistent with the rough
// slices. `ampRadius` = the wheel radius (keeps every circle's wobble parallel).
// Draw it inside the SAME rotation as the slices so it doesn't desync on a spin.
function roughCirclePath(cx: number, cy: number, baseRadius: number, ampRadius: number): Path2D {
  const path = new Path2D();
  const steps = Math.max(96, Math.round(baseRadius * 0.7));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = baseRadius + rimNoise(a, ampRadius);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

// Backing disc whose wobbly rim is sampled IDENTICALLY to the slices' outer
// arcs — same divider angles, same per-span step (mirrors buildRoughSegmentPath's
// arc loop). A separately sampled rough circle disagreed with the slice rim at
// divider valleys and poked a white sliver past the slices; this can't, because
// it traces the exact same points. A star polygon around the centre, so (like the
// clean full-disc backing) the centre is filled. Draw inside the slices' rotation.
function buildRoughDisc(
  center: { x: number; y: number },
  radius: number,
  startAngles: number[],
  segmentSizes: number[],
  outlineOut?: StrokePt[],
): Path2D {
  const path = new Path2D();
  let first = true;
  for (let s = 0; s < startAngles.length; s++) {
    const startAngle = startAngles[s];
    const sweep = segmentSizes[s];
    if (sweep <= 0) continue;
    const arcSteps = Math.max(8, Math.ceil(sweep / 0.022));
    for (let i = 0; i <= arcSteps; i++) {
      const a = startAngle + (sweep * i) / arcSteps;
      const r = radius + rimNoise(a, radius);
      const x = center.x + Math.cos(a) * r;
      const y = center.y + Math.sin(a) * r;
      if (first) { path.moveTo(x, y); first = false; } else path.lineTo(x, y);
      // Same multiplier the slice arcs use (strokeMul(a, 1)), so the continuous
      // rim ring matches the slice rim strokes exactly where they overlap.
      if (outlineOut) outlineOut.push({ x, y, m: strokeMul(a, 1) });
    }
  }
  path.closePath();
  return path;
}

// Rough wedge — a jittered slice that ALSO honours rounded outer corners. Radial
// edges jitter tangentially (small chunks); the outer arc rides the rim wobble
// (large chunks). Shared dividers + rim points are computed from the angle alone,
// so adjacent slices line up exactly. Corners are rounded the same way clean mode
// does (quadratic through the corner, per-segment clamp), which works because the
// edge jitter tapers to ~0 at the rim — the radial edges reach the corner clean.
function buildRoughSegmentPath(
  center: { x: number; y: number },
  radius: number,
  startAngle: number,
  endAngle: number,
  cornerRadius: number,
  innerCornerStyle: string,
  centerInset: number,
  startEdgeSmooth: number,
  endEdgeSmooth: number,
  outlineOut?: StrokePt[],
): Path2D {
  const path = new Path2D();
  const inner = innerCornerStyle === 'none' ? 0 : centerInset;
  const sweep = endAngle - startAngle;
  // Emit a point to the path (moveTo for the first, lineTo after) and, if the
  // caller wants it, record it + its stroke-width multiplier for the variable
  // "ink" divider stroke (see strokeVariableWidth).
  let moved = false;
  const emit = (x: number, y: number, m: number) => {
    if (!moved) { path.moveTo(x, y); moved = true; } else path.lineTo(x, y);
    if (outlineOut) outlineOut.push({ x, y, m });
  };
  // Enough to resolve the finest edges: grain layer 4 runs at t·101 (~16.1
  // cycles), so 120 steps keeps ~7.5 samples/cycle and even the micro-grained
  // edges read smooth, not faceted. (Both slices of a divider use the same
  // count, so the shared edge still matches exactly.)
  const EDGE_STEPS = 120;
  // Arc sampled at the SAME per-span step as buildRoughDisc, so a rim point this
  // slice keeps lands exactly on the backing's rim point — no white sliver.
  const arcSteps = Math.max(8, Math.ceil(sweep / 0.022));
  // A point on the radial edge at `angle`, fraction t (inner → rim). The rim
  // radius itself wobbles so the edge's outer end lands on the rough arc.
  const edgePoint = (angle: number, t: number, smooth: number) => {
    const rimR = radius + rimNoise(angle, radius);
    const r = inner + (rimR - inner) * t;
    const off = edgeNoise(angle, t, radius, smooth);
    return {
      x: center.x + Math.cos(angle) * r - Math.sin(angle) * off,
      y: center.y + Math.sin(angle) * r + Math.cos(angle) * off,
    };
  };
  // A point on the wobbly rim at `angle` (no tangential offset — the edge jitter
  // is ~0 here, and the corner curve/arc ride the silhouette directly).
  const rimPoint = (a: number) => {
    const r = radius + rimNoise(a, radius);
    return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
  };
  // Append a corner quadratic (p0 → control c → p2) to the path as a jittered
  // polyline so the rounded tip reads hand-drawn, not vector-smooth. The jitter
  // rides the curve normal and tapers (sin πu) to 0 at both ends, so the corner
  // still meets the radial pull-back (p0) and the arc (p2) exactly. Corners
  // aren't shared between slices, so `seedAngle` (the divider) just needs to be
  // stable, not matched. The path is assumed to already sit at p0.
  type Pt = { x: number; y: number };
  const roughCorner = (p0: Pt, c: Pt, p2: Pt, seedAngle: number) => {
    const steps = Math.max(6, Math.ceil(Math.hypot(p2.x - p0.x, p2.y - p0.y) / 6));
    const m = strokeMul(seedAngle, 1);
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const mu = 1 - u;
      const bx = mu * mu * p0.x + 2 * mu * u * c.x + u * u * p2.x;
      const by = mu * mu * p0.y + 2 * mu * u * c.y + u * u * p2.y;
      const tx = 2 * mu * (c.x - p0.x) + 2 * u * (p2.x - c.x);
      const ty = 2 * mu * (c.y - p0.y) + 2 * u * (p2.y - c.y);
      const tlen = Math.hypot(tx, ty) || 1;
      const taper = Math.sin(Math.PI * u);
      const noise = Math.sin(u * 11 + seedAngle * 6 + roughPhases[24]) * 0.6
                  + Math.sin(u * 23 + seedAngle * 4 + roughPhases[25]) * 0.4;
      const off = ROUGHNESS.edgeAmp * radius * ROUGHNESS.cornerRough * taper * noise;
      emit(bx - (ty / tlen) * off, by + (tx / tlen) * off, m);
    }
  };

  // Corner rounding (mirrors clean buildSegmentPath): clamp the angular corner so
  // the two corners of a wedge never overlap; `effR` is the radial pull-back.
  const cornerArc = Math.min(cornerRadius / radius, sweep / 2);
  const effR = cornerArc * radius;

  // No rounding requested — original sharp wedge (also avoids degenerate curves).
  if (effR <= 0.01) {
    for (let i = 0; i <= EDGE_STEPS; i++) {
      const t = i / EDGE_STEPS;
      const p = edgePoint(startAngle, t, startEdgeSmooth);
      emit(p.x, p.y, strokeMul(startAngle, t));
    }
    for (let i = 1; i <= arcSteps; i++) {
      const a = startAngle + (sweep * i) / arcSteps;
      const p = rimPoint(a);
      emit(p.x, p.y, strokeMul(a, 1));
    }
    for (let i = EDGE_STEPS - 1; i >= 0; i--) {
      const t = i / EDGE_STEPS;
      const p = edgePoint(endAngle, t, endEdgeSmooth);
      emit(p.x, p.y, strokeMul(endAngle, t));
    }
    path.closePath();
    return path;
  }

  // Fraction t at which a radial edge stops (radius pulled back by effR). rimR
  // wobbles per angle, so compute per side; both sides of a shared divider pull
  // back by the SAME radial distance, matching clean mode's per-segment clamp.
  const tCorner = (angle: number) => {
    const rimR = radius + rimNoise(angle, radius);
    return Math.max(0, 1 - effR / (rimR - inner));
  };
  const tStart = tCorner(startAngle);
  const tEnd = tCorner(endAngle);
  const arcStartA = startAngle + cornerArc;
  const arcEndA = endAngle - cornerArc;

  // Start radial edge: inner → pull-back point. `cursor` tracks the last point so
  // the corner quadratics know where they start from.
  const startSteps = Math.max(2, Math.ceil(EDGE_STEPS * tStart));
  let cursor: Pt = { x: 0, y: 0 };
  for (let i = 0; i <= startSteps; i++) {
    const t = (tStart * i) / startSteps;
    const p = edgePoint(startAngle, t, startEdgeSmooth);
    emit(p.x, p.y, strokeMul(startAngle, t));
    cursor = p;
  }
  // Outer arc — only the grid points inside the corner cut-backs (so they match
  // the backing exactly); the corners themselves are (jittered) quadratics through
  // the rough rim point at the divider, bridging the pull-back to the arc.
  let started = false;
  for (let i = 0; i <= arcSteps; i++) {
    const a = startAngle + (sweep * i) / arcSteps;
    if (a < arcStartA || a > arcEndA) continue;
    const p = rimPoint(a);
    if (!started) {
      roughCorner(cursor, rimPoint(startAngle), p, startAngle);
      started = true;
    } else {
      emit(p.x, p.y, strokeMul(a, 1));
    }
    cursor = p;
  }
  if (!started) {
    // Corners meet (no flat arc between them) — round to a single apex at mid.
    const apex = rimPoint((startAngle + endAngle) / 2);
    roughCorner(cursor, rimPoint(startAngle), apex, startAngle);
    cursor = apex;
  }
  // End corner: last arc point → (control = rough rim at endAngle) → pull-back.
  const endPull = edgePoint(endAngle, tEnd, endEdgeSmooth);
  roughCorner(cursor, rimPoint(endAngle), endPull, endAngle);
  // End radial edge: pull-back → inner.
  const endSteps = Math.max(2, Math.ceil(EDGE_STEPS * tEnd));
  for (let i = endSteps - 1; i >= 0; i--) {
    const t = (tEnd * i) / endSteps;
    const p = edgePoint(endAngle, t, endEdgeSmooth);
    emit(p.x, p.y, strokeMul(endAngle, t));
  }
  path.closePath();
  return path;
}

function buildSegmentPath(
  center: { x: number; y: number },
  radius: number,
  startAngle: number,
  endAngle: number,
  cornerRadius: number,
  innerCornerStyle: string,
  centerInset: number,
  startEdgeSmooth = 1,
  endEdgeSmooth = 1,
  outlineOut?: StrokePt[],
): Path2D {
  const segmentSize = endAngle - startAngle;
  if (ROUGHNESS.enabled) {
    return buildRoughSegmentPath(center, radius, startAngle, endAngle, cornerRadius, innerCornerStyle, centerInset, startEdgeSmooth, endEdgeSmooth, outlineOut);
  }
  // Clamp the rounded-corner radius so the two corner arcs at the ends of
  // the wedge never overlap. Without this clamp, when the segment is
  // narrower than 2 * cornerRadius/radius, the outer arc's sweep would
  // be negative — and Canvas2D's `path.arc()` with a negative sweep and
  // anticlockwise=false draws the *long* way around the circle. Result:
  // a tiny segment's path covers nearly the entire wheel and its fill
  // colour blanks every other segment for one frame. This was the
  // fraction-of-a-second recolour visible at the start of the add
  // animation and the end of the remove animation, where the placeholder
  // segment briefly has near-zero weight.
  const maxCornerArc = segmentSize / 2;
  const cornerArc = Math.min(cornerRadius / radius, maxCornerArc);
  const effectiveCornerRadius = cornerArc * radius;
  const path = new Path2D();

  if (innerCornerStyle === 'none') {
    path.moveTo(center.x, center.y);
  } else {
    const innerStartX = center.x + centerInset * Math.cos(startAngle);
    const innerStartY = center.y + centerInset * Math.sin(startAngle);
    path.moveTo(innerStartX, innerStartY);
  }

  // Line to outer edge near start
  path.lineTo(
    center.x + (radius - effectiveCornerRadius) * Math.cos(startAngle),
    center.y + (radius - effectiveCornerRadius) * Math.sin(startAngle),
  );

  // Rounded corner at start
  const outerStartX = center.x + radius * Math.cos(startAngle);
  const outerStartY = center.y + radius * Math.sin(startAngle);
  const arcStartX = center.x + radius * Math.cos(startAngle + cornerArc);
  const arcStartY = center.y + radius * Math.sin(startAngle + cornerArc);
  path.quadraticCurveTo(outerStartX, outerStartY, arcStartX, arcStartY);

  // Arc along the outer edge — guaranteed non-negative because cornerArc
  // is clamped to segmentSize/2.
  const arcStart = startAngle + cornerArc;
  const arcSweep = segmentSize - 2 * cornerArc;
  path.arc(center.x, center.y, radius, arcStart, arcStart + arcSweep);

  // Rounded corner at end (uses the same clamped radius)
  const outerEndX = center.x + radius * Math.cos(endAngle);
  const outerEndY = center.y + radius * Math.sin(endAngle);
  path.quadraticCurveTo(
    outerEndX, outerEndY,
    center.x + (radius - effectiveCornerRadius) * Math.cos(endAngle),
    center.y + (radius - effectiveCornerRadius) * Math.sin(endAngle),
  );

  if (innerCornerStyle === 'none') {
    path.lineTo(center.x, center.y);
  } else {
    const innerStartX = center.x + centerInset * Math.cos(startAngle);
    const innerStartY = center.y + centerInset * Math.sin(startAngle);
    const innerEndX = center.x + centerInset * Math.cos(endAngle);
    const innerEndY = center.y + centerInset * Math.sin(endAngle);

    path.lineTo(innerEndX, innerEndY);

    if (innerCornerStyle === 'rounded') {
      path.quadraticCurveTo(center.x, center.y, innerStartX, innerStartY);
    } else if (innerCornerStyle === 'straight') {
      path.lineTo(innerStartX, innerStartY);
    } else {
      // 'circular' — arc along inner circle (counter-clockwise)
      path.arc(center.x, center.y, centerInset, endAngle, startAngle, true);
    }
  }

  path.closePath();
  return path;
}

// ── Thumbnail painter ──────────────────────────────────────────────────
// Miniature of the actual wheel — `strokeWidth`, corner settings, and
// `showBackgroundCircle` are taken from the wheel's own config and scaled
// against the wheel's ideal render size (700px) so the thumbnail reads as
// a true shrunken copy. (The center marker is an HTML overlay, drawn by
// WheelThumbnail, not here.) Defaults match `defaultWheelConfig` so callers
// that don't pass a style still get a wheel that looks right.

const WHEEL_REFERENCE_SIZE = 700; // mirrors RouletteScreen's idealWheelSize

export interface WheelThumbnailStyle {
  strokeWidth?: number;                                          // default 7.7
  outerStrokeWidth?: number;                                     // default 0 — extra outer ring
  outerStrokeDots?: boolean;                                     // decorative bezel dots
  bezelDotsColorMode?: 'default' | 'custom' | 'segment';
  bezelDotsCustomColor?: string;
  showBackgroundCircle?: boolean;                                // default true
  wheelBaseColor?: string;                                       // default white — divider/ring + bg circle colour
  cornerRadius?: number;                                         // default 30 — segment corner rounding
  innerCornerStyle?: 'none' | 'rounded' | 'circular' | 'straight'; // default 'none'
  centerInset?: number;                                          // default 50 — inner donut inset
  // Marker tuning — used by the WheelThumbnail overlay (NOT drawn on the
  // canvas, since the marker is an HTML/CSS element). See CustomMarker.
  markerDiameter?: number;                                       // default 60 — % of marker box
  markerPeek?: number;                                           // default 4 — % of diameter
  markerBaseColor?: string;                                      // default white
  roughSeed?: number;                                            // per-wheel wobble seed (default 0)
  showPin?: boolean;                                             // draw the pin graphic (default off)
}

export function paintWheelThumbnail(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  items: WheelItem[],
  style?: WheelThumbnailStyle,
  // When set, EVERYTHING (back circle, segment fills, dividers, outer ring) is
  // painted in this one colour — producing a flat silhouette of the wheel's
  // exact outline. Used by WheelThumbnail to render a silhouette copy behind
  // the wheel that follows the true shape (flower outlines when the background
  // circle is off, rounded corners, outer stroke), not a plain circle.
  monochrome?: string,
): void {
  // Per-wheel wobble — set before any rough path is built (see paintWheel).
  if (ROUGHNESS.enabled) roughPhases = computeRoughPhases(style?.roughSeed ?? 0);

  const center = { x: width / 2, y: height / 2 };
  const canvasR = Math.min(width, height) / 2;
  // Proportional scale: thumbnail dimension vs the wheel's ideal render size.
  const scale = Math.min(width, height) / WHEEL_REFERENCE_SIZE;
  const wheelStrokeWidth = style?.strokeWidth ?? 7.7;
  // Edge peak softening from the Inner Stroke (already in slider units here).
  if (ROUGHNESS.enabled) edgeSoftKnee = kneeFromStroke(wheelStrokeWidth);
  const wheelCornerRadius = style?.cornerRadius ?? 30;
  const wheelInnerStyle = style?.innerCornerStyle ?? 'none';
  const wheelCenterInset = style?.centerInset ?? 50;
  const showRing = style?.showBackgroundCircle ?? true;
  const wheelBaseColor = style?.wheelBaseColor ?? '#FFFFFF';
  // Stroke gets a small boost over strict 700-reference proportion: at
  // thumbnail scale, sub-pixel strokes render too faint. ~15% bigger reads
  // closer to how the wheel actually looks at its in-app render sizes
  // (typically 300–500px, not the 700px ideal). Marker / corner / inset
  // stay on strict proportion.
  const strokeW = wheelStrokeWidth * scale * 1.15;
  // Extra outer ring — scaled with the same boost as the divider stroke.
  const outerStrokeW = (style?.outerStrokeWidth ?? 0) * scale * 1.15;
  const ringInset = outerStrokeW > 0 ? outerStrokeW : 0;
  // Corner radius — small BOOST (~15%) over strict proportion. At
  // thumbnail scale the rounded-corner look reads better when the corners
  // are a touch more pronounced than the wheel's own ratio gives.
  const cornerR = wheelCornerRadius * scale * 1.15;
  const innerInset = wheelCenterInset * scale;
  // Pie radius mirrors paintWheel: canvas radius − half stroke width.
  // With the back-circle disc at canvasR and segment outer-arc strokes
  // centred on pieR (extending ±strokeW/2), the visible outer white band
  // works out to exactly strokeW — matching the divider strokes. Going
  // further inward (pieR = canvasR − strokeW) inflated the outer band to
  // 1.5 × strokeW, which read as a white "peek".
  const pieR = canvasR - ringInset - strokeW / 2;
  const totalWeight = items.reduce((s, item) => s + item.weight, 0);

  ctx.clearRect(0, 0, width, height);

  // Back circle — full white disc filling the entire canvas. Provides the
  // outer ring (visible strokeW-wide band between pieR and canvasR) AND a
  // background behind the pie (matches the real wheel's showBackgroundCircle
  // behaviour). Rounded-segment corner notches peek white through, which
  // matches the wheel's actual look.
  //
  // Edge case: when BOTH strokeWidth and cornerRadius are 0, there's no
  // outer ring band to "lift" the disc visually away from the edge, and
  // no notches either — the back circle and the pie align exactly. A
  // strict canvasR disc reads as too tight then; pull it in to 0.97 so a
  // thin dark sliver at the canvas edge breaks the silhouette.
  if (showRing) {
    const noStrokeNoRound = wheelStrokeWidth === 0 && wheelCornerRadius === 0;
    const backCircleScale = noStrokeNoRound ? 0.97 : 1.0;
    ctx.beginPath();
    // Full disc to the canvas edge — with `pieR` pulled in by `ringInset`, the
    // base-colour band between the pie and the edge widens by the outer stroke.
    ctx.arc(center.x, center.y, canvasR * backCircleScale, 0, Math.PI * 2);
    // 50% grey in the no-stroke / no-round edge case (mirrors paintWheel);
    // white otherwise. Silhouette mode overrides with the one mono colour.
    ctx.fillStyle = monochrome ?? (noStrokeNoRound ? '#808080' : wheelBaseColor);
    ctx.fill();
  }

  // Pie slices + per-slice stroke (dividers). Uses the same
  // `buildSegmentPath` the real wheel uses, so corner rounding /
  // innerCornerStyle / centerInset all transfer over proportionally.
  // The wheel paints with rotation = -Math.PI/2 + rotation; for a static
  // thumbnail we just offset the first segment to start at the top.
  const thumbPaths: Path2D[] = [];
  const thumbDividers: number[] = []; // segment divider angles (for bezel dots)
  const thumbSweeps: number[] = [];
  const nThumb = items.length;
  const sweeps = items.map((it) => (it.weight / totalWeight) * 2 * Math.PI);
  let startAngle = -Math.PI / 2;
  for (let i = 0; i < nThumb; i++) {
    const sweep = sweeps[i];
    thumbDividers.push(startAngle);
    thumbSweeps.push(sweep);
    // Match paintWheel: thin slices (low %) get straighter edges.
    const startEdgeSmooth = edgeSmoothFactor(Math.min(sweep, sweeps[(i - 1 + nThumb) % nThumb]));
    const endEdgeSmooth = edgeSmoothFactor(Math.min(sweep, sweeps[(i + 1) % nThumb]));
    thumbPaths.push(buildSegmentPath(center, pieR, startAngle, startAngle + sweep,
                                     cornerR, wheelInnerStyle, innerInset, startEdgeSmooth, endEdgeSmooth));
    startAngle += sweep;
  }

  // No background circle → a constant-width STROKE of the segment-union
  // silhouette (a scaled copy tapered at the rounded corners). Mirrors paintWheel.
  if (outerStrokeW > 0 && !showRing && pieR > 0) {
    const innerHole = innerInset > 0 && wheelInnerStyle !== 'none' ? innerInset : 0;
    ctx.save();
    if (innerHole > 0) {
      ctx.beginPath();
      ctx.rect(-width, -height, width * 3, height * 3);
      ctx.arc(center.x, center.y, innerHole, 0, Math.PI * 2);
      ctx.clip('evenodd');
    }
    ctx.strokeStyle = monochrome ?? wheelBaseColor;
    ctx.lineWidth = strokeW + outerStrokeW * 2;
    ctx.lineJoin = 'round';
    for (const p of thumbPaths) ctx.stroke(p);
    ctx.restore();
  }

  ctx.lineWidth = strokeW;
  ctx.strokeStyle = monochrome ?? wheelBaseColor;
  ctx.lineJoin = 'round';
  for (let i = 0; i < thumbPaths.length; i++) {
    ctx.fillStyle = monochrome ?? items[i].color;
    ctx.fill(thumbPaths[i]);
    if (strokeW > 0) ctx.stroke(thumbPaths[i]);
  }

  // Decorative outer dots (carnival-bulb bezel) — geometry in scaled thumbnail
  // px. Skipped in silhouette (mono) mode. Flag is gated at config-save time.
  if (!monochrome && (style?.outerStrokeDots ?? false)) {
    const dotMode = style?.bezelDotsColorMode ?? 'default';
    drawOuterDots(ctx, center.x, center.y, pieR, strokeW, outerStrokeW,
      bezelDotColor(dotMode, wheelBaseColor, style?.bezelDotsCustomColor),
      thumbDividers, thumbSweeps, 1 / 1.15,
      dotMode === 'segment' ? items.map(it => it.color) : undefined,
      cornerR, !showRing);
  }

  // The centre marker is drawn as an HTML overlay (CustomMarker) by
  // WheelThumbnail, not on the canvas — so no center dot here.
}
