// Icon SVGs are rendered as CSS `mask-image` (and a few <img>) across the
// editor UI. The browser only fetches each one the first time an element
// using it mounts — so the first time the editor sheet opens, icons like the
// reorder grip and the +/- buttons flash blank for a frame while their SVG
// loads. That reads as "rough".
//
// Warming the cache up front fixes it: a `new Image().src = url` issues a GET
// that the browser caches by URL. The later mask-image request for the same
// URL is then served from cache with no network round-trip, so the icon
// paints on the first frame the sheet opens.
const ICON_SVGS = [
  // Segment editor (the ones the user sees flash on sheet open)
  '/images/drag.svg',
  '/images/chevrons.svg',
  '/images/addl.svg',
  '/images/subtractl.svg',
  '/images/addsegment.svg',
  // Sheets + chrome
  '/images/close.svg',
  '/images/template.svg',
  '/images/segments.svg',
  '/images/style.svg',
  '/images/settings.svg',
  '/images/undo.svg',
  '/images/redo.svg',
  '/images/playl.svg',
  '/images/pagepointer.svg',
  // Marker pin assets
  '/images/pinshadow.svg',
  '/images/pinbase.svg',
];

let done = false;

// Preload every icon SVG once. Idempotent and safe to call eagerly at startup.
export function preloadIcons(): void {
  if (done || typeof window === 'undefined') return;
  done = true;
  for (const src of ICON_SVGS) {
    const img = new Image();
    img.src = src;
  }
}
