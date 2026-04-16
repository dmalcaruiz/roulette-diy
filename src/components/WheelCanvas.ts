import { WheelItem } from '../models/types';
import { hexToRgba, lerpColor, withAlpha } from '../utils/colorUtils';

export interface WheelPainterConfig {
  items: WheelItem[];
  rotation: number;
  fontSize: number;
  cornerRadius: number;
  strokeWidth: number;
  showBackgroundCircle: boolean;
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

  const center = { x: width / 2, y: height / 2 };
  const strokeInset = strokeWidth > 0 ? strokeWidth / 2 + 0.5 : 0;
  const radius = Math.min(width, height) / 2 - strokeInset;
  const scale = radius / 350;

  ctx.clearRect(0, 0, width, height);

  // Background circle (not rotated)
  if (showBackgroundCircle) {
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    if (strokeWidth > 0) {
      ctx.strokeStyle = '#FFFFFF';
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

    // Segment fill with optional transition color lerp
    const effectiveColor = (fromItems && i < fromItems.length && transition < 1)
      ? lerpColor(fromItems[i].color, item.color, transition)
      : item.color;

    ctx.fillStyle = effectiveColor;
    ctx.fill(path);

    // Stroke
    if (strokeWidth > 0) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = strokeWidth;
      ctx.stroke(path);
    }

    // Text — skip tiny segments
    if (layout.segmentSizes[i] > 0.15) {
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(layout.startAngles[i] + layout.segmentSizes[i] / 2);

      // Clip to segment area
      ctx.beginPath();
      ctx.rect(centerInset, -radius, radius - centerInset, radius * 2);
      ctx.clip();

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
    const overlayRadius = showBackgroundCircle ? radius + (strokeWidth / 2) + 0.5 : radius + 0.5;

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

    // Winning segment text
    if (layout.segmentSizes[winningIndex] > 0.15) {
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(layout.startAngles[winningIndex] + layout.segmentSizes[winningIndex] / 2);

      ctx.beginPath();
      ctx.rect(centerInset, -radius, radius - centerInset, radius * 2);
      ctx.clip();

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
    center.x + (radius - cornerRadius) * Math.cos(startAngle),
    center.y + (radius - cornerRadius) * Math.sin(startAngle),
  );

  // Rounded corner at start
  const outerStartX = center.x + radius * Math.cos(startAngle);
  const outerStartY = center.y + radius * Math.sin(startAngle);
  const arcStartX = center.x + radius * Math.cos(startAngle + cornerRadius / radius);
  const arcStartY = center.y + radius * Math.sin(startAngle + cornerRadius / radius);
  path.quadraticCurveTo(outerStartX, outerStartY, arcStartX, arcStartY);

  // Arc along the outer edge
  const arcStart = startAngle + cornerRadius / radius;
  const arcSweep = segmentSize - (2 * cornerRadius / radius);
  path.arc(center.x, center.y, radius, arcStart, arcStart + arcSweep);

  // Rounded corner at end
  const outerEndX = center.x + radius * Math.cos(endAngle);
  const outerEndY = center.y + radius * Math.sin(endAngle);
  path.quadraticCurveTo(
    outerEndX, outerEndY,
    center.x + (radius - cornerRadius) * Math.cos(endAngle),
    center.y + (radius - cornerRadius) * Math.sin(endAngle),
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

// ── Thumbnail painter (simple, no text/images) ──────────────────────────

export function paintWheelThumbnail(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  items: WheelItem[],
): void {
  const center = { x: width / 2, y: height / 2 };
  const radius = Math.min(width, height) / 2;
  const totalWeight = items.reduce((s, item) => s + item.weight, 0);

  ctx.clearRect(0, 0, width, height);

  // Gray background to fill anti-aliasing gaps
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#D4D4D8';
  ctx.fill();

  let startAngle = -Math.PI / 2;
  for (const item of items) {
    const sweep = (item.weight / totalWeight) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.arc(center.x, center.y, radius, startAngle, startAngle + sweep);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    startAngle += sweep;
  }

  // Inner stroke
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius - 0.75, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
