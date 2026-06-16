import { oklchShade } from '../utils/colorUtils';

// Hand-drawn rough circle as an SVG path — a few low integer harmonics wobble the
// radius so the marker's lower layer reads hand-drawn (matching the wheel's
// silhouette) instead of a perfect CSS circle. Integer harmonics keep it
// 2π-periodic (clean seam); the per-harmonic phases are derived from `seed` with
// the same fract(sin·k) hash the wheel uses, so each wheel id gets its own wobble
// while staying deterministic (it doesn't boil frame-to-frame).
// `phase` adds a small offset to every harmonic — same seed/character, just
// nudged — for shapes that should differ only SLIGHTLY (e.g. the shadow halos vs
// the marker, and from each other) rather than being fully decorrelated.
function roughCirclePath(cx: number, cy: number, r: number, amp: number, seed: number, phase = 0): string {
  const ph = (c: number) => {
    const x = Math.sin(seed * 127.1 + c * 311.7 + 0.5) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  };
  const p0 = ph(0) + phase, p1 = ph(1) + phase, p2 = ph(2) + phase;
  const steps = 72;
  let d = '';
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const n = Math.sin(a * 3 + p0) * 0.6
            + Math.sin(a * 5 + p1) * 0.3
            + Math.sin(a * 9 + p2) * 0.1;
    const rr = r + amp * n;
    d += `${i === 0 ? 'M' : 'L'}${(cx + Math.cos(a) * rr).toFixed(2)} ${(cy + Math.sin(a) * rr).toFixed(2)} `;
  }
  return d + 'Z';
}

// Hand-drawn ring drawn as a FILLED ribbon (an annulus) so its width can swell
// and taper around the circle — the "ink stroke" look, since an SVG <path>
// stroke can't vary its width. The centreline wobbles like roughCirclePath
// (deform `amp`/`seed`), and the half-width is modulated by its own harmonics
// (`widthVar`). Fill it with fillRule="evenodd" to leave the centre hollow.
function roughRingRibbon(cx: number, cy: number, r: number, halfW: number, amp: number, seed: number, widthVar: number): string {
  const ph = (c: number) => {
    const x = Math.sin(seed * 127.1 + c * 311.7 + 0.5) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  };
  const p0 = ph(0), p1 = ph(1), p2 = ph(2), w0 = ph(3), w1 = ph(4);
  const steps = 72;
  let outer = '';
  let inner = '';
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const n = Math.sin(a * 3 + p0) * 0.6 + Math.sin(a * 5 + p1) * 0.3 + Math.sin(a * 9 + p2) * 0.1;
    const rr = r + amp * n;
    const wmul = Math.max(0.35, 1 + widthVar * (Math.sin(a * 4 + w0) * 0.6 + Math.sin(a * 7 + w1) * 0.4));
    const hw = halfW * wmul;
    outer += `${i === 0 ? 'M' : 'L'}${(cx + Math.cos(a) * (rr + hw)).toFixed(2)} ${(cy + Math.sin(a) * (rr + hw)).toFixed(2)} `;
    inner += `${i === 0 ? 'M' : 'L'}${(cx + Math.cos(a) * (rr - hw)).toFixed(2)} ${(cy + Math.sin(a) * (rr - hw)).toFixed(2)} `;
  }
  return `${outer}Z ${inner}Z`;
}

interface CustomMarkerProps {
  // The marker box diameter in px. The circle diameter is markerDiameter% of
  // this; all the absolute-px details (halos, strokes) are tuned for the live
  // wheel's box (~128px). For smaller previews, scale this whole component
  // with a CSS transform rather than shrinking `size` (which would leave the
  // px details over-sized).
  size: number;
  markerDiameter?: number; // % of size, both layers
  markerPeek?: number;     // % of the diameter the top layer lifts
  markerBaseColor?: string; // TOP layer fill; everything else derives from it
  roughSeed?: number;       // per-wheel seed for the hand-drawn layer wobble
  showPin?: boolean;        // draw the pin graphic (pinbase + pinshadow); default off
}

