// Staircase ("pixel-art") rounded-rect CLIP-PATHS — the CSS twin of the
// canvas pixelate pass, for chrome that can't be a canvas (dynamic-height
// DOM like the segment cards). Corners are quantized to the wheel's block
// grid as stair steps; edges stay straight (a straight line pixelates to
// itself). Coordinates mix px (corners) with calc(100% − px) (far edges),
// so one string works at ANY element size — no per-frame work when a card
// expands/collapses.

// Per-block-row corner insets for a quarter circle of radius n blocks.
// ins[0] = the row touching the flat edge where the arc STARTS (deepest
// inset); ins[n-1] ≈ 0 (arc meets the perpendicular edge).
function cornerInsets(n: number): number[] {
  const ins: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = n - i - 0.5; // block-row centre distance from the arc centre
    ins.push(Math.round(n - Math.sqrt(Math.max(0, n * n - d * d))));
  }
  return ins;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// Clockwise staircase outline of a rounded rect, as polygon() point strings.
// `inset` shifts the whole outline inward (used for ring holes).
function outlinePoints(radiusPx: number, block: number, inset: number): string[] {
  const n = Math.max(1, Math.round(radiusPx / block));
  const ins = cornerInsets(n);
  const px = (v: number) => `${round2(inset + v)}px`;
  const far = (v: number) => `calc(100% - ${round2(inset + v)}px)`;
  const pts: string[] = [];
  // Top-left: up the left edge, stepping right toward the top edge.
  for (let i = n - 1; i >= 0; i--) pts.push(`${px(ins[i] * block)} ${px((i + 1) * block)}`, `${px(ins[i] * block)} ${px(i * block)}`);
  // Top-right: along the top edge, stepping down the right edge.
  for (let i = 0; i < n; i++) pts.push(`${far(ins[i] * block)} ${px(i * block)}`, `${far(ins[i] * block)} ${px((i + 1) * block)}`);
  // Bottom-right: down the right edge, stepping left toward the bottom edge.
  for (let i = n - 1; i >= 0; i--) pts.push(`${far(ins[i] * block)} ${far((i + 1) * block)}`, `${far(ins[i] * block)} ${far(i * block)}`);
  // Bottom-left: along the bottom edge, stepping up the left edge.
  for (let i = 0; i < n; i++) pts.push(`${px(ins[i] * block)} ${far(i * block)}`, `${px(ins[i] * block)} ${far((i + 1) * block)}`);
  return pts;
}

const clipCache = new Map<string, string>();

/** Staircase rounded-rect clip: `clipPath: pixelRoundedClip(16, block)`. */
export function pixelRoundedClip(radiusPx: number, block: number): string {
  const key = `r|${radiusPx}|${block}`;
  let v = clipCache.get(key);
  if (!v) {
    v = `polygon(${outlinePoints(radiusPx, block, 0).join(', ')})`;
    clipCache.set(key, v);
  }
  return v;
}

/** Staircase RING clip (e.g. the card halo): apply to an element that is the
 *  ringed box EXPANDED by `ringPx` on all sides (position absolute,
 *  inset: -ringPx) with a solid/alpha background. Outer silhouette radius =
 *  radiusPx + ringPx; the hole (the box itself) sits ringPx in at radiusPx.
 *  One polygon with a zero-width bridge between the two loops (the classic
 *  hole trick — opposite winding + coincident entry/exit segments). */
export function pixelRingClip(radiusPx: number, ringPx: number, block: number): string {
  const key = `ring|${radiusPx}|${ringPx}|${block}`;
  let v = clipCache.get(key);
  if (!v) {
    const outer = outlinePoints(radiusPx + ringPx, block, 0);
    const inner = outlinePoints(radiusPx, block, ringPx).reverse(); // opposite winding → hole
    v = `polygon(${[...outer, outer[0], ...inner, inner[0]].join(', ')})`;
    clipCache.set(key, v);
  }
  return v;
}

/** Quantize a width (border/ring) to whole blocks so it renders uniformly
 *  on the pixel grid. */
export function pixelSnap(widthPx: number, block: number): number {
  return Math.max(1, Math.round(widthPx / block)) * block;
}
