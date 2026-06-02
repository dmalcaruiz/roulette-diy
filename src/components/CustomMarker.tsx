import { oklchShadow } from '../utils/colorUtils';

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
}

// The center marker: faint halo rings, a base-derived 3D dot stack (bottom +
// lifted top), a ring, centre accent + base circles, and the pin assets on
// top. Shared by the live wheel (SpinningWheel) and the thumbnail previews.
export default function CustomMarker({
  size,
  markerDiameter = 62,
  markerPeek = 5,
  markerBaseColor = '#FFFFFF',
}: CustomMarkerProps) {
  const baseD = size * (markerDiameter / 100);
  const peekPx = baseD * (markerPeek / 100);
  // Top fill is the base colour; bottom + strokes all derive (darken) from it.
  const topFill = markerBaseColor;
  const topStroke = oklchShadow(topFill, 0.012);     // barely darker than top
  const bottomFill = oklchShadow(topFill, 0.07);      // derivative — darker
  const bottomStroke = oklchShadow(bottomFill, 0.03); // a bit darker than bottom
  const ringStroke = oklchShadow(topFill, 0.013);     // slightly darker than base
  const accentFill = oklchShadow(topFill, 0.04);      // centre accent — a hint lighter than bottom
  const coreFill = oklchShadow(topFill, 0.008);       // centre base circle — a hint darker than base
  const coreStroke = oklchShadow(topFill, 0.06);      // centre circle stroke
  const pinD = baseD * 2.2;
  return (
    <div style={{ position: 'relative', width: size, height: size, pointerEvents: 'none' }}>
      {/* Lowest halo — black 6%, +28px diameter */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: baseD + 28, height: baseD + 28, borderRadius: '50%', backgroundColor: 'rgba(0,0,0,0.06)' }} />
      {/* Halo — black 14%, +12px diameter */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: baseD + 12, height: baseD + 12, borderRadius: '50%', backgroundColor: 'rgba(0,0,0,0.14)' }} />
      {/* Bottom layer — derived (darker), dead centre, 3px inner stroke */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: baseD, height: baseD, borderRadius: '50%', backgroundColor: bottomFill, border: `3px solid ${bottomStroke}`, boxSizing: 'border-box' }} />
      {/* Top layer — base colour, lifted up by `peek`% so the bottom peeks below */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: baseD, height: baseD, borderRadius: '50%', backgroundColor: topFill, border: `3px solid ${topStroke}`, boxSizing: 'border-box' }} />
      {/* Ring — 2px stroke, between the top layer and the inner accent circle */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: baseD * 0.78, height: baseD * 0.78, borderRadius: '50%', border: `2px solid ${ringStroke}`, boxSizing: 'border-box' }} />
      {/* Centre accent — darker-than-base circle */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: baseD * 0.5, height: baseD * 0.5, borderRadius: '50%', backgroundColor: accentFill }} />
      {/* Inner circle — base colour, slightly smaller than the accent, 3px stroke */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: baseD * 0.41, height: baseD * 0.41, borderRadius: '50%', backgroundColor: coreFill, border: `3px solid ${coreStroke}`, boxSizing: 'border-box' }} />
      {/* Pin base (tinted to base colour), then a doubled shadow on top */}
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: pinD, height: pinD, backgroundColor: topFill, WebkitMaskImage: 'url(/images/pinbase.svg)', WebkitMaskRepeat: 'no-repeat', WebkitMaskSize: 'contain', WebkitMaskPosition: 'center', maskImage: 'url(/images/pinbase.svg)', maskRepeat: 'no-repeat', maskSize: 'contain', maskPosition: 'center' }} />
      <img src="/images/pinshadow.svg" alt="" style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: pinD, height: pinD, objectFit: 'contain' }} />
      <img src="/images/pinshadow.svg" alt="" style={{ position: 'absolute', top: '50%', left: '50%', transform: `translate(-50%, -50%) translateY(${-peekPx}px)`, width: pinD, height: pinD, objectFit: 'contain', opacity: 0.5 }} />
    </div>
  );
}
