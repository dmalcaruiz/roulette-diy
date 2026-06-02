import { useRef, useEffect } from 'react';
import { WheelItem } from '../models/types';
import { paintWheelThumbnail, type WheelThumbnailStyle } from './WheelCanvas';
import CustomMarker from './CustomMarker';

// Box size the marker's absolute-px details are tuned for (≈ the live wheel's
// marker box). The overlay renders CustomMarker at this size, then scales it
// to the thumbnail's proportional marker box — so the preview marker matches
// the live one shrunk, rather than over-sized px on a tiny canvas.
const MARKER_DESIGN = 128;
const WHEEL_REF = 700; // matches WheelCanvas WHEEL_REFERENCE_SIZE
// Boost over the strict live-wheel proportion — at tiny thumbnail scale the
// marker reads too small otherwise (same idea as the stroke/corner boosts).
const THUMB_MARKER_BOOST = 1.18;

interface WheelThumbnailProps {
  items: WheelItem[];
  size?: number;
  // Optional style from the source wheel's config — strokeWidth, corner /
  // marker settings, etc. — scaled proportionally so the thumbnail reads as a
  // true miniature. Omitted = defaultWheelConfig values used.
  style?: WheelThumbnailStyle;
  // [THUMB-DBG] Optional label so the diagnostic log can identify which
  // tile/wheel this thumbnail represents.
  debugLabel?: string;
}

export default function WheelThumbnail({ items, size = 40, style, debugLabel }: WheelThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Stable JSON of style so the effect doesn't re-run when an inline
  // object identity changes but the values didn't.
  const styleKey = JSON.stringify(style ?? {});

  // [THUMB-DBG] Log every time items prop changes (which causes a repaint).
  // The signature includes count + first segment text + first color so two
  // wheels with different content show clearly different sigs.
  const itemsSig = `n=${items.length} first=${items[0]?.text ?? ''}|${items[0]?.color ?? ''}`;
  const lastSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastSigRef.current !== null && lastSigRef.current !== itemsSig) {
      // eslint-disable-next-line no-console
      console.log(`[THUMB-DBG ${debugLabel ?? '?'}] items changed: ${lastSigRef.current} -> ${itemsSig}`);
    }
    lastSigRef.current = itemsSig;
  }, [itemsSig, debugLabel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    paintWheelThumbnail(ctx, size, size, items, style);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, size, styleKey]);

  // Thumbnail's proportional marker box (a fixed fraction of the wheel — the
  // marker no longer depends on a per-wheel size), then the scale from the
  // design reference.
  const markerBox = size * (250 / WHEEL_REF) * THUMB_MARKER_BOOST;
  const markerScale = markerBox / MARKER_DESIGN;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, display: 'block' }}
      />
      {/* Center marker overlay — rendered at MARKER_DESIGN then scaled down. */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: `translate(-50%, -50%) scale(${markerScale})`,
        width: MARKER_DESIGN,
        height: MARKER_DESIGN,
        pointerEvents: 'none',
      }}>
        <CustomMarker
          size={MARKER_DESIGN}
          markerDiameter={style?.markerDiameter}
          markerPeek={style?.markerPeek}
          markerBaseColor={style?.markerBaseColor}
        />
      </div>
    </div>
  );
}