// The center marker: faint halo rings, a base-derived 3D dot stack (bottom +
// lifted top), a ring, centre accent + base circles, and the pin assets on
// top. Shared by the live wheel (SpinningWheel) and the thumbnail previews.
export default function CustomMarker({
  size,
  markerDiameter = 60,
  markerPeek = 4,
  markerBaseColor = '#FFFFFF',
  roughSeed = 0,
  showPin = false,
}: CustomMarkerProps) {
  const baseD = size * (markerDiameter / 100);
  const peekPx = baseD * (markerPeek / 100);
  // Rough lower-layer geometry: wobble amplitude as a fraction of the disc, and an
  // SVG box padded enough that the wobble + stroke never clip.
  const roughAmp = baseD * 0.0045;
  // The three centre circles (ring/accent/inner) get an even gentler wobble than
  // the outer discs, so the small shapes don't read as over-deformed.
  const innerAmp = roughAmp * 0.5;
  const roughPad = roughAmp + 3;
  const roughBox = baseD + roughPad * 2;
  const roughR = baseD / 2 - 1.5; // matches the 3px border-box stroke's outer edge
  // One shared path for BOTH layers (same seed/phases), so the top and bottom
  // discs deform identically and stay visually synced — only their fill/stroke and
  // the top's peek lift differ.
  const roughPath = roughCirclePath(roughBox / 2, roughBox / 2, roughR, roughAmp, roughSeed);
  // Halo/shadow discs below the marker — bigger boxes, same seed/amp so they
  // deform in parallel with the marker (a wobbly shadow of the same shape).
  const halo1D = baseD + 28;
  const halo2D = baseD + 12;
  const halo1Box = halo1D + roughPad * 2;
  const halo2Box = halo2D + roughPad * 2;
  // Top fill is the base colour; bottom + strokes all derive (darken) from it.
  const topFill = markerBaseColor;
  const topStroke = oklchShade(topFill, 0.012);     // barely darker than top
  const bottomFill = oklchShade(topFill, 0.07);      // derivative — darker
  const bottomStroke = oklchShade(bottomFill, 0.03); // a bit darker than bottom
  // Ring (+ shadow tint). topBoost (3rd→4th args: lightBoost, topBoost) adds a
  // quadratic lift at the bright end so near-white bases darken enough to stay
  // visible, while mid/dark bases (which looked right) barely move.
  const ringStroke = oklchShade(topFill, 0.05, -0.5, 0.9);
  const accentFill = oklchShade(topFill, 0.04);      // centre accent — a hint lighter than bottom
  const coreFill = oklchShade(topFill, 0.008);       // centre base circle — a hint darker than base
  const coreStroke = oklchShade(topFill, 0.06);      // centre circle stroke
  // Pin shadow tint — the same colour as the ring. The shadow SVG carries its
  // own alpha gradient (0 → full), which controls the shape/strength.
  const shadowColor = ringStroke;
  const pinD = baseD * 2.2;
  return (
    <div style={{ position: 'relative', width: size, height: size, pointerEvents: 'none' }}>
      {/* Shadow halos — same seed as the marker but each with a small phase
          nudge, so the shadow's roughness is SLIGHTLY off from the bottom layer
          and the two halos are slightly off from each other (not fully different). */}
      {/* Lowest halo — black 6%, +28px diameter */}
      <svg width={halo1Box} height={halo1Box} viewBox={`0 0 ${halo1Box} ${halo1Box}`}
        style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', overflow: 'visible' }}>
        <path d={roughCirclePath(halo1Box / 2, halo1Box / 2, halo1D / 2, roughAmp, roughSeed, 0.35)} fill="rgba(0,0,0,0.06)" />
      </svg>
      {/* Halo — black 14%, +12px diameter */}
      <svg width={halo2Box} height={halo2Box} viewBox={`0 0 ${halo2Box} ${halo2Box}`}
        style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', overflow: 'visible' }}>
        <path d={roughCirclePath(halo2Box / 2, halo2Box / 2, halo2D / 2, roughAmp, roughSeed, 0.7)} fill="rgba(0,0,0,0.14)" />
      </svg>
      {/* Bottom layer — derived (darker), dead centre, hand-drawn rough outline
          (replaces the perfect CSS circle so it matches the wheel silhouette) */}
      <svg width={roughBox} height={roughBox} viewBox={`0 0 ${roughBox} ${roughBox}`}
        style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', overflow: 'visible' }}>
        <path d={roughPath} fill={bottomFill} stroke={bottomStroke} strokeWidth={3} strokeLinejoin="round" />
      </svg>
      {/* Top layer AS A WHOLE — base disc, ring, accent, inner circle — all
          hand-drawn with the SAME seed/amplitude so they wobble in parallel
          (concentric, like the wheel's rings), lifted by `peek`% above the
          bottom. roughR-style insets account for each stroke width. */}
      <svg width={roughBox} height={roughBox} viewBox={`0 0 ${roughBox} ${roughBox}`}
        style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, overflow: 'visible' }}>
        {/* base disc fill + an ink-blot ribbon for its thin border (rides the
            same edge as the fill: same r/amp/seed), so the top-layer stroke
            swells and tapers instead of being a uniform line */}
        <path d={roughPath} fill={topFill} />
        <path d={roughRingRibbon(roughBox / 2, roughBox / 2, roughR, 1.5, roughAmp, roughSeed, 0.3)} fill={topStroke} fillRule="evenodd" />
        {/* ring — its OWN deform source (offset seed + slightly bigger amp) AND a
            variable "ink" width (filled ribbon that swells/tapers around it) */}
        <path d={roughRingRibbon(roughBox / 2, roughBox / 2, baseD * 0.39 - 1.5, 1.5, innerAmp * 1.25, roughSeed + 7.1, 0.25)} fill={ringStroke} fillRule="evenodd" />
        {/* centre accent + inner circle — their OWN deform source (distinct from
            the discs' roughSeed and the ring's roughSeed+7.1) so the centre group
            doesn't track the outer shapes. They share it, staying synced together. */}
        <path d={roughCirclePath(roughBox / 2, roughBox / 2, baseD * 0.25, innerAmp, roughSeed + 13.7)} fill={accentFill} />
        <path d={roughCirclePath(roughBox / 2, roughBox / 2, baseD * 0.205 - 1.5, innerAmp, roughSeed + 13.7)} fill={coreFill} stroke={coreStroke} strokeWidth={3} strokeLinejoin="round" />
      </svg>
      {/* Pin base (tinted to base colour), then the shadow tinted via mask
          (its alpha gradient kept, recoloured to a darker base shade). Hidden by
          default — gated behind the `showPin` setting. */}
      {showPin && <>
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: pinD, height: pinD, backgroundColor: topFill, WebkitMaskImage: 'url(/images/pinbase.svg)', WebkitMaskRepeat: 'no-repeat', WebkitMaskSize: 'contain', WebkitMaskPosition: 'center', maskImage: 'url(/images/pinbase.svg)', maskRepeat: 'no-repeat', maskSize: 'contain', maskPosition: 'center' }} />
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: pinD, height: pinD, backgroundColor: shadowColor, WebkitMaskImage: 'url(/images/pinshadow.svg)', WebkitMaskRepeat: 'no-repeat', WebkitMaskSize: 'contain', WebkitMaskPosition: 'center', maskImage: 'url(/images/pinshadow.svg)', maskRepeat: 'no-repeat', maskSize: 'contain', maskPosition: 'center' }} />
      </>}
    </div>
  );
}
