import { useRef, useEffect } from 'react';
import { WheelItem } from '../models/types';
import { paintWheelThumbnail } from './WheelCanvas';

interface WheelThumbnailProps {
  items: WheelItem[];
  size?: number;
}

export default function WheelThumbnail({ items, size = 40 }: WheelThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    paintWheelThumbnail(ctx, size, size, items);
  }, [items, size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
