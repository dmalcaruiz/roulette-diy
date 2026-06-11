// OKLCH shadow color derivation — ported from Dart color_utils.dart

function gammaExpansion(channel: number): number {
  const abs = Math.abs(channel);
  if (abs <= 0.04045) return channel / 12.92;
  const sign = channel >= 0 ? 1 : -1;
  return sign * Math.pow((abs + 0.055) / 1.055, 2.4);
}

function gammaCorrection(channel: number): number {
  const abs = Math.abs(channel);
  if (abs > 0.0031308) {
    const sign = channel >= 0 ? 1 : -1;
    return sign * (1.055 * Math.pow(abs, 1.0 / 2.4) - 0.055);
  }
  return channel * 12.92;
}

function cubeRoot(x: number): number {
  return x >= 0 ? Math.pow(x, 1 / 3) : -Math.pow(-x, 1 / 3);
}

// Additive drop in OKLCh L with a piecewise weight by base lightness:
//   `newL = okL − delta · (1 + lightBoost · okL + topBoost · okL²)`
// C + h preserved. The eye reads *relative* lightness change (Weber-style),
// so a constant absolute drop reads as a heavy shadow on dark bases and a
// near-invisible step on light ones. The two boost terms compensate:
//   - `lightBoost` adds drop linearly with okL (boost across the whole upper
//     half).
//   - `topBoost` adds drop quadratically (extra emphasis on the brightest
//     end — saturated yellows / lights — where the linear term alone can't
//     produce visible contrast without re-darkening dark greys).
// Pure black stays at 0; pure white drops by `delta · (1 + lightBoost + topBoost)`.
export function oklchShadow(hexColor: string, delta = 0.05, lightBoost = 2, topBoost = 0): string {
  const { r, g, b, a } = hexToRgba(hexColor);

  const lr = gammaExpansion(r / 255);
  const lg = gammaExpansion(g / 255);
  const lb = gammaExpansion(b / 255);

  const lCone = cubeRoot(0.412221469470763 * lr + 0.5363325372617348 * lg + 0.0514459932675022 * lb);
  const mCone = cubeRoot(0.2119034958178252 * lr + 0.6806995506452344 * lg + 0.1073969535369406 * lb);
  const sCone = cubeRoot(0.0883024591900564 * lr + 0.2817188391361215 * lg + 0.6299787016738222 * lb);

  const okL = 0.210454268309314 * lCone + 0.7936177747023054 * mCone - 0.0040720430116193 * sCone;
  const okA = 1.9779985324311684 * lCone - 2.4285922420485799 * mCone + 0.450593709617411 * sCone;
  const okB = 0.0259040424655478 * lCone + 0.7827717124575296 * mCone - 0.8086757549230774 * sCone;

  const c = Math.sqrt(okA * okA + okB * okB);
  const h = Math.atan2(okB, okA);

  const drop = delta * (1 + lightBoost * okL + topBoost * okL * okL);
  const newL = Math.max(0, Math.min(1, okL - drop));
  const newA = c * Math.cos(h);
  const newB = c * Math.sin(h);

  const l2 = newL + 0.3963377773761749 * newA + 0.2158037573099136 * newB;
  const m2 = newL - 0.1055613458156586 * newA - 0.0638541728258133 * newB;
  const s2 = newL - 0.0894841775298119 * newA - 1.2914855480194092 * newB;

  const l3 = l2 * l2 * l2;
  const m3 = m2 * m2 * m2;
  const s3 = s2 * s2 * s2;

  const rOut = 4.0767416360759574 * l3 - 3.3077115392580616 * m3 + 0.2309699031821044 * s3;
  const gOut = -1.2684379732850317 * l3 + 2.6097573492876887 * m3 - 0.3413193760026573 * s3;
  const bOut = -0.0041960761386756 * l3 - 0.7034186179359362 * m3 + 1.7076146940746117 * s3;

  const rFinal = Math.round(Math.max(0, Math.min(1, gammaCorrection(rOut))) * 255);
  const gFinal = Math.round(Math.max(0, Math.min(1, gammaCorrection(gOut))) * 255);
  const bFinal = Math.round(Math.max(0, Math.min(1, gammaCorrection(bOut))) * 255);

  return rgbaToHex(rFinal, gFinal, bFinal, a);
}

