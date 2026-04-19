// Client-side image resize. Runs on the main thread via Canvas — fast enough for
// phone-camera photos. Produces a compressed JPEG (or WebP if supported) under
// the target size so uploads stay small regardless of source.

export interface ResizeOptions {
  maxDimension?: number;  // longest side in px
  quality?: number;       // 0..1, JPEG/WebP encoder quality
  mimeType?: 'image/jpeg' | 'image/webp';
}

export interface ResizedImage {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
}

export async function resizeImage(
  source: File | Blob,
  opts: ResizeOptions = {},
): Promise<ResizedImage> {
  const maxDimension = opts.maxDimension ?? 2000;
  const quality = opts.quality ?? 0.85;
  const mimeType = opts.mimeType ?? 'image/jpeg';

  const bitmap = await createImageBitmap(source);
  const { width: srcW, height: srcH } = bitmap;

  const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
  const dstW = Math.round(srcW * scale);
  const dstH = Math.round(srcH * scale);

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(dstW, dstH)
    : Object.assign(document.createElement('canvas'), { width: dstW, height: dstH });

  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D canvas context unavailable');

  ctx.drawImage(bitmap, 0, 0, dstW, dstH);
  bitmap.close();

  const blob: Blob = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type: mimeType, quality })
    : await new Promise<Blob>((resolve, reject) => {
        (canvas as HTMLCanvasElement).toBlob(
          b => b ? resolve(b) : reject(new Error('toBlob returned null')),
          mimeType,
          quality,
        );
      });

  return { blob, width: dstW, height: dstH, mimeType };
}

// Pre-tuned presets for each upload purpose.
export const RESIZE_PRESETS = {
  profile:      { maxDimension: 512,  quality: 0.85 },
  profileThumb: { maxDimension: 160,  quality: 0.75 },
  wheelCover:   { maxDimension: 1600, quality: 0.85 },
  segment:      { maxDimension: 800,  quality: 0.85 },
  response:     { maxDimension: 2000, quality: 0.85 },
  responseThumb:{ maxDimension: 400,  quality: 0.75 },
} as const satisfies Record<string, ResizeOptions>;
