import { useEffect, useRef } from 'react';
import { oklchShade, hexToRgba } from '../utils/colorUtils';
import { pixelateCanvas, PIXELATED, type Palette } from './WheelCanvas';

// Canvas twin of CustomMarker, drawn onto its own STATIC (non-rotating) canvas so
// it can be pixelated to match the wheel. The DOM/SVG marker can't take
// `image-rendering: pixelated`, and it must not ride the spinning art canvas, so
// pixelate mode uses this instead. It repaints only when its props change (the
// marker never animates), so the pixelation cost is one-off, not per-frame.
//
// The geometry mirrors CustomMarker exactly (same rough-circle harmonics, seeds,
// phases, radii and derived colours) — keep the two in sync if either changes.

// Rough circle as a Path2D (canvas port of CustomMarker.roughCirclePath).
function roughCirclePath(cx: number, cy: number, r: number, amp: number, seed: number, phase = 0): Path2D {
  const ph = (c: number) => {
    const x = Math.sin(seed * 127.1 + c * 311.7 + 0.5) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  };
  const p0 = ph(0) + phase, p1 = ph(1) + phase, p2 = ph(2) + phase;
  const steps = 72;
  const path = new Path2D();
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const n = Math.sin(a * 3 + p0) * 0.6 + Math.sin(a * 5 + p1) * 0.3 + Math.sin(a * 9 + p2) * 0.1;
    const rr = r + amp * n;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

// Rough variable-width ring ribbon as an evenodd Path2D (canvas port of
// CustomMarker.roughRingRibbon). Fill with 'evenodd' to leave the centre hollow.
function roughRingRibbon(cx: number, cy: number, r: number, halfW: number, amp: number, seed: number, widthVar: number): Path2D {
  const ph = (c: number) => {
    const x = Math.sin(seed * 127.1 + c * 311.7 + 0.5) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  };
  const p0 = ph(0), p1 = ph(1), p2 = ph(2), w0 = ph(3), w1 = ph(4);
  const steps = 72;
  const path = new Path2D();
  const ring = (radial: (rr: number, hw: number) => number) => {
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const n = Math.sin(a * 3 + p0) * 0.6 + Math.sin(a * 5 + p1) * 0.3 + Math.sin(a * 9 + p2) * 0.1;
      const rr = r + amp * n;
      const wmul = Math.max(0.35, 1 + widthVar * (Math.sin(a * 4 + w0) * 0.6 + Math.sin(a * 7 + w1) * 0.4));
      const hw = halfW * wmul;
      const edge = radial(rr, hw);
      const x = cx + Math.cos(a) * edge, y = cy + Math.sin(a) * edge;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
  };
  ring((rr, hw) => rr + hw); // outer loop
  ring((rr, hw) => rr - hw); // inner loop → evenodd hole
  return path;
}

interface PixelatedMarkerProps {
  size: number;              // marker box diameter, same as CustomMarker `size`
  markerDiameter?: number;
  markerPeek?: number;
  markerBaseColor?: string;
  roughSeed?: number;
  // CSS px per pixel-block. Pass the wheel's block size (wheelWidth /
  // PIXEL_BLOCKS) so the marker shares the wheel's exact grid density.
  pixelScale?: number;
}

// Padding around the marker box so the +28px halo (and any peek lift) never clip
// the canvas edge.
const PAD = 24;

export default function PixelatedMarker({
  size,
  markerDiameter = 60,
  markerPeek = 0,
  markerBaseColor = '#FFFFFF',
  roughSeed = 0,
  pixelScale = 2,
}: PixelatedMarkerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cssSize = size + PAD * 2;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cssSize * dpr || canvas.height !== cssSize * dpr) {
      canvas.width = cssSize * dpr;
      canvas.height = cssSize * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);

    const cx = cssSize / 2, cy = cssSize / 2;
    const baseD = size * (markerDiameter / 100);
    const peekPx = baseD * (markerPeek / 100);
    const roughAmp = baseD * 0.0045;
    const innerAmp = roughAmp * 0.5;
    const roughR = baseD / 2 - 1.5;
    const topFill = markerBaseColor;
    const topStroke = oklchShade(topFill, 0.012);
    const bottomFill = oklchShade(topFill, 0.07);
    const bottomStroke = oklchShade(bottomFill, 0.03);
    const ringStroke = oklchShade(topFill, 0.05, -0.5, 0.9);
    const accentFill = oklchShade(topFill, 0.04);
    const coreFill = oklchShade(topFill, 0.008);
    const coreStroke = oklchShade(topFill, 0.06);
    const halo1D = baseD + 28;
    const halo2D = baseD + 12;
    const roughPath = roughCirclePath(cx, cy, roughR, roughAmp, roughSeed);

    ctx.lineJoin = 'round';

    // Shadow halos.
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fill(roughCirclePath(cx, cy, halo1D / 2, roughAmp, roughSeed, 0.35));
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fill(roughCirclePath(cx, cy, halo2D / 2, roughAmp, roughSeed, 0.7));

    // Bottom layer (derived, darker).
    ctx.fillStyle = bottomFill;
    ctx.fill(roughPath);
    ctx.strokeStyle = bottomStroke;
    ctx.lineWidth = 3;
    ctx.stroke(roughPath);

    // Top layer as a whole, lifted by peek.
    ctx.save();
    ctx.translate(0, -peekPx);
    ctx.fillStyle = topFill;
    ctx.fill(roughPath);
    ctx.fillStyle = topStroke;
    ctx.fill(roughRingRibbon(cx, cy, roughR, 1.5, roughAmp, roughSeed, 0.3), 'evenodd');
    ctx.fillStyle = ringStroke;
    ctx.fill(roughRingRibbon(cx, cy, baseD * 0.39 - 1.5, 1.5, innerAmp * 1.25, roughSeed + 7.1, 0.25), 'evenodd');
    ctx.fillStyle = accentFill;
    ctx.fill(roughCirclePath(cx, cy, baseD * 0.25, innerAmp, roughSeed + 13.7));
    const core = roughCirclePath(cx, cy, baseD * 0.205 - 1.5, innerAmp, roughSeed + 13.7);
    ctx.fillStyle = coreFill;
    ctx.fill(core);
    ctx.strokeStyle = coreStroke;
    ctx.lineWidth = 3;
    ctx.stroke(core);
    ctx.restore();

    // Fixed palette of the marker's OPAQUE colours → the palette-vote quantize
    // snaps opaque blocks to a real colour (fully aliased, no AA). keepTranslucent
    // preserves the faint shadow halos as blocky translucent blocks instead of
    // thresholding them away.
    const palette: Palette = [bottomFill, bottomStroke, topFill, topStroke, ringStroke, accentFill, coreFill, coreStroke].map(h => {
      const { r, g, b } = hexToRgba(h);
      return [r, g, b] as [number, number, number];
    });
    if (PIXELATED) pixelateCanvas(ctx, cssSize, cssSize, pixelScale, palette, true);
  }, [cssSize, size, markerDiameter, markerPeek, markerBaseColor, roughSeed, pixelScale]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: cssSize, height: cssSize, display: 'block', pointerEvents: 'none',
        imageRendering: PIXELATED ? 'pixelated' : undefined,
      }}
    />
  );
}