// Like oklchShadow (darken via OKLCh lightness), but ALSO eases chroma down a
// little so derived shades stay distinct on saturated bases. The reduction is
// PROPORTIONAL — a small fraction (≈ `delta · SHADE_CHROMA_RATIO`) of the
// colour's OWN chroma — not a flat subtraction. A flat amount washed out
// medium-saturation colours and stacked up across the darker (bigger-delta)
// layers; proportional keeps the darkening while preserving most of the
// saturation. White/greys (chroma ~0) are unaffected. Chroma clamps at 0.
const SHADE_CHROMA_RATIO = 1.5;
// Extra lightness darkening scaled by chroma. oklchShadow's lightBoost only
// boosts *light* colours, so a mid-lightness saturated base darkens too little
// (its vivid hue also hides small lightness steps). This adds darkening
// proportional to chroma, so saturated bases get a stronger drop. White/greys
// (chroma ~0) are unaffected.
const SHADE_CHROMA_BOOST = 4;
// `topBoost` adds drop quadratically in lightness (okL²) — like oklchShadow's,
// it lifts only the brightest end, so near-white bases can darken more without
// touching mid/dark ones (which a linear lightBoost can't do).
export function oklchShade(hexColor: string, delta = 0.05, lightBoost = 2, topBoost = 0): string {
  const { r, g, b, a } = hexToRgba(hexColor);

  const lr = gammaExpansion(r / 255);
  const lg = gammaExpansion(g / 255);
  const lb = gammaExpansion(b / 255);

  const lCone = cubeRoot(0.412221469470763 * lr + 0.5363325372617348 * lg + 0.0514459932675022 * lb);
  const mCone = cubeRoot(0.2119034958178252 * lr + 0.6806995506452344 * lg + 0.1073969535369406 * lb);
  const sCone = cubeRoot(0.0883024591900564 * lr + 0.2817188391361215 * lg + 0.6299787016738222 * lb);

  const okL = 0.210454268309314 * lCone + 0.7936177747023054 * mCone - 0.0040720430116193 * sCone;
  const okA = 1.9779985324311684 * lCone - 2.4285922420485799 * mCone + 0.450593709617411 * sCone;
  const okB = 0.0259040424655478 * lCone + 0.7827717124575296 * mCone - 0.8086757549230774 * sCone;

  const c = Math.sqrt(okA * okA + okB * okB);
  const h = Math.atan2(okB, okA);

  const drop = delta * (1 + lightBoost * okL + topBoost * okL * okL + SHADE_CHROMA_BOOST * c);
  const newL = Math.max(0, Math.min(1, okL - drop));
  const newC = Math.max(0, c * (1 - delta * SHADE_CHROMA_RATIO));
  const newA = newC * Math.cos(h);
  const newB = newC * Math.sin(h);

  const l2 = newL + 0.3963377773761749 * newA + 0.2158037573099136 * newB;
  const m2 = newL - 0.1055613458156586 * newA - 0.0638541728258133 * newB;
  const s2 = newL - 0.0894841775298119 * newA - 1.2914855480194092 * newB;

  const l3 = l2 * l2 * l2;
  const m3 = m2 * m2 * m2;
  const s3 = s2 * s2 * s2;

  const rOut = 4.0767416360759574 * l3 - 3.3077115392580616 * m3 + 0.2309699031821044 * s3;
  const gOut = -1.2684379732850317 * l3 + 2.6097573492876887 * m3 - 0.3413193760026573 * s3;
  const bOut = -0.0041960761386756 * l3 - 0.7034186179359362 * m3 + 1.7076146940746117 * s3;

  return rgbaToHex(
    Math.round(Math.max(0, Math.min(1, gammaCorrection(rOut))) * 255),
    Math.round(Math.max(0, Math.min(1, gammaCorrection(gOut))) * 255),
    Math.round(Math.max(0, Math.min(1, gammaCorrection(bOut))) * 255),
    a,
  );
}

