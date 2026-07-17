import { useState, useRef, useLayoutEffect, type CSSProperties, type ReactNode } from 'react';
import { deriveCardSurfaces, hexToRgba, lerpColor } from '../utils/colorUtils';
import { pixelateCanvas, PIXELATED, type Palette } from './WheelCanvas';

// Pixel-art 3D card chrome — the canvas twin of the PreviewTile /
// PushDownButton card recipe (top face + bottom peek + halo ring + inner
// stroke), quantized to the wheel's block grid exactly like PixelButton.
// ONLY the chrome pixelates: children (e.g. a mini wheel thumbnail) render
// as crisp DOM on top of the canvas.
//
// Press feel matches PixelButton, not PushDownButton: the face JUMPS onto
// the peek on the next paint (no eased transition) — canvas redraws are
// discrete, and the instant dip is part of the 8-bit character.

interface PixelCardProps {
  width: number;
  height: number;        // total box (face + bottom peek)
  faceHeight: number;    // top-face height; peek = height - faceHeight
  radius: number;
  color: string;         // base colour — surfaces derived via deriveCardSurfaces
  backdrop: string;      // colour behind the card; solidifies the halo's 25% alpha
  // CSS px per pixel-block. Pass the wheel's snapped block size
  // (spriteScaleFor(wheelWidth)) so the card shares the wheel's grid.
  pixelScale: number;
  // Controlled press (parent-managed gesture, e.g. PreviewTile's tap dip).
  pressed?: boolean;
  pressDepth?: number;
  // Uncontrolled button mode — the card handles its own press state + tap.
  onTap?: () => void;
  style?: CSSProperties;
  children?: ReactNode;
}

// Rounded-rect Path2D (arcTo — no ctx.roundRect dependency). Shared with
// SnappingSheet's pixel chrome strip.
export function rrPath(x0: number, y0: number, x1: number, y1: number, r: number): Path2D {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const p = new Path2D();
  p.moveTo(x0 + r, y0);
  p.arcTo(x1, y0, x1, y1, r);
  p.arcTo(x1, y1, x0, y1, r);
  p.arcTo(x0, y1, x0, y0, r);
  p.arcTo(x0, y0, x1, y0, r);
  p.closePath();
  return p;
}

const HALO_W = 3.5; // matches the DOM tiles' 3.5px halo box-shadow

export function PixelCard({
  width,
  height,
  faceHeight,
  radius,
  color,
  backdrop,
  pixelScale,
  pressed,
  pressDepth = 2,
  onTap,
  style,
  children,
}: PixelCardProps) {
  const [pressedLocal, setPressedLocal] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isPressed = pressed ?? pressedLocal;
  // Canvas bleeds past the box so the halo ring isn't clipped. A whole
  // multiple of the block size so the card's box edges land exactly on
  // block boundaries (otherwise every edge straddles two blocks and the
  // silhouette wobbles asymmetrically).
  const PAD = Math.ceil((HALO_W + 2) / pixelScale) * pixelScale;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cw = width + PAD * 2;
    const ch = height + PAD * 2;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.translate(PAD, PAD);

    const surfaces = deriveCardSurfaces(color);
    // Solid stand-in for the DOM halo (bottom colour at 25% alpha over the
    // panel behind) — the palette snap needs opaque colours.
    const halo = lerpColor(backdrop, surfaces.bottom, 0.25);
    // Inner stroke width quantized to whole blocks so it survives the
    // pixelate pass at a uniform thickness.
    const stroke = Math.max(1, Math.round(3 / pixelScale)) * pixelScale;
    const peekTop = height - faceHeight;
    const off = isPressed ? pressDepth : 0;

    ctx.fillStyle = halo;
    ctx.fill(rrPath(-HALO_W, peekTop - HALO_W, width + HALO_W, height + HALO_W, radius + HALO_W));
    ctx.fillStyle = surfaces.bottom;
    ctx.fill(rrPath(0, peekTop, width, height, radius));
    ctx.fillStyle = surfaces.innerStroke;
    ctx.fill(rrPath(0, off, width, off + faceHeight, radius));
    ctx.fillStyle = surfaces.top;
    ctx.fill(rrPath(stroke, off + stroke, width - stroke, off + faceHeight - stroke, Math.max(0, radius - stroke)));

    const palette: Palette = [halo, surfaces.bottom, surfaces.innerStroke, surfaces.top].map(h => {
      const { r, g, b } = hexToRgba(h);
      return [r, g, b] as [number, number, number];
    });
    // Drop the PAD translate before pixelating — pixelateCanvas clears and
    // redraws the whole bitmap under the CURRENT transform, so a leftover
    // offset shifts the blocky image and leaves a smooth-ghost strip behind.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (PIXELATED) pixelateCanvas(ctx, cw, ch, pixelScale, palette);
  }, [width, height, faceHeight, radius, color, backdrop, pixelScale, isPressed, pressDepth, PAD]);

  const release = () => setPressedLocal(false);

  return (
    <div
      onPointerDown={onTap ? () => setPressedLocal(true) : undefined}
      onPointerUp={onTap ? release : undefined}
      onPointerLeave={onTap ? release : undefined}
      onPointerCancel={onTap ? release : undefined}
      onClick={onTap ? () => onTap() : undefined}
      style={{
        width,
        height,
        position: 'relative',
        cursor: onTap ? 'pointer' : undefined,
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        // The tap light-up the DOM cards had — applied to the whole unit
        // (chrome + content) since the face is baked into the canvas.
        filter: isPressed ? 'brightness(1.12)' : undefined,
        ...style,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          left: -PAD,
          top: -PAD,
          width: width + PAD * 2,
          height: height + PAD * 2,
          imageRendering: PIXELATED ? 'pixelated' : undefined,
          pointerEvents: 'none',
        }}
      />
      {/* Content — crisp DOM, centred on the face, rides the press dip. */}
      <div style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width,
        height: faceHeight,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: isPressed ? `translateY(${pressDepth}px)` : undefined,
        pointerEvents: 'none',
      }}>
        {children}
      </div>
    </div>
  );
}
