import { WheelItem } from '../models/types';
import { hexToRgba, lerpColor, withAlpha, oklchShade, readableTextColor } from '../utils/colorUtils';

// Minimum combined (strokeWidth + outerStrokeWidth) for the decorative outer
// dots to be available/drawn — below this there isn't enough chrome band to
// host them. Shared with the editor so the toggle unlocks at the same point.
export const OUTER_DOTS_MIN_STROKE = 12;
// Past this corner radius the wheel reads as a flower/blob and a clean bezel
// ring of dots stops looking right — so the option is disabled above it.
export const OUTER_DOTS_MAX_CORNER = 20;

// A colour that reads against the (usually light) chrome stroke — darken a
// light base, lighten a dark one — so the dots look like beads/rivets on it.
function dotsContrastColor(baseColor: string): string {
  const { r, g, b } = hexToRgba(baseColor);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return oklchShade(baseColor, lum > 0.5 ? 0.42 : -0.5);
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
  const dot = (a: number) => {
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * dotRing, cy + Math.sin(a) * dotRing, dotR, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.fillStyle = dotColor;
  const n = dividerAngles.length;

  // Spacing relative to the dot size: ~7.5 diameters (= 15·dotR) of arc between
  // dots. Smaller dots ⇒ smaller gap ⇒ more in-between dots. The per-segment
  // count then just follows from its arc (pure geometry → symmetric).
  const targetGap = (15 * dotR) / dotRing;
  // A segment whose two divider dots would sit closer than ~1¼ diameters is
  // "super slim": suppress its (shared) edge dots and place one central dot.
  const slimArc = (2.5 * dotR) / dotRing;
  const slim = sweeps.map((s) => s < slimArc);

  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    // Shared divider dot — suppressed if either adjacent segment is super-slim,
    // so the slim segment's crowded edges collapse into its central dot.
    if (!slim[i] && !slim[prev]) dot(dividerAngles[i]);
    if (slim[i]) {
      dot(dividerAngles[i] + sweeps[i] / 2); // one central dot on the slim segment
    } else {
      const interior = Math.max(0, Math.min(40, Math.round(sweeps[i] / targetGap) - 1));
      for (let j = 1; j <= interior; j++) {
        dot(dividerAngles[i] + sweeps[i] * (j / (interior + 1)));
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
}

interface CachedLayout {
  paths: Path2D[];
  startAngles: number[];
  segmentSizes: number[];
  effectiveWeights: number[];
}

// Per-segment fitted label: the size it renders at and the line(s) to draw.
interface FittedText { fontSize: number; lines: string[]; }

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
  // Once we have to truncate, aim for a fraction of the available width so a
  // few extra characters are dropped — leaves breathing room and keeps the
  // head/tail clearly legible instead of crammed to the edge.
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
): FittedText[] {
  const total = items.reduce((s, it) => s + it.weight, 0) || 1;
  // Text must clear both the donut inset AND the centre marker's circle.
  const innerLimit = Math.max(centerInset, markerRadius, 0);
  const avail = Math.max(0, textX - innerLimit);
  const floorPx = Math.max(targetFont * TEXT_FIT_FLOOR, 6 * scale);
  // Separate, higher floor for LENGTH-driven shrinking: a too-long label only
  // shrinks ~this far before we ellipsize instead of shrinking on to the Min
  // Size floor. (Thin-wedge / angular shrinking still goes all the way to
  // floorPx.) Higher → ellipsis kicks in sooner at a larger size.
  const lengthFloorPx = Math.max(targetFont * 0.9, floorPx);
  const ANG_MARGIN = 1 * scale;
  const SHRINK = 0.92;
  // Visual glyph height as a fraction of font size (Inter, centred baseline).
  // Using the full font size over-shrinks labels that actually fit; 0.82 keeps
  // uniform wheels at the target while the wedge clip still catches any sliver.
  const GLYPH_H = 0.82;
  ctx.font = `600 ${targetFont}px Inter, sans-serif`;

  return items.map((it) => {
    const half = Math.min(((2 * Math.PI * it.weight) / total) / 2, Math.PI / 2);
    const sinHalf = Math.sin(half);

    // Best font size for a given set of lines: shrink until both the radial
    // (length) and angular (thickness at the text's inner end) limits hold.
    const fitLines = (lines: string[]): number => {
      let wTarget = 0;
      for (const ln of lines) wTarget = Math.max(wTarget, ctx.measureText(ln).width);
      const nLines = lines.length;
      // Single line → just the glyph height; two lines → a line of spacing
      // plus a glyph height on top.
      const lineFactor = nLines > 1 ? (nLines - 1) * 1.05 + GLYPH_H : GLYPH_H;
      let f = targetFont;
      for (let k = 0; k < 24; k++) {
        const textW = (wTarget * f) / targetFont;
        const rInner = textX - textW;
        const thickness = 2 * Math.max(rInner, innerLimit) * sinHalf;
        const angularOK = f * lineFactor + ANG_MARGIN <= thickness;
        const radialOK = rInner >= innerLimit;
        // Stop once it fits the wedge thickness AND either the whole label fits
        // radially or we've shrunk to the length floor (past which we ellipsize
        // rather than keep shrinking).
        if (angularOK && (radialOK || f <= lengthFloorPx)) break;
        f *= SHRINK;
        if (f <= floorPx) { f = floorPx; break; }
      }
      return f;
    };

    let lines = [it.text];
    let f = fitLines(lines);
    // Wrap if the single line would overflow (i.e. it's about to be ellipsized)
    // and a 2-line split renders at least as large — preferred over chopping.
    const singleOverflows = (ctx.measureText(it.text).width * f) / targetFont > avail;
    if (wrap && singleOverflows) {
      const split = splitTwoLines(it.text);
      if (split.length === 2) {
        const f2 = fitLines(split);
        if (f2 >= f) { lines = split; f = f2; }
      }
    }
    lines = lines.map((ln) => ellipsize(ctx, ln, targetFont, f, avail));
    return { fontSize: f, lines };
  });
}

// Memoize-last: only one wheel animates at a time, so a single-entry cache hits
// every spin frame (key omits rotation). Thumbnails draw no text, so they
// never touch this.
let _ftKey = '';
let _ftVal: FittedText[] = [];

export function paintWheel(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: WheelPainterConfig,
): void {
  const { items, rotation, cornerRadius, strokeWidth, showBackgroundCircle,
          imageSize, overlayColor, textVerticalOffset, innerCornerStyle,
          centerInset, overlayOpacity, winningIndex, fromItems, transition } = config;
  const wheelBaseColor = config.wheelBaseColor ?? '#FFFFFF';
  const outerStrokeWidth = config.outerStrokeWidth ?? 0;
  const outerStrokeDots = config.outerStrokeDots ?? false;
  const textWrap = config.textWrap ?? false;

  const center = { x: width / 2, y: height / 2 };
  const strokeInset = strokeWidth > 0 ? strokeWidth / 2 + 0.5 : 0;
  // Reserve room at the edge for the extra outer ring (drawn after segments).
  const outerInset = outerStrokeWidth > 0 ? outerStrokeWidth + 0.5 : 0;
  const radius = Math.min(width, height) / 2 - strokeInset - outerInset;
  const scale = radius / 350;
  const textX = radius - 20 * scale;

  ctx.clearRect(0, 0, width, height);

  // Background circle (not rotated). Edge case: when BOTH strokeWidth and
  // cornerRadius are 0, the disc lines up exactly with the segment outer
  // arc — strict canvasR reads as too tight with no ring band or rounded
  // corners to lift it visually. Pull it in to 0.98 so a thin dark sliver
  // at the edge breaks the silhouette (mirrors the thumbnail's logic).
  if (showBackgroundCircle) {
    const noStrokeNoRound = strokeWidth === 0 && cornerRadius === 0;
    const bgRadius = noStrokeNoRound ? radius * 0.98 : radius;
    ctx.beginPath();
    ctx.arc(center.x, center.y, bgRadius, 0, Math.PI * 2);
    // 50% grey in the no-stroke / no-round edge case (the disc is the
    // only visible "outline" since there's no ring or rounded corners);
    // white otherwise.
    ctx.fillStyle = noStrokeNoRound ? '#808080' : wheelBaseColor;
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

  // Precompute layout
  const layout: CachedLayout = { paths: [], startAngles: [], segmentSizes: [], effectiveWeights };
  let startAngle = 0;
  for (let i = 0; i < items.length; i++) {
    const segmentSize = arcSize * effectiveWeights[i];
    layout.startAngles.push(startAngle);
    layout.segmentSizes.push(segmentSize);
    layout.paths.push(buildSegmentPath(center, radius, startAngle, startAngle + segmentSize, cornerRadius, innerCornerStyle, centerInset));
    startAngle += segmentSize;
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
    const key = `${width}|${strokeWidth}|${outerStrokeWidth}|${centerInset}|${markerDiameter}|${config.fontSize}|${textWrap ? 1 : 0}|`
      + items.map((it) => `${it.text}${it.weight}`).join('');
    if (key !== _ftKey) {
      _ftVal = computeFittedText(ctx, items, config.fontSize, textX, scale, centerInset, markerRadius, textWrap);
      _ftKey = key;
    }
  }

  // Draw rotated segments
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rotation);
  ctx.translate(-center.x, -center.y);

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
    ctx.lineWidth = strokeWidth + outerStrokeWidth * 2;
    ctx.lineJoin = 'round';
    for (const p of layout.paths) ctx.stroke(p);
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

    // Stroke
    if (strokeWidth > 0) {
      ctx.strokeStyle = wheelBaseColor;
      ctx.lineWidth = strokeWidth;
      // Round joins instead of the default 'miter' — at small wheel sizes
      // the join between the radial edge and the rounded-corner curve gets
      // acute enough that miter joins spike well past the stroke width,
      // producing visible spike artifacts on the wheel's outer rim.
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    }

    // Text — always drawn, regardless of how thin the slice is. The
    // wedge clip below crops anything that would overflow the slice (both
    // radially AND across the slice's angular thickness), so a label that's
    // taller/longer than a thin wedge is trimmed at the segment boundary
    // instead of spilling into the neighbouring segments.
    {
      // Fade text in / out for segments mid-add or mid-remove (one side
      // of the transition has near-zero weight). The interpolated wedge
      // already grows / shrinks naturally from the weight lerp; this just
      // keeps the text from popping at full opacity over a tiny slice.
      let contentOpacity = 1;
      if (fromItems && i < fromItems.length && transition < 1) {
        const fromWeight = fromItems[i].weight;
        const toWeight = items[i].weight;
        // Threshold is just above the near-zero override weight WheelEditor
        // sends on add/remove (0.001), so segments mid-fade pick up a
        // smooth opacity ramp instead of holding text full-bright over a
        // sliver-thin slice.
        if (fromWeight <= 0.002) contentOpacity = transition;
        else if (toWeight <= 0.002) contentOpacity = 1 - transition;
      }

      ctx.save();
      ctx.globalAlpha = contentOpacity;

      // Clip to the segment's exact wedge. Done here — still in the wheel's
      // rotated frame, the same one the fill above used — so the path lines
      // up with the slice and rounded corners / inner style are respected.
      // The clip locks to device space, so the per-segment rotate below only
      // positions the text; it can't drag the clip region off the wedge.
      ctx.clip(path);

      ctx.translate(center.x, center.y);
      ctx.rotate(layout.startAngles[i] + layout.segmentSizes[i] / 2);

      // Draw text — per-segment fitted size + (optional) two lines from the
      // cached auto-fit layout. Colour flips to black on light fills (OKLCH L).
      ctx.fillStyle = readableTextColor(effectiveColor);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const ft = _ftVal[i];
      ctx.font = `600 ${ft.fontSize}px Inter, sans-serif`;
      const lineH = ft.fontSize * 1.05;
      const y0 = -textVerticalOffset - ((ft.lines.length - 1) * lineH) / 2;
      for (let li = 0; li < ft.lines.length; li++) {
        ctx.fillText(ft.lines[li], textX, y0 + li * lineH);
      }

      ctx.restore();
    }
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
    ctx.beginPath();
    ctx.arc(center.x, center.y, (innerEdge + outerEdge) / 2, 0, Math.PI * 2);
    ctx.strokeStyle = wheelBaseColor;
    ctx.lineWidth = outerEdge - innerEdge;
    ctx.stroke();
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
    drawOuterDots(ctx, center.x, center.y, radius, strokeWidth, outerStrokeWidth, dotsContrastColor(wheelBaseColor), layout.startAngles, layout.segmentSizes);
    ctx.restore();
  }

  // ── Overlay: dark tint + winning segment highlight ──
  if (overlayOpacity > 0 && winningIndex >= 0 && winningIndex < items.length) {
    // Always extend past the outermost stroke. Segment outer-arc strokes
    // extend `strokeWidth/2` past `radius` whether or not the background
    // circle is on — previously the no-bg-circle branch dropped that
    // term and the overlay left the outer ring strokes uncovered (visible
    // as a bright rim on the dimmed win frame). +0.5 is just an AA buffer.
    const overlayRadius = radius + (strokeWidth > 0 ? strokeWidth / 2 : 0) + outerStrokeWidth + 0.5;

    // Dark overlay
    ctx.beginPath();
    ctx.arc(center.x, center.y, overlayRadius, 0, Math.PI * 2);
    const oc = hexToRgba(overlayColor);
    ctx.fillStyle = `rgba(${oc.r}, ${oc.g}, ${oc.b}, ${overlayOpacity * 0.7})`;
    ctx.fill();

    // Winning segment highlight
    ctx.save();
    ctx.globalAlpha = overlayOpacity;
    ctx.translate(center.x, center.y);
    ctx.rotate(rotation);
    ctx.translate(-center.x, -center.y);

    const winItem = items[winningIndex];
    ctx.fillStyle = winItem.color;
    ctx.fill(layout.paths[winningIndex]);

    // Winning segment text — always drawn (the wedge clip below crops
    // anything that would overflow a too-thin slice into its neighbours).
    {
      ctx.save();
      // Clip to the winning slice's exact wedge (same rotated frame the fill
      // above used), then rotate to lay the text along the slice centreline.
      ctx.clip(layout.paths[winningIndex]);
      ctx.translate(center.x, center.y);
      ctx.rotate(layout.startAngles[winningIndex] + layout.segmentSizes[winningIndex] / 2);

      ctx.fillStyle = readableTextColor(winItem.color);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      // Same fitted size + lines as the wheel, so the win overlay matches.
      const wft = _ftVal[winningIndex];
      ctx.font = `600 ${wft.fontSize}px Inter, sans-serif`;
      const wLineH = wft.fontSize * 1.05;
      const wy0 = -textVerticalOffset - ((wft.lines.length - 1) * wLineH) / 2;
      for (let li = 0; li < wft.lines.length; li++) {
        ctx.fillText(wft.lines[li], textX, wy0 + li * wLineH);
      }

      ctx.restore();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

function buildSegmentPath(
  center: { x: number; y: number },
  radius: number,
  startAngle: number,
  endAngle: number,
  cornerRadius: number,
  innerCornerStyle: string,
  centerInset: number,
): Path2D {
  const segmentSize = endAngle - startAngle;
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
  const center = { x: width / 2, y: height / 2 };
  const canvasR = Math.min(width, height) / 2;
  // Proportional scale: thumbnail dimension vs the wheel's ideal render size.
  const scale = Math.min(width, height) / WHEEL_REFERENCE_SIZE;
  const wheelStrokeWidth = style?.strokeWidth ?? 7.7;
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
  let startAngle = -Math.PI / 2;
  for (const item of items) {
    const sweep = (item.weight / totalWeight) * 2 * Math.PI;
    thumbDividers.push(startAngle);
    thumbSweeps.push(sweep);
    thumbPaths.push(buildSegmentPath(center, pieR, startAngle, startAngle + sweep,
                                     cornerR, wheelInnerStyle, innerInset));
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
    drawOuterDots(ctx, center.x, center.y, pieR, strokeW, outerStrokeW, dotsContrastColor(wheelBaseColor), thumbDividers, thumbSweeps, 1 / 1.15);
  }

  // The centre marker is drawn as an HTML overlay (CustomMarker) by
  // WheelThumbnail, not on the canvas — so no center dot here.
}
