import { WheelItem } from '../models/types';
import { hexToRgba, lerpColor, withAlpha } from '../utils/colorUtils';

export interface WheelPainterConfig {
  items: WheelItem[];
  rotation: number;
  fontSize: number;
  cornerRadius: number;
  strokeWidth: number;
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

  const center = { x: width / 2, y: height / 2 };
  const strokeInset = strokeWidth > 0 ? strokeWidth / 2 + 0.5 : 0;
  const radius = Math.min(width, height) / 2 - strokeInset;
  const scale = radius / 350;

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

  // Draw rotated segments
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rotation);
  ctx.translate(-center.x, -center.y);

  const fontSize = config.fontSize;

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

      // Draw text
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `600 ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const textX = radius - 20 * scale;
      const textY = -textVerticalOffset;

      ctx.fillText(item.text, textX, textY);

      ctx.restore();
    }
  }

  ctx.restore(); // remove rotation

  // ── Overlay: dark tint + winning segment highlight ──
  if (overlayOpacity > 0 && winningIndex >= 0 && winningIndex < items.length) {
    // Always extend past the outermost stroke. Segment outer-arc strokes
    // extend `strokeWidth/2` past `radius` whether or not the background
    // circle is on — previously the no-bg-circle branch dropped that
    // term and the overlay left the outer ring strokes uncovered (visible
    // as a bright rim on the dimmed win frame). +0.5 is just an AA buffer.
    const overlayRadius = radius + (strokeWidth > 0 ? strokeWidth / 2 : 0) + 0.5;

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

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `600 ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(winItem.text, radius - 20 * scale, -textVerticalOffset);

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
  showBackgroundCircle?: boolean;                                // default true
  wheelBaseColor?: string;                                       // default white — divider/ring + bg circle colour
  cornerRadius?: number;                                         // default 30 — segment corner rounding
  innerCornerStyle?: 'none' | 'rounded' | 'circular' | 'straight'; // default 'none'
  centerInset?: number;                                          // default 50 — inner donut inset
  // Marker tuning — used by the WheelThumbnail overlay (NOT drawn on the
  // canvas, since the marker is an HTML/CSS element). See CustomMarker.
  markerDiameter?: number;                                       // default 65 — % of marker box
  markerPeek?: number;                                           // default 9 — % of diameter
  markerBaseColor?: string;                                      // default white
}

export function paintWheelThumbnail(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  items: WheelItem[],
  style?: WheelThumbnailStyle,
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
  const pieR = canvasR - strokeW / 2;
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
    ctx.arc(center.x, center.y, canvasR * backCircleScale, 0, Math.PI * 2);
    // 50% grey in the no-stroke / no-round edge case (mirrors paintWheel);
    // white otherwise.
    ctx.fillStyle = noStrokeNoRound ? '#808080' : wheelBaseColor;
    ctx.fill();
  }

  // Pie slices + per-slice stroke (dividers). Uses the same
  // `buildSegmentPath` the real wheel uses, so corner rounding /
  // innerCornerStyle / centerInset all transfer over proportionally.
  ctx.lineWidth = strokeW;
  ctx.strokeStyle = wheelBaseColor;
  ctx.lineJoin = 'round';
  // The wheel paints with rotation = -Math.PI/2 + rotation; for a static
  // thumbnail we just offset the first segment to start at the top.
  let startAngle = -Math.PI / 2;
  for (const item of items) {
    const sweep = (item.weight / totalWeight) * 2 * Math.PI;
    const path = buildSegmentPath(center, pieR, startAngle, startAngle + sweep,
                                   cornerR, wheelInnerStyle, innerInset);
    ctx.fillStyle = item.color;
    ctx.fill(path);
    if (strokeW > 0) ctx.stroke(path);
    startAngle += sweep;
  }
  // The centre marker is drawn as an HTML overlay (CustomMarker) by
  // WheelThumbnail, not on the canvas — so no center dot here.
}