// Simple additive rise in OKLCh L, mirror of oklchShadow:
//   `newL = okL + delta · (1 + darkBoost · (1 − okL))`
// C + h preserved. Dark bases get a heavier rise (visible rim on dark
// surfaces), lights get just `delta`. Works correctly at extremes: pure
// black lifts by `delta · (1 + darkBoost)`, pure white stays at 1.
export function oklchHighlight(hexColor: string, delta = 0.05, darkBoost = 1): string {
  const { r, g, b, a } = hexToRgba(hexColor);

  const lr = gammaExpansion(r / 255);
  const lg = gammaExpansion(g / 255);
  const lb = gammaExpansion(b / 255);

  const lCone = cubeRoot(0.412221469470763 * lr + 0.5363325372617348 * lg + 0.0514459932675022 * lb);
  const mCone = cubeRoot(0.2119034958178252 * lr + 0.6806995506452344 * lg + 0.1073969535369406 * lb);
  const sCone = cubeRoot(0.0883024591900564 * lr + 0.2817188391361215 * lg + 0.6299787016738222 * lb);

  const okL = 0.210454268309314 * lCone + 0.7936177747023054 * mCone - 0.0040720430116193 * sCone;
  const okA = 1.9779985324311684 * lCone - 2.4285922420485799 * mCone + 0.450593709617411 * sCone;
  const okB = 0.0259040424655478 * lCone + 0.7827717124575296 * mCone - 0.8086757549230774 * sCone;

  const c = Math.sqrt(okA * okA + okB * okB);
  const h = Math.atan2(okB, okA);

  const rise = delta * (1 + darkBoost * (1 - okL));
  const newL = Math.max(0, Math.min(1, okL + rise));
  const newA = c * Math.cos(h);
  const newB = c * Math.sin(h);

  const l2 = newL + 0.3963377773761749 * newA + 0.2158037573099136 * newB;
  const m2 = newL - 0.1055613458156586 * newA - 0.0638541728258133 * newB;
  const s2 = newL - 0.0894841775298119 * newA - 1.2914855480194092 * newB;

  const l3 = l2 * l2 * l2;
  const m3 = m2 * m2 * m2;
  const s3 = s2 * s2 * s2;

  const rOut = 4.0767416360759574 * l3 - 3.3077115392580616 * m3 + 0.2309699031821044 * s3;
  const gOut = -1.2684379732850317 * l3 + 2.6097573492876887 * m3 - 0.3413193760026573 * s3;
  const bOut = -0.0041960761386756 * l3 - 0.7034186179359362 * m3 + 1.7076146940746117 * s3;

  const rFinal = Math.round(Math.max(0, Math.min(1, gammaCorrection(rOut))) * 255);
  const gFinal = Math.round(Math.max(0, Math.min(1, gammaCorrection(gOut))) * 255);
  const bFinal = Math.round(Math.max(0, Math.min(1, gammaCorrection(bOut))) * 255);

  return rgbaToHex(rFinal, gFinal, bFinal, a);
}

// Perceptual blend of two hex colours in OKLCh space: lightness + chroma
// interpolate linearly and HUE travels the shortest arc — so red+yellow lands on
// a vivid orange instead of the muddy mid-grey a straight RGB (or even OKLab)
// average yields when the two hues pull apart. `t` = 0 → c1, 1 → c2 (default 0.5,
// an even mix). If a colour is achromatic (chroma ≈ 0) its hue is undefined, so
// the other's hue is carried rather than rotating toward an arbitrary 0° (CSS
// colour-mix does the same). Alpha follows c1.
export function oklchMix(c1: string, c2: string, t = 0.5): string {
  const toLch = (hex: string) => {
    const { r, g, b } = hexToRgba(hex);
    const lr = gammaExpansion(r / 255);
    const lg = gammaExpansion(g / 255);
    const lb = gammaExpansion(b / 255);
    const lCone = cubeRoot(0.412221469470763 * lr + 0.5363325372617348 * lg + 0.0514459932675022 * lb);
    const mCone = cubeRoot(0.2119034958178252 * lr + 0.6806995506452344 * lg + 0.1073969535369406 * lb);
    const sCone = cubeRoot(0.0883024591900564 * lr + 0.2817188391361215 * lg + 0.6299787016738222 * lb);
    const L = 0.210454268309314 * lCone + 0.7936177747023054 * mCone - 0.0040720430116193 * sCone;
    const A = 1.9779985324311684 * lCone - 2.4285922420485799 * mCone + 0.450593709617411 * sCone;
    const B = 0.0259040424655478 * lCone + 0.7827717124575296 * mCone - 0.8086757549230774 * sCone;
    return { L, C: Math.sqrt(A * A + B * B), h: Math.atan2(B, A) };
  };

  const { a } = hexToRgba(c1);
  const o1 = toLch(c1);
  const o2 = toLch(c2);

  const L = o1.L + (o2.L - o1.L) * t;
  const C = o1.C + (o2.C - o1.C) * t;

  // Hue: shortest arc, but carry the defined side when one colour is achromatic.
  const ACHROMA = 1e-4;
  let h: number;
  if (o1.C < ACHROMA && o2.C < ACHROMA) h = 0;
  else if (o1.C < ACHROMA) h = o2.h;
  else if (o2.C < ACHROMA) h = o1.h;
  else {
    let dh = o2.h - o1.h;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    else if (dh < -Math.PI) dh += 2 * Math.PI;
    h = o1.h + dh * t;
  }

  const newA = C * Math.cos(h);
  const newB = C * Math.sin(h);

  const l2 = L + 0.3963377773761749 * newA + 0.2158037573099136 * newB;
  const m2 = L - 0.1055613458156586 * newA - 0.0638541728258133 * newB;
  const s2 = L - 0.0894841775298119 * newA - 1.2914855480194092 * newB;

  const l3 = l2 * l2 * l2;
  const m3 = m2 * m2 * m2;
  const s3 = s2 * s2 * s2;

  const rOut = 4.0767416360759574 * l3 - 3.3077115392580616 * m3 + 0.2309699031821044 * s3;
  const gOut = -1.2684379732850317 * l3 + 2.6097573492876887 * m3 - 0.3413193760026573 * s3;
  const bOut = -0.0041960761386756 * l3 - 0.7034186179359362 * m3 + 1.7076146940746117 * s3;

  return rgbaToHex(
    Math.round(Math.max(0, Math.min(1, gammaCorrection(rOut))) * 255),
    Math.round(Math.max(0, Math.min(1, gammaCorrection(gOut))) * 255),
    Math.round(Math.max(0, Math.min(1, gammaCorrection(bOut))) * 255),
    a,
  );
}

