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

export function oklchShadow(hexColor: string, lightnessReduction = 0.1): string {
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

  const newL = Math.max(0, Math.min(1, okL - lightnessReduction));
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
