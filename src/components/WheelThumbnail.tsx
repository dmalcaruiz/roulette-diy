import { useRef, useEffect } from 'react';
import { WheelItem } from '../models/types';
import { paintWheelThumbnail, type WheelThumbnailStyle } from './WheelCanvas';

interface WheelThumbnailProps {
  items: WheelItem[];
  size?: number;
  // Optional style from the source wheel's config — strokeWidth,
  // centerMarkerSize, showBackgroundCircle — scaled proportionally so the
  // thumbnail reads as a true miniature. Omitted = defaultWheelConfig
  // values used.
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

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
