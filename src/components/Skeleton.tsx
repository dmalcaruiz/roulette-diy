import type { CSSProperties } from 'react';

// IG-style shimmering skeleton placeholder. Use for "we're still fetching"
// states instead of a blank screen or a centered spinner — the user sees the
// shape of the content immediately and only the shimmer animates.
//
// The shimmer is a single CSS gradient + keyframe animation injected once
// (see SkeletonStyles below). Skeleton itself is a styled <div> that takes
// width / height / borderRadius props.

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}

export default function Skeleton({ width = '100%', height = 16, radius = 8, style }: SkeletonProps) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        // Darker, more saturated base than the previous near-white grey so
        // the lighter sweep band reads clearly — matches the IG/Facebook
        // shimmer recipe (visible contrast between base and pulse).
        backgroundColor: '#D6D6DC',
        // A wide light band sliding across a darker base. The band fades in
        // and out smoothly so it reads as a soft pulse rather than a hard
        // edge. The 200% size + offscreen start gives a long sweep distance
        // and a brief gap between sweeps.
        backgroundImage:
          'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)',
        backgroundSize: '200% 100%',
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '150% 0',
        animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

// Inject the shimmer keyframes once. Cheap; safe to import from anywhere.
// Sweep travels left → right, offscreen on both ends so the pulse "enters"
// and "exits" the tile rather than wrapping abruptly.
if (typeof document !== 'undefined' && !document.getElementById('skeleton-keyframes')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'skeleton-keyframes';
  styleEl.textContent = `
    @keyframes skeleton-shimmer {
      0%   { background-position: 150% 0; }
      100% { background-position: -50% 0; }
    }
  `;
  document.head.appendChild(styleEl);
}
