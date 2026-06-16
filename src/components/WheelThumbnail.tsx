import { useRef, useEffect } from 'react';
import { WheelItem } from '../models/types';
import { paintWheelThumbnail, roughSeedFromId, type WheelThumbnailStyle } from './WheelCanvas';
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

// Shadow built from crisp silhouette copies painted BEHIND the wheel (no blur).
// Each is a faithful copy of the wheel's outline (paintWheelThumbnail's
// monochrome mode) painted a touch LARGER than the wheel — so its FILL shows as
// a halo around the wheel instead of hiding directly behind it. Concentric with
// the wheel. Ordered back-to-front: a wide light halo, then a tighter darker one.
//
// Painted in OPAQUE black, then faded uniformly via the canvas element's CSS
// `opacity`. Painting in a translucent colour would let the per-segment fills,
// dividers, and overlapping edges stack alpha — the strokes would show through.
// Opaque fill + layer opacity keeps each silhouette dead flat.
//   spreadFrac = how far it extends past the wheel, per side (frac of size)
//   offsetFrac = downward bias (frac of size); 0 = centred on the wheel
//   opacity    = the whole flat silhouette's strength
const SHADOW_FILL = '#000';
const SHADOW_LAYERS = [
  { opacity: 0.10, spreadFrac: 0.05, offsetFrac: 0 },
  { opacity: 0.20, spreadFrac: 0.012, offsetFrac: 0 },
];

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
  const shadowRefs = useRef<(HTMLCanvasElement | null)[]>([]);

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
    // Per-wheel wobble: default the seed from the items' text so each wheel's
    // thumbnail differs. Callers holding the wheel id can override via
    // style.roughSeed to match the live wheel exactly.
    const seededStyle: WheelThumbnailStyle = {
      ...style,
      roughSeed: style?.roughSeed ?? roughSeedFromId(items.map(it => it.text).join('')),
    };
    paintWheelThumbnail(ctx, size, size, items, seededStyle);

    // Shadow silhouettes — each a faithful copy of the wheel's outline painted
    // a bit LARGER (in its own bigger canvas) in one flat tone, so its fill
    // shows as a halo around the wheel. Reusing paintWheelThumbnail means they
    // follow the true outline (flower shapes, rounded corners, outer stroke).
    SHADOW_LAYERS.forEach((layer, i) => {
      const c = shadowRefs.current[i];
      if (!c) return;
      const cctx = c.getContext('2d');
      if (!cctx) return;
      const big = size + size * layer.spreadFrac * 2;
      c.width = big * dpr;
      c.height = big * dpr;
      cctx.scale(dpr, dpr);
      paintWheelThumbnail(cctx, big, big, items, seededStyle, SHADOW_FILL);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, size, styleKey]);

  // Thumbnail's proportional marker box (a fixed fraction of the wheel — the
  // marker no longer depends on a per-wheel size), then the scale from the
  // design reference.
  const markerBox = size * (250 / WHEEL_REF) * THUMB_MARKER_BOOST;
  const markerScale = markerBox / MARKER_DESIGN;

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      {/* Shadow silhouettes behind the wheel — painted larger (see SHADOW_LAYERS)
          so their fill reads as a halo following the wheel's TRUE outline. Each
          is offset -spread to stay centred (+ optional downward offsetFrac). */}
      {SHADOW_LAYERS.map((layer, i) => {
        const spread = size * layer.spreadFrac;
        const big = size + spread * 2;
        return (
          <canvas
            key={i}
            ref={el => { shadowRefs.current[i] = el; }}
            aria-hidden
            style={{
              position: 'absolute',
              left: -spread,
              top: -spread + size * layer.offsetFrac,
              zIndex: i,
              width: big,
              height: big,
              opacity: layer.opacity,
              display: 'block',
              pointerEvents: 'none',
            }}
          />
        );
      })}
      <canvas
        ref={canvasRef}
        style={{ position: 'relative', zIndex: SHADOW_LAYERS.length, width: size, height: size, display: 'block' }}
      />
      {/* Center marker overlay — rendered at MARKER_DESIGN then scaled down. */}
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: `translate(-50%, -50%) scale(${markerScale})`,
        width: MARKER_DESIGN,
        height: MARKER_DESIGN,
        zIndex: SHADOW_LAYERS.length + 1,
        pointerEvents: 'none',
      }}>
        <CustomMarker
          size={MARKER_DESIGN}
          markerDiameter={style?.markerDiameter}
          markerPeek={style?.markerPeek}
          markerBaseColor={style?.markerBaseColor}
          roughSeed={style?.roughSeed ?? roughSeedFromId(items.map(it => it.text).join(''))}
          showPin={style?.showPin}
        />
      </div>
    </div>
  );
}
