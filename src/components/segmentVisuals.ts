// Per-segment visuals shared by the wheel painters: lucide icons (drawn from
// extracted 24×24 node data, synchronously) and custom images (async-loaded and
// cached). Painters are synchronous and simply skip a not-yet-loaded image;
// anything that paints the wheel subscribes via onVisualLoaded() to repaint once
// an image finishes decoding.
import { ICON_NODES } from '../utils/iconNodes';

// ── Async repaint notifier ──
type Listener = () => void;
const listeners = new Set<Listener>();
export function onVisualLoaded(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function notify(): void { for (const fn of [...listeners]) fn(); }

// ── Custom-image cache (url → HTMLImageElement) ──
const imgCache = new Map<string, HTMLImageElement>();

// A decoded image for `url`, or null if it isn't ready yet (kicking off the load
// on first request). Subscribers are notified on load so the wheel repaints.
export function getSegmentImage(url: string | null | undefined): HTMLImageElement | null {
  if (!url) return null;
  let img = imgCache.get(url);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = notify;
    img.onerror = () => { /* leave unloaded; the painter skips it */ };
    img.src = url;
    imgCache.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

// Draw `img` cover-fit (center-crop) into the rounded rect (x, y, w, h, r).
export function drawSegmentImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.save();
  ctx.beginPath();
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, rr);
  else ctx.rect(x, y, w, h);
  ctx.clip();
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

// Draw a lucide icon (by kebab-case name) centred at (cx, cy), `size` px tall,
// stroked in `color`. Uses the extracted node data — synchronous and crisp at
// any size. Mirrors lucide's render: fill none, 2-unit stroke, round caps/joins.
export function drawIconNode(
  ctx: CanvasRenderingContext2D,
  name: string,
  cx: number, cy: number, size: number, color: string,
): void {
  const node = ICON_NODES[name];
  if (!node) return;
  const s = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.25;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [tag, a] of node) {
    if (tag === 'path') {
      ctx.stroke(new Path2D(String(a.d)));
      continue;
    }
    ctx.beginPath();
    if (tag === 'circle') {
      ctx.arc(+a.cx, +a.cy, +a.r, 0, Math.PI * 2);
    } else if (tag === 'line') {
      ctx.moveTo(+a.x1, +a.y1); ctx.lineTo(+a.x2, +a.y2);
    } else if (tag === 'rect') {
      const rx = a.rx != null ? +a.rx : 0;
      if (rx && typeof ctx.roundRect === 'function') ctx.roundRect(+a.x, +a.y, +a.width, +a.height, rx);
      else ctx.rect(+a.x, +a.y, +a.width, +a.height);
    } else if (tag === 'polyline' || tag === 'polygon') {
      const pts = String(a.points).trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i < pts.length; i += 2) {
        if (i === 0) ctx.moveTo(pts[i], pts[i + 1]);
        else ctx.lineTo(pts[i], pts[i + 1]);
      }
      if (tag === 'polygon') ctx.closePath();
    } else if (tag === 'ellipse') {
      ctx.ellipse(+a.cx, +a.cy, +a.rx, +a.ry, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
  ctx.restore();
}
