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

// ── Rough variant — hand-drawn wobble on the block grid ────────────────────
// Same seeded-hash recipe as RoughPanel/PixelButton, but emitted as a
// size-agnostic polygon() so it works on dynamic-height DOM (segment cards):
// corner stair rows jitter ±1 block, and the long horizontal edges get a
// couple of 1-block-deep nicks at seeded fractional positions. Everything
// carves INWARD (a clip-path can't paint outside its box), so layered chrome
// stays safe: a nick just lets the layer behind show through — irregular
// "ink" like a hand-drawn stroke.

const rand01 = (seed: number, i: number) => {
  const x = Math.sin(seed * 127.1 + i * 311.7 + 0.5) * 43758.5453;
  return x - Math.floor(x);
};

export function pixelRoughClip(radiusPx: number, block: number, seed: number): string {
  const key = `rough|${radiusPx}|${block}|${seed}`;
  let v = clipCache.get(key);
  if (v) return v;

  const n = Math.max(1, Math.round(radiusPx / block));
  const base = cornerInsets(n);
  // Per-corner jittered stair rows — sparse, so most rows stay clean and the
  // wobble reads as a few deliberate hand-drawn irregularities, not noise.
  // Only carve deeper or restore toward square (clamped ≥ 0) — never bulge
  // past the straight edges.
  const jitter = (c: number) => base.map((ins, i) => {
    const r = rand01(seed, c * 97 + i);
    if (r < 0.16) return ins + 1;
    if (r > 0.93) return Math.max(0, ins - 1);
    return ins;
  });
  // ONE wide nick per horizontal edge: [start, end, depthBlocks], kept clear
  // of the corner zones. A single long dip (1–2 blocks deep) reads as a
  // hand-drawn edge; several short shallow ones read as pixel noise.
  // Vertical edges are short and corner-dominated on these cards, so they
  // stay straight.
  const nicks = (o: number): Array<[number, number, number]> => {
    const a0 = 0.18 + rand01(seed, o) * 0.40;
    const depth = rand01(seed, o + 4) < 0.5 ? 1 : 2;
    return [[a0, a0 + 0.10 + rand01(seed, o + 1) * 0.14, depth]];
  };

  const px = (u: number) => `${round2(u)}px`;
  const far = (u: number) => `calc(100% - ${round2(u)}px)`;
  const pct = (f: number) => `${round2(f * 100)}%`;
  const tl = jitter(0), tr = jitter(1), br = jitter(2), bl = jitter(3);
  const pts: string[] = [];
  // Top-left corner: up the left edge, stepping right toward the top edge.
  for (let i = n - 1; i >= 0; i--) pts.push(`${px(tl[i] * block)} ${px((i + 1) * block)}`, `${px(tl[i] * block)} ${px(i * block)}`);
  // Top edge nick (left → right).
  for (const [f0, f1, d] of nicks(11)) pts.push(`${pct(f0)} 0px`, `${pct(f0)} ${px(d * block)}`, `${pct(f1)} ${px(d * block)}`, `${pct(f1)} 0px`);
  // Top-right corner.
  for (let i = 0; i < n; i++) pts.push(`${far(tr[i] * block)} ${px(i * block)}`, `${far(tr[i] * block)} ${px((i + 1) * block)}`);
  // Bottom-right corner.
  for (let i = n - 1; i >= 0; i--) pts.push(`${far(br[i] * block)} ${far((i + 1) * block)}`, `${far(br[i] * block)} ${far(i * block)}`);
  // Bottom edge nick (right → left).
  for (const [f0, f1, d] of nicks(29)) pts.push(`${pct(1 - f0)} 100%`, `${pct(1 - f0)} ${far(d * block)}`, `${pct(1 - f1)} ${far(d * block)}`, `${pct(1 - f1)} 100%`);
  // Bottom-left corner.
  for (let i = 0; i < n; i++) pts.push(`${px(bl[i] * block)} ${far(i * block)}`, `${px(bl[i] * block)} ${far((i + 1) * block)}`);

  v = `polygon(${pts.join(', ')})`;
  clipCache.set(key, v);
  return v;
}

/** Small stable hash for per-card seeds (e.g. from a segment id). */
export function roughSeedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h >>> 0) % 9973;
}