// ── Card-surface derivation ─────────────────────────────────────────────
// A single base color drives every surface on a 3D card (top face, bottom
// face, halo ring, inner stroke). Each derived shade is an OKLCh
// transformation of the base — chroma + hue are preserved, only lightness
// shifts — so a red card gets a darker red bottom face (not brown-shifted),
// a blue card gets a darker blue (not purple-shifted), etc. Only the base
// itself is passed through verbatim.
export interface CardSurfaces {
  top: string;          // = base (verbatim)
  bottom: string;       // base darkened (L · 0.755) — the lifted shadow layer.
  halo: string;         // bottom + 25% alpha — the 3.5px outer ring.
  innerStroke: string;  // base LIGHTENED in OKLCh — a soft highlight rim
                        // on the top face. Lighter than the base so it
                        // reads as a subtle inner glow on dark surfaces
                        // (where a darker shade would just disappear).
}

export function deriveCardSurfaces(base: string): CardSurfaces {
  const bottom = oklchShadow(base, 0.05, 2.5, 0.8);
  return {
    top: base,
    bottom,
    halo: `${bottom}40`,
    innerStroke: oklchHighlight(base, 0.04, 1),
  };
}

// ── Color conversion helpers ─────────────────────────────────────────────

export function hexToRgba(hex: string): { r: number; g: number; b: number; a: number } {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 6) h = 'FF' + h;
  const n = parseInt(h, 16);
  if (h.length === 8) {
    return {
      a: (n >>> 24) & 0xFF,
      r: (n >>> 16) & 0xFF,
      g: (n >>> 8) & 0xFF,
      b: n & 0xFF,
    };
  }
  return { r: (n >>> 16) & 0xFF, g: (n >>> 8) & 0xFF, b: n & 0xFF, a: 255 };
}

export function rgbaToHex(r: number, g: number, b: number, a = 255): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  if (a < 255) {
    return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function colorToHex(hex: string): string {
  const { r, g, b } = hexToRgba(hex);
  return `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
}

export function hexStringToColor(s: string): string | null {
  const hex = s.trim().replace(/^#/, '');
  if (hex.length !== 6 || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  return `#${hex}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgba(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function lerpColor(from: string, to: string, t: number): string {
  const a = hexToRgba(from);
  const b = hexToRgba(to);
  return rgbaToHex(
    Math.round(a.r + (b.r - a.r) * t),
    Math.round(a.g + (b.g - a.g) * t),
    Math.round(a.b + (b.b - a.b) * t),
    Math.round(a.a + (b.a - a.a) * t),
  );
}

// OKLCH perceptual lightness (L, 0..1) of a hex colour.
export function oklchLightness(hexColor: string): number {
  const { r, g, b } = hexToRgba(hexColor);
  const lr = gammaExpansion(r / 255);
  const lg = gammaExpansion(g / 255);
  const lb = gammaExpansion(b / 255);
  const lCone = cubeRoot(0.412221469470763 * lr + 0.5363325372617348 * lg + 0.0514459932675022 * lb);
  const mCone = cubeRoot(0.2119034958178252 * lr + 0.6806995506452344 * lg + 0.1073969535369406 * lb);
  const sCone = cubeRoot(0.0883024591900564 * lr + 0.2817188391361215 * lg + 0.6299787016738222 * lb);
  return 0.210454268309314 * lCone + 0.7936177747023054 * mCone - 0.0040720430116193 * sCone;
}

// Readable text colour over a coloured fill: white by default, flipping to black
// only once the fill is LIGHTER (in OKLCH lightness) than #ffd500. The flip point
// sits a hair ABOVE #ffd500's own lightness, so #ffd500 itself (and anything
// darker) keeps white text; only fills lighter than it get black.
const TEXT_FLIP_LIGHTNESS = oklchLightness('#ffd500') + 0.02;
export function readableTextColor(bgHex: string): string {
  return oklchLightness(bgHex) > TEXT_FLIP_LIGHTNESS ? '#000000' : '#FFFFFF';
}
